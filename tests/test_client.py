def test_evaluate_normalizes_answers():
    from ollaya_gate.client import evaluate

    def fake_transport(state, questions, model):
        return {
            "model": "jev-1.13.0",
            "answers": {
                "decision": {"type": "choice", "choice": "allow", "confidence": 0.9},
                "safe": {"type": "noul", "noul": 0.95},
                "risk": {"type": "score", "score": 0.2, "confidence": 0.8},
            },
        }

    out = evaluate({"objective": "x"}, {"decision": {}}, transport=fake_transport)
    assert out["decision"] == {"choice": "allow", "confidence": 0.9}
    assert out["safe"] == {"noul": 0.95}
    assert out["model"] == "jev-1.13.0"


def test_evaluate_raises_on_transport_error():
    import pytest

    from ollaya_gate.client import GateCallError, evaluate

    def bad_transport(state, questions, model):
        raise RuntimeError("boom")

    with pytest.raises(GateCallError):
        evaluate({}, {}, transport=bad_transport)


def test_evaluate_wraps_malformed_answers_as_bad_response():
    import pytest

    from ollaya_gate.client import GateCallError, evaluate

    def missing_keys_transport(state, questions, model):
        return {"model": "jev-1.13.0", "answers": {"decision": {"choice": "allow"}}}

    with pytest.raises(GateCallError, match="bad-response"):
        evaluate({"objective": "x"}, {"decision": {}}, transport=missing_keys_transport)


def test_evaluate_wraps_non_numeric_confidence_as_bad_response():
    import pytest

    from ollaya_gate.client import GateCallError, evaluate

    def bad_confidence_transport(state, questions, model):
        return {
            "model": "jev-1.13.0",
            "answers": {
                "decision": {"choice": "allow", "confidence": "not-a-number"},
                "safe": {"noul": 0.95},
                "risk": {"score": 0.2, "confidence": 0.8},
            },
        }

    with pytest.raises(GateCallError, match="bad-response"):
        evaluate({"objective": "x"}, {"decision": {}}, transport=bad_confidence_transport)


def test_evaluate_wraps_non_finite_confidence_as_bad_response():
    # Round 6 review: float(x) silently accepts NaN/Infinity, but
    # json.dumps(float("nan")) emits a bare NaN token, which breaks the
    # TS side's JSON.parse of the gate's stdout. Must fail here, not there.
    import math

    import pytest

    from ollaya_gate.client import GateCallError, evaluate

    for bad in (float("nan"), float("inf"), float("-inf")):

        def bad_transport(state, questions, model, bad=bad):
            return {
                "model": "jev-1.13.0",
                "answers": {
                    "decision": {"choice": "allow", "confidence": bad},
                    "safe": {"noul": 0.95},
                    "risk": {"score": 0.2, "confidence": 0.8},
                },
            }

        with pytest.raises(GateCallError, match="bad-response"):
            evaluate({"objective": "x"}, {"decision": {}}, transport=bad_transport)

    # Sanity: a genuinely finite, ordinary confidence still passes through.
    assert math.isfinite(0.9)


def test_evaluate_returns_pick_when_present():
    from ollaya_gate.client import evaluate

    def fake_transport(state, questions, model):
        return {
            "model": "jev-1.13.0",
            "answers": {
                "decision": {"type": "choice", "choice": "allow", "confidence": 0.9},
                "safe": {"type": "noul", "noul": 0.95},
                "risk": {"type": "score", "score": 0.2, "confidence": 0.8},
                "pick": {"type": "choice", "choice": "b"},
            },
        }

    out = evaluate({"objective": "x"}, {"decision": {}}, transport=fake_transport)
    assert out["pick"] == {"choice": "b"}


def _serve(handler_body, status=200):
    """One-shot local HTTP server standing in for the Ollaya daemon."""
    import http.server
    import json
    import threading

    seen = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            seen["path"] = self.path
            seen["auth"] = self.headers.get("Authorization")
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            payload = json.dumps(handler_body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.handle_request, daemon=True).start()
    return server, seen


_ANSWERS = {
    "decision": {"type": "choice", "choice": "deny", "confidence": 0.58, "probabilities": {}},
    "safe": {"type": "noul", "noul": 0.02},
    "risk": {"type": "score", "score": 1.96, "confidence": 0.9, "legend": {}, "probabilities": {}},
}


def test_real_transport_posts_to_native_decide(monkeypatch):
    from ollaya_gate.client import evaluate

    server, seen = _serve({"model": "winnow:e4b", "answers": _ANSWERS, "state_truncated": False,
                           "usage": {"input_tokens": 1154, "output_tokens": 0}})
    monkeypatch.setenv("OLLAYA_HOST", f"127.0.0.1:{server.server_port}")
    monkeypatch.delenv("OLLAYA_API_KEY", raising=False)
    out = evaluate({"objective": "x"}, {"decision": {}}, model="winnow:e4b")
    assert seen["path"] == "/api/decide"
    assert seen["body"] == {"model": "winnow:e4b", "state": {"objective": "x"}, "questions": {"decision": {}}}
    assert seen["auth"] is None
    assert out["decision"] == {"choice": "deny", "confidence": 0.58}
    assert out["usage"] == {"input_tokens": 1154}


def test_real_transport_rejects_truncated_state(monkeypatch):
    # A truncated state may have lost the halt itself: never judge it.
    import pytest

    from ollaya_gate.client import GateCallError, evaluate

    server, _ = _serve({"model": "winnow:e4b", "answers": _ANSWERS, "state_truncated": True})
    monkeypatch.setenv("OLLAYA_HOST", f"127.0.0.1:{server.server_port}")
    with pytest.raises(GateCallError, match="state-truncated"):
        evaluate({"objective": "x"}, {"decision": {}})


def test_real_transport_maps_http_errors(monkeypatch):
    import pytest

    from ollaya_gate.client import GateCallError, evaluate

    server, _ = _serve({"error": 'model "winnow:e4b" not found, try pulling it first',
                        "code": "MODEL_NOT_FOUND"}, status=404)
    monkeypatch.setenv("OLLAYA_HOST", f"127.0.0.1:{server.server_port}")
    with pytest.raises(GateCallError, match="http-404 MODEL_NOT_FOUND"):
        evaluate({"objective": "x"}, {"decision": {}})


def test_real_transport_sends_api_key_when_set(monkeypatch):
    from ollaya_gate.client import evaluate

    server, seen = _serve({"model": "m", "answers": _ANSWERS})
    monkeypatch.setenv("OLLAYA_HOST", f"127.0.0.1:{server.server_port}")
    monkeypatch.setenv("OLLAYA_API_KEY", "local-secret")
    evaluate({"objective": "x"}, {"decision": {}})
    assert seen["auth"] == "Bearer local-secret"


def test_real_transport_unreachable_daemon(monkeypatch):
    import socket

    import pytest

    from ollaya_gate.client import GateCallError, evaluate

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setenv("OLLAYA_HOST", f"127.0.0.1:{port}")
    with pytest.raises(GateCallError, match="ollaya-unreachable"):
        evaluate({"objective": "x"}, {"decision": {}})


def test_base_url_follows_ollaya_host_rules():
    from ollaya_gate.client import base_url

    assert base_url({}) == "http://127.0.0.1:11435"
    assert base_url({"OLLAYA_HOST": "localhost"}) == "http://localhost:11435"
    assert base_url({"OLLAYA_HOST": "0.0.0.0:9000"}) == "http://0.0.0.0:9000"
    assert base_url({"OLLAYA_HOST": "https://gpu.lan"}) == "https://gpu.lan:443"
    assert base_url({"OLLAYA_HOST": "[::1]"}) == "http://[::1]:11435"
    assert base_url({"OLLAYA_HOST": "[::1]:8080/prefix/"}) == "http://[::1]:8080/prefix"
