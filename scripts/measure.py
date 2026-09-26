#!/usr/bin/env python3
"""measure.py v2: allowance / safety / latency / cost over v1+v2 logs.

Usage: python3 scripts/measure.py [--log PATH]... [--json] [--by-session]
       [--price-per-1k USD]  (cost = input_tokens * price / 1000)
Reads OLLAYA_GATE_LOG env by default; tolerates corrupt lines and both
schema versions (action vs gateAction, elapsedMs vs duration_ms).
"""
import argparse
import json
import math
import os
import sys
from collections import Counter
from pathlib import Path

TRAP_REASONS = {"catastrophic-pattern"}
DENY_REASONS = {"model-deny"}
FAIL_OPEN = "fail-open"
# setup() runs more than once per opencode process (see AGENTS.md /
# docs/ARCHITECTURE.md): every real permission gets logged twice, once by
# the losing instance as gateAction="ask-human" reason="duplicate-suppressed"
# (a no-op that never called the model) and once by the winner with the real
# decision. Counting these as ordinary rows doubles `total` and inflates
# the apparent ask-human rate toward 50% regardless of what the model actually
# decided (live-verified: 418/849 rows in a production log were this
# no-op, only 10 were genuine ask-human).
DUPLICATE_SUPPRESSED = "duplicate-suppressed"


def _safe_float(x, default=0.0):
    """float(x), rejecting non-numeric AND non-finite (NaN/Infinity).

    A JSON-valid-but-non-numeric elapsedMs string would crash the whole
    report (ValueError, uncaught); a NaN/Infinity elapsedMs wouldn't
    crash but would silently poison p95/mean for the entire report with
    no warning, and make --json's own output invalid JSON (json.dumps
    emits bare NaN/Infinity tokens by default). Same bug class as
    decision.confidence in client.py.
    """
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _safe_int(x, default=0):
    try:
        return int(x)
    except (TypeError, ValueError):
        return default


def _config_logfile() -> str | None:
    cfg_path = os.environ.get("OPENCODE_CONFIG_FILE")
    if cfg_path is None:
        cfg_path = str(Path.home() / ".config/opencode/opencode.json")
    try:
        with open(cfg_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    plugins = data.get("plugins")
    if not isinstance(plugins, list):
        return None
    for entry in plugins:
        if not isinstance(entry, dict):
            continue
        pkg = entry.get("package")
        if isinstance(pkg, str) and "ollaya-decision-gate" in pkg:
            opts = entry.get("options")
            if isinstance(opts, dict):
                lf = opts.get("logFile")
                if isinstance(lf, str) and lf:
                    return lf
    return None


def load(paths):
    rows = []
    corrupt = 0
    for path in paths:
        try:
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        parsed = json.loads(line)
                    except json.JSONDecodeError:
                        corrupt += 1
                        continue
                    # A line can be valid JSON and still not be a log row
                    # (a bare number/string/null/array), which would crash
                    # main()'s first .get() call on it. Same "tolerates
                    # corrupt lines" bucket.
                    if not isinstance(parsed, dict):
                        corrupt += 1
                        continue
                    rows.append(parsed)
        except FileNotFoundError:
            pass
    return rows, corrupt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", action="append", default=[])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--by-session", action="store_true")
    ap.add_argument("--price-per-1k", type=float, default=0.0)
    args = ap.parse_args()
    if args.log:
        paths = args.log
    else:
        env_log = os.environ.get("OLLAYA_GATE_LOG")
        cfg_log = None if env_log else _config_logfile()
        # An explicit source is exclusive: merging stray decisions*.jsonl
        # from the cwd would silently add unrelated rows to the report.
        if env_log or cfg_log:
            paths = [env_log or cfg_log]
        else:
            paths = ["decisions-plugin.jsonl", "decisions.jsonl"]
    # dedupe, keep order
    seen, uniq = set(), []
    for p in paths:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    # resolved log: first existing file among candidates, else first candidate
    resolved_log = next((p for p in uniq if Path(p).exists()), uniq[0] if uniq else "")
    all_rows, corrupt = load(uniq)
    rows = [r for r in all_rows if r.get("reason") != DUPLICATE_SUPPRESSED]
    duplicates_suppressed = len(all_rows) - len(rows)
    actions = Counter((r.get("gateAction") or r.get("action") or "?") for r in rows)
    errcls = Counter(r.get("error_class", "-") for r in rows if r.get("reason") == FAIL_OPEN)
    total = len(rows)
    traps = sum(1 for r in rows if r.get("reason") in TRAP_REASONS or r.get("reason") in DENY_REASONS)
    failopen = sum(1 for r in rows if r.get("reason") == FAIL_OPEN)
    lat = sorted(_safe_float(r.get("elapsedMs", r.get("duration_ms", 0))) for r in rows)
    p95 = lat[min(len(lat) - 1, int(0.95 * len(lat)))] if lat else 0
    mean = sum(lat) / len(lat) if lat else 0
    tokens = sum(_safe_int((r.get("usage") or {}).get("input_tokens", 0)) for r in rows
                 if isinstance(r.get("usage"), dict))
    cost = tokens * args.price_per_1k / 1000.0
    out = {
        "total": total,
        "actions": dict(actions),
        "allow_rate": (actions.get("allow", 0) / total) if total else 0,
        "traps_blocked": traps,
        "fail_open": failopen,
        "fail_open_rate": (failopen / total) if total else 0,
        "error_classes": dict(errcls),
        "p95_elapsed_ms": p95,
        "mean_elapsed_ms": round(mean, 1),
        "input_tokens": tokens,
        "est_cost_usd": round(cost, 4),
        "corrupt_lines": corrupt,
        "duplicates_suppressed": duplicates_suppressed,
        "log": resolved_log,
    }
    if args.by_session:
        by = {}
        for r in rows:
            sid = r.get("sessionID") or "unknown"
            # A log row's sessionID isn't guaranteed to be a string: a
            # numeric sessionID would crash the --by-session text path's
            # sid[:8] below with TypeError. --json mode is unaffected
            # (json.dumps coerces non-string keys itself).
            if not isinstance(sid, str):
                sid = str(sid)
            b = by.setdefault(sid, {"n": 0, "allow": 0, "fail_open": 0})
            b["n"] += 1
            if (r.get("gateAction") or r.get("action")) == "allow":
                b["allow"] += 1
            if r.get("reason") == FAIL_OPEN:
                b["fail_open"] += 1
        out["by_session"] = by
    if args.json:
        # The resolved path travels inside the JSON ("log"); a separate
        # log= line here would make the output invalid JSON.
        print(json.dumps(out, indent=2))
    else:
        print(f"log={resolved_log}")
        print(f"total={total} actions={dict(actions)}")
        print(f"allow_rate={out['allow_rate']:.2f} traps_blocked={traps} "
              f"fail_open={failopen} ({out['fail_open_rate']:.2f}) errors={dict(errcls)}")
        print(f"p95_elapsed_ms={p95} mean={out['mean_elapsed_ms']} corrupt={corrupt} "
              f"duplicates_suppressed={duplicates_suppressed}")
        print(f"input_tokens={tokens} est_cost_usd={out['est_cost_usd']}")
        if args.by_session:
            for sid, b in out["by_session"].items():
                # A lone UTF-16 surrogate in sessionID would crash a raw
                # print via stdout's utf-8 encoder, same bug class as
                # sha256_hex. errors="replace" for a display-only
                # truncated preview, not anything requiring fidelity.
                safe_sid = sid[:8].encode("utf-8", errors="replace").decode("utf-8")
                print(f"  session {safe_sid}: n={b['n']} allow={b['allow']} fail_open={b['fail_open']}")
        print("note=cost needs --price-per-1k and usage.input_tokens in log")


if __name__ == "__main__":
    sys.exit(main())
