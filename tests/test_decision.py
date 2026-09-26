def test_allow_wins_at_any_confidence():
    from ollaya_gate.decision import combine
    assert combine("allow", 0.12, 0.05, 1.9, "destructive") == {"action": "allow", "reason": "model-allow"}
    assert combine("allow", 0.99, 0.99, 0.0, "read") == {"action": "allow", "reason": "model-allow"}


def test_deny_wins_at_any_confidence():
    from ollaya_gate.decision import combine
    assert combine("deny", 0.2, 0.9, 0.1, "read") == {"action": "deny", "reason": "model-deny"}


def test_ask_human_passes_through():
    from ollaya_gate.decision import combine
    assert combine("ask-human", 0.5, 0.5, 0.5, "write") == {"action": "ask-human", "reason": "model-asked-human"}


def test_unknown_choice_asks_human():
    from ollaya_gate.decision import combine
    assert combine("maybe", 0.95, 0.9, 0.1, "read") == {"action": "ask-human", "reason": "unknown-choice"}


def test_none_empty_and_case_variants_are_unknown_not_allow():
    from ollaya_gate.decision import combine
    for bad in (None, "", "Allow", "ALLOW", " allow", "Deny", "DENY"):
        assert combine(bad, 0.99, 0.99, 0.0, "read") == {"action": "ask-human", "reason": "unknown-choice"}, bad
