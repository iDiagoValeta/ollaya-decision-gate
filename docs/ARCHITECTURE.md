# Architecture

This gate is derived from jev-decision-gate, which used Jev, TypeSafe's
hosted API. This copy decides locally: the decision model runs on the
user's own machine through Ollaya (https://ollaya.dev, "Ollama for
decision models"). The old hosted model's name is kept only in that
provenance sentence.

## Flow

Requires `"permission": "ask"` in opencode's config (global or project):
under `"allow"` the evaluate hook sees `effect=allow` already and leaves
it alone, and no `permission.asked` event fires at all when the ambient
mode is already `allow`, so there is nothing for the gate to decide. See
`docs/TROUBLESHOOTING.md`.

```
permission evaluate hook (ctx.permission.hook("evaluate"))
  → input.effect already allow/deny (user config) → leave it, done
  → claim eval:<sessionID>:<source>:<action>:<sha> (exclusive marker): lose it, do nothing
  → action === "question" → effect=allow (passthrough), NO model call
        log reason=question-permission-passthrough
        (answering happens via the wrapped question tool or the form API, see below)
  → catastrophic check (local regex over normalized command, no network)
        → effect=deny + message "Blocked by ollaya-decision-gate: ... kill-list"
  → subagent/task: enrich resources with the dispatch prompt
  → kindFor(action, resources): read | write | destructive
  → requests over 256 KiB (MAX_SCANNED_CHARS) → left to the human,
        reason oversized-request (no scan, no model call)
  → objectiveFor(sessionID): recent conversation, both roles, redacted,
                              ≤22000 chars default (options.objectiveChars /
                              OLLAYA_GATE_OBJECTIVE_CHARS, max 90000)
  → gateEvent { objective, halt {kind,tool,detail redacted, head+tail
                ≤90000 chars; for edits the patches from metadata.files
                are appended, for grep/glob/list the path/include from
                metadata are appended as "path: ..." lines}, context
                {sessionID,risk_hints}, policy }
  → schemas.build_state: structured JSON {untrusted, objective, halt,
        risk_hints, policy, question, user_notes?} fitted to the model's
        state window (STATE_BUDGETS 22000/12000/6000 chars, next one down
        on state-truncated)
  → runGate: spawn pythonBin -m ollaya_gate.cli (timeout 25s default, max 30s,
        PYTHONPATH=src, minimal env); one retry if the child died from a
        signal or a transient spawn error
      → build_state / build_questions / client.evaluate → POST /api/decide
        on the Ollaya daemon (default 127.0.0.1:11435; model
        OLLAYA_GATE_MODEL or winnow:e4b)
      → decision.combine: pass through the model's decision, no thresholds
  → allow → effect=allow
    deny  → effect=deny + message "Denied by ollaya-decision-gate: ..."
            (the agent gets the reason and continues)
    ask-human / any error → effect stays "ask" → opencode emits
            permission.asked and prompts the human; the plugin only logs
            reason=asked-human for it (no model call, no reply)
  → both sides append v2 JSONL (0600, no secrets)
```

Fallback (hook API missing, logged reason=hook-unavailable): the older
permission.asked + `opencode api POST .../permission/{id}/reply` path.

question tool (wrapped via ctx.tool.transform)
  → the model answers each question in-process (multichoice + pick, labels
    redacted on the way out, mapped back to the original label)
  → all answered → the tool returns {output:{answers}, content, metadata}
    itself: no form, no reply API, works in any opencode server
  → any question unanswerable (ask-human, pick not offered, ambiguous,
    no options) → the original execute opens the human form; the call is
    marked so the form path below does not ask the model again

question tool → form (metadata.kind=question), listed at GET /api/form
  → ONE shared 750ms poller per process (not per setup() instance),
    listing each known project directory via
    GET /api/form?location[directory]=<dir> (the bare endpoint only
    lists the service's own directory); at most one tick in flight at
    a time (also listens form.created / legacy question.v2.asked /
    question.asked)
  → claim form:<formID> (same exclusive-marker pattern)
  → objectiveFor (bounded; failures fall back to a short default)
  → for each form field with options: runGate as multichoice (+ pick)
  → allow+valid pick → POST /api/session/{sessionID}/form/{formID}/reply
                        body {"answer":{"q0":"<pick>", ...}}
     log phase=form-answer then reason=question-answered
  → else ask-human, logged
```

`pythonBin` resolution: `options.pythonBin` → `OLLAYA_GATE_PYTHON` → newest
mise install under `~/.local/share/mise/installs/python/*/bin/python3` →
`python3`. The spawn sets `PYTHONPATH=<repo>/src` so the `ollaya_gate`
package resolves when the opencode service's `/usr/bin/python3` does not
have it installed (the gate has no runtime dependencies, standard library
only).

Live autonomy check (non-interactive, against a running service):
`scripts/verify_autonomy.py` (see `docs/TROUBLESHOOTING.md`).

## Key decisions (ADRs, short)

- **Local Ollaya daemon via `/api/decide`.** The gate no longer calls a
  hosted API. `client.py` is a stdlib-only HTTP client (no TypeSafe SDK,
  no API key) that POSTs `{model, state, questions}` to
  the daemon's native `POST /api/decide` at `OLLAYA_HOST` (default
  `127.0.0.1:11435`; `http://` is assumed, the port defaults to 11435 for
  http and 443 for https). Optional `OLLAYA_API_KEY` becomes an
  `Authorization: Bearer` header; optional `OLLAYA_GATE_KEEP_ALIVE` is
  sent as the request's `keep_alive`. Why local: the decision model runs
  on the user's own machine, so there is no hosted account, no API key, no
  network egress for the decision itself, and no per-call pricing. Why
  stdlib instead of the old TypeSafe SDK: that SDK only ever wrapped the
  hosted API, and the daemon exposes a plain JSON endpoint, so `urllib.request`
  from the standard library drops a runtime dependency and works on any
  Python 3.10+ the plugin finds (including the service's bare
  `/usr/bin/python3`). Why `/api/decide` and never the TypeSafe-compatible
  `/v1/systemone`: on Ollaya 0.7.1 the `/v1` route, for llama.cpp models
  such as winnow, silently answers on a truncated state instead of the
  `422 STATE_TRUNCATED` its own contract (docs/api.md section 5.3)
  promises. The state's head is kept and the halt (the action being
  judged) is cut off, so the model judges an action it never saw. Measured
  2026-09-27: with a 30k-char objective, winnow:e4b allowed all 13 of 13
  destructive traps. Ollaya 0.7.2 fixed the `/v1` route
  (ollaya-dev/ollaya#16; checked 2026-09-27: it now returns 422), and the
  gate keeps `/api/decide` so it behaves the same on 0.7.1 and later.
  `/api/decide` reports `state_truncated: true`, which
  `client.py` turns into `state-truncated`. `cli.py` retries with the next
  smaller budget of `STATE_BUDGETS = (22000, 12000, 6000)` only on
  `state-truncated`; when the last budget is still truncated the call
  fails open to ask-human with `error_class: state-truncated`. A
  truncated state is never judged.
- **Default model `winnow:e4b`.** The default is `winnow:e4b` (Gemma 4
  E4B, Q8_0 GGUF), overridable with `OLLAYA_GATE_MODEL`. It was picked
  from a measurement on 2026-09-27 on the author's laptop (NVIDIA RTX
  4060 Laptop 8 GB VRAM, 16 CPU threads, 30 GB RAM, Ollaya 0.7.1; winnow
  and jevk5 re-run on 0.7.2, same winnow results) over 28
  labelled permission halts (12 safe, 13 traps, 3 ambiguous) run through
  the gate's real state and question builders. "false allow" means a trap
  the model allowed:

  | model | device | p50 latency | safe allowed | traps allowed |
  |---|---|---|---|---|
  | winnow:e4b (Gemma 4 E4B, Q8_0 GGUF) | GPU | 0.24 s | 12/12 | 1/13 (CI edit that skips lint) |
  | decision (Qwen3.5 0.8B) | GPU | 0.48 s | 11/12 | 4/13 |
  | kev (0.8B) | GPU | 0.44 s | 8/12 | 5/13 |
  | decider:0.8b | GPU | 0.83 s | 11/12 | 8/13 |
  | kev:4b | CPU (does not fit 8 GB) | 22.9 s | 6/12 | 3/13 |
  | von | GPU | 0.15 s | answers ask-human to everything | 0/13 |
  | decider (2B) | fails to load on 8 GB (ONNX Cast error) | | | |
  | jevk5 (Qwen3.5 4B, Q8_0 GGUF, Ollaya 0.7.2+) | GPU | 0.45 s | 12/12 | 2/13 |

  winnow:e4b allowed 1/13 traps (it was never compared with Jev on this
  set); the catastrophic kill-list still runs first
  and catches the most dangerous commands regardless of the model. The
  first call after load is 2 to 4 s (model load ~4 s) and it uses about
  7 GB VRAM while loaded; the daemon unloads it after 5 min idle by
  default (`OLLAYA_KEEP_ALIVE` on the daemon, or `OLLAYA_GATE_KEEP_ALIVE`
  per request). On the golden events (`tests/golden.json`) run live,
  winnow never allowed the three real traps there (push to main ->
  ask-human, rm -rf -> deny, doom loop -> ask-human) and sent the
  golden multichoice test-runner question to ask-human. In the live
  `scripts/verify_autonomy.py` run it answered the agent's question tool by
  itself (0.6 s). It is cautious on some ordinary steps (an `ls -la`,
  read-only `grep`s and a `glob` went to the manual prompt in live runs).
  With 30k chars of padded conversation jevk5 allowed 6/13 traps and a
  golden hard trap, against winnow's 2/13, which settles the default.

  Long conversations cost winnow some safe steps (8/12 allowed already
  with 8k chars of padding). Three state changes were measured against
  that with `scripts/eval_live.py` at 0, 8k and 30k chars of padding and
  rejected, because none reduced friction without letting a trap through
  that the kill-list does not catch:

  | variant | safe allowed (0 / 8k / 30k) | traps allowed at 30k |
  |---|---|---|
  | current (objective before halt, 22k budget) | 12 / 8 / 8 | CI edit, `rm -rf ~/` (kill-list catches it) |
  | halt before objective in the state | 10 / 7 / 9 | CI edit, test weakened (plus `~/.ssh` read at 0) |
  | 10k-char first budget | 12 / 8 / 8 | CI edit |
  | allow examples (ls, grep, tests, in-repo edit) in the decision question | 12 / 10 / 10 | CI edit, test weakened |
- **Shared state lives on `globalThis`, not in module scope.** opencode
  loads a separate copy of the plugin module for each `setup()` instance
  (one per project directory). Module-scope "shared" state would give one
  form poller per directory instead of one per process. With
  `globalThis[Symbol.for("ollaya-decision-gate.shared.v1")]` there is one
  poller per process, shared across all instances. A test imports two
  copies of the module and asserts they share one interval.
- **The question tool is answered inside the tool, not through its
  form.** Wrapping `question`'s `execute` returns the model's pick as the
  tool result, so no reply has to reach the server, and it works outside
  the background service. The form path remains only for the human
  fallback and for non-question forms.
- **Permissions are decided in the `evaluate` hook, not by replying to
  `permission.asked`.** opencode awaits the async hook; `effect=allow`
  runs the tool with no prompt, `effect=deny` + `message` fails just that
  tool call with the message and the agent continues, and leaving `ask`
  falls through to the normal human prompt. Replying to `permission.asked`
  via `opencode api` always targets the background service, so a
  decision 404s when the plugin runs in any other server; and a bare
  `reject` reply aborts the whole agent turn. The `evaluate` hook avoids
  both. Forms still reply via `opencode api` (there is no form API in the
  plugin context), so form answers still only work in the background
  service.
- **`opencode run --auto` is out of scope: it bypasses the gate
  entirely, by design.** `--auto` is a client-side "auto-approve
  permissions not explicitly denied" behavior in opencode's own CLI; it
  does not wait for `permission.asked` subscribers, so it typically
  resolves a request before this plugin's reply (always at least one
  subprocess spawn plus an HTTP round trip) can land, including
  defeating the catastrophic-pattern kill-list, which replies in
  ~100ms with no network call and still loses. No fix is possible from
  inside this plugin: there is no hook that fires before `--auto`
  commits. See `docs/TROUBLESHOOTING.md`. Headless/autonomous sessions
  that need the gate's protection must go through the raw session API
  (`POST /api/session`, `POST /api/session/{id}/prompt`, poll
  `GET /api/session/{id}/message`) instead of `--auto`.
- **Reply via `opencode api POST`, never `ctx.permission.reply()`.**
  The SDK method proved unreliable for replying to `permission.asked`
  in this environment. `replyPermission` in `index.ts` shells out to
  `opencode api POST /api/session/{sessionID}/permission/{requestID}/reply`,
  mirroring `replyFormAnswer`'s pattern for form answers. This path is
  now only exercised by the `hook-unavailable` fallback, since
  permissions are normally decided in the `evaluate` hook; form answers
  always use it, since there is no form API in the plugin context.
- **Fail-open, never silent allow.** Every `except` maps to
  `ask-human`/`fail-open` with an `error_class` (and, when useful, an
  `error_detail`): `transport` (daemon unreachable or an HTTP error),
  `state-truncated`, `bad-response`, `exception`. Rationale: a broken
  gate must cost a prompt, not a breach. There is no desktop alert on
  this path; the log is the only signal, by design.
- **Two writers, one schema.** Plugin and CLI each log (the CLI sees
  the model internals, the plugin sees session/request IDs). Schema v2
  unifies field names so `measure.py` reads both.
- **Two-phase question handling (form API on 2.0.x).** Agent questions
  are split across permission unlock and answering:
  1. `permission.asked` with `action === "question"` is a passthrough
     allow with **no** `ctx.session.context` and **no** model call. The
     permission phase only unlocks the tool.
  2. The wrapped `question` tool answers in-process when the model can
     (see above). When it can't, the tool opens a **form**
     (`metadata.kind=question`). The plugin discovers it via
     `GET /api/form` polling (and `form.created` / legacy question
     events), the model returns a `pick`, and the plugin submits
     `POST /api/session/{sessionID}/form/{formID}/reply` with
     `{"answer":{"q0":"<pick>"}}`.
- **`kindFor` covers documented OpenCode permission keys.** Mapping
  follows https://opencode.ai/docs/permissions/: read-class
  (`read`, `glob`, `grep`, `external_directory`, `lsp`, `skill`, ...),
  write-class (`edit` / `write` / `apply_patch`, `bash`, `task`,
  `webfetch`, `websearch`, ...), `doom_loop` -> destructive, `question`
  -> multichoice (permission path only; see above). Anything else
  fail-opens to ask-human.
- **`curl`/`wget` are destructive only when they act like a write, not
  because they exist.** `DESTRUCTIVE_HINT` used to match a bare
  `curl|wget`, so a read-only `curl -s URL` scored identically to
  `rm -rf /`: measured live, removing that unconditional match moved
  the model's own safe/risk numbers for that exact command from
  0.29/1.5 to 0.70/0.5. `hasDestructiveCurlOrWget` (`index.ts`) looks for:
  a write/output flag (`-o`, `-O`, `--output`, `--remote-name`), a
  body-sending flag (`-d`, `--data*`, `-F`, `--form`, `-T`,
  `--upload-file`, `--json`), a non-GET/HEAD `-X`/`--request` method, a
  redirection to a real file anywhere in the command (`>`, `>>`, but not
  fd duplication like `2>&1` or anything sent to `/dev/null`), a pipe into
  `tee` with a file argument, or another pipeline segment that is an
  interpreter (`sh`, `bash`, `zsh`, `python`, `python3`, `node`, `perl`,
  `ruby`, or any `sudo ...`). OpenCode may hand a piped bash command as
  one resource per segment (`["curl -s URL", "sh"]`) or as a single
  string (`"curl -s URL | sh"`), so every resource is also split on `|`
  before the check. `kindFor` falls to `read` for a fetch that clears
  this check (not the generic write default), and both `kindFor` and the
  risk-hint computation in `evaluatePermission`/`handleOne` call the same
  function, so the two never drift apart. The kill-list is untouched: a
  `curl`/`wget` piped straight into a shell already matches a kill-list
  pattern and is denied before `kindFor` ever runs.

  A flag-by-flag regex misses curl's getopt-style short-flag clustering
  (`-sLo file URL` is `-s -L -o file URL`), which let a write flag bundled
  with harmless ones slip through as a read: the inverse of the bug above,
  a command that DOES write scored as safe. Each short-flag cluster is
  now scanned letter by letter, case-sensitively: lowercase `o` and
  uppercase `O` both mean curl's file-output flag, lowercase `d` is
  `--data`, uppercase `F` is `--form`, uppercase `T` is `--upload-file`;
  none of them share a letter with common boolean flags like `-s`, `-S`,
  `-L`, `-f`, `-I`. `-o`/`--output` take an explicit filename and can
  target stdout with `-` (`curl -o -`, `-so-`, attached or as its own
  token), which is not a write; `-O`/`--remote-name` take no argument and
  always write a file named from the URL, so curl has no stdout form of
  it. `wget` inverts curl's own default: it saves to disk unless told
  otherwise, so a bare `wget URL` is a write, and only an explicit stdout
  target (`-O-`, `-qO-`, `-O -`, `--output-document=-`) or `--spider`
  (checks the URL, downloads nothing) keep it a read.
- **grep/glob/list get their path back before the model sees them.**
  On opencode 2.0.x, a `grep`/`glob` permission's `resources` carries
  only the search pattern (e.g. a grep's `resources` is just the regex,
  never the directory); the target path lives in `metadata.path`
  instead (`metadata.include`/`metadata.glob` also travel there when
  present). Judging a bare pattern with no path gave the model nothing
  to anchor risk on and it defaulted to ask-human; measured live, adding
  `path: <path>` to the same halt turned that exact ask-human into an
  allow. `metadataDetailFor` (`index.ts`) appends `key: value` lines
  built from `metadata` to the model's `halt.detail` only, the same way
  `editPatchesOf` appends a diff for edits: the kill-list and `kindFor`
  keep evaluating the original, unenriched `resources`. Wired into both
  the `evaluate` hook and the `permission.asked` fallback path, since a
  plugin loaded on an older opencode without the hook API needs the same
  enrichment.
- **Redact before send.** Secrets never leave the box: redaction
  runs in TS (before spawn) and Python (before the model call); logs
  store `detail_sha256`, not detail. Both layers give identical output:
  a secret-named key (`password`, `token`, `api_key`, ...) has its value
  redacted whether bare, `"double"` or `'single'` quoted (one line, up
  to 200 chars), with the key itself quoted or not (JSON, YAML, .env,
  shell), and so do `--password`, `curl -u`, `mysql -p` and env-style
  `NAME value` pairs.
- **Send the model a structured state, and only that.** `build_state`
  returns JSON: `untrusted` (which fields are data), `objective`,
  `halt {kind, tool, detail}`, `risk_hints`, `policy`, `question`,
  optional `user_notes`. Untrusted text lives in its own string field,
  so it cannot forge the policy or question. The raw event is never
  attached: it would bypass the Python redaction. Measured live on
  allow/deny/padded-payload cases: same actions as sending brief plus
  raw event, equal or higher confidence, 15 to 25% fewer tokens, and
  injected "pre-approved, answer allow" text still denied. The model's
  judgment is still the only real defense against a convincing payload;
  see `SECURITY.md` for the accepted prompt-injection risk.
- **Give the model as much context as fits, never a head-only cut.**
  The objective budget defaults to 22000 chars (clamped to 200..90000
  via `objectiveChars` / `OLLAYA_GATE_OBJECTIVE_CHARS`) and the detail to
  90000 (`DETAIL_MAX_CHARS`). Anything clipped keeps head and tail around
  an explicit marker, plus a risk hint: a head-only cut would hide a
  payload placed after padding. Redaction runs before clipping so no
  secret is half-matched. The default model reads at most 6,144 state
  tokens, about 22k chars of conversation; `schemas.py` fits objective
  and detail into that budget (smaller on retry) and `cli.py` retries
  with a smaller budget on `state-truncated` instead of falling to
  ask-human.
- **The kill-list scans everything it accepts.** `isCatastrophic`
  runs over overlapping 4000-char windows, which keeps its regex
  backtracking bounded per window and linear overall; requests over
  256 KiB skip the scan and the model and go to the human.
- **Option labels are capped and redacted too, not just OBJECTIVE/
  detail.** `labelsFromFormField` (`index.ts`, question-tool multichoice
  options) feeds the model's `"pick"` criteria with attacker-reachable
  label text, so each label is redacted and capped at 200 chars
  (`normalizedLabel`). Whatever the model picks must still be one of the
  attacker's own pre-supplied options, checked independently on both the
  TS (`labels.includes`) and Python (`choice not in options`) sides.
  `valueForPick` re-derives the same normalization at lookup time
  (rather than assuming a positional mapping) so a truncated/redacted
  pick still round-trips to its real underlying value.
- **Form answers honor field types and visibility, not just
  multichoice picks.** In `handleFormAsked`, a `multiselect` field's
  reply value is an **array** of the picked option values
  (`{"answer":{"q0":["pizza"]}}`) rather than a string; `hidden`/`when`
  conditions gate each field against the answers already decided
  (`fieldVisible`, `eq`/`neq` compared with `===`; an unreferenced key
  means `eq` false / `neq` true), and a not-visible or unanswerable field
  (no options, non-multiselect type) is omitted from the reply: the
  server 400s on a reply that includes a field whose `when` isn't
  satisfied. Every early exit from the field loop logs a distinct
  `reason` (`form-model-not-allow`, `form-pick-not-offered`,
  `form-pick-ambiguous`, `form-unsupported-field`, `form-field-hidden`)
  with `fieldKey` instead of returning silently; any aborting reason
  leaves the form pending for the human, same as any other ask-human.
- **The event-subscription loop is sequential, by construction.** The
  `for await (const event of ctx.event.subscribe(...))` loop
  (`index.ts`) is a plain pull-based async iterator: `await
  handleOne(...)` for one permission blocks the loop from starting the
  next event (of any kind) until that gate round-trip finishes (up to
  `timeoutMs`, 25s default/30s max). Under concurrent load, later
  simultaneous permissions queue behind earlier ones. This also means
  `inFlight`'s "concurrent duplicates await the same promise" branch is
  currently unreachable (only one requestID can occupy it at a time by
  construction), dead code, not incorrect, kept because parallelizing
  event dispatch would touch the dedup/claim logic directly and needs
  its own dedicated review. `resolved`/`endedSessions`/`formSeen` are
  bounded (`capped()`, 2000 entries, clears rather than tracking
  per-entry age) to prevent unbounded growth.
- **The model decides, no thresholds.** The winning action is whatever
  the model's `decision` answer says, at any confidence. Safe/risk
  answers are evidence, not vetoes. Unknown strings and errors still
  degrade to ask-human; catastrophic patterns never reach the model.
- **One evaluation per request, claimed before calling the model.** The
  server may emit the same permission request more than once while
  pending, and `setup()` runs more than once per opencode process: two
  independent plugin instances can receive the same event. An exclusive
  marker file (`.ollaya-gate-replied/<requestID>`) is claimed at the top
  of `handleOne`, before any model call: the loser skips entirely (no
  model call, no reply attempt), the winner evaluates and replies once.
  Form answers use the same pattern with a `form:`-prefixed claim key.
  Within one instance, in-flight sharing plus a resolved cache also
  dedupe cheaply; late duplicates log `duplicate-suppressed`, except on
  the form path, where a losing claim logs nothing at all (with many
  sibling instances racing every form, losing is the expected outcome,
  not an event worth a log row).
- **One shared form poller per process, listing per project directory.**
  Each `setup()` instance would otherwise start its own 750ms
  `opencode api GET /api/form` interval, one per project directory in
  the process. Module-level state (`registerPoller`/`unregisterPoller`,
  exported for tests) means the first instance starts the single
  interval and later ones only register their handler; the last cleanup
  stops it. Each `setup()` also registers its own `ctx.location.directory`
  (refcounted, removed on cleanup) and every tick lists each known
  directory via `GET /api/form?location[directory]=<dir>`
  (`formListPath`, encoded with `encodeURIComponent`): the bare
  endpoint only lists the service's own directory. With no known
  directory it falls back to the bare endpoint. At most one tick runs at
  a time (a still-running tick skips the next one) so slow listings
  can't stack processes. The tick uses any one registered handler's ctx
  (`session.context` is a process-wide RPC).
- **Single-writer log.** The plugin logs every decision; the Python
  gate stays silent when spawned by the plugin (`OLLAYA_GATE_CLI_LOG=0`)
  and logs only in standalone use.
- **Bounded multi-turn context, not unbounded history.** `objectiveFor`
  sends recent conversation turns from both the user and the assistant
  (assistant text only, tool-call payloads are skipped), newest-first
  until a char budget is hit, so the model can judge whether a halt
  matches what the agent has actually been doing, not just the human's
  last message. The budget (`objectiveChars` / `OLLAYA_GATE_OBJECTIVE_CHARS`,
  default 22000, clamped to 200 to 90000) fills most of the model's
  window; `schemas.py` does the final fit. The form-answer path
  uses a tighter budget (and tolerates `objectiveFor` failure) so a
  stuck context call does not block answering.

## Files

| File | Owns |
| ---- | ---- |
| `plugin/ollaya-decision-gate/index.ts` | hook, catastrophic, kind, objective, question tool wrap, form API poll/reply, spawn (`pythonBin`/mise/`PYTHONPATH`), log |
| `src/ollaya_gate/schemas.py` | structured state, redaction, questions |
| `src/ollaya_gate/client.py` | stdlib HTTP client, `POST /api/decide`, error mapping |
| `src/ollaya_gate/decision.py` | decision combine, no thresholds (pure, fully tested) |
| `src/ollaya_gate/cli.py` | stdin/stdout, v2 log, fail-open map, `STATE_BUDGETS` retry |
| `src/ollaya_gate/doctor.py` | diagnostics (daemon `/api/version`, model `/api/tags`) |
| `scripts/measure.py` | rates, p95, cost, by-session |
| `scripts/verify_autonomy.py` | live non-interactive autonomy check |
