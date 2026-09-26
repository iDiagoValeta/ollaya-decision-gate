import json
import os
import sys
from datetime import datetime, timezone

from . import client as client_mod
from . import decision as decision_mod
from . import schemas as schemas_mod

LOG_SCHEMA_VERSION = 2


def _classify_error(exc):
    name = type(exc).__name__
    msg = str(exc) if exc is not None else ""
    if msg.startswith("bad-response"):
        return "bad-response"
    if msg.startswith("state-truncated"):
        return "state-truncated"
    if name == "GateCallError":
        return "transport"
    return "exception"


def decide_event(event, evaluate_fn, _error_box=None):
    try:
        objective = event["objective"]
        halt = event["halt"]
        context = event.get("context", {})
        policy = event.get("policy", {})
        user_notes = schemas_mod.load_user_notes()
        questions = schemas_mod.build_questions(halt)
        for budget in schemas_mod.STATE_BUDGETS:
            state = schemas_mod.build_state(objective, halt, context, policy, user_notes, budget)
            try:
                result = evaluate_fn(state, questions)
                break
            except Exception as exc:
                # Dense text can overflow the model's state window even
                # within the char budget: retry smaller rather than ask a
                # human. A truncated state is never judged (see client.py).
                if "state-truncated" not in str(exc) or budget == schemas_mod.STATE_BUDGETS[-1]:
                    raise
        combined = decision_mod.combine(
            result["decision"]["choice"],
            float(result["decision"]["confidence"]),
            float(result["safe"]["noul"]),
            float(result["risk"]["score"]),
            halt.get("kind", "write"),
        )
        pick = None
        if halt.get("kind") == "multichoice" and combined["action"] == "allow" and (halt.get("options") or []):
            options = halt.get("options") or []
            choice = None
            try:
                choice = result.get("pick", {}).get("choice")
            except Exception:
                choice = None
            if choice not in options:
                if _error_box is not None:
                    _error_box["error_class"] = "bad-response"
                return {
                    "action": "ask-human",
                    "reason": "fail-open",
                    "pick": None,
                    "confidence": 0.0,
                    "model": None,
                    "error": "bad-response",
                }
            pick = choice
        out = {
            "action": combined["action"],
            "reason": combined["reason"],
            "pick": pick,
            "confidence": float(result["decision"]["confidence"]),
            "model": result.get("model"),
        }
        if result.get("usage") is not None:
            out["usage"] = result["usage"]
        return out
    except Exception as exc:
        detail = schemas_mod.redact_secrets(str(exc))[:200]
        if _error_box is not None:
            _error_box["error_class"] = _classify_error(exc)
            _error_box["error_detail"] = detail
        return {
            "action": "ask-human",
            "reason": "fail-open",
            "pick": None,
            "confidence": 0.0,
            "model": None,
            "error": _classify_error(exc),
            "error_detail": detail,
        }


def _chmod_600(path):
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def main():
    raw = sys.stdin.read()
    try:
        event = json.loads(raw) if raw.strip() else {}
    except Exception:
        event = {}
    model = os.environ.get("OLLAYA_GATE_MODEL") or client_mod.DEFAULT_MODEL

    def real_evaluate(state, questions):
        return client_mod.evaluate(state, questions, model=model)

    error_box = {}
    if not event:
        event = {"objective": "", "halt": {"kind": "write"}}
    out = decide_event(event, real_evaluate, error_box)
    if os.environ.get("OLLAYA_GATE_CLI_LOG", "1") != "0":
        _write_log_entry(event, out, error_box)
    sys.stdout.write(json.dumps(out))


def _write_log_entry(event, out, error_box):
    log_path = os.environ.get("OLLAYA_GATE_LOG", "decisions-plugin.jsonl")
    try:
        halt = event.get("halt", {}) if isinstance(event, dict) else {}
        context = event.get("context", {}) if isinstance(event, dict) else {}
        with open(log_path, "a", encoding="utf-8") as handle:
            entry = {
                "v": LOG_SCHEMA_VERSION,
                "at": datetime.now(timezone.utc).isoformat(),
                "sessionID": context.get("sessionID"),
                "requestID": context.get("requestID"),
                "tool": halt.get("tool"),
                "kind": halt.get("kind"),
                "detail_sha256": schemas_mod.sha256_hex(halt.get("detail", "")),
                "model": out.get("model"),
                "action": out.get("action"),
                "gateAction": out.get("action"),
                "reason": out.get("reason"),
                "confidence": out.get("confidence"),
                "pick": out.get("pick"),
            }
            if out.get("usage") is not None:
                entry["usage"] = out["usage"]
            if out.get("reason") == "fail-open" and error_box.get("error_class"):
                entry["error_class"] = error_box["error_class"]
                if error_box.get("error_detail"):
                    entry["error_detail"] = error_box["error_detail"]
            handle.write(json.dumps(entry) + "\n")
        _chmod_600(log_path)
    except Exception:
        pass


if __name__ == "__main__":
    main()
