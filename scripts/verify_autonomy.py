#!/usr/bin/env python3
"""Non-interactive autonomy check against a running opencode service.

Unlike `opencode run` (which auto-rejects permissions when --auto is off,
and auto-approves them when --auto is on, racing the plugin), this script
prompts a session and deliberately does NOT reply to permission.asked.
The ollaya-decision-gate plugin must own allow/deny and question answers.

Usage:
  ollaya serve &                           # the local daemon the plugin calls
  opencode service start
  python3 scripts/verify_autonomy.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

PROMPT = (
    "Hazme UNA pregunta multiopción: qué cenamos hoy. "
    "Opciones exactamente: pizza, sushi, ensalada. "
    "Usa la herramienta question del sistema y espera la respuesta. "
    "Cuando recibas la respuesta, escribe exactamente: ELEGIDO=<opción> "
    "y nada más de trabajo."
)
MODEL = os.environ.get("OLLAYA_VERIFY_MODEL", "opencode/nemotron-3-ultra-free")
TEST_DIR = os.environ.get("OLLAYA_VERIFY_DIR", str(Path.home() / "ollaya-gate-test"))


def resolve_log() -> Path:
    """Where the plugin writes: OLLAYA_GATE_LOG, else `logFile` from the
    opencode config (same lookup as measure.py), else the plugin's own
    default `<repo>/decisions-plugin.jsonl`."""
    env = os.environ.get("OLLAYA_GATE_LOG")
    if env:
        return Path(env)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from measure import _config_logfile

    cfg = _config_logfile()
    return Path(cfg) if cfg else Path(__file__).resolve().parent.parent / "decisions-plugin.jsonl"


LOG = resolve_log()
TIMEOUT_S = int(os.environ.get("OLLAYA_VERIFY_TIMEOUT", "180"))
# An isolated `opencode serve` (e.g. one whose config loads only this
# plugin) instead of the background service.
SERVER = os.environ.get("OLLAYA_VERIFY_SERVER", "")


def api(*args: str) -> str:
    env = os.environ.copy()
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:" + env.get("PATH", "")
    server = ["--server", SERVER] if SERVER else []
    proc = subprocess.run(
        ["opencode", "api", *server, *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"opencode api failed: {proc.stderr or proc.stdout}")
    return proc.stdout


def main() -> int:
    Path(TEST_DIR).mkdir(parents=True, exist_ok=True)
    offset = LOG.stat().st_size if LOG.exists() else 0

    created = json.loads(
        api(
            "POST",
            "/api/session",
            "-d",
            json.dumps({"title": "ollaya-verify-autonomy", "directory": TEST_DIR}),
        )
    )
    sid = created.get("data", created).get("id")
    if not sid:
        print("FAIL: no session id", created, file=sys.stderr)
        return 2
    print(f"session={sid}")

    # Switch model if the endpoint exists; ignore failures.
    try:
        provider, model = MODEL.split("/", 1)
        api(
            "POST",
            f"/api/session/{sid}/model",
            "-d",
            json.dumps({"model": {"providerID": provider, "id": model}}),
        )
    except Exception as exc:
        print(f"warn: model switch skipped: {exc}")

    # Prompt: do NOT subscribe as a competing permission handler.
    try:
        api(
            "POST",
            f"/api/session/{sid}/prompt",
            "-d",
            json.dumps({"text": PROMPT}),
        )
    except Exception as exc:
        # Some builds use a different body shape; try alternate.
        print(f"prompt attempt1 failed: {exc}")
        api(
            "POST",
            f"/api/session/{sid}/prompt",
            "-d",
            json.dumps({"parts": [{"type": "text", "text": PROMPT}]}),
        )

    deadline = time.time() + TIMEOUT_S
    saw_passthrough = False
    saw_answered = False
    pick = None
    while time.time() < deadline:
        if LOG.exists():
            with LOG.open("rb") as _lf:
                _lf.seek(offset)
                _content = _lf.read().decode("utf-8", errors="replace")
            for line in _content.splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("sessionID") != sid:
                    continue
                reason = row.get("reason")
                if reason == "question-permission-passthrough":
                    saw_passthrough = True
                if reason == "question-answered":
                    saw_answered = True
                    pick = row.get("pick")
        # Check session messages for ELEGIDO=
        try:
            import sqlite3

            db = Path.home() / ".local/share/opencode/opencode.db"
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            rows = con.execute(
                "SELECT type, data FROM session_message WHERE session_id=? ORDER BY seq",
                (sid,),
            ).fetchall()
            for typ, data in rows:
                if typ != "assistant":
                    continue
                payload = json.loads(data) if isinstance(data, str) else data
                content = payload.get("content") or []
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "text":
                        text = str(part.get("text") or "")
                        if "ELEGIDO=" in text and saw_answered:
                            print(
                                json.dumps(
                                    {
                                        "ok": True,
                                        "sessionID": sid,
                                        "pick": pick,
                                        "passthrough": saw_passthrough,
                                        "answered": saw_answered,
                                        "evidence": "ELEGIDO in assistant text",
                                    }
                                )
                            )
                            return 0
                    if (
                        part.get("type") == "tool"
                        and part.get("name") == "question"
                        and (part.get("state") or {}).get("status") == "completed"
                        and saw_answered
                    ):
                        print(
                            json.dumps(
                                {
                                    "ok": True,
                                    "sessionID": sid,
                                    "pick": pick,
                                    "passthrough": saw_passthrough,
                                    "answered": saw_answered,
                                    "evidence": "question tool completed",
                                }
                            )
                        )
                        return 0
            idle = [r for r in rows if r[0] == "idle"]
            if idle:
                last = json.loads(idle[-1][1]) if isinstance(idle[-1][1], str) else idle[-1][1]
                if last.get("outcome") in ("succeeded", "failed", "interrupted"):
                    # keep waiting a bit if succeeded without ELEGIDO yet
                    if last.get("outcome") != "succeeded":
                        print(
                            json.dumps(
                                {
                                    "ok": False,
                                    "sessionID": sid,
                                    "outcome": last.get("outcome"),
                                    "passthrough": saw_passthrough,
                                    "answered": saw_answered,
                                    "pick": pick,
                                }
                            )
                        )
                        return 1
        except Exception:
            pass
        time.sleep(1.5)

    print(
        json.dumps(
            {
                "ok": False,
                "sessionID": sid,
                "error": "timeout",
                "passthrough": saw_passthrough,
                "answered": saw_answered,
                "pick": pick,
            }
        )
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
