import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Catastrophic patterns: rejected instantly without calling the model.
// Checked against a NORMALIZED command string (lowercased, quotes/
// separators collapsed) so trivial obfuscation does not bypass them.
//
// Known, accepted false-positive trade-off (present since quote-stripping
// was added, widened by backslash-stripping): stripping quotes/backslashes
// to defeat obfuscation also means descriptive text that merely MENTIONS a
// dangerous command inside quotes can normalize into something that matches
// e.g. `echo "talk about rm -rf / here"` or `echo "rm -r\f / in docs"`
// both normalize to a string containing `rm -rf /`. This fails closed (the
// command is rejected, not silently allowed) so it's a usability cost, not
// a security hole, and there is no narrower fix available: restricting
// backslash-stripping to avoid this would reopen the r\m obfuscation bypass
// it exists to close (confirmed: `r\m` has a backslash between two
// letters, same shape as the false-positive case). A real shell parser
// could tell prose from syntax; a regex-based kill-list can't.
const CATASTROPHIC = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\S*\s+)*(\/(?!\S)|\/\*|~(?!\S)|~\/(?!\S)|\$home(?!\S)|\$home\/(?!\S)|\${home}(?!\S)|\${home}\/(?!\S)|\/home(?!\S)|\/home\/[^/\s]+(?!\S)|\/root(?!\S)|\.(?!\S)|\.\/(?!\S)|\.\.(?!\S)|\.\.\/(?!\S))/,
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+.*--no-preserve-root/,
  /\bmkfs\b/,
  /\bdd\b\s+.*\bof=\/dev\//,
  />\s*\/dev\/(sd[a-z]|nvme\d+n\d+|vd[a-z]|hd[a-z])/,
  /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/,
  /\bchmod\s+(-R\s+)?777\s+(\/|~|\$home|\${home}|\/home|\/etc|\/usr)/,
  /\bchown\s+-R\s+\S+\s+(\/|~|\/etc|\/usr)/,
  /:\(\)\s*\{\s*:\|\:&\s*\}\s*;/,
  /\bsudo\s+rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+/,
  /\bfind\s+\/\S*\s+.*-delete\b/,
  /\bcurl\b.*\|\s*(sh|bash|sudo\s+bash)\b/,
  /\bwget\b.*\|\s*(sudo\s+bash|sh|bash)\b/,
  /\bbase64\s+(-d|--decode)\b.*\|\s*(sh|bash)\b/,
  // Remote code run through substitution instead of a pipe: `bash -c
  // "$(curl ...)"`, `eval "$(wget ...)"`, `source <(curl ...)`. Only a
  // fetch (curl/wget) directly inside the substitution counts, so local
  // `eval "$(ssh-agent -s)"` or `source <(kubectl completion bash)` pass.
  /\b(sh|bash|zsh|dash|ksh)\s+(-[a-z]+\s+)*-[a-z]*c\s+["']?\s*(\$\(|`)\s*(curl|wget)\b/,
  /\beval\s+["']?\s*(\$\(|`)\s*(curl|wget)\b/,
  /(^|[\s(])(source|sh|bash|zsh|\.)\s+<\(\s*(curl|wget)\b/,
  /\b(powershell|pwsh)\b.*\biex\b/i,
  /\bgit\s+push\b.*--(force|mirror)\b/,
  /\bgit\s+push\b.*\s+(-f)(?!\S)/,
  /\bgh\s+repo\s+delete\b/,
  /\bkubectl\s+delete\b.*--all/,
  /\bterraform\s+destroy\b/,
  /\baws\s+s3\s+rm\b.*--recursive/,
  /\bdocker\s+system\s+prune\b/,
  /\bdrop\s+(table|database)\b/i,
]

const DESTRUCTIVE_HINT = /(^|\s)(rm\s+-rf|sudo|git\s+push|git\s+reset\s+--hard|git\s+clean\s+-fd?|kubectl\s+delete|terraform\s+(apply|destroy)|npm\s+publish|cargo\s+publish|drop\s+(table|database)|docker\s+(rm|system)|aws\s+s3)/i

// curl/wget used to be an unconditional DESTRUCTIVE_HINT match, so a
// read-only `curl -s URL` scored the same as `rm -rf /`: measured live,
// the model's own safe/risk numbers moved from 0.29/1.5 to 0.70/0.5 once
// the hint was removed for that exact command. They now count as
// destructive only when they write to disk, send a request body, use a
// non-idempotent method, or when another segment of the same pipeline is
// an interpreter (a fetch piped straight into a shell has an effect no
// static check can determine). opencode splits a piped bash command into
// one resource per pipeline segment (`curl -s URL | sh` arrives as
// `["curl -s URL", "sh"]`), so every resource is checked; each resource is
// also split on "|" in case a single resource still holds the whole
// pipeline as one string.
//
// Bundled short flags (getopt-style clustering, e.g. `-sLo` is -s -L -o)
// are invisible to a flag-by-flag regex, so each short-flag cluster is
// scanned letter by letter. The letters are checked case-sensitively on
// purpose: curl's -o/-O/-d/-F/-T share no letters with common boolean
// flags like -s/-S/-L/-f/-I.
//   o (lower): --output, takes an explicit filename and can target
//              stdout via "-" (`curl -o -` / `-so-`), which is not a
//              write.
//   O (upper): --remote-name, takes no argument and always writes to a
//              file named from the URL; curl has no stdout form of it.
//   d (lower): --data*, sends a request body.
//   F (upper): --form, sends a request body.
//   T (upper): --upload-file, uploads a file.
const CURL_SHORT_CLUSTER = /(^|\s)-([a-zA-Z]+)/g

// True when the text right after a value-taking flag is the stdout marker
// "-", attached ("-o-") or as its own next token ("-o -" / "-o - url").
function targetsStdout(rest: string): boolean {
  return /^\s*-(?=\s|$)/.test(rest)
}

function curlClusterIsWrite(segment: string): boolean {
  CURL_SHORT_CLUSTER.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CURL_SHORT_CLUSTER.exec(segment)) !== null) {
    const letters = m[2]
    if (/[dFT]/.test(letters) || letters.includes("O")) return true
    if (letters.includes("o") && !targetsStdout(segment.slice(m.index + m[0].length))) return true
  }
  return false
}

const CURL_LONG_WRITE_FLAGS = /(^|\s)(--remote-name\b|--data(-[a-z]+)?\b|--form\b|--upload-file\b|--json\b)/
const CURL_OUTPUT_LONG = /(^|\s)--output(?:=|\s+)(\S*)/

function curlMethodIsWrite(segment: string): boolean {
  const m = segment.match(/(?:-X|--request)[ =]+["']?([A-Za-z]+)/i)
  if (!m) return false
  const method = m[1].toUpperCase()
  return method !== "GET" && method !== "HEAD"
}

function curlWrites(segment: string): boolean {
  if (curlClusterIsWrite(segment)) return true
  if (CURL_LONG_WRITE_FLAGS.test(segment)) return true
  const outputMatch = CURL_OUTPUT_LONG.exec(segment)
  if (outputMatch && outputMatch[2] !== "-") return true
  return curlMethodIsWrite(segment)
}

// wget saves to disk by default, the opposite default from curl (which
// prints to stdout unless told otherwise): only an explicit stdout target
// or --spider (checks the URL, downloads nothing) keep it a read.
const WGET_STDOUT_SHORT_ATTACHED = /-[a-zA-Z]*O-(?!\S)/
const WGET_STDOUT_SHORT_SPACED = /-[a-zA-Z]*O\s+-(?=\s|$)/
const WGET_STDOUT_LONG = /--output-document(?:=|\s+)-(?=\s|$)/
const WGET_SPIDER = /--spider\b/

function wgetWrites(segment: string): boolean {
  if (WGET_SPIDER.test(segment)) return false
  const stdout =
    WGET_STDOUT_SHORT_ATTACHED.test(segment) || WGET_STDOUT_SHORT_SPACED.test(segment) || WGET_STDOUT_LONG.test(segment)
  return !stdout
}

const PIPELINE_INTERPRETER = /(^|\s)(sudo\b|sh\b|bash\b|zsh\b|python3?\b|node\b|perl\b|ruby\b)/i

// A redirection to a real file anywhere in the command is a write, even
// with no curl/wget flag involved (`curl -s URL > out.json`). fd
// duplication (`2>&1`) and anything sent to /dev/null are not writes.
const FILE_REDIRECT = /(?:^|\s)&?\d*>{1,2}(?!&)\s*(\S*)/g
function hasFileRedirect(segment: string): boolean {
  FILE_REDIRECT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILE_REDIRECT.exec(segment)) !== null) {
    const target = m[1].toLowerCase()
    if (target && target !== "/dev/null") return true
  }
  return false
}

// `curl ... | tee out.txt` writes just as much as `curl -o out.txt ...`.
const TEE_WITH_FILE = /\btee\b\s+\S+/

export function hasDestructiveCurlOrWget(resources: readonly string[]): boolean {
  const segments = resources.flatMap((r) => r.split("|"))
  const fetchSegments = segments.filter((s) => /\b(curl|wget)\b/i.test(s))
  if (fetchSegments.length === 0) return false
  if (segments.some((s) => hasFileRedirect(s))) return true
  if (segments.some((s) => TEE_WITH_FILE.test(s))) return true
  if (fetchSegments.some((s) => (/\bwget\b/i.test(s) ? wgetWrites(s) : curlWrites(s)))) return true
  return segments.some((s) => !/\b(curl|wget)\b/i.test(s) && PIPELINE_INTERPRETER.test(s))
}

// Command substitution ($(...) or `...`) can hide a command's real effect
// from both the kill-list and normalizeCommand (neither evaluates it),
// not blockable by regex, so it's surfaced to the model as a hint instead.
const COMMAND_SUBSTITUTION = /\$\(|`/

const SECRET_PATTERNS: RegExp[] = [
  /bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
  /basic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9\-_]{8,}|xox[bpas]-[A-Za-z0-9\-_]{8,})\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // Raw JWT (no Bearer prefix): three base64url segments, starts "eyJ"
  // (base64 of the JSON header's leading `{"`).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
]

export function normalizeCommand(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'`\\]/g, "")
    .replace(/\$\{ifs\}/g, " ")
    .replace(/\$ifs\b/g, " ")
    .replace(/[;&|]+/g, " ")
    .replace(/\/bin\/rm\b/g, "rm")
    .replace(/\/usr\/bin\/rm\b/g, "rm")
    .replace(/\s+/g, " ")
    .trim()
}

// Keeps head and tail when text exceeds limit: a head-only cut would hide
// whatever follows padding (e.g. `echo <2000 chars> && curl ... | sh`).
// Call it on already-redacted text, so a secret split by the cut is never
// half-matched by the redaction patterns. Slices by code point.
export const OMITTED_MARK = "[... middle omitted by ollaya-decision-gate ...]"
// TS-side pre-clip before send: schemas.py STATE_BUDGETS does the final fit.
const DETAIL_MAX_CHARS = 90000
export function clipHeadTail(text: string, limit: number): string {
  const cps = Array.from(text)
  if (cps.length <= limit) return text
  const keep = Math.max(0, limit - OMITTED_MARK.length - 2)
  const head = Math.ceil(keep / 2)
  return `${cps.slice(0, head).join("")}\n${OMITTED_MARK}\n${cps.slice(cps.length - (keep - head)).join("")}`
}

export function redactSecrets(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, "[REDACTED]")
  }
  // scheme://user:PASSWORD@host: redact only the password, keep the
  // rest (host/port/path) visible for debugging context. Scheme repetition
  // is bounded to 20 (real schemes are a handful of chars): an unbounded
  // `*` here is O(n^2) on long input with no "://" anywhere, since the
  // engine retries a greedy-then-backtrack search from every position.
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]{0,20}:\/\/[^\s/:@]+):([^\s/@]{1,})@/g, "$1:[REDACTED]@")
  // Keyword may be embedded in a longer identifier (AWS_SECRET_ACCESS_KEY=...),
  // not just stand alone (password=...); the keyword can appear anywhere
  // in the token, not only at its start. The flanking runs are bounded
  // to 56: unbounded stars here are O(n^2) on keyword-dense input with no
  // "=" anywhere, since each mid-string keyword match re-scans an O(n)
  // greedy tail looking for a separator that never comes.
  // Value can be unquoted ([^\s"']{4,}), double-quoted ("[^"\n]{1,200}"),
  // or single-quoted ('[^'\n]{1,200}'). Quoted values may contain spaces.
  // The key may also be quoted (JSON/YAML: "api_key": "value").
  out = out.replace(
    /(["']?\b[a-z0-9_]{0,56}(?:api[_-]?key|password|passwd|secret|token)[a-z0-9_]{0,56}\b["']?\s*[:=]\s*)(?:("([^"\n]{1,200})")|('([^'\n]{1,200})')|([^\s"']{4,}))/gi,
    "$1[REDACTED]",
  )
  // Secrets passed as CLI flag values rather than KEY=VALUE. Every
  // repetition below is bounded, for the same O(n^2) reason as above.
  // curl -u/--user user:pass (keep the user, redact only the password).
  // Password can be unquoted ([^\s'"`]{1,200}), double-quoted ("[^"\n]{1,200}"),
  // or single-quoted ('[^'\n]{1,200}'). Quoted values may contain spaces.
  out = out.replace(
    /(--user\s+|-u\s+)([^\s:'"]{1,100}):(?:("([^"\n]{1,200})")|('([^'\n]{1,200})')|([^\s'"`]{1,200}))/g,
    "$1$2:[REDACTED]",
  )
  // --password value / --password=value on any command (single-dash too).
  // Value can be unquoted ([^\s'"`]{1,200}), double-quoted ("[^"\n]{1,200}"),
  // or single-quoted ('[^'\n]{1,200}'). Quoted values may contain spaces.
  out = out.replace(
    /(^|[\s;|&({['"`])(-{1,2}password)(=|\s+)(?:("([^"\n]{1,200})")|('([^'\n]{1,200})')|([^\s'"`]{1,200}))/gi,
    "$1$2$3[REDACTED]",
  )
  // VAR VALUE with no "=" (env-style: PGPASSWORD hunter2, or
  // `aws configure set aws_secret_access_key hunter2`). The name must be
  // env-var-shaped (ALL-CAPS or containing an underscore), so prose like
  // `fix password reset flow` or `grep -r token src/` is untouched.
  // Value can be unquoted ([^\s'"`]{4,200}), double-quoted ("[^"\n]{1,200}"),
  // or single-quoted ('[^'\n]{1,200}'). Quoted values may contain spaces.
  // One bounded token run, with the keyword/caps/underscore checks done
  // in code rather than as nested `[A-Za-z0-9_]*keyword[A-Za-z0-9_]*`
  // stars in the regex, which is O(n^2) on underscore-dense input.
  // Overlapping candidates (`set aws_secret_access_key VALUE`: the
  // rejected `set ...` pair must not swallow the real token) rule out a
  // plain replace(); hence the manual scan, which advances one char on
  // reject (bounded re-scan, still O(n) overall).
  const pairRe = /\b([A-Za-z0-9_]{1,64})\s+(?:("([^"\n]{1,200})")|('([^'\n]{1,200})')|([^\s'"`]{4,200}))/g
  let scanned = ""
  let pos = 0
  pairRe.lastIndex = 0
  let pm: RegExpExecArray | null
  while ((pm = pairRe.exec(out)) !== null) {
    const token = pm[1] as string
    const lowered = token.toLowerCase()
    const hasKeyword =
      lowered.includes("password") || lowered.includes("passwd") || lowered.includes("secret") || lowered.includes("token")
    if (hasKeyword && (token.includes("_") || token === token.toUpperCase())) {
      scanned += out.slice(pos, pm.index) + token + " [REDACTED]"
      pos = pm.index + pm[0].length
    } else {
      scanned += out.slice(pos, pm.index + 1)
      pos = pm.index + 1
      pairRe.lastIndex = pos
    }
  }
  out = scanned + out.slice(pos)
  // -p VALUE / -pVALUE only belong to mysql/mariadb/mysqldump and
  // `docker login` (-p is --port or mkdir's parents flag elsewhere), so
  // they are only touched on lines invoking the owning command.
  // Value can be unquoted ([^\s'"`]{1,200}), double-quoted ("[^"\n]{1,200}"),
  // or single-quoted ('[^'\n]{1,200}'). Quoted values may contain spaces.
  out = out
    .split("\n")
    .map((line) => {
      if (/\b(?:mysql|mariadb|mysqldump)\b/i.test(line)) {
        line = line.replace(/(?<![\w-])-p(?!assword)(?:("([^"\n]{1,200})")|('([^'\n]{1,200})')|([^\s'"`]{1,200}))/g, "-p[REDACTED]")
        line = line.replace(/(?<![\w-])-p(\s+)(?:("([^"\n]{1,200})")|('([^'\n]{1,200})')|([^\s'"`]{1,200}))/g, "-p$1[REDACTED]")
      }
      if (/\bdocker\b.{0,500}?\blogin\b/i.test(line)) {
        line = line.replace(/(?<![\w-])-p(\s+)(?:("([^"\n]{1,200})")|('([^'\n]{1,200})')|([^\s'"`]{1,200}))/g, "-p$1[REDACTED]")
      }
      return line
    })
    .join("\n")
  return out
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex")
}

// Several CATASTROPHIC patterns use `.*`/`(\S*\s+)*` before a literal
// target: on a long string with no real target, each
// occurrence of the pattern's trigger word forces its own O(remaining
// length) backtrack search, so a string with many trigger occurrences is
// O(n^2) overall (about 1.6MB of "rm -rf junk..." froze the event loop for
// ~19s). The check therefore runs over overlapping windows of bounded size:
// quadratic cost stays inside each window, the total is linear in length,
// and a target hidden behind padding is still found. The overlap is far
// longer than any kill-list command, so none is split between windows.
const CATASTROPHIC_CHECK_MAX_CHARS = 4000

const CATASTROPHIC_WINDOW_OVERLAP = 500
// Beyond this the kill-list scan (linear, ~2 ms/KB worst case) would stall
// the event loop, and no real tool call is this large: evaluatePermission
// sends such requests straight to the human instead of scanning them.
export const MAX_SCANNED_CHARS = 256 * 1024

export function isCatastrophic(joined: string): boolean {
  const step = CATASTROPHIC_CHECK_MAX_CHARS - CATASTROPHIC_WINDOW_OVERLAP
  for (let start = 0; start === 0 || start + CATASTROPHIC_WINDOW_OVERLAP < joined.length; start += step) {
    const window = joined.slice(start, start + CATASTROPHIC_CHECK_MAX_CHARS)
    const normalized = normalizeCommand(window)
    if (CATASTROPHIC.some((re) => re.test(window) || re.test(normalized))) return true
  }
  return false
}

// Documented OpenCode permission keys (https://opencode.ai/docs/permissions/):
// read, edit, glob, grep, bash, task, skill, lsp, question, webfetch,
// websearch, external_directory, doom_loop. edit also covers write/apply_patch.
const READ_ACTIONS = new Set([
  "read",
  "glob",
  "grep",
  "external_directory",
  "lsp",
  "skill",
  "todowrite",
])
export function kindFor(action: string, resources: string[]): string {
  if (action === "question") return "multichoice"
  if (action === "doom_loop") return "destructive"
  if (READ_ACTIONS.has(action)) return "read"
  const text = resources.join("\n")
  if (DESTRUCTIVE_HINT.test(text) || hasDestructiveCurlOrWget(resources)) return "destructive"
  if (/\b(curl|wget)\b/i.test(text)) return "read"
  return "write"
}

function numberedOptions(options: string[]): string {
  return options.map((o, i) => `${i + 1}. ${o}`).join("\n")
}

function resourceKinds(resources: string[]): string {
  return resources
    .map((r) => {
      const t = r.trim()
      if (!t) return "empty"
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          const p: unknown = JSON.parse(t)
          if (Array.isArray(p)) return `json-array[${p.length}]`
          if (p && typeof p === "object") return `json-keys:${Object.keys(p).slice(0, 8).join(",")}`
          return "json-scalar"
        } catch {
          return "json-broken"
        }
      }
      return `text:${t.length}ch`
    })
    .join("|")
}

function isEnabled(options: Record<string, unknown>): boolean {
  if (typeof options.enabled === "boolean") return options.enabled
  const env = (process.env.OLLAYA_GATE_ENABLED ?? "").toLowerCase()
  if (env === "0" || env === "false" || env === "off" || env === "no") return false
  return true
}

function repoRoot(options: Record<string, unknown>): string {
  if (typeof options.gateDir === "string" && options.gateDir) return options.gateDir
  if (process.env.OLLAYA_GATE_DIR) return process.env.OLLAYA_GATE_DIR
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
}

// Successful gate calls (spawn-to-decision) can run close to 10s even
// without concurrent load, and real multi-session load can push a
// permission's gate call well past a tight timeout, stalling that
// session with no self-heal. The likely driver is the sequential
// event-loop (see docs/ARCHITECTURE.md, "documented as an accepted
// limitation") queueing several sessions' permissions behind one
// another, or upstream API-side latency under real load: neither
// interpreter-spawn nor CPU contention among gate subprocesses explains
// it (an isolated concurrent-spawn test showed no such contention).
// 25000 gives headroom over observed p99 while staying under the
// existing 30000 hard cap.
export const DEFAULT_GATE_TIMEOUT_MS = 25000

export function timeoutMsOf(options: Record<string, unknown>): number {
  const raw =
    (options.timeoutMs as unknown) ??
    process.env.OLLAYA_GATE_TIMEOUT_MS ??
    process.env.OLLAYA_GATE_TIMEOUT ??
    DEFAULT_GATE_TIMEOUT_MS
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10)
  if (!Number.isFinite(n)) return DEFAULT_GATE_TIMEOUT_MS
  return Math.min(30000, Math.max(1000, n))
}

// How much recent conversation (chars, both roles) to send as OBJECTIVE.
// The default model (winnow:e4b) reads at most 6,144 state tokens, about
// 22k chars of conversation, and schemas.py fits objective and detail into
// that budget (smaller on retry), so collecting more is wasted work.
// Override per-project via options.objectiveChars or OLLAYA_GATE_OBJECTIVE_CHARS.
function objectiveBudgetOf(options: Record<string, unknown>): number {
  const raw = (options.objectiveChars as unknown) ?? process.env.OLLAYA_GATE_OBJECTIVE_CHARS
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10)
  if (!Number.isFinite(n)) return 22000
  return Math.min(90000, Math.max(200, n))
}

function logFileOf(options: Record<string, unknown>): string {
  if (typeof options.logFile === "string" && options.logFile) return options.logFile
  if (process.env.OLLAYA_GATE_LOG) return process.env.OLLAYA_GATE_LOG
  return path.join(repoRoot(options), "decisions-plugin.jsonl")
}

function logLine(options: Record<string, unknown>, entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(logFileOf(options), JSON.stringify({ v: 2, at: new Date().toISOString(), ...entry }) + "\n")
    try {
      fs.chmodSync(logFileOf(options), 0o600)
    } catch {
      // best effort
    }
  } catch {
    // Logging must never break the permission flow.
  }
}

// Cross-instance request claim: setup() may run more than once per
// process (and several processes may share a gateDir), so in-memory
// maps alone cannot guarantee a single evaluation/reply. First
// claimant wins via an exclusive marker file, claimed before the model
// call; losers skip evaluating entirely.
function repliedDirOf(options: Record<string, unknown>): string {
  return path.join(repoRoot(options), ".ollaya-gate-replied")
}

// Returns "won" (evaluate and reply now), "lost" (someone else owns
// it) or "error" (marker unusable: evaluate anyway, never suppress on
// FS trouble).
export function claimReply(options: Record<string, unknown>, requestID: string, inst: string): "won" | "lost" | "error" {
  // Length-bound the fast path too, not just the charset: an all-alnum
  // requestID over Linux's 255-byte NAME_MAX hits ENAMETOOLONG on the
  // write below, which lands in the shared catch as generic "error",
  // if that happened for both racing claimants it would silently reopen
  // the exact double-evaluation race this function exists to close.
  // sha256Hex's fixed 64-char output is always safe.
  const name = /^[A-Za-z0-9_-]+$/.test(requestID) && requestID.length <= 200 ? requestID : sha256Hex(requestID)
  const dir = repliedDirOf(options)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // The marker directory path itself is unusable (e.g. a plain file
    // sitting where the directory should be): a broken marker
    // mechanism, never a legitimate claim conflict. Must not be
    // reported as "lost" (which means "someone
    // else owns it" and, applied here, would permanently ask-human
    // every single permission/form forever, logged as the misleading
    // "duplicate-suppressed", implying a race with a live second
    // instance, not a broken path, with no self-healing since
    // pruneReplied's own readdirSync on the same broken path also fails
    // silently). "error" correctly means "evaluate anyway" instead.
    return "error"
  }
  try {
    fs.writeFileSync(path.join(dir, name), inst, { flag: "wx" })
    return "won"
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === "EEXIST") return "lost"
    return "error"
  }
}

// The in-memory dedup collections (resolved/endedSessions/formSeen) have
// no eviction otherwise: nothing ever calls .delete() on the success
// path, so a long-lived process accumulates one entry per ever-seen
// requestID/sessionID/formID for its whole uptime. A size cap, checked
// before each insert, is a simpler and lower-risk circuit breaker than
// retrofitting per-entry timestamps through every signature that
// touches these maps. There is no cross-request race (the event loop is
// sequential (see the ADR on that in docs/ARCHITECTURE.md) and
// inFlight itself is never capped), but clearing `resolved` early CAN
// drop the cached entry a late duplicate permission.asked would use to
// retry a reply that had failed: that duplicate falls through to
// duplicate-suppressed instead of retrying. Not a lost or silently-wrong
// decision: the original reply-failed entry is already in the log with
// its own error_class/error_detail, so the record survives either way.
// At most one missed *automatic* self-heal on an already-rare path.
const MAX_DEDUP_ENTRIES = 2000

export function capped<T extends Map<string, unknown> | Set<string>>(collection: T, max: number = MAX_DEDUP_ENTRIES): T {
  if (collection.size >= max) collection.clear()
  return collection
}

function pruneReplied(options: Record<string, unknown>, maxAgeMs = 3600000): void {
  try {
    const dir = repliedDirOf(options)
    const now = Date.now()
    for (const f of fs.readdirSync(dir)) {
      try {
        const p = path.join(dir, f)
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p)
      } catch {
        // Keep going; pruning is best effort.
      }
    }
  } catch {
    // Directory may not exist yet; nothing to prune.
  }
}

// Option labels come from the agent's own tool call (question fields), so
// they're attacker-reachable the same way OBJECTIVE/HALT.detail are:
// capped per-label (build_objective_block caps OBJECTIVE/detail too) and
// redacted before they become the model's multichoice criteria (see
// build_questions in schemas.py). Not fenced like OBJECTIVE/detail: the
// pre-supplied "must be one of these options" check bounds what a
// resulting pick can do, so the goal here is capping cost/exposure, not
// closing a bypass; see SECURITY.md.
const LABEL_MAX_CHARS = 200

// Same normalization applied on both the way out (labelsFromFormField,
// what the model sees) and the way back (valueForPick, matching the model's pick to
// the original option): deterministic, so re-deriving it at lookup time
// stays correct even though filter/slice can shift indices, without
// needing a positional mapping between raw options and shown labels.
export function normalizedLabel(text: string): string {
  return redactSecrets(text).slice(0, LABEL_MAX_CHARS)
}

export function labelsFromFormField(field: unknown): string[] {
  if (!field || typeof field !== "object") return []
  const opts = (field as { options?: unknown }).options
  if (!Array.isArray(opts)) return []
  return opts
    .map((item) => {
      if (typeof item === "string") return item
      // A JSON array can legally hold null/undefined entries; valueForPick
      // already guards this (`item &&`) and this map must too, or one bad
      // entry crashes the whole form's auto-answer instead of just being
      // skipped.
      if (!item || typeof item !== "object") return null
      const o = item as { label?: unknown; value?: unknown }
      if (typeof o.label === "string" && o.label) return o.label
      if (typeof o.value === "string" && o.value) return o.value
      return null
    })
    .filter((label): label is string => typeof label === "string" && label.length > 0)
    .slice(0, 10)
    .map(normalizedLabel)
}

// Returns null when the pick is ambiguous: two different original options
// normalized (redacted/truncated) to the same string, so which one the model
// "meant" can't be recovered: first-match-wins would silently apply a
// different, still-valid option than the one actually intended, with no
// signal anything went wrong. Callers must
// treat null the same as "pick not offered": ask-human, don't guess.
export function valueForPick(field: unknown, pick: string): string | null {
  if (!field || typeof field !== "object") return pick
  const opts = (field as { options?: unknown }).options
  if (!Array.isArray(opts)) return pick
  const matches: string[] = []
  for (const item of opts) {
    if (typeof item === "string") {
      if (normalizedLabel(item) === pick) matches.push(item)
      continue
    }
    if (item && typeof item === "object") {
      const o = item as { label?: unknown; value?: unknown }
      const rawLabel = typeof o.label === "string" && o.label ? o.label : typeof o.value === "string" && o.value ? o.value : null
      if (rawLabel !== null && normalizedLabel(rawLabel) === pick) {
        matches.push(typeof o.value === "string" && o.value ? o.value : pick)
      }
    }
  }
  const distinct = new Set(matches)
  if (distinct.size > 1) return null
  return matches.length > 0 ? matches[0] : pick
}

// A form field is only answerable when it's not hidden and all
// its `when` conditions hold against the answers already decided for
// earlier fields. `eq`/`neq` compare with `===` (the schema gives no
// coercion rules; a numeric when-value won't match a string answer, which
// is the safe direction). An unreferenced key counts as unanswered: `eq`
// is false, `neq` is true. A malformed condition can't be verified, so it
// fails safe (field not visible) rather than risking a reply value that
// violates an unparseable constraint. Callers skip the field entirely:
// no model call, no answer entry (the server 400s on a reply that includes
// a field whose `when` isn't satisfied).
export function fieldVisible(field: unknown, answers: Record<string, unknown>): boolean {
  if (!field || typeof field !== "object") return true
  const f = field as { hidden?: unknown; when?: unknown }
  if (f.hidden === true) return false
  const lookup = answers && typeof answers === "object" ? answers : {}
  const when = f.when
  if (!Array.isArray(when)) return true
  for (const cond of when) {
    if (!cond || typeof cond !== "object") return false
    const c = cond as { key?: unknown; op?: unknown; value?: unknown }
    if (typeof c.key !== "string" || c.key === "") return false
    const op = c.op === "neq" ? "neq" : "eq"
    const answered = lookup[c.key]
    if (op === "neq") {
      if (answered !== undefined && answered === c.value) return false
    } else {
      if (answered === undefined || answered !== c.value) return false
    }
  }
  return true
}

// Encodes the model's pick into the value the form reply API expects
// for this field's type. multiselect fields take an array of option values
// (the model's single pick -> one-element array; a future list pick is mapped
// element-wise by the caller). Every other field takes a plain string.
// Ambiguity (valueForPick returning null: two options collide after
// redaction/truncation) propagates as null; callers treat it as ask-human.
export function encodeAnswer(field: unknown, pick: string): string | string[] | null {
  const value = valueForPick(field, pick)
  if (value === null) return null
  const type = field && typeof field === "object" ? (field as { type?: unknown }).type : undefined
  if (type === "multiselect") return [value]
  return value
}

/** Path listing pending interactive forms. Without a project directory this
 * is the bare endpoint (the service's own directory only); with one it
 * scopes the listing to that project: `GET /api/form` without a
 * location only ever lists forms of the service's own directory, so a
 * project session's forms would otherwise always be `[]`. */
export function formListPath(directory?: string): string {
  if (!directory) return "/api/form"
  return `/api/form?location[directory]=${encodeURIComponent(directory)}`
}

/** List pending interactive forms (question tool uses kind=question forms on 2.0.x). */
export function listPendingForms(directory?: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const child = spawn("opencode", ["api", "GET", formListPath(directory)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        // ignore
      }
      // Same SIGKILL backstop as spawnGate's timeout/cancel paths: a hung
      // `opencode` CLI that ignores SIGTERM stays alive indefinitely, and
      // this runs on every 750ms poll tick with no backpressure, so a
      // single hang leaks one orphaned process per tick.
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
      }, 2000)
      killer.unref?.()
      resolve([])
    }, 5000)
    child.stdout?.on("data", (c) => {
      if (stdout.length < 256_000) stdout += String(c)
    })
    child.on("error", () => {
      clearTimeout(timer)
      resolve([])
    })
    child.on("close", () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(stdout) as { data?: unknown } | unknown
        const data = parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)
          ? (parsed as { data: unknown[] }).data
          : Array.isArray(parsed)
            ? parsed
            : []
        resolve(data.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") as Record<string, unknown>[])
      } catch {
        resolve([])
      }
    })
  })
}

/** POST a reply to an OpenCode API endpoint via the CLI (`opencode api POST`), never
 * `ctx.permission.reply()`. The SDK method is unreliable: it can report
 * "Permission request not found" for a permission that is STILL listed as
 * pending via GET /api/session/{id}/permission, while a raw
 * `opencode api POST .../reply` on that exact requestID succeeds
 * immediately. This is not a server-side expiry/TTL race; the SDK
 * method itself is what's unreliable (plausibly related to setup()
 * running more than once per process, see claimReply). Shared by
 * replyFormAnswer and replyPermission below. */
export function postApiReply(apiPath: string, body: Record<string, unknown>, errPrefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["api", "POST", apiPath, "-d", JSON.stringify(body)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        // ignore
      }
      // Same SIGKILL backstop as spawnGate's timeout/cancel paths. Every
      // permission/form reply goes through here.
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
      }, 2000)
      killer.unref?.()
      reject(new Error(`${errPrefix} timeout`))
    }, 10000)
    child.stderr?.on("data", (c) => {
      if (stderr.length < 4000) stderr += String(c)
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${errPrefix} exit ${code}: ${stderr.slice(0, 200)}`))
    })
  })
}

/** Submit answers to a pending OpenCode form (question tool on 2.0.x). */
function replyFormAnswer(sessionID: string, formID: string, answer: Record<string, string | string[]>): Promise<void> {
  return postApiReply(`/api/session/${sessionID}/form/${formID}/reply`, { answer }, "form-reply")
}

function replyPermission(sessionID: string, requestID: string, decision: "once" | "reject"): Promise<void> {
  return postApiReply(`/api/session/${sessionID}/permission/${requestID}/reply`, { decision }, "permission-reply")
}

function pythonBin(options: Record<string, unknown>): string {
  if (typeof options.pythonBin === "string" && options.pythonBin) return options.pythonBin
  if (process.env.OLLAYA_GATE_PYTHON) return process.env.OLLAYA_GATE_PYTHON
  // The gate needs only the standard library, but the opencode service
  // may run with an old /usr/bin/python3 (< 3.10). Prefer a mise-managed
  // interpreter when present.
  const home = process.env.HOME || ""
  const miseRoot = path.join(home, ".local/share/mise/installs/python")
  try {
    const versions = fs.readdirSync(miseRoot).sort().reverse()
    for (const v of versions) {
      const bin = path.join(miseRoot, v, "bin", "python3")
      if (fs.existsSync(bin)) return bin
    }
  } catch {
    // fall through
  }
  return "python3"
}

function minimalEnv(options: Record<string, unknown>): Record<string, string | undefined> {
  const root = repoRoot(options)
  const src = path.join(root, "src")
  const existing = process.env.PYTHONPATH ?? ""
  const pyPath = existing ? `${src}${path.delimiter}${existing}` : src
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PYTHONPATH: pyPath,
    OLLAYA_HOST: process.env.OLLAYA_HOST,
    OLLAYA_API_KEY: process.env.OLLAYA_API_KEY,
    OLLAYA_GATE_LOG: logFileOf(options),
    OLLAYA_GATE_CLI_LOG: "0",
    OLLAYA_GATE_MODEL: process.env.OLLAYA_GATE_MODEL,
    OLLAYA_GATE_KEEP_ALIVE: process.env.OLLAYA_GATE_KEEP_ALIVE,
    OLLAYA_GATE_DIR: process.env.OLLAYA_GATE_DIR ?? root,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  }
}

// Spawns the gate subprocess without writing stdin yet, so its cold start
// (interpreter init, module imports) can overlap with an async
// caller-side step (objectiveFor's session.context RPC) instead of paying
// both costs back to back. Every permission.reply() this plugin makes
// races a short, non-configurable server-side window (see
// docs/TROUBLESHOOTING.md "Ordinary permission replies can silently miss
// the window"): this does not close that race, it narrows it.
function spawnGate(options: Record<string, unknown>): {
  send: (event: Record<string, unknown>) => void
  cancel: () => void
  result: Promise<Record<string, unknown>>
} {
  const child = spawn(pythonBin(options), ["-m", "ollaya_gate.cli"], {
    cwd: repoRoot(options),
    env: minimalEnv(options),
  })
  let stdout = ""
  let stderr = ""
  const CAP = 256 * 1024
  let settleResolve!: (value: Record<string, unknown>) => void
  let settleReject!: (reason: unknown) => void
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    settleResolve = resolve
    settleReject = reject
  })
  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM")
    } catch {
      // ignore
    }
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // ignore
      }
    }, 2000)
    killer.unref?.()
    settleReject(new Error("gate timeout"))
  }, timeoutMsOf(options))
  ;(timer as unknown as { unref?: () => void }).unref?.()
  child.stdout.on("data", (chunk) => {
    if (stdout.length < CAP) stdout += String(chunk).slice(0, CAP - stdout.length)
  })
  child.stderr.on("data", (chunk) => {
    if (stderr.length < CAP) stderr += String(chunk).slice(0, CAP - stderr.length)
  })
  child.on("error", (error) => {
    clearTimeout(timer)
    settleReject(error)
  })
  child.on("close", (code, signal) => {
    clearTimeout(timer)
    if (code !== 0) {
      const msg = signal ? `gate killed by ${signal}` : `gate exit ${code}`;
      settleReject(new Error(msg + " " + stderr.slice(0, 200)))
      return
    }
    try {
      settleResolve(JSON.parse(stdout) as Record<string, unknown>)
    } catch (parseError) {
      settleReject(parseError)
    }
  })
  return {
    send(event) {
      try {
        child.stdin.write(JSON.stringify(event))
        child.stdin.end()
      } catch (stdinError) {
        clearTimeout(timer)
        settleReject(stdinError)
      }
    },
    cancel() {
      clearTimeout(timer)
      try {
        child.kill("SIGTERM")
      } catch {
        // ignore
      }
      // Same SIGKILL backstop as the timeout path above: without it, a
      // child that doesn't die on SIGTERM (installed its own handler, or
      // just misses the signal) leaks forever: cancel() has no other
      // caller to retry it, and nothing else cleans it up.
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
      }, 2000)
      killer.unref?.()
      // Swallow the eventual close/error event so it doesn't surface as an
      // unhandled rejection once nothing is awaiting `result` anymore.
      result.catch(() => {})
    },
    result,
  }
}

// A gate subprocess that died from a signal (OOM killer, a stray pkill)
// or could not be spawned for a transient resource reason is worth one
// fresh attempt: the retry only re-asks the model, it cannot allow anything by
// itself. A non-zero exit, a timeout or unparseable output is a real
// answer about this input and is not retried.
export function isRetryableGateError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.startsWith("gate killed by")) return true
  const code = (err as { code?: unknown } | null)?.code
  return code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || code === "ENOMEM"
}

export async function runGate(options: Record<string, unknown>, event: Record<string, unknown>): Promise<{ decision: Record<string, unknown>; retried: boolean }> {
  // First attempt
  let gate = spawnGate(options)
  gate.send(event)
  try {
    const decision = await gate.result
    return { decision, retried: false }
  } catch (err) {
    // Retry ONLY for signal kills or spawn errors (child 'error' event)
    // Do NOT retry for timeouts or JSON parse errors
    if (!isRetryableGateError(err)) {
      throw err
    }
    // One retry with a fresh spawn
    gate = spawnGate(options)
    gate.send(event)
    const decision = await gate.result
    return { decision, retried: true }
  }
}

type ConversationTurn = { role: "user" | "assistant"; text: string }

export function textOfMessage(message: unknown): ConversationTurn | null {
  if (!message || typeof message !== "object") return null
  const msg = message as { type?: unknown; role?: unknown; text?: unknown; parts?: unknown; content?: unknown }
  // v2 shape: { type: "user"|"assistant", text: "..." }. Legacy shape:
  // { role: "user"|"assistant", parts: [{ text }] }.
  const role = msg.type === "user" || msg.role === "user"
    ? "user"
    : msg.type === "assistant" || msg.role === "assistant"
      ? "assistant"
      : null
  if (role === null) return null
  if (typeof msg.text === "string" && msg.text.trim()) return { role, text: msg.text }
  // Real assistant-message shape, confirmed against the installed
  // @opencode/client types, not just observed behavior:
  // SessionMessageAssistant has neither .text nor .parts at all: its text
  // lives in content[].text for "text"/"reasoning" items ("tool" items
  // have no plain text and are skipped, same reasoning as the .parts
  // branch below). Without this, every assistant turn silently vanished
  // from what the model is shown, despite the surrounding code's own comment
  // that OBJECTIVE should reflect "what the agent has been doing, not
  // just the human's last message."
  if (Array.isArray(msg.content)) {
    const text = msg.content
      .filter((p): p is { type?: unknown; text?: unknown } => !!p && typeof p === "object")
      .filter((p) => (p.type === "text" || p.type === "reasoning") && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
    if (text.trim()) return { role, text }
  }
  if (Array.isArray(msg.parts)) {
    // Only plain text parts (thinking/response). Tool-call parts have no
    // `.text` field and are skipped, keeping this cheap even for turns
    // with large tool output.
    const text = msg.parts
      .filter((p): p is { text?: unknown } => !!p && typeof p === "object")
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
    if (text.trim()) return { role, text }
  }
  return null
}

// permission.asked's optional `source` ({type:"tool", messageID, id}):
// points back at the exact tool-call part that triggered this permission.
export type PermissionSource = { messageID: string; id: string }

// The "subagent" permission action (opencode 2.0.11; docs still call it
// "task") carries only the target agent's short name in `resources`:
// live-verified: `resKinds` was consistently "text:7ch", the exact length
// of "general", for every subagent dispatch observed, never the dispatch's
// `description`/`prompt`. The model then evaluates a "write" action whose only
// evidence is a 7-character agent slug, with `objectiveFor` unable to fill
// the gap since it deliberately excludes tool-call payloads (see
// `textOfMessage`): the actual dispatch prompt lives nowhere the model can see
// it, so it defaults to low-confidence deny nearly every time (0.06-0.26
// confidence across a live run of 6 parallel subagent dispatches, all
// denied). `source` lets us pull the real dispatch content (agent/
// description/prompt) from the same session-context RPC `objectiveFor`
// already makes, so the model can judge what the subagent will actually do
// instead of just its target agent type. Fails open to the original
// (thin) resources on any lookup failure: this only ever adds evidence,
// never removes the existing fail-open path.
export async function subagentDetailFor(
  ctx: { session: { context: (input: { sessionID: string }) => Promise<unknown> } },
  sessionID: string,
  source: PermissionSource | null | undefined,
): Promise<string | null> {
  if (!source?.messageID || !source?.id) return null
  try {
    const messages = await ctx.session.context({ sessionID })
    const list = Array.isArray(messages) ? messages : []
    const message = list.find(
      (m): m is { content?: unknown } =>
        !!m && typeof m === "object" && (m as { id?: unknown }).id === source.messageID,
    )
    const content = Array.isArray((message as { content?: unknown } | undefined)?.content)
      ? ((message as { content: unknown[] }).content)
      : []
    const call = content.find(
      (c): c is { state?: unknown } => !!c && typeof c === "object" && (c as { id?: unknown }).id === source.id,
    )
    const input = (call as { state?: { input?: unknown } } | undefined)?.state?.input
    if (!input || typeof input !== "object") return null
    const { agent, description, prompt } = input as Record<string, unknown>
    const parts = [
      typeof agent === "string" && agent ? `agent: ${agent}` : "",
      typeof description === "string" && description ? `description: ${description}` : "",
      typeof prompt === "string" && prompt ? `prompt: ${prompt}` : "",
    ].filter(Boolean)
    return parts.length ? parts.join("\n") : null
  } catch {
    return null
  }
}

// Unified diffs from an edit permission's metadata.files, one per file,
// each under a header naming the file. Null when there is nothing usable.
export function editPatchesOf(metadata: unknown): string | null {
  const files = (metadata as { files?: unknown } | null | undefined)?.files
  if (!Array.isArray(files)) return null
  const parts = files
    .filter((f): f is { file?: unknown; patch?: unknown } => !!f && typeof f === "object")
    .filter((f) => typeof f.patch === "string" && f.patch)
    .map((f) => `--- patch for ${typeof f.file === "string" ? f.file : "?"} ---\n${f.patch as string}`)
  return parts.length ? parts.join("\n") : null
}

// grep/glob permissions on opencode 2.0.x carry only the search pattern in
// `resources` (e.g. a grep permission's resources is just `[a-z]+`, never
// the path being searched); the target path lives in metadata instead
// (metadata.path is documented for glob; grep's real shape is confirmed
// live against a running opencode service). Without it the model judges a
// bare pattern with no path and defaults to ask-human: adding the path
// measurably moved one such case from ask-human to allow. Model payload
// only, like editPatchesOf above: kill-list and kindFor keep evaluating
// resources, unchanged.
const METADATA_DETAIL_KEYS = ["path", "include", "glob"] as const
export function metadataDetailFor(action: string, metadata: unknown): string | null {
  if (action !== "grep" && action !== "glob" && action !== "list") return null
  if (!metadata || typeof metadata !== "object") return null
  const m = metadata as Record<string, unknown>
  const lines = METADATA_DETAIL_KEYS.filter((key) => typeof m[key] === "string" && m[key]).map(
    (key) => `${key}: ${m[key] as string}`,
  )
  return lines.length ? lines.join("\n") : null
}

/**
 * Dependencies injected into evaluatePermission for testability.
 */
export interface EvaluateDeps {
  runGate: (options: Record<string, unknown>, event: Record<string, unknown>) => Promise<{ decision: Record<string, unknown>; retried: boolean }>;
  objectiveFor: (
    ctx: { session: { context: (input: { sessionID: string }) => Promise<unknown> } },
    sessionID: string,
    ended: Set<string>,
    budgetChars: number,
  ) => Promise<string>;
  kindFor: (action: string, resources: string[]) => string;
  redactSecrets: (text: string) => string;
  sha256Hex: (text: string) => string;
  isCatastrophic: (joined: string) => boolean;
  subagentDetailFor: (
    ctx: { session: { context: (input: { sessionID: string }) => Promise<unknown> } },
    sessionID: string,
    source: PermissionSource | null | undefined,
  ) => Promise<string | null>;
  resourceKinds: (resources: string[]) => string;
  DESTRUCTIVE_HINT: RegExp;
  COMMAND_SUBSTITUTION: RegExp;
  objectiveBudgetOf: (options: Record<string, unknown>) => number;
  ctx: { session: { context: (input: { sessionID: string }) => Promise<unknown> } };
  log: (entry: Record<string, unknown>) => void;
  options: Record<string, unknown>;
  endedSessions: Set<string>;
  inst: string;
}

/**
 * Synchronous hook callback for `permission.evaluate`.
 * Mutates `input.effect` and optionally `input.message` to decide allow/deny/ask.
 * This is exported for unit testing.
 */
export async function evaluatePermission(
  deps: EvaluateDeps,
  input: {
    sessionID: string;
    agent?: string;
    action: string;
    resources: ReadonlyArray<string>;
    metadata?: Record<string, unknown>;
    source?: PermissionSource;
    effect: "allow" | "deny" | "ask";
    message?: string;
  },
): Promise<void> {
  const { sessionID, action, resources, source, effect } = input;

  // Respect user's allow/deny config: only intercept when effect is "ask"
  if (effect !== "ask") {
    return;
  }

  // Question tool: passthrough-allow (form answers handled separately via form API)
  if (action === "question") {
    input.effect = "allow";
    deps.log({
      sessionID,
      tool: action,
      kind: "multichoice",
      gateAction: "allow",
      reason: "question-permission-passthrough",
    });
    return;
  }

  // Convert readonly array to mutable for enrichment
  const mutableResources: string[] = Array.from(resources);
  let joined = mutableResources.join("\n");
  let resKinds = deps.resourceKinds(mutableResources);

  if (joined.length > MAX_SCANNED_CHARS) {
    deps.log({ sessionID, tool: action, gateAction: "ask-human", reason: "oversized-request", detailChars: joined.length, detail_sha256: deps.sha256Hex(joined) });
    return;
  }

  // Catastrophic pattern: deny instantly with message, no model call
  if (deps.isCatastrophic(joined)) {
    input.effect = "deny";
    input.message =
      "Blocked by ollaya-decision-gate: matches the catastrophic-command kill-list. Do not retry this command or variants of it.";
    deps.log({
      sessionID,
      tool: action,
      kind: "destructive",
      gateAction: "reject",
      reason: "catastrophic-pattern",
      detail_sha256: deps.sha256Hex(joined),
    });
    return;
  }

  // Subagent/task enrichment
  if (action === "subagent" || action === "task") {
    const enriched = await deps.subagentDetailFor(deps.ctx, sessionID, source);
    if (enriched) {
      mutableResources[0] = enriched;
      joined = enriched;
      resKinds = deps.resourceKinds(mutableResources);
    }
  }

  const kind = deps.kindFor(action, mutableResources);

  // Build gate event and call the model
  try {
    const objective = await deps.objectiveFor(deps.ctx, sessionID, deps.endedSessions, deps.objectiveBudgetOf(deps.options));
    // Edits carry their diff in metadata.files, not in resources (which is
    // just the path): without it the model would judge every write blind. Only
    // the model payload gets it; the kill-list and kindFor stay on resources.
    const patches = editPatchesOf(input.metadata);
    const metaDetail = metadataDetailFor(action, input.metadata);
    const extra = [patches, metaDetail].filter((x): x is string => !!x).join("\n");
    const detail = clipHeadTail(deps.redactSecrets(extra ? `${joined}\n${extra}` : joined), DETAIL_MAX_CHARS);
    const hintParts: string[] = [];
    if (action === "doom_loop") hintParts.push("doom_loop: identical tool call repeated");
    if (deps.DESTRUCTIVE_HINT.test(joined) || hasDestructiveCurlOrWget(mutableResources)) hintParts.push("matches destructive-hint");
    if (deps.COMMAND_SUBSTITUTION.test(joined)) hintParts.push("contains command substitution ($(...) or `...`); real effect cannot be statically determined");
    if (detail.includes(OMITTED_MARK)) hintParts.push("detail too long: middle omitted, judge head and tail");
    const riskHints = hintParts.join("; ");

    const halt: Record<string, unknown> = { kind, tool: action, detail };
    const gateEvent = {
      objective,
      halt,
      context: { sessionID, requestID: "", risk_hints: riskHints },
      policy: { default: "ask-human when unsure" },
    };

    const startedAt = Date.now();
    const { decision, retried } = await deps.runGate(deps.options, gateEvent);
    const elapsedMs = Date.now() - startedAt;

    deps.log({
      sessionID,
      tool: action,
      kind,
      gateAction: decision.action,
      reason: decision.reason,
      confidence: decision.confidence,
      model: decision.model,
      ...(decision.usage ? { usage: decision.usage } : {}),
      pick: decision.pick ?? null,
      elapsedMs,
      objectiveChars: objective.length,
      detail_sha256: deps.sha256Hex(joined),
      resKinds,
      ...(retried ? { retry: 1 } : {}),
      ...(typeof decision.error === "string" ? { error_class: decision.error } : {}),
      ...(typeof decision.error_detail === "string" ? { error_detail: decision.error_detail } : {}),
    });

    if (decision.action === "allow") {
      input.effect = "allow";
    } else if (decision.action === "deny") {
      input.effect = "deny";
      const reason = String(decision.reason ?? "model-deny");
      input.message = `Denied by ollaya-decision-gate (local model): ${deps.redactSecrets(reason)}. Choose a safer alternative or explain why this is needed.`;
    } else {
      // ask-human or unknown -> leave effect as "ask"
    }
  } catch (err) {
    // Fail-open: never silent allow, always leave effect as "ask"
    deps.log({
      sessionID,
      tool: action,
      kind,
      gateAction: "ask-human",
      reason: "fail-open",
      error_class: err instanceof Error ? err.message.slice(0, 120) : "exception",
    });
    // effect remains "ask"
  }
}

class SessionEndedError extends Error {
  constructor(message = "session-ended") {
    super(message)
    this.name = "SessionEndedError"
  }
}

function archivedAt(info: unknown): unknown {
  if (!info || typeof info !== "object") return undefined
  const time = (info as { time?: unknown }).time
  if (!time || typeof time !== "object") return undefined
  return (time as { archived?: unknown }).archived
}

// The opencode SDK's error surface for "this session is gone" overlaps in
// wording with a dozen unrelated *NotFoundError types (ProviderNotFoundError,
// AgentNotFoundError, SkillNotFoundError, McpServerNotFoundError,
// CommandNotFoundError, FileNotFoundError, ...), confirmed reachable:
// a bare /not found/i regex matches "Provider anthropic not
// found" just as readily as an actual session error. Misclassifying one of
// those as "session ended" is worse than it sounds: the session gets
// permanently cached as ended, and this
// just silently stops replying for that session, forever, violating
// SECURITY.md's "never silently allows" guarantee in spirit even though
// it denies rather than allows). Checking the SDK's own `_tag` first
// (Effect's TaggedStruct discriminant: SessionNotFoundError is the real
// one) is precise when present; the regex fallback now requires "session"
// to co-occur with the not-found-ish wording instead of either alone,
// closing the cross-contamination with sibling *NotFoundError types.
export function looksLikeSessionGone(err: unknown): boolean {
  const tag = (err as { _tag?: unknown } | null | undefined)?._tag
  if (tag === "SessionNotFoundError") return true
  const msg = err instanceof Error ? err.message : String(err)
  return /\bsession\b/i.test(msg) && /not\s*found|unknown|no such|deleted|archived/i.test(msg)
}

async function sessionIsEnded(
  ctx: { session: { get?: (input: { sessionID: string }) => Promise<unknown>; context: (input: { sessionID: string }) => Promise<unknown> } },
  sessionID: string,
  ended: Set<string>,
): Promise<boolean> {
  if (ended.has(sessionID)) return true
  if (typeof ctx.session.get !== "function") return false
  try {
    const info = await ctx.session.get({ sessionID })
    if (archivedAt(info) != null) {
      capped(ended).add(sessionID)
      return true
    }
    return false
  } catch (err) {
    if (looksLikeSessionGone(err)) {
      capped(ended).add(sessionID)
      return true
    }
    return false
  }
}

async function objectiveFor(
  ctx: { session: { context: (input: { sessionID: string }) => Promise<unknown> } },
  sessionID: string,
  ended: Set<string>,
  budgetChars: number,
): Promise<string> {
  try {
    const messages = await ctx.session.context({ sessionID })
    const list = Array.isArray(messages) ? messages : []
    const turns = list.map(textOfMessage).filter((t): t is ConversationTurn => t !== null)
    // Recent conversation, both roles, newest last: lets the model judge
    // whether a halt matches what the human asked AND what the agent
    // has been doing, not just the human's last message. Walk backward
    // so a budget cut drops the oldest turns first; each turn is also
    // capped so one huge message can't eat the whole budget.
    const lines: string[] = []
    let total = 0
    for (let i = turns.length - 1; i >= 0 && total < budgetChars; i--) {
      const line = `${turns[i].role === "user" ? "User" : "Assistant"}: ${turns[i].text}`.slice(0, 1000)
      lines.unshift(line)
      total += line.length + 1
    }
    const transcript = redactSecrets(lines.join("\n")).slice(-budgetChars)
    return transcript || "Complete the assigned coding task"
  } catch (err) {
    if (looksLikeSessionGone(err)) {
      capped(ended).add(sessionID)
      const msg = err instanceof Error ? err.message : String(err)
      throw new SessionEndedError(msg.slice(0, 120))
    }
    return "Complete the assigned coding task"
  }
}

// Question tool calls whose questions the model could not answer and were handed
// to the tool's own execute (which opens the human form). The form path
// skips those forms instead of asking the model the same thing again.
// opencode loads a separate copy of this module for every setup()
// instance (one per project directory), so module-level state is NOT
// shared between instances: a "one poller per process" design that
// leaves this on module-level state ends up as one poller per
// directory instead. Process-wide state has to live on
// globalThis. The versioned key keeps a future incompatible shape from
// colliding with an instance still running older code.
type SharedState = {
  questionsLeftForHuman: Set<string>
  pollHandlers: Set<PollHandler>
  pollDirRefs: Map<string, number>
  formSeen: Set<string>
  pollTimer: ReturnType<typeof setInterval> | null
  pollInFlight: boolean
  pollCursor: number
}
const SHARED: SharedState = ((globalThis as Record<symbol, unknown>)[Symbol.for("ollaya-decision-gate.shared.v1")] ??= {
  questionsLeftForHuman: new Set<string>(),
  pollHandlers: new Set<PollHandler>(),
  pollDirRefs: new Map<string, number>(),
  formSeen: new Set<string>(),
  pollTimer: null,
  pollInFlight: false,
  pollCursor: 0,
}) as SharedState
const questionsLeftForHuman = SHARED.questionsLeftForHuman

export type QuestionToolInput = {
  questions?: Array<{ question?: unknown; header?: unknown; multiple?: unknown; options?: unknown }>
}

// Same shape the built-in question tool returns once a human answers
// (captured live on 2.0.16): output.answers is one array of labels per
// question, and content is the sentence the model reads.
export function questionToolResult(
  input: QuestionToolInput,
  answers: string[][],
): { output: { answers: string[][] }; content: string; metadata: { answers: string[][] } } {
  const qs = Array.isArray(input.questions) ? input.questions : []
  const pairs = qs.map((q, i) => `"${String(q?.question ?? "")}"="${(answers[i] ?? []).join(", ")}"`).join(", ")
  return {
    output: { answers },
    content: `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`,
    metadata: { answers },
  }
}

// Asks the model each question of one question-tool call. Returns one [label] per
// question, or null as soon as one cannot be answered (not allow, pick not
// offered, ambiguous after redaction, or no options): the caller then
// falls back to the human form for the whole call.
export async function answerQuestionsWithModel(
  deps: {
    runGate: (options: Record<string, unknown>, event: Record<string, unknown>) => Promise<{ decision: Record<string, unknown>; retried: boolean }>
    objective: () => Promise<string>
    log: (entry: Record<string, unknown>) => void
    options: Record<string, unknown>
  },
  sessionID: string,
  callKey: string,
  input: QuestionToolInput,
): Promise<string[][] | null> {
  const qs = Array.isArray(input.questions) ? input.questions : []
  if (qs.length === 0) return null
  const objective = await deps.objective()
  const answers: string[][] = []
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i] ?? {}
    const originals = (Array.isArray(q.options) ? q.options : [])
      .map((o) => (o && typeof o === "object" ? (o as { label?: unknown }).label : o))
      .filter((l): l is string => typeof l === "string" && l.length > 0)
      .slice(0, 10)
    const base = { sessionID, requestID: callKey, tool: "question", phase: "question-tool", fieldIndex: i }
    if (originals.length === 0) {
      deps.log({ ...base, gateAction: "ask-human", reason: "form-unsupported-field" })
      return null
    }
    const labels = originals.map(normalizedLabel)
    const detail = redactSecrets(
      [String(q.header ?? ""), String(q.question ?? ""), numberedOptions(labels)].filter(Boolean).join("\n").slice(0, 4000),
    )
    const startedAt = Date.now()
    const { decision, retried } = await deps.runGate(deps.options, {
      objective,
      halt: { kind: "multichoice", tool: "question", detail, options: labels, numbered: numberedOptions(labels) },
      context: { sessionID, requestID: callKey, risk_hints: "interactive-question-tool", fieldIndex: i },
      policy: { default: "ask-human when unsure" },
    })
    deps.log({
      ...base,
      kind: "multichoice",
      gateAction: decision.action,
      reason: decision.reason,
      confidence: decision.confidence,
      model: decision.model,
      ...(decision.usage ? { usage: decision.usage } : {}),
      pick: decision.pick ?? null,
      elapsedMs: Date.now() - startedAt,
      optionsCount: labels.length,
      ...(retried ? { retry: 1 } : {}),
      ...(typeof decision.error === "string" ? { error_class: decision.error } : {}),
      ...(typeof decision.error_detail === "string" ? { error_detail: decision.error_detail } : {}),
    })
    const pick = decision.pick
    if (decision.action !== "allow" || typeof pick !== "string" || !pick) {
      deps.log({ ...base, gateAction: "ask-human", reason: "form-model-not-allow" })
      return null
    }
    const matches = originals.filter((o) => normalizedLabel(o) === pick)
    if (matches.length === 0) {
      deps.log({ ...base, gateAction: "ask-human", reason: "form-pick-not-offered", pick })
      return null
    }
    if (new Set(matches).size > 1) {
      deps.log({ ...base, gateAction: "ask-human", reason: "form-pick-ambiguous", pick })
      return null
    }
    answers.push([matches[0] as string])
  }
  return answers
}

// Shared form poller: setup() runs once per project directory, so a
// process with N project directories would otherwise run N identical
// 750ms `opencode api GET /api/form` intervals (~20 CLI spawns/second idle, ~2
// cores). Module-level state means the first instance to set up starts the
// single interval and later ones only register their handler; the last
// cleanup stops it again. Any registered ctx works for the tick's
// session.context calls (process-wide RPC, not directory-scoped).
export interface PollHandler {
  ctx: { session: { get?: (input: { sessionID: string }) => Promise<unknown>; context: (input: { sessionID: string }) => Promise<unknown> } }
  log: (entry: Record<string, unknown>) => void
  inst: string
  options: Record<string, unknown>
  endedSessions: Set<string>
}

const sharedPollHandlers = SHARED.pollHandlers
const sharedPollDirRefs = SHARED.pollDirRefs
const sharedFormSeen = SHARED.formSeen

function addSharedPollDir(directory: string): void {
  sharedPollDirRefs.set(directory, (sharedPollDirRefs.get(directory) ?? 0) + 1)
}

function removeSharedPollDir(directory: string): void {
  const refs = (sharedPollDirRefs.get(directory) ?? 0) - 1
  if (refs <= 0) sharedPollDirRefs.delete(directory)
  else sharedPollDirRefs.set(directory, refs)
}

function tickSharedPoller(): void {
  // One tick in flight at a time: if the previous round of CLI spawns has
  // not finished, skip this tick instead of stacking processes.
  if (SHARED.pollInFlight || sharedPollHandlers.size === 0) return
  SHARED.pollInFlight = true
  void (async () => {
    try {
      const handler = [...sharedPollHandlers][0] as PollHandler
      // Poll the known project directories location-scoped, ONE per
      // tick in round-robin: all of them per tick is still ~12 CLI
      // spawns/s with 40 directories. This poll only backs up the
      // form.created event, so N x 750ms of fallback latency is fine.
      // With none known, keep the bare endpoint.
      const known = [...sharedPollDirRefs.keys()]
      const dirs: (string | undefined)[] = known.length > 0 ? [known[SHARED.pollCursor++ % known.length]] : [undefined]
      for (const dir of dirs) {
        const pending = await listPendingForms(dir)
        for (const item of pending) {
          const id = String(item.id ?? "")
          if (!id || sharedFormSeen.has(id)) continue
          capped(sharedFormSeen).add(id)
          try {
            await handleFormAsked(handler.ctx, handler.log, handler.inst, handler.options, item, handler.endedSessions)
          } catch {
            sharedFormSeen.delete(id)
          }
        }
      }
    } finally {
      SHARED.pollInFlight = false
    }
  })()
}

export function registerPoller(
  handler: PollHandler,
  startInterval: typeof setInterval = setInterval,
): ReturnType<typeof setInterval> | null {
  sharedPollHandlers.add(handler)
  if (SHARED.pollTimer === null) {
    SHARED.pollTimer = startInterval(tickSharedPoller, 750)
  }
  return SHARED.pollTimer
}

export function unregisterPoller(
  handler: PollHandler,
  clearTimer: typeof clearInterval = clearInterval,
): void {
  sharedPollHandlers.delete(handler)
  if (sharedPollHandlers.size === 0 && SHARED.pollTimer !== null) {
    clearTimer(SHARED.pollTimer)
    SHARED.pollTimer = null
  }
}

export default Plugin.define({
  id: "ollaya-decision-gate",
  async setup(ctx) {
    const options = ((ctx as { options?: unknown }).options ?? {}) as Record<string, unknown>
    if (!isEnabled(options)) return
    
    // Dedupe: the server may emit the same permission request more than
    // once while it is pending. Evaluate once per requestID; concurrent
    // duplicates await the same promise, late duplicates reuse the cached
    // reply without calling the model again.
    const inFlight = new Map<string, Promise<Record<string, unknown>>>()
    const resolved = new Map<string, { decision: string; repliedOk: boolean }>()
    const endedSessions = new Set<string>()
    const inst = Math.random().toString(36).slice(2, 8)
    const logEv = (entry: Record<string, unknown>): void =>
      logLine(options, { inst, pid: process.pid, ...entry })
    pruneReplied(options)
    
    // Answer the question tool in-process: wrapping its execute means
    // the model's pick is returned as the tool result directly, with no form and
    // no reply through `opencode api` (which only reaches the background
    // service). When the model cannot answer, the original execute opens the
    // human form as before. The marker keeps sibling setup() instances
    // from wrapping the same tool twice.
    try {
      await ctx.tool.transform((editor) => {
        editor.update("question", (tool) => {
          const t = tool as { execute: (input: unknown, context: unknown) => Promise<unknown>; __gateWrapped?: boolean }
          if (t.__gateWrapped) return
          const original = t.execute
          t.__gateWrapped = true
          t.execute = async (input: unknown, context: unknown) => {
            const c = (context ?? {}) as { sessionID?: unknown; messageID?: unknown; id?: unknown }
            const sessionID = String(c.sessionID ?? "")
            const callKey = `${String(c.messageID ?? "")}:${String(c.id ?? "")}`
            try {
              const answers = await answerQuestionsWithModel(
                {
                  runGate,
                  objective: () =>
                    objectiveFor(ctx, sessionID, endedSessions, Math.min(1500, objectiveBudgetOf(options))).catch(
                      () => "Answer the agent's multiple-choice question to unblock the session",
                    ),
                  log: logEv,
                  options,
                },
                sessionID,
                callKey,
                (input ?? {}) as QuestionToolInput,
              )
              if (answers) {
                logEv({ sessionID, requestID: callKey, tool: "question", gateAction: "allow", reason: "question-answered", phase: "question-tool", pick: answers.map((a) => a.join(", ")).join(" | ") })
                return questionToolResult((input ?? {}) as QuestionToolInput, answers)
              }
            } catch (err) {
              logEv({ sessionID, requestID: callKey, tool: "question", gateAction: "ask-human", reason: "fail-open", phase: "question-tool", error_class: err instanceof Error ? err.message.slice(0, 120) : "exception" })
            }
            capped(questionsLeftForHuman).add(callKey)
            return original(input, context)
          }
        })
      })
    } catch (err) {
      logEv({ reason: "question-tool-wrap-unavailable", error_class: err instanceof Error ? err.message.slice(0, 120) : "exception" })
    }

    // Try to register the synchronous permission.evaluate hook (opencode v2.0.16+)
    // If unavailable, fall back to the permission.asked event path.
    let hookRegistration: { dispose: () => void } | null = null
    let hookRegistered = false
    try {
      hookRegistration = await ctx.permission.hook("evaluate", async (input) => {
        // Build claim key for cross-instance dedup
        const sessionID = input.sessionID
        const action = input.action
        const resources = Array.from(input.resources)
        const source = input.source
        const joined = resources.join("\n")
        const sourcePart = source ? `${source.messageID}:${source.id}` : `${sha256Hex(joined)}:${sessionID}:${Math.round(Date.now() / 2000) * 2000}`
        const claimKey = `eval:${sessionID}:${sourcePart}:${action}:${sha256Hex(joined)}`
        const claim = claimReply(options, claimKey, inst)
        if (claim === "lost") {
          logEv({ sessionID, tool: action, gateAction: "ask-human", reason: "duplicate-suppressed" })
          return
        }
        
        const deps: EvaluateDeps = {
          runGate,
          objectiveFor,
          kindFor,
          redactSecrets,
          sha256Hex,
          isCatastrophic,
          subagentDetailFor,
          resourceKinds,
          DESTRUCTIVE_HINT,
          COMMAND_SUBSTITUTION,
          objectiveBudgetOf,
          ctx: { session: { context: ctx.session.context } },
          log: logEv,
          options,
          endedSessions,
          inst,
        }
        await evaluatePermission(deps, input)
      })
      hookRegistered = true
    } catch (err) {
      // Hook API not available (older opencode version): fall back to permission.asked events
      logEv({
        reason: "hook-unavailable",
        error_class: err instanceof Error ? err.message.slice(0, 120) : "exception",
      })
    }
    // pruneReplied only ran once, at setup(): a long-running opencode host
    // process (days/weeks, setup() never re-invoked) accumulates one marker
    // file per permission/form forever (unbounded: 5000 claimReply
    // calls means 5000 unpruned files). Same class of bug
    // already fixed for the in-memory collections via capped(); this is
    // its on-disk sibling. Cadence matches pruneReplied's own maxAgeMs
    // default (1h): no need to poll as often as the form-list.
    const pruneTimer = setInterval(() => pruneReplied(options), 3600000)
    ;(pruneTimer as unknown as { unref?: () => void }).unref?.()
    const controller = new AbortController()
    const formSeen = new Set<string>()
    // Shared poller: one 750ms interval per process (not per setup()
    // instance) polling /api/form location-scoped per known project
    // directory. This instance only registers its handler and its own
    // project directory; cleanup unregisters both.
    const pollHandler: PollHandler = {
      ctx: ctx as PollHandler["ctx"],
      log: logEv,
      inst,
      options,
      endedSessions,
    }
    const pollDir = (ctx as { location?: { directory?: unknown } }).location?.directory
    const pollDirStr = typeof pollDir === "string" && pollDir ? pollDir : null
    if (pollDirStr) addSharedPollDir(pollDirStr)
    registerPoller(pollHandler)
    ;(SHARED.pollTimer as unknown as { unref?: () => void } | null)?.unref?.()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const evt = event as { type?: string; data?: Record<string, unknown>; properties?: Record<string, unknown> }
        if (evt.type === "session.deleted") {
          const dead = String((evt.data ?? evt.properties ?? {}).sessionID ?? "")
          if (dead) capped(endedSessions).add(dead)
          continue
        }
        // Forms (question tool on 2.0.x) and legacy question events.
        if (
          evt.type === "form.created" ||
          evt.type === "question.v2.asked" ||
          evt.type === "question.asked"
        ) {
          const payload = (evt.properties ?? evt.data ?? {}) as Record<string, unknown>
          const form = (payload.form && typeof payload.form === "object"
            ? (payload.form as Record<string, unknown>)
            : payload) as Record<string, unknown>
          const fid = String(form.id ?? payload.id ?? "")
          if (fid) capped(formSeen).add(fid)
          // handleFormAsked re-derives its own formID from *this* payload's
          // .id alone (no further fallback): if the real id only lived at
          // the outer event's payload.id (form.id itself absent), fid above
          // resolves it correctly but handleFormAsked would still see
          // formID="" and hit its missing-ids early return, permanently
          // stuck: nothing gets claimed on disk (claimReply never runs),
          // yet formSeen is now marked forever, blocking the poll path's
          // retry for a form nothing ever actually processed.
          // Hand it a form object whose .id already matches fid.
          const formForHandler = fid && !form.id ? { ...form, id: fid } : form
          const task = handleFormAsked(ctx, logEv, inst, options, formForHandler, endedSessions)
          void task.catch(() => {
            // Failures are logged inside the handler. Mirror the poll
            // path's own cleanup: most failures inside
            // handleFormAsked are swallowed by its own internal fail-open
            // catch and never reject here, but a throw BEFORE its
            // claimReply call (e.g. missing-ids on a malformed event) never
            // claims anything on disk: leaving fid in formSeen forever
            // would permanently block the poll path's own retry for a form
            // that was never actually claimed.
            if (fid) formSeen.delete(fid)
          })
          continue
        }
        if (evt.type !== "permission.asked") continue
        const data = evt.data ?? evt.properties ?? {}
        const sessionID = String(data.sessionID ?? "")
        const requestID = String(data.id ?? "")
        const action = String((data as { action?: unknown }).action ?? "")
        // If the hook is registered, permission.asked means we already decided ask-human
        // or the config forced it. Just log as trace, no model call, no reply.
        if (hookRegistered) {
          logEv({ sessionID, requestID, tool: action, gateAction: "ask-human", reason: "asked-human" })
          continue
        }
        const resources = Array.isArray((data as { resources?: unknown }).resources)
          ? ((data as { resources: unknown[] }).resources.map(String))
          : []
        const metadata = (data as { metadata?: unknown }).metadata
        const source = ((): PermissionSource | null => {
          const s = (data as { source?: unknown }).source
          if (!s || typeof s !== "object") return null
          const messageID = (s as { messageID?: unknown }).messageID
          const id = (s as { id?: unknown }).id
          return typeof messageID === "string" && typeof id === "string" ? { messageID, id } : null
        })()
        if (!sessionID || !requestID) {
          logEv({
            sessionID: sessionID || null,
            requestID: requestID || null,
            tool: action || null,
            gateAction: "ask-human",
            reason: "missing-ids",
          })
          continue
        }
        if (await sessionIsEnded(ctx as Parameters<typeof sessionIsEnded>[0], sessionID, endedSessions)) {
          logEv({
            sessionID,
            requestID,
            tool: action,
            gateAction: "ask-human",
            reason: "session-ended",
          })
          continue
        }

        const cached = resolved.get(requestID)
        if (cached) {
          if (!cached.repliedOk && cached.decision !== "ask-human") {
            try {
              await replyPermission(sessionID, requestID, cached.decision === "allow" ? "once" : "reject")
              cached.repliedOk = true
            } catch {
              // Still pending or already resolved; nothing more to do.
            }
          } else {
            logEv({ sessionID, requestID, tool: action, gateAction: cached.decision === "allow" ? "allow" : cached.decision === "deny" ? "deny" : "ask-human", reason: "duplicate-suppressed" })
          }
          continue
        }
        const ongoing = inFlight.get(requestID)
        if (ongoing) {
          try {
            await ongoing
          } catch {
            // First evaluation owns the outcome; duplicates just wait.
          }
          continue
        }

        const task = handleOne(ctx, logEv, inst, options, sessionID, requestID, action, resources, endedSessions, source, metadata)
        inFlight.set(requestID, task)
        try {
          const outcome = await task
          capped(resolved).set(requestID, outcome)
        } catch {
          capped(resolved).set(requestID, { decision: "ask-human", repliedOk: true })
        } finally {
          inFlight.delete(requestID)
        }
      }
      } catch {
        // Subscription ended (server shutdown). Nothing to report.
      }
    })()
    return () => {
      unregisterPoller(pollHandler)
      if (pollDirStr) removeSharedPollDir(pollDirStr)
      clearInterval(pruneTimer)
      controller.abort()
      hookRegistration?.dispose()
    }
  },
})

export async function handleFormAsked(
  ctx: { session: { get?: (input: { sessionID: string }) => Promise<unknown>; context: (input: { sessionID: string }) => Promise<unknown> } },
  log: (entry: Record<string, unknown>) => void,
  inst: string,
  options: Record<string, unknown>,
  payload: Record<string, unknown>,
  endedSessions: Set<string>,
): Promise<void> {
  const sessionID = String(payload.sessionID ?? "")
  const formID = String(payload.id ?? "")
  if (!sessionID || !formID) {
    log({ sessionID: sessionID || null, requestID: formID || null, tool: "question", gateAction: "ask-human", reason: "missing-ids" })
    return
  }
  const toolRef = (payload.metadata as { tool?: { messageID?: unknown; id?: unknown } } | undefined)?.tool
  if (toolRef && questionsLeftForHuman.has(`${String(toolRef.messageID ?? "")}:${String(toolRef.id ?? "")}`)) {
    // The model already declined this question in the tool wrapper; asking
    // again here would just repeat the same call. It is the human's.
    return
  }
  const claim = claimReply(options, `form:${formID}`, inst)
  if (claim === "lost") {
    // Expected cross-instance outcome (setup() runs once per project
    // directory, so 15+ siblings race every form): staying silent keeps
    // the losers from flooding the log with duplicate-suppressed noise,
    // which would otherwise dominate the log. The winner logs the real outcome.
    return
  }
  if (await sessionIsEnded(ctx, sessionID, endedSessions)) {
    log({ sessionID, requestID: formID, tool: "question", gateAction: "ask-human", reason: "session-ended" })
    return
  }

  const fields = Array.isArray(payload.fields) ? payload.fields : []
  const answer: Record<string, string | string[]> = {}
  const picks: string[] = []

  try {
    let objective = "Answer the agent's multiple-choice question to unblock the session"
    try {
      objective = await objectiveFor(ctx, sessionID, endedSessions, Math.min(1500, objectiveBudgetOf(options)))
    } catch {
      // keep fallback
    }

    for (let fi = 0; fi < Math.max(fields.length, 1); fi++) {
      const field = fields[fi]
      const key =
        field && typeof field === "object" && typeof (field as { key?: unknown }).key === "string"
          ? String((field as { key: string }).key)
          : `q${fi}`
      const type = field && typeof field === "object" ? (field as { type?: unknown }).type : undefined

      // Conditional/hidden fields are skipped (no model call, no
      // answer entry) when their visibility doesn't hold against the
      // answers already decided. The server 400s on a reply that includes
      // a field whose `when` isn't satisfied, so this is not optional.
      if (!fieldVisible(field, answer)) {
        log({
          sessionID,
          requestID: formID,
          tool: "question",
          gateAction: "ask-human",
          reason: "form-field-hidden",
          fieldKey: key,
          phase: "form-answer",
        })
        continue
      }

      const labels = labelsFromFormField(field)
      const required =
        field && typeof field === "object" ? (field as { required?: unknown }).required === true : false

      // A visible field with no options and a non-multiselect
      // type (boolean/number/free-string) can't be answered by a pick:
      // there is nothing for the model to choose from. Log before calling the model
      // and don't call it. A non-required one is skipped (the form keeps
      // going); a required one aborts the form (ask-human: the field
      // stays pending for the human, since it can't be filled for them).
      if (labels.length === 0 && type !== "multiselect") {
        log({
          sessionID,
          requestID: formID,
          tool: "question",
          gateAction: "ask-human",
          reason: "form-unsupported-field",
          fieldKey: key,
          required,
          phase: "form-answer",
        })
        if (required) return
        continue
      }

      const title = field && typeof field === "object" ? String((field as { title?: unknown }).title ?? "") : ""
      const description =
        field && typeof field === "object" ? String((field as { description?: unknown }).description ?? "") : ""
      const detail = redactSecrets(
        [title, description, labels.map((l, i) => `${i + 1}. ${l}`).join("\n")].filter(Boolean).join("\n").slice(0, 4000),
      )
      const halt: Record<string, unknown> = {
        kind: "multichoice",
        tool: "question",
        detail: detail || "agent question form",
      }
      if (labels.length > 0) {
        halt.options = labels
        halt.numbered = numberedOptions(labels)
      }
      const startedAt = Date.now()
      const { decision, retried } = await runGate(options, {
        objective,
        halt,
        context: { sessionID, requestID: formID, risk_hints: "interactive-form-question", fieldIndex: fi },
        policy: { default: "ask-human when unsure" },
      })
      const elapsedMs = Date.now() - startedAt
      log({
        sessionID,
        requestID: formID,
        tool: "question",
        kind: "multichoice",
        gateAction: decision.action,
        reason: decision.reason,
        confidence: decision.confidence,
        model: decision.model,
        ...(decision.usage ? { usage: decision.usage } : {}),
        pick: decision.pick ?? null,
        elapsedMs,
        objectiveChars: objective.length,
        optionsCount: labels.length,
        fieldKey: key,
        ...(retried ? { retry: 1 } : {}),
        ...(typeof decision.error === "string" ? { error_class: decision.error } : {}),
        ...(typeof decision.error_detail === "string" ? { error_detail: decision.error_detail } : {}),
        phase: "form-answer",
      })

      // No silent early exits from the field loop: every one logs a
      // distinct reason with gateAction "ask-human" (the field stays
      // pending for the human) and this fieldKey.
      const rawPick = decision.pick
      if (decision.action !== "allow" || rawPick == null) {
        log({
          sessionID,
          requestID: formID,
          tool: "question",
          gateAction: "ask-human",
          reason: "form-model-not-allow",
          fieldKey: key,
          decisionAction: decision.action,
          decisionReason: decision.reason,
          pick: rawPick ?? null,
          phase: "form-answer",
        })
        return
      }
      let pickList: string[]
      if (!Array.isArray(rawPick)) {
        if (typeof rawPick !== "string" || rawPick === "") {
          log({
            sessionID,
            requestID: formID,
            tool: "question",
            gateAction: "ask-human",
            reason: "form-model-not-allow",
            fieldKey: key,
            decisionAction: decision.action,
            decisionReason: decision.reason,
            pick: rawPick,
            phase: "form-answer",
          })
          return
        }
        pickList = [rawPick]
      } else {
        if (rawPick.length === 0 || rawPick.some((p) => typeof p !== "string" || p === "")) {
          log({
            sessionID,
            requestID: formID,
            tool: "question",
            gateAction: "ask-human",
            reason: "form-model-not-allow",
            fieldKey: key,
            decisionAction: decision.action,
            decisionReason: decision.reason,
            pick: rawPick,
            phase: "form-answer",
          })
          return
        }
        pickList = rawPick as string[]
      }
      if (labels.length > 0 && pickList.some((p) => !labels.includes(p))) {
        log({
          sessionID,
          requestID: formID,
          tool: "question",
          gateAction: "ask-human",
          reason: "form-pick-not-offered",
          fieldKey: key,
          pick: rawPick,
          phase: "form-answer",
        })
        return
      }
      const values: string[] = []
      for (const p of pickList) {
        const encoded = encodeAnswer(field, p)
        if (encoded === null) {
          log({
            sessionID,
            requestID: formID,
            tool: "question",
            gateAction: "ask-human",
            reason: "form-pick-ambiguous",
            fieldKey: key,
            pick: p,
            phase: "form-answer",
          })
          return
        }
        if (typeof encoded === "string") values.push(encoded)
        else values.push(...encoded)
      }
      if (type !== "multiselect" && values.length !== 1) {
        // Several picks for a single-select field: can't tell which one the model
        // meant. Same treatment as any other ambiguity.
        log({
          sessionID,
          requestID: formID,
          tool: "question",
          gateAction: "ask-human",
          reason: "form-pick-ambiguous",
          fieldKey: key,
          pick: rawPick,
          phase: "form-answer",
        })
        return
      }
      picks.push(...pickList)
      answer[key] = type === "multiselect" ? values : values[0]
    }

    // Every field was skipped (hidden or unsupported): the server accepts an
    // empty answer, which would submit the form on the human's behalf with
    // nothing in it. Leave it pending for the human instead.
    if (Object.keys(answer).length === 0) {
      log({ sessionID, requestID: formID, tool: "question", gateAction: "ask-human", reason: "form-nothing-answerable", phase: "form-answer" })
      return
    }

    try {
      await replyFormAnswer(sessionID, formID, answer)
      log({
        sessionID,
        requestID: formID,
        tool: "question",
        gateAction: "allow",
        reason: "question-answered",
        pick: picks.join(" | "),
      })
    } catch (err) {
      log({
        sessionID,
        requestID: formID,
        tool: "question",
        gateAction: "ask-human",
        reason: "form-reply-failed",
        error_class: err instanceof Error ? err.message.slice(0, 120) : "exception",
      })
    }
  } catch (err) {
    log({
      sessionID,
      requestID: formID,
      tool: "question",
      kind: "multichoice",
      gateAction: "ask-human",
      reason: "fail-open",
      error_class: err instanceof Error ? err.message.slice(0, 120) : "exception",
      phase: "form-answer",
    })
  }
}

export async function handleOne(
  ctx: { session: { get?: (input: { sessionID: string }) => Promise<unknown>; context: (input: { sessionID: string }) => Promise<unknown> } },
  log: (entry: Record<string, unknown>) => void,
  inst: string,
  options: Record<string, unknown>,
  sessionID: string,
  requestID: string,
  action: string,
  resources: string[],
  endedSessions: Set<string>,
  source?: PermissionSource | null,
  metadata?: unknown,
): Promise<{ decision: string; repliedOk: boolean }> {
  // From permission.asked to whenever we attempt (or give up on) a reply,
  // diagnoses the reply-vs-server-window race, distinct from
  // the model's own call time (which runGate already measures separately).
  const receivedAt = Date.now()
  // Claim the whole request (evaluation + reply) before calling the model, not
  // just before replying. setup() runs more than once per opencode
  // process (confirmed in production logs: same pid, different inst),
  // so without this, every instance independently evaluates and races
  // to reply to the same permission: 2-3x model calls and, for the
  // interactive question tool, a reply race against the human's own
  // answer. First claimant wins via an exclusive marker file; losers
  // never touch the model at all.
  const claim = claimReply(options, requestID, inst)
  if (claim === "lost") {
    log({ sessionID, requestID, tool: action, gateAction: "ask-human", reason: "duplicate-suppressed" })
    return { decision: "ask-human", repliedOk: true }
  }

  let joined = resources.join("\n")
  let resKinds = resourceKinds(resources)
  if (joined.length > MAX_SCANNED_CHARS) {
    log({ sessionID, requestID, tool: action, gateAction: "ask-human", reason: "oversized-request", detailChars: joined.length, detail_sha256: sha256Hex(joined) })
    return { decision: "ask-human", repliedOk: true }
  }
  if (isCatastrophic(joined)) {
    log({ sessionID, requestID, tool: action, kind: "destructive", gateAction: "reject", reason: "catastrophic-pattern", detail_sha256: sha256Hex(joined) })
    let repliedOk = true
    try {
      await replyPermission(sessionID, requestID, "reject")
    } catch (err) {
      log({ sessionID, requestID, tool: action, gateAction: "reject", reason: "reply-failed", error_class: err instanceof Error ? err.message.slice(0, 120) : "exception", totalElapsedMs: Date.now() - receivedAt })
      repliedOk = false
      // The reject was computed but never delivered: the tool call may be
      // hanging with no signal at all otherwise. See docs/TROUBLESHOOTING.md
      // "Ordinary permission replies can silently miss the window".
    }
    return { decision: "deny", repliedOk }
  }

  // question permission: allow the tool, with no session.context and no model call.
  // Answering happens by polling /api/form and POSTing form replies.
  // Touching session.context here was implicated in the post-pick hang.
  if (action === "question") {
    let repliedOk = true
    try {
      await replyPermission(sessionID, requestID, "once")
    } catch (err) {
      log({
        sessionID,
        requestID,
        tool: action,
        kind: "multichoice",
        gateAction: "allow",
        reason: "reply-failed",
        error_class: err instanceof Error ? err.message.slice(0, 120) : "exception",
        totalElapsedMs: Date.now() - receivedAt,
      })
      repliedOk = false
    }
    log({
      sessionID,
      requestID,
      tool: action,
      kind: "multichoice",
      gateAction: "allow",
      reason: "question-permission-passthrough",
      detail_sha256: sha256Hex(joined),
      resKinds,
      repliedOk,
    })
    return { decision: "allow", repliedOk }
  }

  // The subagent/task permission's own `resources` is just the target
  // agent's short name (see subagentDetailFor's comment): pull the real
  // dispatch content (agent/description/prompt) so kindFor and the model both
  // see what the subagent will actually do, not just its agent type.
  // Never throws (subagentDetailFor fails open to null internally), so
  // this can't turn into a new fail-open path of its own.
  if (action === "subagent" || action === "task") {
    const enriched = await subagentDetailFor(ctx, sessionID, source)
    if (enriched) {
      resources = [enriched]
      joined = enriched
      resKinds = resourceKinds(resources)
    }
  }

  const kind = kindFor(action, resources)

  // spawnGate is called INSIDE the try: spawn() throws SYNCHRONOUSLY,
  // not via a rejected promise, when an env
  // value derived from options (e.g. a NUL byte in a malformed
  // logFile/gateDir) is invalid. Outside the try, that throw
  // propagated out of handleOne entirely, past every log() call in this
  // function, caught only by setup()'s bare event-loop catch, which logs
  // nothing and marks repliedOk:true so a
  // later duplicate permission.asked for the same requestID never even
  // retries (claimReply already claimed it). Strictly worse than every
  // other fail-open path in this file, which was built specifically to
  // never fail silently.
  try {
    // Spawn the gate subprocess before objectiveFor's session.context RPC
    // resolves, not after: its cold start (interpreter init, module imports
    // import) then overlaps with that RPC instead of adding to it serially.
    // Every millisecond here is one this permission's reply doesn't get to
    // spend against the server's reply window.
    const startedAt = Date.now()
    let objective: string
    // First spawn attempt
    let gate = spawnGate(options)
    let retried = false
    try {
      objective = await objectiveFor(ctx, sessionID, endedSessions, objectiveBudgetOf(options))
    } catch (err) {
      gate.cancel()
      throw err
    }
    const metaDetail = metadataDetailFor(action, metadata)
    const detail = clipHeadTail(redactSecrets(metaDetail ? `${joined}\n${metaDetail}` : joined), DETAIL_MAX_CHARS)
    const hintParts: string[] = []
    if (action === "doom_loop") hintParts.push("doom_loop: identical tool call repeated")
    if (DESTRUCTIVE_HINT.test(joined) || hasDestructiveCurlOrWget(resources)) hintParts.push("matches destructive-hint")
    if (COMMAND_SUBSTITUTION.test(joined)) hintParts.push("contains command substitution ($(...) or `...`); real effect cannot be statically determined")
    if (detail.includes(OMITTED_MARK)) hintParts.push("detail too long: middle omitted, judge head and tail")
    const riskHints = hintParts.join("; ")
    const halt: Record<string, unknown> = { kind, tool: action, detail }
    const gateEvent = {
      objective,
      halt,
      context: { sessionID, requestID, risk_hints: riskHints },
      policy: { default: "ask-human when unsure" },
    }
    // First attempt
    gate.send(gateEvent)
    let decision: Record<string, unknown>
    try {
      decision = await gate.result
    } catch (err) {
      // Retry ONLY for signal kills or spawn errors (child 'error' event)
      // Do NOT retry for timeouts or JSON parse errors
      if (!isRetryableGateError(err)) {
        throw err
      }
      // One retry with a fresh spawn
      gate = spawnGate(options)
      gate.send(gateEvent)
      decision = await gate.result
      retried = true
    }
    // Spans spawn → decision (overlaps objectiveFor's RPC), not just the
    // subprocess's own runtime: that's the full budget that matters for
    // the reply-window race.
    const elapsedMs = Date.now() - startedAt
    log({
      sessionID,
      requestID,
      tool: action,
      kind,
      gateAction: decision.action,
      reason: decision.reason,
      confidence: decision.confidence,
      model: decision.model,
      ...(decision.usage ? { usage: decision.usage } : {}),
      pick: decision.pick ?? null,
      elapsedMs,
      objectiveChars: objective.length,
      detail_sha256: sha256Hex(joined),
      resKinds,
      ...(retried ? { retry: 1 } : {}),
      ...(typeof decision.error === "string" ? { error_class: decision.error } : {}),
      ...(typeof decision.error_detail === "string" ? { error_detail: decision.error_detail } : {}),
    })
    let repliedOk = true
    if (decision.action === "allow" || decision.action === "deny") {
      try {
        await replyPermission(sessionID, requestID, decision.action === "allow" ? "once" : "reject")
      } catch (err) {
        log({
          sessionID,
          requestID,
          tool: action,
          gateAction: decision.action,
          reason: "reply-failed",
          error_class: err instanceof Error ? err.message.slice(0, 120) : "exception",
          totalElapsedMs: Date.now() - receivedAt,
        })
        repliedOk = false
        // The model decided, but the reply arrived after the server stopped
        // tracking the request: the tool call is likely hanging with no
        // other signal. See docs/TROUBLESHOOTING.md "Ordinary permission
        // replies can silently miss the window".
      }
    }
    return { decision: String(decision.action), repliedOk }
  } catch (err) {
    if (err instanceof SessionEndedError || endedSessions.has(sessionID)) {
      log({
        sessionID,
        requestID,
        tool: action,
        kind,
        gateAction: "ask-human",
        reason: "session-ended",
        error_class: err instanceof Error ? err.message.slice(0, 120) : "exception",
      })
      return { decision: "ask-human", repliedOk: true }
    }
    log({
      sessionID,
      requestID,
      tool: action,
      kind,
      gateAction: "ask-human",
      reason: "fail-open",
      error_class: err instanceof Error ? err.message.slice(0, 120) : "exception",
    })
    return { decision: "ask-human", repliedOk: true }
  }
}
