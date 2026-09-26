import json

from ollaya_gate import doctor


def test_log_path_follows_env(tmp_path, monkeypatch):
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(tmp_path / "env.jsonl"))
    assert doctor.plugin_log_path() == str(tmp_path / "env.jsonl")


def test_log_path_follows_opencode_config(tmp_path, monkeypatch):
    cfg = tmp_path / "opencode.json"
    cfg.write_text(json.dumps({"plugins": [{"package": "/x/ollaya-decision-gate", "options": {"logFile": str(tmp_path / "cfg.jsonl")}}]}))
    monkeypatch.delenv("OLLAYA_GATE_LOG", raising=False)
    monkeypatch.setenv("OPENCODE_CONFIG_FILE", str(cfg))
    assert doctor.plugin_log_path() == str(tmp_path / "cfg.jsonl")


def test_log_path_defaults_to_repo_file(tmp_path, monkeypatch):
    monkeypatch.delenv("OLLAYA_GATE_LOG", raising=False)
    monkeypatch.setenv("OPENCODE_CONFIG_FILE", str(tmp_path / "missing.json"))
    assert doctor.plugin_log_path().endswith("decisions-plugin.jsonl")
    assert doctor.plugin_log_path() != "decisions-plugin.jsonl"


def test_writable_check_never_creates_the_file(tmp_path):
    target = tmp_path / "new.jsonl"
    assert doctor._writable(str(target)) is True
    assert not target.exists()
    assert doctor._writable(str(tmp_path / "no-such-dir" / "x.jsonl")) is False


def test_doctor_run_creates_no_log_in_cwd(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OLLAYA_GATE_LOG", str(tmp_path / "configured.jsonl"))
    try:
        doctor.main()
    except SystemExit:
        pass
    assert not (tmp_path / "decisions-plugin.jsonl").exists()
    assert not (tmp_path / "configured.jsonl").exists()
    assert f"log writable ({tmp_path / 'configured.jsonl'})" in capsys.readouterr().out


def test_ollaya_checks_fail_when_daemon_is_down(monkeypatch, capsys):
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setenv("OLLAYA_HOST", f"127.0.0.1:{port}")
    assert doctor.ollaya_checks() is False
    assert "FAIL  ollaya daemon" in capsys.readouterr().out


def test_ollaya_checks_need_the_model_pulled(monkeypatch, capsys):
    def fake_get(url, timeout=3):
        if url.endswith("/api/version"):
            return {"version": "0.7.1"}
        return {"models": [{"name": "laya:latest"}, {"name": "winnow:e4b"}]}

    monkeypatch.setattr(doctor, "_get_json", fake_get)
    monkeypatch.setenv("OLLAYA_GATE_MODEL", "winnow:e4b")
    assert doctor.ollaya_checks() is True
    monkeypatch.setenv("OLLAYA_GATE_MODEL", "laya")
    assert doctor.ollaya_checks() is True
    monkeypatch.setenv("OLLAYA_GATE_MODEL", "kev:4b")
    assert doctor.ollaya_checks() is False
    assert "ollaya pull kev:4b" in capsys.readouterr().out
