import importlib.util
import json
import sys
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "measure.py"


def _load_measure():
    spec = importlib.util.spec_from_file_location("measure", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_config_logfile_is_used(tmp_path, monkeypatch, capsys):
    custom = tmp_path / "custom.jsonl"
    custom.write_text(json.dumps({"gateAction": "allow", "reason": "model-allow"}) + "\n")
    cfg = tmp_path / "opencode.json"
    cfg.write_text(
        json.dumps(
            {"plugins": [{"package": "ollaya-decision-gate", "options": {"logFile": str(custom)}}]}
        )
    )
    monkeypatch.setenv("OPENCODE_CONFIG_FILE", str(cfg))
    monkeypatch.delenv("OLLAYA_GATE_LOG", raising=False)
    # avoid fallback providing extra rows; ensure cwd fallbacks absent or empty
    monkeypatch.chdir(tmp_path)
    # ensure fallback file does not exist with competing data
    fallback = tmp_path / "decisions.jsonl"
    if fallback.exists():
        fallback.unlink()
    monkeypatch.setattr(sys, "argv", ["measure.py"])
    _load_measure().main()
    out = capsys.readouterr().out
    assert f"log={custom}" in out
    assert "total=1" in out


def test_config_absent_falls_back_to_cwd(tmp_path, monkeypatch, capsys):
    missing_cfg = tmp_path / "nope.json"
    monkeypatch.setenv("OPENCODE_CONFIG_FILE", str(missing_cfg))
    monkeypatch.delenv("OLLAYA_GATE_LOG", raising=False)
    fallback = tmp_path / "decisions-plugin.jsonl"
    fallback.write_text(json.dumps({"gateAction": "allow", "reason": "model-allow"}) + "\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["measure.py"])
    _load_measure().main()
    out = capsys.readouterr().out
    # resolved should be the fallback (relative path)
    assert "log=" in out
    assert "decisions-plugin.jsonl" in out
    assert "total=1" in out


def test_config_invalid_json_falls_back(tmp_path, monkeypatch, capsys):
    bad_cfg = tmp_path / "bad.json"
    bad_cfg.write_text("{ not valid json")
    monkeypatch.setenv("OPENCODE_CONFIG_FILE", str(bad_cfg))
    monkeypatch.delenv("OLLAYA_GATE_LOG", raising=False)
    fallback = tmp_path / "decisions-plugin.jsonl"
    fallback.write_text(json.dumps({"gateAction": "allow"}) + "\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["measure.py"])
    _load_measure().main()
    out = capsys.readouterr().out
    assert "log=" in out
    assert "total=1" in out


def test_log_line_appears_with_explicit_log(tmp_path, monkeypatch, capsys):
    lg = tmp_path / "explicit.jsonl"
    lg.write_text(json.dumps({"gateAction": "allow"}) + "\n")
    monkeypatch.setattr(sys, "argv", ["measure.py", "--log", str(lg)])
    _load_measure().main()
    out = capsys.readouterr().out
    assert f"log={lg}" in out


def test_env_overrides_config(tmp_path, monkeypatch, capsys):
    custom = tmp_path / "custom2.jsonl"
    custom.write_text(json.dumps({"gateAction": "deny"}) + "\n")
    cfg = tmp_path / "opencode2.json"
    cfg.write_text(
        json.dumps(
            {"plugins": [{"package": "ollaya-decision-gate", "options": {"logFile": str(custom)}}]}
        )
    )
    env_log = tmp_path / "env.jsonl"
    env_log.write_text(json.dumps({"gateAction": "allow"}) + "\n")
    monkeypatch.setenv("OPENCODE_CONFIG_FILE", str(cfg))
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(env_log))
    monkeypatch.setattr(sys, "argv", ["measure.py"])
    _load_measure().main()
    out = capsys.readouterr().out
    assert f"log={env_log}" in out
    assert "total=1" in out
    # should reflect env file's allow, not custom's deny
    assert "allow" in out


def test_json_mode_output_is_pure_json_with_log_field(tmp_path, monkeypatch, capsys):
    lg = tmp_path / "explicit.jsonl"
    lg.write_text(json.dumps({"gateAction": "allow"}) + "\n")
    monkeypatch.setattr(sys, "argv", ["measure.py", "--log", str(lg), "--json"])
    _load_measure().main()
    parsed = json.loads(capsys.readouterr().out)
    assert parsed["log"] == str(lg)


def test_configured_log_ignores_stray_cwd_logs(tmp_path, monkeypatch, capsys):
    custom = tmp_path / "custom3.jsonl"
    custom.write_text(json.dumps({"gateAction": "allow"}) + "\n")
    cfg = tmp_path / "opencode3.json"
    cfg.write_text(
        json.dumps(
            {"plugins": [{"package": "ollaya-decision-gate", "options": {"logFile": str(custom)}}]}
        )
    )
    stray = tmp_path / "decisions-plugin.jsonl"
    stray.write_text("".join(json.dumps({"gateAction": "deny"}) + "\n" for _ in range(3)))
    monkeypatch.setenv("OPENCODE_CONFIG_FILE", str(cfg))
    monkeypatch.delenv("OLLAYA_GATE_LOG", raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["measure.py"])
    _load_measure().main()
    out = capsys.readouterr().out
    assert "total=1" in out
    assert "deny" not in out
