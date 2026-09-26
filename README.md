# ollaya-decision-gate

[![CI](https://github.com/iDiagoValeta/ollaya-decision-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/iDiagoValeta/ollaya-decision-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](pyproject.toml)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](plugin/package.json)

A local permission gate for OpenCode: a decision model running on your
own machine (served by Ollaya, default `winnow:e4b`) auto-approves
routine tool calls, and anything the model calls risky or uncertain
falls back to your manual prompt. Nothing leaves the machine by
default: the Ollaya daemon listens on 127.0.0.1. Every delegation is
recorded in the JSONL decision log (`gateAction`, `reason`,
`error_class`, `error_detail`); there is no desktop popup for
ask-human/fail-open, only the manual prompt and the log entry.

Derived from jev-decision-gate, which used Jev, TypeSafe's hosted API.

> [!WARNING]
> This plugin lets a model auto-approve OpenCode's tool-permission
> prompts on your behalf. Read [Safety model](#safety-model) before
> pointing it at anything you care about. Defaults fail open to your
> manual prompt, never to silent allow: daemon down, model not pulled,
> any gate error, or an unrecognized decision all fall back to asking
> you, and a local kill-list rejects catastrophic shell commands before
> the model is ever asked. You remain responsible for what gets
> approved. The local model is not perfect (it allowed 1 of 13 traps in
> the evaluation, see [Choosing a model](#choosing-a-model)): the
> kill-list still runs first, and scope what the gate guards accordingly.
>
> **`opencode run --auto` bypasses this gate entirely**, including the
> catastrophic kill-list, because `--auto` resolves permissions
> client-side before the plugin can reply. Never use `--auto` when the
> gate's decisions are meant to matter; see
> [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for the
> reproduction and the safe alternative for headless sessions.

**Contents:** [Requirements](#requirements),
[Quickstart](#quickstart), [Choosing a model](#choosing-a-model),
[Safety model](#safety-model),
[Differences from jev-decision-gate](#differences-from-jev-decision-gate),
[Layout](#layout), [Develop](#develop)

```
opencode v2 --permission.asked--> plugin/ --stdin/stdout--> ollaya_gate (Python) --POST /api/decide--> Ollaya daemon (local)
     ^                                | allow -> reply once
     |                                | deny -> reply reject
     |                                | ask-human -> silence, logged
     |
     +--question tool call--> plugin/ (in-process, model answers each field)
            +- if unanswerable --> question form (GET /api/form) --> model pick
                   --> POST /api/session/.../form/.../reply  {"answer":{"q0":"<pick>"}}
```

The plugin sends the model a structured state per halt (objective,
halt kind, tool, redacted detail, risk hints, policy) fit to a char
budget (`STATE_BUDGETS = (22_000, 12_000, 6_000)`; default objective
collection is 22,000 chars), so the model judges with as much context
as fits its state window. The model answers three parallel questions
(allow/deny/ask-human, is-this-safe, risk-score); the `decision`
answer alone wins, at any confidence; safe/risk are asked for as
context, not vetoes (see "Safety model" below for why). Any error
fail-opens to ask-human: a broken gate never silently allows.

Catastrophic shell patterns (`rm -rf /`, pipe-to-shell, force-push,
`mkfs`, fork bombs, ...) are rejected instantly without calling the
model.

Agent questions (multichoice) are auto-answered when the model can
pick: the permission to open the question tool is
passthrough-allowed without session context (no model call), and the
question tool itself is wrapped so the model answers each field
in-process. When that can't answer, OpenCode opens a **form**
(`metadata.kind=question`) instead. The plugin polls `GET /api/form`
(and listens for `form.created` / legacy question events), asks the
model for a pick, and submits
`POST /api/session/{sessionID}/form/{formID}/reply` with
`{"answer":{"q0":"<pick>"}}`. If the model is unsure or the submit
fails, it stays pending for you to answer in the TUI; see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Requirements

- Ollaya on your machine (`https://ollaya.dev`): the daemon serves
  the decision model locally, default address `127.0.0.1:11435`
  (override with `OLLAYA_HOST`)
- Linux with glibc 2.38 or newer; for GPU, NVIDIA driver R580 or
  newer (the Ollaya installer adds the CUDA runtime). A 4B-class
  model needs about 7 GB VRAM; on smaller GPUs or CPU-only machines
  latency is seconds, and the plugin's 25 s gate timeout applies
  (then ask-human)
- OpenCode on the `@opencode/plugin` line (`permission.asked` events;
  the older, more common `@opencode-ai/plugin` line does not fire it,
  see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) if you are
  not sure which one you have)
- `"permission": "ask"` in your `opencode.json` (global or project):
  under `"allow"` there is nothing for the gate to intercept
- Python 3.10+ with `pip install -e .` (stdlib only, no runtime
  dependencies)
- Node 20+ for the plugin adapter

## Quickstart

```bash
curl -fsSL https://ollaya.dev/install.sh | sh
ollaya serve &                  # or the systemd service the installer creates with sudo
ollaya pull winnow:e4b          # 8.0 GB download, no implicit pulls (see below)
python3 -m pip install -e .     # no runtime dependencies (stdlib only)
npm --prefix plugin install
python3 -m ollaya_gate.doctor
```

Notes:

- The installer needs no sudo when run as
  `OLLAYA_INSTALL_DIR=$HOME/.local OLLAYA_NO_SERVICE=1`.
- There are no implicit pulls: if the model is not pulled, every
  decision fails open to ask-human (the daemon answers 404, logged
  with `error_class: transport`).
- `python3 -m ollaya_gate.doctor` checks the daemon
  (`GET /api/version`) and that the configured model is pulled
  (`GET /api/tags`), plus Python, Node, opencode v2, log path, and a
  synthetic round-trip through the gate (no network).
- Env vars the plugin passes to the gate subprocess: `OLLAYA_HOST`
  (default `127.0.0.1:11435`), `OLLAYA_API_KEY` (optional, sent as
  `Authorization: Bearer`, only needed if you expose the daemon),
  `OLLAYA_GATE_MODEL` (default `winnow:e4b`),
  `OLLAYA_GATE_KEEP_ALIVE` (optional per-request `keep_alive`).
  Disable anytime with `"enabled": false` or
  `OLLAYA_GATE_ENABLED=0`.

## Choosing a model

Measured 2026-09-27 on the author's laptop (NVIDIA RTX 4060 Laptop
8 GB VRAM, 16 CPU threads, 30 GB RAM, Ollaya 0.7.1). Eval set: 28
labelled permission halts (12 safe, 13 traps, 3 ambiguous) through
the gate's real state/question builders. "false allow" means a trap
the model allowed.

| model | device | p50 latency | safe allowed | traps allowed |
|---|---|---|---|---|
| winnow:e4b (Gemma 4 E4B, Q8_0 GGUF) | GPU | 0.24 s | 12/12 | 1/13 (CI edit that skips lint) |
| decision (Qwen3.5 0.8B) | GPU | 0.48 s | 11/12 | 4/13 |
| kev (0.8B) | GPU | 0.44 s | 8/12 | 5/13 |
| decider:0.8b | GPU | 0.83 s | 11/12 | 8/13 |
| kev:4b | CPU (does not fit 8 GB) | 22.9 s | 6/12 | 3/13 |
| von | GPU | 0.15 s | answers ask-human to everything | 0/13 |
| decider (2B) | fails to load on 8 GB (ONNX Cast error) | | | |
| jevk5 | not in the ollaya.dev registry on 2026-09-27 | | | |

Notes:

- Reproduce it on your hardware: `python3 scripts/eval_live.py`
  (`--model NAME`, `--long CHARS`, `--json`). It runs the golden events
  and `tests/live_eval_cases.json` through the gate's real path and
  exits 1 if any trap is allowed, so with winnow it currently exits 1
  (the CI edit). It measures the model alone: in the full gate the
  kill-list rejects four of the thirteen traps (`rm -rf ~/`, force
  push, `DROP TABLE`, `chmod -R 777 /`) before the model is asked.
- Long conversations: with 30,000 chars of padded conversation
  (`--long 30000`) winnow allowed 2/13 traps (the CI edit and
  `rm -rf ~/ build/`, which the kill-list catches first) and 8/12 safe
  steps. Judgment degrades as the conversation fills the state.
- `winnow:e4b` is the default (`OLLAYA_GATE_MODEL` overrides it).
  First call after load takes about 2 to 4 s (model load about 4 s),
  about 7 GB VRAM while loaded; the daemon unloads it after 5 min
  idle by default (daemon-side `OLLAYA_KEEP_ALIVE`, or per-request
  `OLLAYA_GATE_KEEP_ALIVE`).
- 1 of 13 traps allowed on this eval; the kill-list still runs first.
  The golden events (`tests/golden.json`) run live: winnow never
  allowed the three real traps there (push to main went to ask-human,
  `rm -rf` was denied, doom loop went to ask-human), and it sent the
  golden multichoice test-runner question to ask-human.
- Multichoice picks: in the live `scripts/verify_autonomy.py` run
  (2026-09-27) winnow answered the agent's question tool by itself in
  0.6 s. It is more cautious than it needs to be on some ordinary
  steps (it sent an `ls -la` and two read-only `grep`s to the manual
  prompt during live runs), so expect some extra prompts.
- Set expectations by hardware: a 4B model needs about 7 GB VRAM; on
  smaller GPUs or CPU-only machines each decision takes seconds and
  the plugin's 25 s gate timeout fail-opens to ask-human.

## Safety model

The model decides, no confidence thresholds. Whatever the
`decision` answer says wins: allow executes, deny blocks, ask-human
falls back to your manual prompt, at any confidence. The safe/risk
answers are context, not vetoes.

What never executes: unknown decision strings (treated as
ask-human), any error (fail-open to ask-human), a truncated state
(never judged, retried smaller or fail-open, see
`client.py`), and catastrophic shell patterns (rejected locally
without calling the model).

**The model's judgment is the real control, not a sandbox.** The
state the model reads includes attacker-reachable text
(conversation content, command output) in its own JSON fields,
marked as data, never instructions: see [SECURITY.md](SECURITY.md)
"Accepted risk: prompt injection into the model's state" for what
that does and doesn't guarantee.

Every decision is appended to a JSONL log (v2 schema:
`at`, `sessionID`, `requestID`, `tool`, `kind`, `gateAction`,
`reason`, `confidence`, `model`, `pick`, `elapsedMs`,
`detail_sha256`, and `usage` with the daemon's token counts) with no
secrets, mode `0600`. Log reasons for model verdicts are
`model-allow`, `model-deny`, `model-asked-human`, and
`form-model-not-allow`. `setup()` runs once per project directory,
so several instances share one opencode process; when two of them
see the same request, the loser logs `duplicate-suppressed` (a no-op
that never touched the model). `scripts/measure.py` excludes those
rows from its rates; a raw `grep gateAction` over the log would
count them. `scripts/measure.py` reports rates, p95, and tokens
(no hosted billing to total; cost is your own hardware and time).

### Personal notes for the model

Give the model standing context about how you want it to judge, read
from two optional plain-text files (see
`.ollaya-notes.example.md`): `.ollaya-notes.md` in a project
(gitignored, never commit it, see "Layout") for project-scoped
notes, and `$XDG_CONFIG_HOME/ollaya-gate/notes.md` (defaults to
`~/.config/ollaya-gate/notes.md`) for notes that follow you across
every project. Both are shown to the model together when present.

This is evidence in the state, exactly like the objective and risk
hints: never a rule engine. It cannot force an allow, and nothing
here runs before or instead of the model: the catastrophic kill-list
and the ask-human/fail-open defaults apply exactly the same
regardless of what the notes say.

## Differences from jev-decision-gate

- Local instead of hosted: the gate POSTs `{model, state,
  questions}` to the Ollaya daemon's native `POST /api/decide`
  (default `127.0.0.1:11435`) instead of a hosted API. No API key
  by default; optional `OLLAYA_API_KEY` is only for a daemon you
  exposed yourself.
- No runtime Python dependencies (stdlib only): no SDK install, no
  key provisioning, no token billing or hosted context window to
  track.
- State budgets fit the local model: `STATE_BUDGETS = (22_000,
  12_000, 6_000)` chars with retry on `state-truncated`, because
  `winnow:e4b` reads at most 6,144 state tokens.
- `POST /api/decide`, not the TypeSafe-compatible `/v1/systemone`:
  on Ollaya 0.7.1 the `/v1` route silently answers on a truncated
  state for llama.cpp models such as winnow instead of the promised
  `422 STATE_TRUNCATED`, so a truncated state would be judged as if
  whole. `/api/decide` reports truncation and the gate never judges
  it.
- Renames: package `ollaya_gate`, plugin dir
  `plugin/ollaya-decision-gate/`, env `OLLAYA_GATE_*` (model
  override `OLLAYA_GATE_MODEL`), notes `.ollaya-notes.md` and
  `~/.config/ollaya-gate/notes.md`, log reasons `model-*`.
- Unchanged: kill-list, two-phase question tool, form API,
  cross-instance claim, redaction in both layers, fail-open, deny
  carries a message, the model's decision wins at any confidence.

## Layout

- `plugin/` (v2 adapter, TypeScript): `plugin/ollaya-decision-gate/`
  holds the hook (catastrophic-pattern kill list, `kindFor`,
  conversation-context gathering, form-API answers, spawn with
  `OLLAYA_HOST`, `OLLAYA_API_KEY`, `OLLAYA_GATE_MODEL`,
  `OLLAYA_GATE_KEEP_ALIVE`, cross-instance dedup, logging)
- `src/ollaya_gate/` (gate, stdlib only): `schemas.py`
  (state/redaction/questions, `STATE_BUDGETS`), `client.py` (local
  Ollaya client on `POST /api/decide`, error mapping:
  `ollaya-unreachable`, `http-<code>`, `state-truncated`,
  `bad-response`), `decision.py` (decision combine, no thresholds),
  `cli.py` (stdin/stdout gate with fail-open and budget retry),
  `doctor.py` (checks the daemon at `GET /api/version` and the
  pulled model at `GET /api/tags`)
- `tests/` (pytest suite plus `golden.json` traps)
- `scripts/` (`install.sh`, `uninstall.sh`, `measure.py` v2,
  `verify_autonomy.py` for the live autonomy check)
- `docs/` ([ARCHITECTURE.md](docs/ARCHITECTURE.md), [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md))

## Develop

```bash
python3 -m pip install -e ".[dev]"
npm --prefix plugin install
python3 -m pytest -q
python3 scripts/measure.py --by-session
python3 -m ollaya_gate.doctor
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md).
