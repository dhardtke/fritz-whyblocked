# Coding guidelines

Dependencies are pinned to exact versions — no `^` or `~` ranges — so an install resolves the same tree on any machine
and upgrades only ever happen deliberately. `bunfig.toml` sets `install.exact`, which keeps a later `bun add` from
writing a caret range and undoing that. `engines.bun` records the required runtime, but Bun does not enforce the field
on install: it documents the requirement rather than gating it. There are no runtime dependencies; keep it that way
unless a dependency saves far more than it costs, since the build has to bundle it.

Upgrades arrive as pull requests from Renovate (`renovate.json`), which keeps the exact pins exact, moves the action
SHAs in `.github/workflows/` along with their version comments, and bumps the Bun that CI runs through `.bun-version`.
It waits until an npm release is three days old and refreshes the lockfile's transitive dependencies weekly. `bun` and
`@types/bun` arrive in one pull request, as do `oxlint` and `oxlint-tsgolint`, since each pair has to move together.
The oxlint pair and the lockfile maintenance automerge once their `check` job is green; everything else is merged by
hand, because merging to `main` deploys. The `bun` pull request also moves the exact `engines.bun`, and the server
follows on deploy (see "How a deploy works" in `docs/deployment.md`).

TypeScript and JavaScript use single quotes; `bun run fmt` enforces it, including the script in `public/index.html`.

Private class members use `#` names, never TypeScript's `private` modifier. A `#` name is private at runtime as well as
to the compiler. Since a `#` name cannot be a parameter property, `bun run lint` bans parameter properties altogether
(`typescript/parameter-properties`); a `private` method or field in a class body is not caught by any rule. A
`private constructor` is the exception, since a constructor cannot have a `#` name.

Input from outside the process — request bodies, the box's responses, environment variables — arrives as `unknown`
and is checked before it gets a type. `bun run lint` rejects `as` casts that narrow a type
(`typescript/no-unsafe-type-assertion`); write a check or a type guard instead.

Code carries no comments unless one records something the code cannot: a non-obvious constraint, an external quirk (the
box's API has several), a reason a surprising choice is deliberate. Never a restatement of what the next lines do — if
that is what a comment would say, the fix is a clearer name or a smaller function. Explanation of why the code is the
way it is belongs in these documents and in commit messages.

Code, comments, docs and commit messages are written in American English.

Commits go directly on `main`; don't open a feature branch unless asked.
