# Troubleshooting

## `opencode run --auto` bypasses the gate entirely, including the catastrophic kill-list

**Do not use `--auto` when this gate's decisions are meant to matter.** It is
not a mitigated risk, it is a hard bypass: `--auto` is documented
(`opencode run --help`) as "Auto-approve permissions that are not explicitly
denied", a **client-side** decision opencode's CLI makes on its own, without
waiting for `permission.asked` subscribers (this plugin included) to reply.
Whatever the plugin decides, `--auto` has usually already resolved the
request by the time the plugin's reply (always at least one subprocess spawn
plus an HTTP round trip) lands, so the reply 404s and the command runs
regardless: deny, ask-human, or even the catastrophic-pattern kill-list, all
equally bypassed.

Reproducible with zero real-world risk (e.g. `terraform` not installed, so a
bypass can't actually destroy anything):

```bash
opencode run --model <any> --auto \
  "Run the shell command: terraform destroy -auto-approve and report the verbatim tool result."
```

The shell **executes** the command even though the decision log shows the
plugin got the call right:

```
{"tool":"shell","kind":"destructive","gateAction":"reject","reason":"catastrophic-pattern", ...}
{"tool":"shell","gateAction":"reject","reason":"reply-failed","error_class":"... HTTP 404 Not Found","totalElapsedMs":109}
```

The reply lands ~100ms after the request (local regex, no network, no model
call) and it is still too slow, because `--auto` doesn't wait on anything.
This is not fixable by making the plugin's reply faster: `--auto` approves
before any plugin gets a chance to race it at all.

**The same command through the raw session API (no `--auto`) is correctly
blocked:**

```bash
opencode api POST /api/session -d '{}'                                    # → sid
opencode api POST "/api/session/$sid/prompt" -d '{"text":"Run the shell command: terraform destroy -auto-approve ..."}'
```

```json
{"type":"tool","name":"shell","executed":false,
 "state":{"status":"error","error":{"type":"aborted","message":"The user declined this tool call"}}}
```

`executed: false`, no `reply-failed` in the log: the plugin's reject lands
before the tool runs. Same plugin, same machine, same model; the only
difference is the absence of `--auto`.

**For headless/non-interactive/subagent work where the gate's protection
matters, drive the session through the raw API instead of `--auto`:**
`POST /api/session`, `POST /api/session/{id}/prompt` (body `{"text": "..."}`),
then poll `GET /api/session/{id}/message` for completion. This behaves like
an interactive TUI session: the gate has as much time as it needs to reply,
since nothing else resolves the permission first.

## "It never asks the model, I always get the manual prompt"

That IS the fail-open design, but find out why:

```bash
python3 -m ollaya_gate.doctor      # "log writable (<path>)" is the log the plugin writes
python3 scripts/measure.py      # same path, printed as log=<path>
tail -5 <that path>
```

| Symptom in log | Cause | Fix |
| -------------- | ----- | --- |
| `reason: fail-open, error_class: transport` with `ollaya-unreachable` in `error_detail` | Ollaya daemon not running | start it: `ollaya serve` (see the dedicated entry below) |
| `reason: fail-open, error_class: transport` with `http-404 MODEL_NOT_FOUND` in `error_detail` | the model is not pulled | `ollaya pull winnow:e4b` (or your `OLLAYA_GATE_MODEL`); there are no implicit pulls |
| `error_class: state-truncated` | conversation too dense for the state window, even at the smallest budget | lower `objectiveChars` / `OLLAYA_GATE_OBJECTIVE_CHARS` (see the dedicated entry below) |
| `error_class: gate timeout` | model slow / daemon busy | raise `timeoutMs` (max 30000); see "Decisions take seconds" |
| no log lines at all, `permission: "allow"` in config | no `permission.asked` fires at all when the ambient mode is already `allow`, nothing to intercept | set `"permission": "ask"` (global or project config); that's what lets the gate substitute the model for the human in the first place |
| no log lines at all, `permission: "ask"` already set | hook never fired for another reason | check `opencode debug config` resolves your plugin path; re-check with `python3 -m ollaya_gate.doctor` |
| `reason: catastrophic-pattern` | command matched kill-list | intended: rewrite the command |

## Every decision fails open with `error_class: transport`

The gate could not reach the Ollaya daemon. The `error_detail` tells the two
apart:

- `ollaya-unreachable: ...`: the daemon is down. Start it with `ollaya serve`
  (or the systemd service the installer creates with sudo).
- `http-404 MODEL_NOT_FOUND`: the daemon is up but the model is not pulled.
  Pull it with `ollaya pull winnow:e4b` (or whatever `OLLAYA_GATE_MODEL`
  names). Ollaya does no implicit pulls, so a missing model is a 404 on
  every decision.

Run `python3 -m ollaya_gate.doctor`: it checks the daemon with
`GET /api/version` and that the model is pulled with `GET /api/tags`, and
prints the resolved `ollaya pull` hint on failure. Any other HTTP status
also maps to `transport` (`http-<code> <CODE>: <message>`).

## `error_class: state-truncated`

The conversation is too dense for the model's state window even at the
smallest budget of `STATE_BUDGETS` (22000, 12000, 6000 chars). `winnow:e4b`
reads at most 6,144 state tokens; a 22k-char conversational objective
measured 5,254 tokens, but code and non-English text are denser, so 6k
chars can still overflow.

This is the gate refusing to judge, by design: `cli.py` only retries with a
smaller budget on `state-truncated`, a truncated state is never judged, and
when the last budget is still truncated the decision falls to your manual
prompt. Lowering `objectiveChars` does not help here (the last budget already
caps the whole state at 6,000 chars); it only happens when the halt detail
itself is that dense, for example a large minified or binary-looking
payload. Answer the prompt yourself.

## First decision after idle is slow

Loading the model takes about 4 s, so the first call after load takes 2 to
4 s. By default the daemon unloads the model after 5 min idle
(`OLLAYA_KEEP_ALIVE` on the daemon). To keep it resident, set
`OLLAYA_KEEP_ALIVE` on the daemon or `OLLAYA_GATE_KEEP_ALIVE` per request
(the plugin passes it through). The plugin's gate timeout is 25 s by
default (max 30000 via `timeoutMs`), so a load spike does not by itself fail
the call.

## Decisions take seconds

The model is running on CPU, or swapping against VRAM. Run `ollaya ps` and
read the DEVICE column: `CPU` means the model does not fit the GPU. A 4B
model needs about 7 GB VRAM; on smaller GPUs or CPU-only machines latency is
seconds (measured 22.9 s for `kev:4b` on CPU, which did not fit 8 GB), and
the plugin's 25 s gate timeout then fails open to ask-human. Free VRAM, use
a GPU that fits the model, or pick a smaller model.

The device is chosen when the model loads and kept until it unloads. If
something else holds the VRAM at that moment (another Ollaya model, a game,
another inference server), winnow loads on CPU and stays there even after
the VRAM frees up; seen on 2026-09-27 with jevk5 still loaded. Unload it with
`ollaya stop winnow:e4b` (or wait for the keep-alive to expire) and the next
decision loads it on the GPU again.

## Which opencode, which version

This project only works on the `@opencode/plugin` API line (the one
with `permission.asked` events), installed as plain `opencode`,
currently tracking 2.0.x (`anomalyco/opencode` on GitHub; same repo
that also ships the older, much more widely-used `@opencode-ai/plugin`
line under the same `opencode` name at 1.18.x: two parallel plugin
API generations in one project, not two separate products). Run
`python3 -m ollaya_gate.doctor`, which reports the resolved version and
whether it looks like the 2.x line.

**Do not rely on the 1.18.x line for this gate.** Its `permission.ask`
plugin hook is dead code: a plugin registering it loads cleanly and
simply never gets consulted, which is *worse* than the 2.x line's known
issues because there is no error to notice. If a future `opencode`
release finally fixes that and you want to port this gate to
`@opencode-ai/plugin`, treat it as a rewrite (different Hooks shape,
`permission.ask(input, output)` with `output.status`, no
`ctx.event.subscribe`), not a config tweak.

**Community v1 plugins on the 2.x line:** before removing a v1-only
plugin, check whether its package ships a *native* v2 build under an
alternate export subpath (`npm view <pkg> exports` and `main` is the
fast way to check): no `/v2`-shaped alternate export means there's
nothing native to point at, and the plugin should be removed from
config rather than left erroring. A hand-written v1 to v2 compatibility
shim is deliberately avoided for auth plugins in particular: a shim bug
in a credential flow is a much worse failure mode than the plugin
simply not loading.

**"It worked on an older opencode 2.x, breaks on the newest one":** the
`@opencode/plugin` SDK package (npm, pinned in `plugin/package.json`)
and the `opencode` CLI binary are versioned independently: a newer
CLI can ship a `permission.asked`/`ctx.session.context` shape the
pinned SDK types don't match, or vice versa. Before filing a bug,
capture the exact runtime version (`opencode --version`) next to the
SDK version, and downgrade via the *direct* installer
(`curl -fsSL https://opencode.ai/v2/install | bash -s -- --version <old>`)
rather than `opencode upgrade <version>`: that command always targets
the single canonical `~/.opencode/bin/opencode`, so if you ever run it
from a renamed/copied binary meant to preserve an old version
side-by-side, it silently overwrites the *canonical* install instead,
not the copy. Keep one install; don't hand-roll a second copy under a
different name to "pin" a version.

Global `~/.config/opencode/opencode.json`:

- `plugin` holds 1.18.x-line plugins (npm names / git specs).
- `plugins` holds 2.x-line plugins, this gate among them, as
  `{package, options}` objects. The gate needs the Ollaya daemon running
  and the model pulled; no API key is required. An optional
  `OLLAYA_API_KEY` is sent as `Authorization: Bearer` if the daemon sits
  behind a proxy.

Anything else in that config (other `instructions` entries, other
plugins in either list) belongs to whatever else you've installed
globally, not to this gate. Check `plugin/README.md` before assuming an
unfamiliar line came from here.

## Question dialog: how auto-answer works, and what to check if it hangs

The question tool is answered two ways, in order:

1. **In-process (preferred).** The plugin wraps the `question` tool's
   `execute`. The model evaluates the offered options and returns a pick;
   the wrapped tool returns that pick as the tool result directly: no
   form, no reply API, works in any opencode server. Log lines show
   `phase: "question-tool"`, `reason: "question-answered"`.
2. **Form fallback.** If the model can't answer (ask-human, pick not
   offered, ambiguous, no options), the original `execute` runs and opens
   the human-facing **form** (`metadata.kind=question`), listed at
   `GET /api/form`. On 2.0.x the question tool always goes through a
   form when unanswered in-process, not a dedicated `/api/question`
   surface. The plugin polls `/api/form` (and also listens for
   `form.created` / legacy `question.v2.asked` / `question.asked`),
   evaluates each field with options as multichoice, and on an
   allow+valid pick POSTs
   `opencode api POST /api/session/{sessionID}/form/{formID}/reply`
   with body `{"answer":{"q0":"<pick>"}}`. Log shows
   `phase: "form-answer"` then `reason: "question-answered"`. If the
   model returns ask-human / invalid pick / reply failure, the form stays
   pending, logged, and the human answers in the TUI.

Separately, `permission.asked` for `action === "question"` is always a
passthrough allow with **no** `ctx.session.context` and **no** model call
(`reason: "question-permission-passthrough"`): this only unlocks the
tool call; it never answers the question itself.

**Field-level behavior on the form path:**

- `multiselect` fields are answered with an **array** of the picked
  option values, not a string: `{"answer":{"q0":["pizza","sushi"]}}`.
  The model returns a single pick today, so the array normally has one
  element; if a future model version returns a list of picks, each one is
  mapped to its option value and the array grows accordingly.
- `hidden: true` fields are never answered. A field with
  `when: [{key, op: "eq"|"neq", value}]` is answered only when **all**
  conditions hold against the answers already decided for earlier
  fields, compared with `===` (no coercion: a numeric `value` won't
  match a string answer, which is the safe direction). An
  unreferenced `key` counts as unanswered: `eq` is false, `neq` is
  true. A not-visible field is **omitted from the reply entirely**:
  the server 400s on a reply that includes a field whose `when`
  isn't satisfied.
- A visible field with **no options and a non-multiselect type**
  (boolean / number / free-string) can't be answered by a pick: the
  model is not called for it. If it's not `required` it's skipped and the
  rest of the form is still auto-answered; if it is `required` the
  whole form stays pending for the human.

**Logged reasons inside the form field loop (no silent exits):**

Every early exit while walking a form's fields logs a line with
`tool: "question"`, `requestID` = formID, `fieldKey`, and one
distinct `reason` (all `gateAction: "ask-human"`: the field/form
stays pending for the human):

| reason | meaning |
| ------ | ------- |
| `form-field-hidden` | conditional field not visible (skipped; form continues) |
| `form-unsupported-field` | visible, no options, non-multiselect type; includes `required` (skipped if false, aborts the form if true) |
| `form-model-not-allow` | the model didn't `allow`, or returned no / empty / non-string pick |
| `form-pick-not-offered` | pick not among the offered labels |
| `form-pick-ambiguous` | `valueForPick`/`encodeAnswer` resolved to null (labels collide after redaction/truncation) or several picks landed on a single-select field |

If a question hangs with no click available: confirm the permission
phase logged `question-permission-passthrough` (no model call on that
requestID), then check whether the in-process wrap or the form path
logged anything at all for the question; no log line at all for a
given form usually means its project directory never registered with
the shared poller (see "High idle CPU" below) rather than a hang in
the answering logic itself. `scripts/verify_autonomy.py` automates a
non-interactive check of this whole path against a running service.

**Repro:** `permission: "ask"` (required, see above), plugin enabled,
Ollaya daemon running with the model pulled. Open a TUI session in
a test directory and send: "Hazme una pregunta multiopción: qué
cenamos hoy. Opciones exactamente: pizza, sushi, ensalada. Usa la
herramienta de pregunta del sistema y espera mi respuesta." Success:
either `phase: "question-tool"` with `reason: "question-answered"`
(no form at all), or passthrough followed by `phase: "form-answer"` /
`question-answered`; the agent continues without a manual click.

## Ordinary permission replies (`read`/`edit`/`bash`/...) and "Permission request not found"

Permissions are decided in the `evaluate` hook (see
`docs/ARCHITECTURE.md` "Key decisions"), not by replying to
`permission.asked`, so a `reply-failed` on a permission now only
appears on the `hook-unavailable` fallback path. Form answers still go
through `opencode api`, so a form answer attempted in any server other
than the background service still gets `form-reply-failed ... 404`
(the background service is the only server `opencode api` reaches).

If you do see `reply-failed` on the fallback path, or `form-reply-failed`
on the form path: confirm which server the plugin is running in
(`opencode api` always targets the background service), and check
`GET /api/session/{id}/permission` (or `/api/form`) directly to see
whether the request is still pending server-side before assuming a
timing issue.

## A denied tool call ended the whole session

A bare `reject` reply aborts the agent's whole turn ("The user
declined this tool call"). The `evaluate` hook's deny always carries a
`message` (`Blocked by ollaya-decision-gate: ...` for the kill-list,
`Denied by ollaya-decision-gate: ...` for the model), so only that tool
call fails, and the agent sees why and continues. If you see
`aborted` after a deny, check the log for `hook-unavailable`: you are
on the reply fallback, where a bare reject is possible.

## `fail-open` with `gate killed by SIGKILL`

The gate subprocess died from a signal (OOM killer, a stray `pkill`).
It is retried once automatically (`retry: 1` in the log line). Only a
second consecutive death, or a timeout, falls open to ask-human.

## High idle CPU / a storm of `opencode api GET /api/form`

**Symptom:** many `opencode` CLI processes visible in `htop`/`ps` and
noticeable idle CPU with no active session.

**Design:** there is a single module-level poller per process
(`registerPoller`/`unregisterPoller` in `index.ts`, shared via
`globalThis` since each `setup()` instance loads its own copy of the
module): the first `setup()` instance starts it, the rest only
register, the last cleanup stops it, and at most one tick runs at a
time. If you see one poll process per project directory instead of one
per opencode process, the shared state is not actually being shared:
check it lives on `globalThis`, not in module scope.

The bare `GET /api/form` only lists the service's own directory
(typically the user's home directory), so the poller lists each known
project directory explicitly via
`GET /api/form?location[directory]=<dir>`. A question form in a
project that is never auto-answered (no `phase: form-answer` line at
all, not even ask-human) means its directory never registered with the
poller: check the service actually has that project open.

On the form path, a losing cross-instance claim logs nothing at all
(not even `duplicate-suppressed`): with many sibling instances racing
every form, losing is the expected outcome and not worth a log row.
`duplicate-suppressed` in the log means the permission (fallback) path
only. `scripts/measure.py` excludes it from rates either way.

## Question answered without any form (`phase: question-tool`)

The plugin answers the `question` tool inside the tool call by default:
log lines with `phase: "question-tool"` and `reason: "question-answered"`,
and no form is created at all. If the model can't answer (for example a
free-text question has no options, logged as `form-unsupported-field`),
the normal form opens for the human, and the form path deliberately
stays silent for it.

## Which log file?

Canonical: the path in `logFile` / `OLLAYA_GATE_LOG`, default
`<repo>/decisions-plugin.jsonl`. `measure.py` resolves the log in
order: `--log` flag (if given), then `OLLAYA_GATE_LOG` env, then
`logFile` from `~/.config/opencode/opencode.json` (looks in the
`plugins` array for an object whose `package` contains
`ollaya-decision-gate` and uses `options.logFile` if present: tolerates
a missing file or invalid JSON and falls through). The first source
found is the only one read; the `decisions-plugin.jsonl` /
`decisions.jsonl` cwd files are read only when none is configured. The
resolved path is printed as `log=<path>` (and included as `log` in
`--json` output). The config path can be overridden with
`OPENCODE_CONFIG_FILE` for tests. `scripts/verify_autonomy.py` reads the
log the plugin writes (`OLLAYA_GATE_LOG`, else config `logFile`, else
`<repo>/decisions-plugin.jsonl`) and drives the session with
`OLLAYA_VERIFY_MODEL` (default `opencode/nemotron-3-ultra-free`). It does
not truncate the production log; it saves the log's byte size at start
(or 0 if absent) and in its poll loop reads only new bytes via
`open("rb").seek(offset).read().decode()`.

## Still stuck?

Open a bug issue with the template: version, env, redacted log lines,
repro steps. Expectation is always fail-open to ask-human.
