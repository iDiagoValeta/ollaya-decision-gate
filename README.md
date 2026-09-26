# ollaya-decision-gate

[![CI](https://github.com/iDiagoValeta/ollaya-decision-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/iDiagoValeta/ollaya-decision-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](pyproject.toml)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](plugin/package.json)

Jev (TypeSafe AI) as the permission gate for OpenCode: routine tool
calls get approved automatically, anything Jev calls risky or
uncertain falls back to your manual prompt. Every delegation is
recorded in the JSONL decision log (`gateAction`, `reason`,
`error_class`, `error_detail`); there is no desktop popup for
ask-human/fail-open, only the manual prompt and the log entry.

> [!WARNING]
> This plugin lets an LLM auto-approve OpenCode's tool-permission
> prompts on your behalf. Read [Safety model](#safety-model) before
> pointing it at anything you care about. Defaults fail open to your
> manual prompt, never to silent allow: no API key, any gate error, or
> an unrecognized decision all fall back to asking you, and a local
> kill-list rejects catastrophic shell commands before Jev is ever
> asked. You remain responsible for what gets approved.
>
> **`opencode run --auto` bypasses this gate entirely** — including the
> catastrophic kill-list — because `--auto` resolves permissions
> client-side before the plugin can reply. Never use `--auto` when the
> gate's decisions are meant to matter; see
> [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for the
> reproduction and the safe alternative for headless sessions.

**Contents:** [Requirements](#requirements) ·
[Quickstart](#quickstart) · [Safety model](#safety-model) ·
[Layout](#layout) · [Develop](#develop)

```
opencode v2 ──permission.asked──▶ plugin/ ──stdin/stdout──▶ ollaya_gate (Python) ──▶ Jev API
     ▲                                │ allow → reply once
     │                                │ deny → reply reject
     │                                │ ask-human → silence, logged
     │
     └──question tool call──▶ plugin/ (in-process, Jev answers each field)
            └─ if unanswerable ──▶ question form (GET /api/form) ──▶ Jev pick
                   ──▶ POST /api/session/.../form/.../reply  {"answer":{"q0":"<pick>"}}
```

The plugin sends Jev a structured state per halt (objective, halt kind,
tool, redacted detail, risk hints, policy) filled up to Jev's input
window, so Jev judges with as much context as fits.
Jev answers three parallel questions (allow/deny/ask-human,
is-this-safe, risk-score); the `decision` answer alone wins, at any
confidence; safe/risk are asked for as context, not vetoes (see
"Safety model" below for why). Any error fail-opens to ask-human: a
broken gate never silently allows.

Catastrophic shell patterns (`rm -rf /`, pipe-to-shell, force-push,
`mkfs`, fork bombs, ...) are rejected instantly without calling Jev.

Agent questions (multichoice) are auto-answered when Jev can pick: the
permission to open the question tool is passthrough-allowed without
session context (no Jev call), and the question tool itself is
wrapped so Jev answers each field in-process. When that can't answer,
OpenCode opens a **form** (`metadata.kind=question`) instead. The
plugin polls `GET /api/form` (and listens for `form.created` / legacy
question events), asks Jev for a pick, and submits
`POST /api/session/{sessionID}/form/{formID}/reply` with
`{"answer":{"q0":"<pick>"}}`. If Jev is unsure or the submit fails,
it stays pending for you to answer in the TUI; see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Requirements

- OpenCode on the `@opencode/plugin` line (`permission.asked` events;
  the older, more common `@opencode-ai/plugin` line does not fire it —
  see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) if you're not
  sure which one you have)
- `"permission": "ask"` in your `opencode.json` (global or project) —
  under `"allow"` there's nothing for the gate to intercept
- Python 3.10+ with `pip install -e .` (pulls `typesafe-sdk`)
- Node 20+ for the plugin adapter
- A TypeSafe API key (`console.typesafe.ai`)

## Quickstart

```bash
git clone git@github.com:iDiagoValeta/ollaya-decision-gate.git
cd ollaya-decision-gate
./scripts/install.sh --project   # or --global for every session
export TYPESAFE_API_KEY="..."
python3 -m ollaya_gate.doctor
```

Or manually — see [plugin/README.md](plugin/README.md) for the full
options table (`typesafeKey`, `logFile`, `gateDir`, `enabled`,
`timeoutMs`, `pythonBin`). Disable anytime with `"enabled": false` or
`OLLAYA_GATE_ENABLED=0`.

## Safety model

Jev decides — no confidence thresholds. Whatever Jev's `decision`
answer says wins: allow executes, deny blocks, ask-human falls back
to your manual prompt, at any confidence. The safe/risk answers are
context, not vetoes.

What never executes: unknown decision strings (treated as ask-human),
any error (fail-open to ask-human), and catastrophic shell patterns
(rejected locally without calling Jev).

**Jev's judgment is the real control, not a sandbox.** The state Jev
reads includes attacker-reachable text (conversation content, command
output) in its own JSON fields, marked as data, never instructions: see
[SECURITY.md](SECURITY.md) "Accepted risk: prompt injection into
Jev's state" for what that does and doesn't guarantee.

Every decision is appended to a JSONL log (v2 schema:
`at`, `sessionID`, `requestID`, `tool`, `kind`, `gateAction`,
`reason`, `confidence`, `model`, `pick`, `elapsedMs`,
`detail_sha256`, and `usage` (Jev's token counts, which `measure.py`
turns into tokens and cost) with no secrets, mode `0600`. `setup()` runs once per
project directory, so several instances share one opencode process;
when two of them see the same request, the loser logs
`duplicate-suppressed` (a no-op that never touched Jev).
`scripts/measure.py` excludes those rows from its rates; a raw
`grep gateAction` over the log would count them.

### Personal notes for Jev

Give Jev standing context about how you want it to judge, read from two
optional plain-text files (see `.ollaya-notes.example.md`): `.ollaya-notes.md`
in a project (gitignored — never commit it, see "Layout") for
project-scoped notes, and `$XDG_CONFIG_HOME/ollaya-gate/notes.md` (defaults
to `~/.config/ollaya-gate/notes.md`) for notes that follow you across every
project. Both are shown to Jev together when present.

This is evidence in the state, exactly like the objective and risk hints:
never a rule engine. It cannot force an allow, and nothing here runs
before or instead of Jev: the catastrophic kill-list and the
ask-human/fail-open defaults apply exactly the same regardless of what
the notes say.

## Layout

- `plugin/` — v2 adapter (TypeScript, zero runtime deps besides `@opencode/plugin`)
- `src/ollaya_gate/` — gate: `schemas.py` (state/redaction/questions),
  `client.py` (Jev wrapper), `decision.py` (decision combine, no thresholds),
  `cli.py` (stdin/stdout gate with fail-open), `doctor.py`
- `tests/` — pytest suite plus `golden.json` traps
- `scripts/` — `install.sh`, `uninstall.sh`, `measure.py` v2,
  `verify_autonomy.py` (live autonomy check)
- `docs/` — [ARCHITECTURE.md](docs/ARCHITECTURE.md), [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## Develop

```bash
python3 -m pytest -q
python3 scripts/measure.py --by-session
python3 -m ollaya_gate.doctor
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md).
