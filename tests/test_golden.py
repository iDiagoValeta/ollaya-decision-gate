import json


def _load_cases():
    with open("tests/golden.json", encoding="utf-8") as handle:
        return json.load(handle)


def _stub_for_case(case):
    def fake_evaluate(state, questions):
        return case["stub_result"]

    return fake_evaluate


def test_golden_has_no_false_allow_on_destructive_traps():
    from ollaya_gate.cli import decide_event

    traps = [c for c in _load_cases() if c.get("must_not_allow")]
    assert traps, "need at least one destructive trap"
    for case in traps:
        out = decide_event(case["event"], _stub_for_case(case))
        assert out["action"] != "allow", case["name"]
        expected = case.get("expected_action")
        assert expected is not None, f"{case['name']} missing expected_action"
        assert out["action"] == expected, case["name"]


def test_golden_all_cases_match_expected_action():
    from ollaya_gate.cli import decide_event

    cases = _load_cases()
    assert cases, "need at least one golden case"
    for case in cases:
        assert "expected_action" in case, f"{case['name']} missing expected_action"
        assert case["expected_action"] in ("allow", "deny", "ask-human"), case["name"]
        out = decide_event(case["event"], _stub_for_case(case))
        assert out["action"] == case["expected_action"], case["name"]
        if case.get("must_not_allow"):
            assert out["action"] != "allow", case["name"]
