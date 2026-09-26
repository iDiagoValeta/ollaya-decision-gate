import json

def test_decide_event_allows_with_fake_evaluate():
    from ollaya_gate.cli import decide_event

    def fake_evaluate(state, questions):
        return {
            "decision": {"choice": "allow", "confidence": 0.92},
            "safe": {"noul": 0.95},
            "risk": {"score": 0.1, "confidence": 0.8},
            "model": "jev-1.13.0",
        }

    event = {
        "objective": "Fix login bug",
        "halt": {"kind": "read", "tool": "read", "detail": "Read src/app.py"},
        "context": {},
        "policy": {},
    }
    out = decide_event(event, fake_evaluate)
    assert out["action"] == "allow"
    assert out["model"] == "jev-1.13.0"


def test_decide_event_fail_open_on_error():
    from ollaya_gate.cli import decide_event

    def bad_evaluate(state, questions):
        raise RuntimeError("down")

    event = {
        "objective": "Fix login bug",
        "halt": {"kind": "destructive", "tool": "bash", "detail": "rm -rf /tmp/x"},
        "context": {},
        "policy": {},
    }
    out = decide_event(event, bad_evaluate)
    assert out == {
        "action": "ask-human",
        "reason": "fail-open",
        "pick": None,
        "confidence": 0.0,
        "model": None,
        "error": "exception",
        "error_detail": "down",
    }


def test_decide_event_uses_model_pick_on_allow():
    from ollaya_gate.cli import decide_event

    def fake_evaluate(state, questions):
        return {
            "decision": {"choice": "allow", "confidence": 0.92},
            "safe": {"noul": 0.95},
            "risk": {"score": 0.1, "confidence": 0.8},
            "pick": {"choice": "b"},
            "model": "jev-1.13.0",
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


def test_decide_event_fail_open_when_pick_missing():
    from ollaya_gate.cli import decide_event

    def fake_evaluate(state, questions):
        return {
            "decision": {"choice": "allow", "confidence": 0.92},
            "safe": {"noul": 0.95},
            "risk": {"score": 0.1, "confidence": 0.8},
            "model": "jev-1.13.0",
        }

    event = {
        "objective": "Pick lib",
        "halt": {"kind": "multichoice", "tool": "ask", "detail": "Which lib?", "options": ["a", "b"]},
        "context": {},
        "policy": {},
    }
    out = decide_event(event, fake_evaluate)
    assert out["action"] == "ask-human"
    assert out["pick"] is None


def test_decide_event_fail_open_when_pick_invalid():
    from ollaya_gate.cli import decide_event

    def fake_evaluate(state, questions):
        return {
            "decision": {"choice": "allow", "confidence": 0.92},
            "safe": {"noul": 0.95},
            "risk": {"score": 0.1, "confidence": 0.8},
            "pick": {"choice": "zzz"},
            "model": "jev-1.13.0",
        }

    event = {
        "objective": "Pick lib",
        "halt": {"kind": "multichoice", "tool": "ask", "detail": "Which lib?", "options": ["a", "b"]},
        "context": {},
        "policy": {},
    }
    error_box = {}
    out = decide_event(event, fake_evaluate, error_box)
    assert out["action"] == "ask-human"
    assert out["pick"] is None
    assert error_box["error_class"] == "bad-response"


def test_decide_event_pick_ignored_on_deny_even_with_options():
    from ollaya_gate.cli import decide_event

    def fake_evaluate(state, questions):
        return {
            "decision": {"choice": "deny", "confidence": 0.92},
            "safe": {"noul": 0.1},
            "risk": {"score": 0.9, "confidence": 0.8},
            "pick": {"choice": "b"},
            "model": "jev-1.13.0",
        }

    event = {
        "objective": "Pick lib",
        "halt": {"kind": "multichoice", "tool": "ask", "detail": "Which lib?", "options": ["a", "b"]},
        "context": {},
        "policy": {},
    }
    out = decide_event(event, fake_evaluate)
    assert out["action"] == "deny"
    assert out["pick"] is None


def test_decide_event_non_dict_pick_fails_open_not_crashes():
    from ollaya_gate.cli import decide_event

    def fake_evaluate(state, questions):
        return {
            "decision": {"choice": "allow", "confidence": 0.92},
            "safe": {"noul": 0.95},
            "risk": {"score": 0.1, "confidence": 0.8},
            "pick": "not-a-dict",
            "model": "jev-1.13.0",
        }

    event = {
        "objective": "Pick lib",
        "halt": {"kind": "multichoice", "tool": "ask", "detail": "Which lib?", "options": ["a", "b"]},
        "context": {},
        "policy": {},
    }
    out = decide_event(event, fake_evaluate)
    assert out["action"] == "ask-human"
    assert out["pick"] is None


def test_decide_event_missing_objective_or_halt_fails_open():
    from ollaya_gate.cli import decide_event

    error_box = {}
    out = decide_event({}, lambda state, questions: {}, error_box)
    assert out["action"] == "ask-human" and out["reason"] == "fail-open"
    assert error_box["error_class"] == "exception"

    error_box2 = {}
    out2 = decide_event({"objective": "o", "halt": None}, lambda state, questions: {}, error_box2)
    assert out2["action"] == "ask-human" and out2["reason"] == "fail-open"
    assert error_box2["error_class"] == "exception"


def test_decide_event_classifies_bad_response_from_client_error():
    from ollaya_gate.cli import decide_event
    from ollaya_gate.client import GateCallError

    def bad_evaluate(state, questions):
        raise GateCallError("bad-response: 'decision'")

    event = {"objective": "o", "halt": {"kind": "read"}, "context": {}, "policy": {}}
    error_box = {}
    out = decide_event(event, bad_evaluate, error_box)
    assert out["action"] == "ask-human" and out["reason"] == "fail-open"
    assert error_box["error_class"] == "bad-response"


def test_classify_error_maps_known_prefixes():
    from ollaya_gate.cli import _classify_error
    from ollaya_gate.client import GateCallError

    assert _classify_error(GateCallError("bad-response: 'decision'")) == "bad-response"
    assert _classify_error(GateCallError("state-truncated")) == "state-truncated"
    assert _classify_error(GateCallError("ollaya-unreachable: [Errno 111] Connection refused")) == "transport"
    assert _classify_error(GateCallError("http-404 MODEL_NOT_FOUND: model not found")) == "transport"
    assert _classify_error(GateCallError("connection reset")) == "transport"
    assert _classify_error(RuntimeError("boom")) == "exception"
    assert _classify_error(None) == "exception"


def _allow_result():
    return {
        "decision": {"choice": "allow", "confidence": 0.92},
        "safe": {"noul": 0.95},
        "risk": {"score": 0.1, "confidence": 0.8},
        "model": "jev-1.13.0",
    }


def test_decide_event_retries_smaller_brief_on_truncated_state():
    from ollaya_gate.cli import decide_event
    from ollaya_gate.schemas import STATE_BUDGETS

    sizes = []

    def evaluate(state, questions):
        sizes.append(len(json.dumps(state)))
        if len(sizes) == 1:
            raise RuntimeError("state-truncated")
        return _allow_result()

    event = {"objective": "o" * (2 * STATE_BUDGETS[0]), "halt": {"kind": "read", "detail": "ls"}}
    out = decide_event(event, evaluate)
    assert out["action"] == "allow"
    assert len(sizes) == 2 and sizes[1] < sizes[0]


def test_decide_event_other_errors_are_not_retried():
    from ollaya_gate.cli import decide_event

    calls = []

    def evaluate(state, questions):
        calls.append(1)
        raise RuntimeError("503 upstream")

    out = decide_event({"objective": "o", "halt": {"kind": "read", "detail": "ls"}}, evaluate)
    assert out["action"] == "ask-human" and out["reason"] == "fail-open"
    assert len(calls) == 1


def test_decide_event_fails_open_when_every_budget_overflows():
    from ollaya_gate.cli import decide_event
    from ollaya_gate.schemas import STATE_BUDGETS

    calls = []

    def evaluate(state, questions):
        calls.append(1)
        raise RuntimeError("state-truncated")

    out = decide_event({"objective": "o", "halt": {"kind": "read", "detail": "ls"}}, evaluate)
    assert out["action"] == "ask-human" and out["reason"] == "fail-open"
    assert len(calls) == len(STATE_BUDGETS)
