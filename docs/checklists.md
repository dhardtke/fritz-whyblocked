# Checklists

What a common change touches, in order. Each step links to the section that explains why; the linter, the typechecker
and the tests catch most steps that are skipped, but not all of them.

## An API endpoint

1. Add the route to `handle()` in `src/server.ts`, under the `/api/` prefix. A route other than `GET` is covered by
   the CSRF header check on its own ("HTTP API" in `docs/architecture.md`).
2. Read a body with `readBody()` and each field with `str()`, `bool()` or `optionalStr()`; never cast it.
3. Throw an `HttpError` for a client error rather than answering it yourself.
4. Put the logic in a module other than `server.ts`, as a function a test can call, and test it there.
5. Call it from `public/index.html` through `api()`, and add the route to the table in `docs/architecture.md`.

## A write to the box

1. Build the full new collection with a pure helper in `src/fritz.ts`, like `upsertDomain()`, and test it in
   `src/fritz.test.ts` ("Box state and writes").
2. Send it through `writeOrPlan()` with a `verify` function that checks the state read back, so the UI gets a dry run
   first and a warning if the box ignores the change.
3. Strip fields the box reports but does not accept, as `writableLists()` does.

## A configuration variable

1. Read it in `loadConfig()` in `src/config.ts`, through `env()` or `num()` so an empty value means unset; a secret
   goes through `secret()` and gets a systemd credential name.
2. Add it to `.env.example` and to the table in `README.md`, and cover its parsing in `src/config.test.ts`.
3. If the server must have it, add it to `/etc/fritz-whyblocked/config.env` on the server before the deploy, and to
   `deploy/fritz-whyblocked.service` if it is a credential.

## A filter-list format

1. Extend `parseLine()` in `src/rules.ts` and its tests in `src/rules.test.ts`.
2. If it adds a rule kind, extend `KIND`, `KINDS`, `KIND_LABEL` and `classify()`. Two bits hold the kind, so there is
   no room for a fifth without changing the index ("The analysis").
3. `findLine()` confirms a hit by searching the list text for the domain and parsing that line again, so the domain
   must appear in the line as it is stored; otherwise the hit is discarded as a hash collision.

## Before committing

1. Update `docs/` in the same commit; a new document is also added to the list in `AGENTS.md`.
2. Run `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun test --parallel`. The Claude Code hook in
   `.claude/settings.json` runs the same checks and blocks `git commit` until they pass.
