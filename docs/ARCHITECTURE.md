# Architecture

## Flow

Requires `"permission": "ask"` in opencode's config (global or project):
under `"allow"` the evaluate hook sees `effect=allow` already and leaves
it alone, and no `permission.asked` event fires at all when the ambient
mode is already `allow`, so there is nothing for the gate to decide. See
`docs/TROUBLESHOOTING.md`.

```
permission evaluate hook (ctx.permission.hook("evaluate"))
  → input.effect already allow/deny (user config) → leave it, done
  → claim eval:<sessionID>:<source>:<action>:<sha> (exclusive marker) — lose it, do nothing
  → action === "question" → effect=allow (passthrough), NO Jev
        log reason=question-permission-passthrough
        (answering happens via the wrapped question tool or the form API — see below)
  → catastrophic check (local regex over normalized command, no network)
        → effect=deny + message "Blocked by ollaya-decision-gate: ... kill-list"
  → subagent/task: enrich resources with the dispatch prompt
  → kindFor(action, resources): read | write | destructive
  → requests over 256 KiB (MAX_SCANNED_CHARS) → left to the human,
        reason oversized-request (no scan, no Jev)
  → objectiveFor(sessionID): recent conversation, both roles, redacted,
                              ≤60000 chars default (options.objectiveChars /
                              OLLAYA_GATE_OBJECTIVE_CHARS, max 90000)
  → gateEvent { objective, halt {kind,tool,detail redacted, head+tail
                ≤90000 chars; for edits the patches from metadata.files
                are appended}, context {sessionID,risk_hints}, policy }
  → schemas.build_state: structured JSON {untrusted, objective, halt,
        risk_hints, policy, question, user_notes?} fitted to Jev's ~33k-token
        window (budgets 90k/45k/20k chars, next one on max_tokens_exceeded)
  → runGate: spawn pythonBin -m ollaya_gate.cli (timeout 25s default, max 30s,
        PYTHONPATH=src, minimal env); one retry if the child died from a
        signal or a transient spawn error
      → build_state / build_questions / client.evaluate → Jev (system_one)
      → decision.combine: pass through Jev's decision, no thresholds
  → allow → effect=allow
    deny  → effect=deny + message "Denied by ollaya-decision-gate (Jev): ..."
            (the agent gets the reason and continues)
    ask-human / any error → effect stays "ask" → opencode emits
            permission.asked and prompts the human; the plugin only logs
            reason=asked-human for it (no Jev, no reply)
  → both sides append v2 JSONL (0600, no secrets)

Fallback (hook API missing, logged reason=hook-unavailable): the older
permission.asked + `opencode api POST .../permission/{id}/reply` path.

question tool (wrapped via ctx.tool.transform)
  → Jev answers each question in-process (multichoice + pick, labels
    redacted on the way out, mapped back to the original label)
  → all answered → the tool returns {output:{answers}, content, metadata}
    itself: no form, no reply API, works in any opencode server
  → any question unanswerable (ask-human, pick not offered, ambiguous,
    no options) → the original execute opens the human form; the call is
    marked so the form path below does not ask Jev again

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
`python3`. The spawn sets `PYTHONPATH=<repo>/src` so `typesafe_sdk`
works when the opencode service's `/usr/bin/python3` lacks it.

Live autonomy check (non-interactive, against a running service):
`scripts/verify_autonomy.py` — see `docs/TROUBLESHOOTING.md`.

## Key decisions (ADRs, short)

- **Shared state lives on `globalThis`, not in module scope.** opencode
  loads a separate copy of the plugin module for each `setup()` instance
  (one per project directory). Module-scope "shared" state would give one
  form poller per directory instead of one per process. With
  `globalThis[Symbol.for("ollaya-decision-gate.shared.v1")]` there is one
  poller per process, shared across all instances. A test imports two
  copies of the module and asserts they share one interval.
- **The question tool is answered inside the tool, not through its
  form.** Wrapping `question`'s `execute` returns Jev's pick as the tool
  result, so no reply has to reach the server, and it works outside the
  background service. The form path remains only for the human fallback
  and for non-question forms.
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
- **`opencode run --auto` is out of scope — it bypasses the gate
  entirely, by design.** `--auto` is a client-side "auto-approve
  permissions not explicitly denied" behavior in opencode's own CLI; it
  does not wait for `permission.asked` subscribers, so it typically
  resolves a request before this plugin's reply (always at least one
  subprocess spawn plus an HTTP round trip) can land — including
  defeating the catastrophic-pattern kill-list, which replies in
  ~100ms with no network call and still loses. No fix is possible from
  inside this plugin — there is no hook that fires before `--auto`
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
  `error_detail`). Rationale: a broken gate must cost a prompt, not a
  breach. There is no desktop alert on this path; the log is the only
  signal, by design.
- **Two writers, one schema.** Plugin and CLI each log (the CLI sees
  the Jev internals, the plugin sees session/request IDs). Schema v2
  unifies field names so `measure.py` reads both.
- **Two-phase question handling (form API on 2.0.x).** Agent questions
  are split across permission unlock and answering:
  1. `permission.asked` with `action === "question"` — passthrough
     allow with **no** `ctx.session.context` and **no** Jev call. The
     permission phase only unlocks the tool.
  2. The wrapped `question` tool answers in-process when Jev can
     (see above). When it can't, the tool opens a **form**
     (`metadata.kind=question`). The plugin discovers it via
     `GET /api/form` polling (and `form.created` / legacy question
     events), Jev returns a `pick`, and the plugin submits
     `POST /api/session/{sessionID}/form/{formID}/reply` with
     `{"answer":{"q0":"<pick>"}}`.
- **`kindFor` covers documented OpenCode permission keys.** Mapping
  follows https://opencode.ai/docs/permissions/: read-class
  (`read`, `glob`, `grep`, `external_directory`, `lsp`, `skill`, …),
  write-class (`edit` / `write` / `apply_patch`, `bash`, `task`,
  `webfetch`, `websearch`, …), `doom_loop` → destructive, `question`
  → multichoice (permission path only; see above). Anything else
  fail-opens to ask-human.
- **Redact before send.** Secrets never leave the box: redaction
  runs in TS (before spawn) and Python (before Jev call); logs store
  `detail_sha256`, not detail. Both layers give identical output: a
  secret-named key (`password`, `token`, `api_key`, ...) has its value
  redacted whether bare, `"double"` or `'single'` quoted (one line, up
  to 200 chars), with the key itself quoted or not (JSON, YAML, .env,
  shell), and so do `--password`, `curl -u`, `mysql -p` and env-style
  `NAME value` pairs.
- **Send Jev a structured state, and only that.** `build_state`
  returns JSON: `untrusted` (which fields are data), `objective`,
  `halt {kind, tool, detail}`, `risk_hints`, `policy`, `question`,
  optional `user_notes`. Untrusted text lives in its own string field,
  so it cannot forge the policy or question. The raw event is never
  attached: it would bypass the Python redaction. Measured live on
  allow/deny/padded-payload cases: same actions as sending brief plus
  raw event, equal or higher confidence, 15 to 25% fewer tokens, and
  injected "pre-approved, answer allow" text still denied. Jev's judgment is still the only real defense against a
  convincing payload; see `SECURITY.md` "Accepted risk: prompt
  injection into Jev's state".
- **Give Jev as much context as fits, never a head-only cut.** Jev is
  cheap (a 90k-char state answers in 1 to 2 s), so the objective budget
  defaults to 60000 chars and the detail to 90000. Anything clipped
  keeps head and tail around an explicit marker, plus a risk hint:
  a head-only cut would hide a payload placed after padding. Redaction
  runs before clipping so no secret is half-matched. The window is
  about 33k tokens (a 95k-char English state used 32.8k); `cli.py`
  retries with a smaller budget on `max_tokens_exceeded` instead of
  falling to ask-human.
- **The kill-list scans everything it accepts.** `isCatastrophic`
  runs over overlapping 4000-char windows, which keeps its regex
  backtracking bounded per window and linear overall; requests over
  256 KiB skip the scan and Jev and go to the human.
- **Option labels are capped and redacted too, not just OBJECTIVE/
  detail.** `labelsFromFormField` (`index.ts`, question-tool multichoice
  options) feeds Jev's `"pick"` criteria with attacker-reachable label
  text, so each label is redacted and capped at 200 chars
  (`normalizedLabel`). Whatever Jev picks must still be one of the
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
  ⇒ `eq` false / `neq` true), and a not-visible or unanswerable field
  (no options, non-multiselect type) is omitted from the reply — the
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
  construction) — dead code, not incorrect, kept because parallelizing
  event dispatch would touch the dedup/claim logic directly and needs
  its own dedicated review. `resolved`/`endedSessions`/`formSeen` are
  bounded (`capped()`, 2000 entries, clears rather than tracking
  per-entry age) to prevent unbounded growth.
- **Jev decides, no thresholds.** The winning action is whatever
  Jev's `decision` answer says, at any confidence. Safe/risk answers
  are evidence, not vetoes. Unknown strings and errors still degrade
  to ask-human; catastrophic patterns never reach Jev.
- **One evaluation per request, claimed before calling Jev.** The
  server may emit the same permission request more than once while
  pending, and `setup()` runs more than once per opencode process — two
  independent plugin instances can receive the same event. An exclusive
  marker file (`.ollaya-gate-replied/<requestID>`) is claimed at the top of
  `handleOne`, before any Jev call: the loser skips entirely (no Jev
  call, no reply attempt), the winner evaluates and replies once. Form
  answers use the same pattern with a `form:`-prefixed claim key. Within
  one instance, in-flight sharing plus a resolved cache also dedupe
  cheaply; late duplicates log `duplicate-suppressed` — except on the
  form path, where a losing claim logs nothing at all (with many sibling
  instances racing every form, losing is the expected outcome, not an
  event worth a log row).
- **One shared form poller per process, listing per project directory.**
  Each `setup()` instance would otherwise start its own 750ms
  `opencode api GET /api/form` interval, one per project directory in
  the process. Module-level state (`registerPoller`/`unregisterPoller`,
  exported for tests) means the first instance starts the single
  interval and later ones only register their handler; the last cleanup
  stops it. Each `setup()` also registers its own `ctx.location.directory`
  (refcounted, removed on cleanup) and every tick lists each known
  directory via `GET /api/form?location[directory]=<dir>`
  (`formListPath`, encoded with `encodeURIComponent`) — the bare
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
  until a char budget is hit, so Jev can judge whether a halt matches
  what the agent has actually been doing — not just the human's last
  message. The budget (`objectiveChars` / `OLLAYA_GATE_OBJECTIVE_CHARS`,
  default 60000, clamped to 200 to 90000) fills most of Jev's window;
  `schemas.py` does the final fit. The form-answer path
  uses a tighter budget (and tolerates `objectiveFor` failure) so a
  stuck context call does not block answering.

## Files

| File | Owns |
| ---- | ---- |
| `plugin/ollaya-decision-gate/index.ts` | hook, catastrophic, kind, objective, question tool wrap, form API poll/reply, spawn (`pythonBin`/mise/`PYTHONPATH`), log |
| `src/ollaya_gate/schemas.py` | structured state, redaction, questions |
| `src/ollaya_gate/client.py` | SDK wrapper, usage passthrough |
| `src/ollaya_gate/decision.py` | decision combine, no thresholds (pure, fully tested) |
| `src/ollaya_gate/cli.py` | stdin/stdout, v2 log, fail-open map |
| `src/ollaya_gate/doctor.py` | diagnostics |
| `scripts/measure.py` | rates, p95, cost, by-session |
| `scripts/verify_autonomy.py` | live non-interactive autonomy check |
