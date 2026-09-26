"""Local Ollaya client (stdlib only) with error mapping.

Talks to the Ollaya daemon's native `POST /api/decide`, not the
TypeSafe-compatible `/v1/systemone`: on Ollaya 0.7.1 the `/v1` route
silently answers on a truncated state for llama.cpp models such as
winnow (the contract says 422 STATE_TRUNCATED). With the state's head
kept and the halt cut off, the model judges an action it never saw, and
in our measurement it then allowed every destructive trap. `/api/decide`
reports `state_truncated`, which is turned into an error here so the
caller retries with a smaller state or fails open to ask-human.
"""

import json
import math
import os
import urllib.error
import urllib.request

DEFAULT_MODEL = "winnow:e4b"
DEFAULT_HOST = "127.0.0.1:11435"
# The plugin kills the gate subprocess at its own timeout (25 s by
# default); this keeps a hung daemon from outliving that budget.
HTTP_TIMEOUT_S = 20


class GateCallError(Exception):
    pass


def _finite_float(x):
    """float(x), but reject NaN/Infinity too.

    Python's float()/json.loads() accept a non-finite confidence, and
    json.dumps(float("nan")) emits a bare `NaN` token, which is invalid
    JSON (RFC 8259) and breaks the TS side's JSON.parse of the gate's
    stdout. Failing here keeps it a clean bad-response/ask-human.
    """
    v = float(x)
    if not math.isfinite(v):
        raise ValueError(f"non-finite value: {v!r}")
    return v


def base_url(env=None):
    """Ollaya's own OLLAYA_HOST convention: `http://` assumed; a missing
    port means 11435 for http and 443 for https; a path is kept."""
    env = os.environ if env is None else env
    host = (env.get("OLLAYA_HOST") or DEFAULT_HOST).strip().rstrip("/")
    if "://" not in host:
        host = "http://" + host
    scheme, rest = host.split("://", 1)
    hostport, _, path = rest.partition("/")
    if ":" not in hostport.rsplit("]", 1)[-1]:
        hostport += ":443" if scheme == "https" else ":11435"
    return f"{scheme}://{hostport}" + (f"/{path}" if path else "")


def _real_transport(state, questions, model):
    body = {"model": model, "state": state, "questions": questions}
    keep_alive = os.environ.get("OLLAYA_GATE_KEEP_ALIVE")
    if keep_alive:
        body["keep_alive"] = keep_alive
    headers = {"Content-Type": "application/json"}
    if os.environ.get("OLLAYA_API_KEY"):
        headers["Authorization"] = f"Bearer {os.environ['OLLAYA_API_KEY']}"
    req = urllib.request.Request(
        base_url() + "/api/decide", json.dumps(body).encode("utf-8"), headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:  # nosec B310
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        try:
            err = json.loads(exc.read())
            detail = f"{err.get('code', '')}: {err.get('error', '')}"
        except Exception:
            detail = ""
        raise GateCallError(f"http-{exc.code} {detail}".strip()) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise GateCallError(f"ollaya-unreachable: {exc}") from exc
    if data.get("state_truncated"):
        raise GateCallError("state-truncated")
    out = {"model": data.get("model", model), "answers": data.get("answers")}
    usage = data.get("usage")
    if isinstance(usage, dict) and usage.get("input_tokens") is not None:
        try:
            out["usage"] = {"input_tokens": int(usage["input_tokens"])}
        except Exception:
            pass
    return out


def evaluate(state, questions, model=DEFAULT_MODEL, transport=None):
    raw = None
    if transport is not None:
        try:
            raw = transport(state, questions, model)
        except Exception as exc:
            raise GateCallError(str(exc)) from exc
    else:
        raw = _real_transport(state, questions, model)
    try:
        answers = raw["answers"]
        out = {
            "decision": {
                "choice": answers["decision"]["choice"],
                "confidence": _finite_float(answers["decision"]["confidence"]),
            },
            "safe": {"noul": _finite_float(answers["safe"]["noul"])},
            "risk": {
                "score": _finite_float(answers["risk"]["score"]),
                "confidence": _finite_float(answers["risk"]["confidence"]),
            },
            "model": raw.get("model", model),
        }
        if "pick" in answers:
            out["pick"] = {"choice": answers["pick"]["choice"]}
        if "usage" in raw:
            out["usage"] = raw["usage"]
        return out
    except Exception as exc:
        raise GateCallError(f"bad-response: {exc}") from exc
