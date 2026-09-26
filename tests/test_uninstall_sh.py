import subprocess
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_UNINSTALL = _REPO_ROOT / "scripts" / "uninstall.sh"


def test_uninstall_sh_gives_a_clear_error_on_a_jsonc_file_with_comments(tmp_path):
    # Round 13 review: json.load is strict JSON, but opencode.jsonc's own
    # extension invites comments/trailing commas. Before the fix this
    # crashed with a raw Python traceback (set -euo pipefail then aborted
    # the whole script, including the log-purge/pip-uninstall steps after
    # it) instead of a clear, actionable message — and left the user
    # unsure whether the plugin was actually removed.
    original = '{\n  // a comment\n  "permission": "ask",\n  "plugins": []\n}\n'
    cfg = tmp_path / "opencode.jsonc"
    cfg.write_text(original)

    result = subprocess.run(
        ["bash", str(_UNINSTALL), "--project"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=15,
    )

    assert result.returncode != 0
    assert "not valid JSON" in result.stderr
    assert "by hand" in result.stderr
    # Backup was made before the crash and is untouched; the original file
    # itself was never overwritten with anything broken.
    assert (tmp_path / "opencode.jsonc.bak").read_text() == original
    assert cfg.read_text() == original
