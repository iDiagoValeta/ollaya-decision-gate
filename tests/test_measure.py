import importlib.util
import json
import math
import sys
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "measure.py"


def _load_measure():
    spec = importlib.util.spec_from_file_location("measure", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_load_skips_json_valid_non_object_rows_as_corrupt(tmp_path):
    # A line that's valid JSON but not an object (a bare
    # number/string/null/array) would crash main()'s first .get() call
    # on it. Must land in the same "corrupt" bucket as unparseable JSON.
    measure = _load_measure()
    log = tmp_path / "log.jsonl"
    log.write_text(
        "\n".join(
            json.dumps(x)
            for x in [{"gateAction": "allow"}, 42, "just a string", None, [1, 2, 3]]
        )
        + "\n"
    )
    rows, corrupt = measure.load([str(log)])
    assert len(rows) == 1
    assert corrupt == 4


def test_safe_float_rejects_non_numeric_and_non_finite():
    measure = _load_measure()
    assert measure._safe_float("not-a-number") == 0.0
    assert measure._safe_float(float("nan")) == 0.0
    assert measure._safe_float(float("inf")) == 0.0
    assert measure._safe_float(float("-inf")) == 0.0
    assert measure._safe_float(800) == 800.0
    assert measure._safe_float(None) == 0.0


def test_safe_int_rejects_non_numeric():
    measure = _load_measure()
    assert measure._safe_int("250.5") == 0
    assert measure._safe_int("not-a-number") == 0
    assert measure._safe_int(250) == 250
    assert measure._safe_int(None) == 0


def test_main_survives_an_adversarial_log_and_emits_valid_json(tmp_path, monkeypatch, capsys):
    # Combines every round-8 finding in one realistic-shaped log file:
    # a non-object row, a non-numeric elapsedMs, a non-numeric
    # usage.input_tokens, NaN/Infinity elapsedMs, and a lone UTF-16
    # surrogate in sessionID (escaped as \ud800 in the JSON text, exactly
    # how a real producer's ensure_ascii-style JSON encoder would write
    # it — the same shape sha256_hex must tolerate in the TS/Python bridge).
    measure = _load_measure()
    log = tmp_path / "log.jsonl"
    rows = [
        {"gateAction": "allow", "reason": "model-allow", "elapsedMs": 800},
        42,
        {"gateAction": "allow", "reason": "model-allow", "elapsedMs": "not-a-number"},
        {"gateAction": "allow", "reason": "model-allow", "elapsedMs": 900, "usage": {"input_tokens": "250.5"}},
        {"gateAction": "allow", "reason": "model-allow", "elapsedMs": float("nan")},
        {"gateAction": "ask-human", "reason": "fail-open", "elapsedMs": float("inf")},
        {"gateAction": "allow", "reason": "model-allow", "elapsedMs": 750, "sessionID": "s8\ud800suffix"},
    ]
    log.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    monkeypatch.setattr(sys, "argv", ["measure.py", "--log", str(log), "--by-session", "--json"])
    measure.main()
    out = capsys.readouterr().out

    parsed = json.loads(out)  # must be strict-valid JSON: no bare NaN/Infinity
    assert parsed["corrupt_lines"] == 1
    assert math.isfinite(parsed["p95_elapsed_ms"])
    assert math.isfinite(parsed["mean_elapsed_ms"])
    assert parsed["input_tokens"] == 0  # the non-numeric usage value was rejected, not miscounted


def test_main_by_session_plain_text_survives_a_lone_surrogate_sessionid(tmp_path, monkeypatch, capsys):
    measure = _load_measure()
    log = tmp_path / "log.jsonl"
    log.write_text(json.dumps({"gateAction": "allow", "sessionID": "s8\ud800suffix"}) + "\n")
    monkeypatch.setattr(sys, "argv", ["measure.py", "--log", str(log), "--by-session"])
    measure.main()  # must not raise UnicodeEncodeError
    out = capsys.readouterr().out
    assert "session " in out


def test_duplicate_suppressed_rows_excluded_from_totals_and_action_rates(tmp_path, monkeypatch, capsys):
    # setup() runs twice per opencode process (documented in AGENTS.md /
    # docs/ARCHITECTURE.md): every real permission is logged once by the
    # losing instance as gateAction="ask-human" reason="duplicate-suppressed"
    # (a no-op — it never called Jev) and once by the winner with the real
    # decision. A plain Counter over gateAction would lump those no-ops in
    # with genuine ask-human delegations, so a session with ~50%
    # duplicate noise would report an ~50% ask-human rate when the true
    # rate (real Jev delegations / real decisions) is near zero —
    # confirmed against a production log: 418/849 rows were
    # duplicate-suppressed vs 10 genuine ask-human rows.
    measure = _load_measure()
    log = tmp_path / "log.jsonl"
    rows = [
        {"gateAction": "allow", "reason": "model-allow"},
        {"gateAction": "ask-human", "reason": "model-asked-human"},
        {"gateAction": "ask-human", "reason": "duplicate-suppressed"},
        {"gateAction": "allow", "reason": "duplicate-suppressed"},
    ]
    log.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    monkeypatch.setattr(sys, "argv", ["measure.py", "--log", str(log), "--json"])
    measure.main()
    out = json.loads(capsys.readouterr().out)

    assert out["total"] == 2
    assert out["actions"] == {"allow": 1, "ask-human": 1}
    assert out["allow_rate"] == 0.5
    assert out["duplicates_suppressed"] == 2


def test_main_by_session_plain_text_survives_a_non_string_sessionid(tmp_path, monkeypatch, capsys):
    # Round 12 review: sid[:8] assumed sessionID was always a string.
    # A numeric sessionID crashed the --by-session text path (not --json,
    # which coerces non-string dict keys itself) with
    # TypeError: 'int' object is not subscriptable.
    measure = _load_measure()
    log = tmp_path / "log.jsonl"
    log.write_text(json.dumps({"gateAction": "allow", "sessionID": 12345}) + "\n")
    monkeypatch.setattr(sys, "argv", ["measure.py", "--log", str(log), "--by-session"])
    measure.main()  # must not raise TypeError
    out = capsys.readouterr().out
    assert "session 12345" in out
