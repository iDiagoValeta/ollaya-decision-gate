# ollaya-decision-gate plugin (OpenCode v2)

Lets a local decision model (served by Ollaya on this machine, default
`winnow:e4b`) answer permission prompts automatically. Allow goes
through, deny blocks, anything uncertain falls back to your manual
prompt. Agent questions are auto-answered too: the question tool's
permission is passed through instantly (no model call), and the
question tool itself is wrapped so the model answers each field
in-process. When that can't answer, OpenCode opens a **form**
(`metadata.kind=question`) that the plugin polls for (`GET /api/form`)
and answers via `POST /api/session/{sessionID}/form/{formID}/reply`.
If the model is unsure or the reply fails, it stays pending for you to
answer in the TUI; see the repo's `docs/ARCHITECTURE.md` and
`docs/TROUBLESHOOTING.md` for the full flow and its known limits.

Requires OpenCode on the `@opencode/plugin` line (`permission.asked`
events; the more common `@opencode-ai/plugin` line does not fire it,
see the repo's `docs/TROUBLESHOOTING.md`), `"permission": "ask"` in
your config, Python 3.10+ with the repo installed (`pip install -e .`,
standard library only), and the Ollaya daemon running with the model
pulled (`ollaya serve`, `ollaya pull winnow:e4b`).

Fastest path: `./scripts/install.sh --project|--global` from the repo
root; it ends by running `python3 -m ollaya_gate.doctor`.

Install in a project:

```jsonc
// opencode.jsonc
{
  "permission": "ask",
  "plugins": [
    {
      "package": "/absolute/path/to/ollaya-decision-gate/plugin/ollaya-decision-gate",
      "options": {
        "logFile": "/absolute/path/to/decisions-plugin.jsonl",
      },
    },
  ],
}
```

For every session, install once globally instead: put the same
`plugins` entry in your global config and every project inherits it.

Options (all optional):

| Option        | Env fallback          | Default                                    |
| ------------- | --------------------- | ------------------------------------------ |
| `logFile`     | `OLLAYA_GATE_LOG`        | `<repo>/decisions-plugin.jsonl`            |
| `gateDir`     | `OLLAYA_GATE_DIR`        | repo root (where `src/ollaya_gate` lives)     |
| `enabled`     | `OLLAYA_GATE_ENABLED`    | `true` (`false`, `0`, `off`, `no` disable) |
| `timeoutMs`   | `OLLAYA_GATE_TIMEOUT_MS` | `25000` (clamped to 1000 to 30000)         |
| `objectiveChars` | `OLLAYA_GATE_OBJECTIVE_CHARS` | `22000` (clamped to 200 to 90000), how much recent conversation (both roles) the model sees |
| `pythonBin`   | `OLLAYA_GATE_PYTHON`     | auto-detected: newest mise-managed Python under `~/.local/share/mise/installs/python/`, else `python3` |

Env only, passed through to the gate: `OLLAYA_HOST` (daemon address,
default `127.0.0.1:11435`), `OLLAYA_API_KEY` (only if the daemon
requires one), `OLLAYA_GATE_MODEL` (default `winnow:e4b`),
`OLLAYA_GATE_KEEP_ALIVE` (how long the daemon keeps the model loaded).

Precedence: `options > env > default`.

To disable without uninstalling, set `"enabled": false` or export
`OLLAYA_GATE_ENABLED=0`. While disabled the plugin subscribes to nothing
and every permission falls back to the manual prompt.

The plugin shells out to the Python gate (`python3 -m ollaya_gate.cli`)
with a minimal env. Each decision is appended (schema v2, mode 0600)
as one JSON line (`at`, `sessionID`, `requestID`, `tool`, `kind`,
`gateAction`, `reason`, `confidence`, `model`, `pick`, `elapsedMs`,
`objectiveChars`, `detail_sha256`) without secrets. Catastrophic
commands are rejected locally (`reason: catastrophic-pattern`) without
calling the model.
