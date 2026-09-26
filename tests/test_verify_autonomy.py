import importlib.util
import json
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "verify_autonomy.py"


def _load():
    spec = importlib.util.spec_from_file_location("verify_autonomy", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_log_follows_env(tmp_path, monkeypatch):
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(tmp_path / "env.jsonl"))
    assert _load().resolve_log() == tmp_path / "env.jsonl"


def test_log_follows_opencode_config(tmp_path, monkeypatch):
    cfg = tmp_path / "opencode.json"
    cfg.write_text(json.dumps({"plugins": [{"package": "/x/ollaya-decision-gate", "options": {"logFile": str(tmp_path / "cfg.jsonl")}}]}))
    monkeypatch.delenv("OLLAYA_GATE_LOG", raising=False)
    monkeypatch.setenv("OPENCODE_CONFIG_FILE", str(cfg))
    assert _load().resolve_log() == tmp_path / "cfg.jsonl"


def test_log_defaults_to_plugin_default(tmp_path, monkeypatch):
    monkeypatch.delenv("OLLAYA_GATE_LOG", raising=False)
    monkeypatch.setenv("OPENCODE_CONFIG_FILE", str(tmp_path / "missing.json"))
    assert _load().resolve_log() == _SCRIPT.parent.parent / "decisions-plugin.jsonl"
