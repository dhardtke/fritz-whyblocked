# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun start                # the server on http://127.0.0.1:8053, configured through .env
bun run start:dev        # same, with --watch
bun run build            # one-file deployment build: dist/fritz-whyblocked.js (+ .map, bun-version)
bun test --parallel      # the test suite; none of it talks to a real box or the network
bun test --parallel src/rules.test.ts # one file
bun test --parallel -t "parseLine"    # one test / describe block by name
bun run fmt              # format; fmt:check only checks
bun run lint             # oxlint, type-aware
bun run typecheck        # bun check
```

The list cache and the statistics database live in `data/` (override with `DATA_DIR`) and are git-ignored. A `.env`
with `FRITZ_PASSWORD` is needed to talk to a box; without one the server still starts and reports the missing password.

Always put plans inside the project directory.

Never edit existing plans or research docs in `docs/agents/` — only add new ones. Each describes the repository as it
stood on the date it carries, so an old path in one is a record, not a bug.

## Architecture

- `src/server.ts` — the entry point: configuration, the HTTP routes, the box-state cache, timers
- `src/analysis.ts`, `src/dns.ts`, `src/rules.ts` — the analysis of why a domain is blocked
- `src/fritz.ts` — login and the box's DNS filter API
- `src/store.ts` — the statistics history in SQLite
- `public/index.html` — the whole UI, one file with no build step
- `src/scripts/` — `build` and `pre-commit-checks`, a Claude Code hook in `.claude/settings.json` that blocks
  `git commit` until `fmt:check`, `lint`, `typecheck` and the tests pass

Tests sit beside the module they exercise.

Details live in `docs/`. Read the ones a task touches before starting it:

- `docs/coding-guidelines.md` — pinning, quote style, private members, comments, American English, commits on `main`.
  Read before writing any code, prose or commit.
- `docs/architecture.md` — the modules, the analysis, writes to the box, the HTTP API, the single-file build, tests.
  Read before changing anything under `src/` or `public/`.
- `docs/checklists.md` — what adding an endpoint, a write to the box, a configuration variable or a rule format
  touches. Read before adding one of those, and its "Before committing" list before every commit.
- `docs/deployment.md` — the CI workflow, the self-hosted runner and its privileges, server setup. Read before changing
  `.github/`, `deploy/`, the build, or anything about how fritz-whyblocked runs in production.

That list is the only index in the repository: a document added to `docs/` is added here in the same commit.
