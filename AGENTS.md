# AGENTS.md

Context for coding agents working in this repo. Humans: see `README.md`
and `docs/ARCHITECTURE.md` instead.

## What this is

An OpenCode **v2** plugin (`plugin/ollaya-decision-gate/`) that intercepts
`permission.asked` events and asks Jev (TypeSafe AI, via `src/ollaya_gate/`,
a Python package spawned as a subprocess) to decide allow/deny/ask-human
instead of always prompting a human. Agent questions are a separate
phase (pending form via `GET /api/form` → form reply API). Two languages,
one flow:

```
opencode v2 → index.ts ctx.permission.hook("evaluate") → spawn python3 -m ollaya_gate.cli
            → schemas.py builds the structured Jev state → client.py calls Jev
            → decision.py combines the answer → cli.py prints JSON
            → index.ts sets input.effect allow / deny+message / leaves "ask"
              (ask → opencode prompts the human; no reply API involved)

opencode v2 → question tool permission → evaluate hook allows it through
              instantly, no Jev call (reason: question-permission-passthrough)
            → ctx.tool.transform wraps the question tool itself → asks Jev
              each field in-process (phase: question-tool) and answers there
              when Jev can decide
            → if that path can't answer, OpenCode opens a form
              (metadata.kind=question) → index.ts polls GET /api/form (also
              listens for form.created / legacy question events) → Jev pick
              → POST /api/session/{sessionID}/form/{formID}/reply
              body {"answer":{"q0":"<pick>"}} (phase: form-answer, human
              fallback)
```

Full flow and ADRs: `docs/ARCHITECTURE.md`. Read it before touching the
gate logic — the "why" for each design choice lives there, not here.

## v2 only, and beta

This gate targets the `@opencode/plugin` API line (the one with
`permission.asked` events), installed as plain `opencode`, currently
2.0.x. That line and the older, much more widely-used
`@opencode-ai/plugin` line (1.18.x) ship from the same
`anomalyco/opencode` repo as two parallel plugin API generations, not
two separate products — but they are NOT interchangeable and a given
install is one or the other, never both under the same binary.

**Do not "simplify" by porting this gate to the 1.18.x line.** Its
`permission.ask` hook is dead code — a plugin using it loads cleanly
and is simply never called (see `docs/TROUBLESHOOTING.md` for
details). Install `opencode` from the official installer
(`~/.opencode/bin/opencode`); don't keep multiple copies (a renamed
binary, a pnpm global `opencode-ai` install, a desktop app) side by
side, and don't hand-copy a binary under a new name to "pin" a
version — see `docs/TROUBLESHOOTING.md` for why that breaks the
canonical install.

**`"permission": "allow"` in opencode.json means the gate does
nothing.** No `permission.asked` event fires when the ambient mode is
already `allow` — there is nothing to intercept. The config (global or
project) must set `"permission": "ask"` for Jev to ever get consulted.
If a fresh install "does nothing" with no errors, check this first.

The `@opencode/plugin` SDK package version (`plugin/package.json`) and
the `opencode` CLI binary version are independently numbered — pin the
SDK explicitly (already done) and treat "it broke on the newest 2.x" as
plausible; verify the actual runtime version before assuming a plugin
bug.

## Layout

| Path | Owns |
| ---- | ---- |
| `plugin/ollaya-decision-gate/index.ts` | opencode hook: catastrophic-pattern kill list, `kindFor`, conversation-context gathering, form-API answers (`/api/form` poll + reply), human alert popup, spawn (`pythonBin` / mise / `PYTHONPATH`), cross-instance dedup, logging |
| `src/ollaya_gate/schemas.py` | structured Jev state (budget fit), redaction, question shapes |
| `src/ollaya_gate/client.py` | TypeSafe SDK wrapper, error mapping |
| `src/ollaya_gate/decision.py` | pure allow/deny/ask-human combine logic (fully unit tested) |
| `src/ollaya_gate/cli.py` | stdin/stdout contract with `index.ts`, v2 JSONL log |
| `src/ollaya_gate/doctor.py` | install diagnostics, no secrets printed |
| `scripts/measure.py` | reads the JSONL log: rates, p95, cost, by-session |
| `scripts/verify_autonomy.py` | non-interactive live check that the plugin answers the question tool (log resolved like `measure.py`) |
| `tests/golden.json` + `tests/test_golden.py` | policy regression traps — a decision-logic/kind change without a new case here is unreviewed |

## Non-negotiables (see `CONTRIBUTING.md` "Safety contract")

1. **Fail-open to `ask-human`, never silent `allow`.** Every `except` in
   the Python gate and every catch in `index.ts` must degrade to
   ask-human with a logged `error_class`, not swallow the error.
2. **No secrets in logs or in the Jev payload.** Both `index.ts`
   (`redactSecrets`) and `schemas.py` (`redact_secrets`) redact
   independently, before send and before log — a change on one side
   without the other is a gap. `pytest -q` has redaction coverage.
3. **Policy changes need a golden case.** Anything touching
   `decision.py`'s combine logic or `kindFor` needs a new entry in
   `tests/golden.json`.
4. **Question tool is two-phase — do not collapse it back into a
   single Jev+`session.context` permission path.** In the `evaluate`
   hook, `action === "question"` gets `effect = "allow"` with **no**
   `ctx.session.context` and **no** Jev call
   (`reason: "question-permission-passthrough"`). The answer itself
   comes from the wrapped `question` tool (`ctx.tool.transform`,
   `phase: "question-tool"`), which asks Jev each field in-process and
   answers there whenever Jev can decide; the form path
   (OpenCode opens a form, `metadata.kind=question`, listed at
   `GET /api/form`) is the human fallback for when it can't. The plugin
   polls `/api/form` (and also listens for `form.created` / legacy
   question events); Jev picks; the plugin replies with
   `POST /api/session/{sessionID}/form/{formID}/reply` body
   `{"answer":{"q0":"<pick>"}}`. Log shows `phase: form-answer` then
   `reason: question-answered`. Read `docs/TROUBLESHOOTING.md`
   "Question dialog hangs" before changing this path again.
5. **`setup()` runs once per project directory, so many times per
   opencode process.** A new `inst` appears for each new session
   directory, and every instance sees the process-wide event stream.
   Any code path that evaluates or replies must claim first (see
   `claimReply` in `index.ts`); the `evaluate` hook claims on
   `eval:<sessionID>:<source>:<action>:<sha>`. Assume you are racing
   sibling instances. **Each instance also gets its own copy of the
   module**, so anything that must be shared per process (poller,
   dedup sets) goes on `globalThis[Symbol.for("ollaya-decision-gate.shared.v1")]`,
   never in a module-level `const`/`let`.
6. **Deny always carries a `message`.** A bare reject aborts the
   agent's whole turn. The `evaluate` hook sets `input.message` on
   every deny.

## Finish on main, nowhere else

`main` is protected (PR + green CI required, no direct push). Work in
a branch, open a PR, merge it once CI is green — then **delete the
branch, local and remote, and leave only `main`**:

```bash
git checkout main && git pull origin main
git branch -D <branch>
git push origin --delete <branch>
```

A task isn't done while a feature branch is still sitting there,
merged or not — `git branch -a` should show `main` and nothing else
when you finish a piece of work.

## Commands

```bash
python3 -m pip install -e ".[dev]"   # Python deps
npm --prefix plugin install           # TS deps

python3 -m pytest -q                              # Python tests
ruff check src tests scripts                       # lint (pyflakes+pycodestyle only, see pyproject.toml)
bandit -r src scripts --severity-level medium       # SAST (medium+ only, see ci.yml comment for why)
npm --prefix plugin exec --no -- tsc --noEmit -p plugin/ollaya-decision-gate   # TS typecheck
npm --prefix plugin test                          # TS unit tests (isCatastrophic/normalizeCommand,
                                                    # redactSecrets, kindFor, claimReply, postApiReply)

python3 -m ollaya_gate.doctor            # install/env diagnostics
python3 scripts/measure.py            # read the decision log
python3 scripts/verify_autonomy.py    # live autonomy check (needs running opencode service)
```

The plugin auto-detects a mise-managed Python (`options.pythonBin` /
`OLLAYA_GATE_PYTHON`, else newest `~/.local/share/mise/installs/python/*/bin/python3`)
and sets `PYTHONPATH=src` on the gate subprocess so `typesafe_sdk` resolves
when the opencode service’s `/usr/bin/python3` lacks it.

CI (`.github/workflows/ci.yml`) runs `pytest` on 3.10-3.12, `ruff`,
`bandit` (SAST, medium+ severity), `tsc --noEmit`, and
`npm --prefix plugin test` (Node's built-in `node:test`, via
`plugin/ollaya-decision-gate/index.test.ts`, compiled by
`plugin/tsconfig.build.json` — covers the exported functions:
`isCatastrophic`, `normalizeCommand`, `redactSecrets`, `kindFor`,
`claimReply`, `postApiReply`). There is no automated
test for the stateful `setup()`/event-subscription/spawn logic — the
interactive permission/dialog flow can only be verified by hand (or
`scripts/verify_autonomy.py`) against a live opencode v2 session (see
`docs/TROUBLESHOOTING.md`).

## Documentation is not optional

Any change that touches behavior, a supported version, a config
requirement, or a known limitation MUST update the relevant doc in the
same change: `docs/ARCHITECTURE.md` (flow/ADRs), `docs/TROUBLESHOOTING.md`
(symptoms/fixes), and this file when the fact belongs here. History is
not kept in the repo; `git log` is the changelog. A fix that works but
isn't documented is not done — the next session (human or agent) will
rediscover the same dead end from scratch.

## Where development artifacts go

Iteration logs, working plans, specs written for an agentic dev
workflow (e.g. superpowers plans/specs), scratch notes — anything that
records *how* the project got built rather than *what it currently is*
— goes in `.dev/` at the repo root, which is gitignored. Never commit
this kind of file under `docs/` or the repo root: `docs/` is what a
contributor reads to understand the current system, and process notes
mixed in there read as confusing clutter, not documentation.

- Still being added to across sessions (e.g. an ongoing round/iteration
  log) → keep it in `.dev/`, don't delete it.
- Served its purpose and is superseded by real docs (e.g. an initial
  design spec once `docs/ARCHITECTURE.md` covers the current design) →
  delete it outright, don't archive it. `git log` already has the
  history if anyone needs it.

## Before claiming a plugin-side fix works

`index.ts` changes cannot be verified by `tsc` alone — it only proves
the code compiles. The actual behavior (does the dialog still hang, did
the reply race disappear) requires running opencode v2 interactively
and checking the JSONL decision log (`OLLAYA_GATE_LOG` / default
`decisions-plugin.jsonl`) for the real `inst`/`pid`/`gateAction`
sequence. Don't report an `index.ts` fix as done from a green `tsc` run
alone.

**A live service picks up `index.ts` edits without a restart — mid-edit
inconsistent states are live-reachable, not just theoretical.** The
running process re-reads this file per-event rather than caching
function bodies once at `setup()`, but `setup()`'s own
subscriptions/closures (`inst`, the `resolved`/`endedSessions`/
`formSeen` maps) are only picked up on a fresh `setup()` call, i.e.
after a restart. Practical consequence: prefer one atomic edit over
several incremental ones when a live service might be evaluating real
permissions during the edit, and expect (don't be alarmed by) a
handful of harmless fail-opens logged with a JS error as `error_class`
during such a window.
