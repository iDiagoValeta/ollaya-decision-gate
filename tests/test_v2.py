def test_write_executes_on_model_say_so():
    from ollaya_gate import decision
    low = decision.combine("allow", 0.15, 0.1, 1.9, "write")
    assert low == {"action": "allow", "reason": "model-allow"}
    denied = decision.combine("deny", 0.9, 0.9, 0.1, "write")
    assert denied == {"action": "deny", "reason": "model-deny"}


def test_no_pick_question_without_options():
    from ollaya_gate.schemas import build_questions
    out = build_questions({"kind": "multichoice", "tool": "question", "detail": "x"})
    assert "pick" not in out
    out2 = build_questions({"kind": "multichoice", "tool": "question", "detail": "x", "options": ["a"]})
    assert out2["pick"]["type"] == "choice"


def test_multichoice_without_options_flows_through():
    from ollaya_gate.cli import decide_event

    def fake(state, questions):
        assert "pick" not in questions
        return {"decision": {"choice": "allow", "confidence": 0.8},
                "safe": {"noul": 0.9}, "risk": {"score": 0.2, "confidence": 0.8},
                "model": "m"}

    event = {"objective": "o", "halt": {"kind": "multichoice", "tool": "question", "detail": "x"},
             "context": {}, "policy": {}}
    out = decide_event(event, fake)
    assert out == {"action": "allow", "reason": "model-allow", "pick": None,
                   "confidence": 0.8, "model": "m"}


def test_fail_open_carries_error():
    from ollaya_gate.cli import decide_event

    def bad(state, questions):
        raise RuntimeError("down")

    out = decide_event({"objective": "o", "halt": {"kind": "read"}}, bad)
    assert out["reason"] == "fail-open" and out["error"] == "exception"


def test_multichoice_pick_recorded_on_allow():
    from ollaya_gate.cli import decide_event

    def fake_evaluate(state, questions):
        return {
            "decision": {"choice": "allow", "confidence": 0.34},
            "safe": {"noul": 0.2},
            "risk": {"score": 1.9, "confidence": 0.9},
            "pick": {"choice": "b"},
            "model": "stub-model",
        }

    event = {
        "objective": "Pick lib",
        "halt": {"kind": "multichoice", "tool": "ask", "detail": "Which lib?", "options": ["a", "b"]},
        "context": {},
        "policy": {},
    }
    out = decide_event(event, fake_evaluate)
    assert out["action"] == "allow"
    assert out["pick"] == "b"


def test_redact_secrets_covers_token_and_key_value_variants_beyond_ghp():
    from ollaya_gate.schemas import redact_secrets
    assert "[REDACTED" in redact_secrets("Authorization: Basic dXNlcjpwYXNz")
    assert "[REDACTED-AWS-KEY]" in redact_secrets("AKIAABCDEFGHIJKLMNOP")
    assert "[REDACTED-TOKEN]" in redact_secrets("github_pat_11ABCDEFG0123456789012")
    assert "[REDACTED-TOKEN]" in redact_secrets("xoxb-1234567890-abcdefgh")
    assert "[REDACTED-TOKEN]" in redact_secrets("sk-abcd12345678")
    assert "[REDACTED]" in redact_secrets("password: hunter2345")
    assert "[REDACTED]" in redact_secrets("passwd=hunter2345")
    assert "[REDACTED]" in redact_secrets("secret: s3cr3tvalue")
    assert "[REDACTED]" in redact_secrets("token=abcd1234")


def test_redact_secrets_closes_security_review_gaps():
    from ollaya_gate.schemas import redact_secrets
    # Keyword embedded in a longer identifier, not just standing alone.
    assert redact_secrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY") == \
        "AWS_SECRET_ACCESS_KEY=[REDACTED]"
    # AWS temporary/STS credentials (ASIA prefix), not just long-term AKIA.
    assert redact_secrets("ASIAIOSFODNN7EXAMPLE") == "[REDACTED-AWS-KEY]"
    # Raw JWT with no Bearer prefix.
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PYE0Kr8VF5Nk"
    assert redact_secrets(jwt) == "[REDACTED-JWT]"
    # Credentials embedded in a connection-string URL: password redacted,
    # scheme/user/host/port/path kept visible for debugging context.
    assert redact_secrets("postgresql://admin:hunter2VerySecret@db.internal:5432/prod") == \
        "postgresql://admin:[REDACTED]@db.internal:5432/prod"
    # No prefix before the keyword must still work: the "keyword embedded
    # in a longer identifier" pattern must match without one.
    assert "[REDACTED]" in redact_secrets("password: hunter2345")
    assert "[REDACTED]" in redact_secrets("token=abcd1234")


def test_redact_secrets():
    import json
    from ollaya_gate.schemas import build_state, redact_secrets
    assert "[REDACTED" in redact_secrets("Bearer abcdefgh1234")
    assert "[REDACTED" in redact_secrets("key=ghp_12345678901234567890")
    assert "BEGIN RSA" not in redact_secrets("-----BEGIN RSA PRIVATE KEY-----")
    st = build_state("Fix x with ghp_12345678901234567890",
                     {"kind": "read", "tool": "read", "detail": "Read f"}, {}, {})
    assert "ghp_" not in json.dumps(st)
    assert st["objective"].startswith("Fix x with")


def test_state_has_hash():
    from ollaya_gate.schemas import build_state, sha256_hex
    st = build_state("Do x", {"kind": "write", "detail": "echo hi"}, {}, {})
    assert st["halt"]["detail"] == "echo hi" and st["objective"] == "Do x"
    assert st["detail_sha256"] == sha256_hex("echo hi")


def test_sha256_hex_survives_a_lone_utf16_surrogate():
    # Round 7 review: index.ts truncates untrusted text with plain
    # .slice(0, N) at several fixed boundaries. JS slices UTF-16 code
    # units, not code points, so an emoji (or any non-BMP character)
    # landing across one of those cuts leaves a lone surrogate in
    # ordinary, non-adversarial text. The default strict "utf-8" codec
    # raised UnicodeEncodeError here, which build_state() surfaced only
    # as a generic fail-open "exception" and which _write_log_entry's
    # blanket except silently swallowed, dropping that log line with
    # zero trace. Must not raise.
    from ollaya_gate.schemas import sha256_hex
    lone_surrogate = "x" * 10 + "\ud83d"  # high surrogate with no low pair
    digest = sha256_hex(lone_surrogate)
    assert len(digest) == 64
    # Deterministic: the same input always hashes the same way.
    assert digest == sha256_hex(lone_surrogate)


def test_decide_event_and_log_entry_survive_a_lone_surrogate_in_detail(tmp_path, monkeypatch):
    import json

    from ollaya_gate.cli import _write_log_entry, decide_event

    lone_surrogate = "x" * 10 + "\ud83d"
    event = {
        "objective": "o",
        "halt": {"kind": "read", "tool": "read", "detail": lone_surrogate},
        "context": {},
        "policy": {},
    }

    def fake_evaluate(state, questions):
        return {"decision": {"choice": "allow", "confidence": 0.9},
                "safe": {"noul": 0.9}, "risk": {"score": 0.1, "confidence": 0.8}, "model": "m"}

    error_box = {}
    out = decide_event(event, fake_evaluate, error_box)
    # The real model decision must come through, not a spurious fail-open
    # caused by the hash blowing up before the model is even called.
    assert out["action"] == "allow" and out["reason"] == "model-allow"
    assert error_box == {}

    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(log))
    _write_log_entry(event, out, error_box)
    # The line must actually get written, not silently dropped.
    row = json.loads(log.read_text().strip())
    assert row["gateAction"] == "allow"


def test_main_defaults_to_write_kind_on_empty_stdin(tmp_path, monkeypatch):
    import io
    import json

    import ollaya_gate.cli as cli_mod
    from ollaya_gate.cli import main

    def fake(state, questions):
        return {"decision": {"choice": "allow", "confidence": 0.9},
                "safe": {"noul": 0.9}, "risk": {"score": 0.1, "confidence": 0.8},
                "model": "m"}

    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(log))
    monkeypatch.setattr(cli_mod.client_mod, "evaluate",
                        lambda state, questions, model: fake(state, questions))
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    out_buf = io.StringIO()
    monkeypatch.setattr("sys.stdout", out_buf)
    main()
    row = json.loads(log.read_text().strip())
    assert row["kind"] == "write"
    out = json.loads(out_buf.getvalue())
    assert out["action"] == "allow"


def test_main_defaults_to_write_kind_on_invalid_json_stdin(tmp_path, monkeypatch):
    import io
    import json

    import ollaya_gate.cli as cli_mod
    from ollaya_gate.cli import main

    def fake(state, questions):
        return {"decision": {"choice": "deny", "confidence": 0.9},
                "safe": {"noul": 0.1}, "risk": {"score": 0.9, "confidence": 0.8},
                "model": "m"}

    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(log))
    monkeypatch.setattr(cli_mod.client_mod, "evaluate",
                        lambda state, questions, model: fake(state, questions))
    monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
    monkeypatch.setattr("sys.stdout", io.StringIO())
    main()
    row = json.loads(log.read_text().strip())
    assert row["kind"] == "write"
    assert row["gateAction"] == "deny"


def test_main_skips_logging_when_cli_log_disabled(tmp_path, monkeypatch):
    import io
    import json

    import ollaya_gate.cli as cli_mod
    from ollaya_gate.cli import main

    def fake(state, questions):
        return {"decision": {"choice": "allow", "confidence": 0.9},
                "safe": {"noul": 0.9}, "risk": {"score": 0.1, "confidence": 0.8},
                "model": "m"}

    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(log))
    monkeypatch.setenv("OLLAYA_GATE_CLI_LOG", "0")
    monkeypatch.setattr(cli_mod.client_mod, "evaluate",
                        lambda state, questions, model: fake(state, questions))
    event = {"objective": "o", "halt": {"kind": "read", "tool": "read", "detail": "Read f"},
             "context": {}, "policy": {}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))
    monkeypatch.setattr("sys.stdout", io.StringIO())
    main()
    assert not log.exists()


def test_main_logs_error_class_on_fail_open(tmp_path, monkeypatch):
    import io
    import json

    import ollaya_gate.cli as cli_mod
    from ollaya_gate.cli import main

    def bad(state, questions, model):
        raise RuntimeError("transport down")

    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(log))
    monkeypatch.setattr(cli_mod.client_mod, "evaluate", bad)
    event = {"objective": "o", "halt": {"kind": "read", "tool": "read", "detail": "Read f"},
             "context": {}, "policy": {}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))
    monkeypatch.setattr("sys.stdout", io.StringIO())
    main()
    row = json.loads(log.read_text().strip())
    assert row["gateAction"] == "ask-human" and row["reason"] == "fail-open"
    assert row["error_class"] == "exception"


def test_main_logs_error_detail_alongside_error_class_on_fail_open(tmp_path, monkeypatch):
    # Live-observed tonight: "transport" fail-opens under heavy concurrent
    # load (several opencode sessions calling the model at once) with no way
    # to tell rate-limit from a dropped connection from an API-side bug,
    # because _classify_error's bucket name is all the log ever kept, the
    # actual exception message client.py's GateCallError wraps was
    # discarded before it reached the log. error_class alone answers "did
    # it fail", error_detail is what makes a repeat diagnosable without
    # reproducing it live again.
    import io
    import json

    import ollaya_gate.cli as cli_mod
    from ollaya_gate.cli import main

    def bad(state, questions, model):
        raise RuntimeError("Connection reset by peer while calling the model")

    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(log))
    monkeypatch.setattr(cli_mod.client_mod, "evaluate", bad)
    event = {"objective": "o", "halt": {"kind": "read", "tool": "read", "detail": "Read f"},
             "context": {}, "policy": {}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))
    monkeypatch.setattr("sys.stdout", io.StringIO())
    main()
    row = json.loads(log.read_text().strip())
    assert row["error_class"] == "exception"
    assert row["error_detail"] == "Connection reset by peer while calling the model"


def test_error_detail_is_redacted_and_capped(tmp_path, monkeypatch):
    import io
    import json

    import ollaya_gate.cli as cli_mod
    from ollaya_gate.cli import main

    def bad(state, questions, model):
        raise RuntimeError("token=s3cr3tvalue1234 " + "x" * 300)

    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(log))
    monkeypatch.setattr(cli_mod.client_mod, "evaluate", bad)
    event = {"objective": "o", "halt": {"kind": "read", "tool": "read", "detail": "Read f"},
             "context": {}, "policy": {}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))
    monkeypatch.setattr("sys.stdout", io.StringIO())
    main()
    row = json.loads(log.read_text().strip())
    assert "s3cr3tvalue1234" not in row["error_detail"]
    assert "[REDACTED]" in row["error_detail"]
    assert len(row["error_detail"]) <= 200


def test_cli_log_schema_v2(tmp_path, monkeypatch):
    import json

    import ollaya_gate.cli as cli_mod
    from ollaya_gate.cli import decide_event, main

    def fake(state, questions):
        return {"decision": {"choice": "allow", "confidence": 0.9},
                "safe": {"noul": 0.9}, "risk": {"score": 0.1, "confidence": 0.8},
                "model": "m", "usage": {"input_tokens": 42}}

    event = {"objective": "o", "halt": {"kind": "read", "tool": "read", "detail": "Read f"},
             "context": {"sessionID": "s1", "requestID": "r1"}, "policy": {}}
    out = decide_event(event, fake)
    assert out["usage"] == {"input_tokens": 42}

    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(log))
    monkeypatch.setattr(cli_mod.client_mod, "evaluate",
                        lambda state, questions, model: fake(state, questions))
    import io
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(event)))
    monkeypatch.setattr("sys.stdout", io.StringIO())
    main()
    row = json.loads(log.read_text().strip())
    assert row["v"] == 2
    assert row["sessionID"] == "s1" and row["requestID"] == "r1"
    assert row["gateAction"] == "allow" and row["usage"] == {"input_tokens": 42}
    assert "detail_sha256" in row and len(row["detail_sha256"]) == 64
