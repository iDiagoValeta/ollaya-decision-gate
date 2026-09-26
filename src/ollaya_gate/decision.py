# src/ollaya_gate/decision.py
"""Jev decides, no thresholds.

The winning action is whatever Jev's `decision` answer says, whatever
its confidence. allow executes, deny blocks, ask-human falls back to
the manual prompt. The safe/risk answers are asked for as
context, not used as vetoes.

Two invariants stay (they are not thresholds):
- Unknown decision strings degrade to ask-human (invalid output must
  never execute).
- Errors anywhere degrade to ask-human/fail-open (see cli.py).
- Catastrophic shell patterns never reach Jev (see plugin).
"""


def combine(decision_choice, decision_confidence, safe_noul, risk_score, halt_kind):
    _ = (decision_confidence, safe_noul, risk_score, halt_kind)
    if decision_choice == "allow":
        return {"action": "allow", "reason": "model-allow"}
    if decision_choice == "deny":
        return {"action": "deny", "reason": "model-deny"}
    if decision_choice == "ask-human":
        return {"action": "ask-human", "reason": "model-asked-human"}
    return {"action": "ask-human", "reason": "unknown-choice"}
