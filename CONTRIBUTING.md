# Contributing

## Quick start

```bash
git clone git@github.com:iDiagoValeta/ollaya-decision-gate.git
cd ollaya-decision-gate
curl -fsSL https://ollaya.dev/install.sh | sh
ollaya serve &
ollaya pull winnow:e4b
python3 -m pip install -e ".[dev]"
npm --prefix plugin install
python3 -m pytest -q
python3 -m ollaya_gate.doctor
```

The gate itself is stdlib only (no runtime dependencies); the `[dev]`
extra is for tests and lint.

## Branches and commits

- Branch from `main`: `feat/<scope>`, `fix/<scope>`, `docs/<scope>`.
- Conventional Commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- One logical change per commit. Keep `main` green.

## Safety contract (must not break)

1. Fail-open to `ask-human` on any error, never silent `allow`.
2. No secrets in logs or model payloads (run `pytest -q`, redaction tests cover this).
3. Policy changes require a golden test in `tests/golden.json`.
4. Never judge a truncated state: truncation is retried smaller or
   fail-opens to ask-human, never a verdict (see `AGENTS.md`
   non-negotiable 7 for why `/api/decide` exists).

## Pull requests

- Fill the PR template, link `Closes #<n>`.
- `pytest -q` green; for plugin changes, `tsc --noEmit` and
  `npm --prefix plugin test` green too.
- Update the relevant doc (`README.md`, `AGENTS.md`,
  `docs/ARCHITECTURE.md`, `docs/TROUBLESHOOTING.md`) when the change
  touches behavior, a supported version, or a known limitation. There
  is no changelog file in the repo; `git log` is the history.
