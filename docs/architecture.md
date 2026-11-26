# Architecture

fritz-whyblocked is one Bun process: an HTTP server that serves a single-page UI and a small JSON API, talks to the
FRITZ!Box over its HTTP API and plain DNS, and keeps two things on disk. It has no runtime dependencies.

## Modules

| Module              | Owns                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `src/server.ts`     | Entry point: configuration, routes, request validation, the box-state cache, the timers      |
| `src/config.ts`     | Environment variables and systemd credentials, turned into a `Config`                        |
| `src/analysis.ts`   | `analyze()`: CNAME chain, probes, trigger, responsible rules, notes                          |
| `src/dns.ts`        | A minimal DNS client over UDP (A, AAAA, CNAME) and the block-address check                   |
| `src/rules.ts`      | Parsing filter-list lines, the hashed `RuleIndex`, `RuleSet` (download, cache, lookup)       |
| `src/fritz.ts`      | `FritzBox` (PBKDF2 login, SID renewal, `GET`/`PUT` of the DNS filter) and pure write helpers |
| `src/store.ts`      | `StatsStore`, the statistics history in SQLite, and `toIntervals()`                          |
| `src/embedded.ts`   | `public/index.html` as a string; the build replaces this module                              |
| `public/index.html` | The whole UI: markup, CSS and one module script, no build step                               |

Only `server.ts` has side effects on import. Everything else exports functions and classes that the tests exercise
directly, which is why `analyze()` takes its DNS client and rule lookup as `AnalysisDeps` instead of importing them.

## The analysis

`GET /api/check?domain=…` runs `analyze()`:

1. `normalizeDomain()` turns the input, domain or URL, into a lowercase hostname, IDNs as punycode.
2. The reference DNS (`REFERENCE_DNS`) resolves the CNAME chain. If it is unreachable, only the name itself is checked.
3. Every link is queried at the box for A and AAAA, on each of its addresses (`BOX_DNS_V4`, `BOX_DNS_V6`). The box
   answers a blocked name with `0.0.0.0` or `::` (`isBlockAddress()`).
4. The last blocked link is the trigger. If it is a CNAME target, an exception for the requested name does not help,
   and the notes say so.
5. `RuleSet.lookup()` finds rules for each link and its parent domains, and `customHitsFor()` the box's own allow and
   deny entries.

The rule index stores each rule as a 44-bit domain hash times four plus its two-bit kind, in a sorted `Float64Array`
(8 bytes per rule; a float holds integers up to 2^53 exactly). A lookup is a binary search; a hit is then confirmed by
finding the original line in the cached list text (`findLine()`), which also rules out hash collisions. Which kinds
apply to subdomains is not documented for the box: `classify()` marks those hits as uncertain, and the UI shows them
as "interpretation unclear".

## Box state and writes

`getFilter()` caches the box's DNS filter for 15 seconds; writes and the timers read it fresh. The filter lists are
downloaded on start and every `LISTS_REFRESH_HOURS` into `DATA_DIR/lists/`; a failed download falls back to the cache.
The statistics are sampled every `STATS_INTERVAL` seconds and kept for 30 days.

Every write to the box goes through `writeOrPlan()`. A request is a dry run unless its body says `"dryRun": false`: the
dry run returns the planned `PUT`, which the UI shows for confirmation. The real write sends it, reads the filter again
and reports whether the change arrived (`applied`, and a `warning` if not). The box's beta API takes the whole
collection on `PUT`, so the pure helpers in `fritz.ts` (`upsertDomain()`, `setListEnabled()`) build the full new list
from the current one, and `writableLists()` strips the read-only `status` fields.

## HTTP API

| Route                     | Body                                     | Does                                           |
| ------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `GET /`                   |                                          | The UI                                         |
| `GET /api/health`         |                                          | `{ "ok": true }`, without auth, for the deploy |
| `GET /api/status`         |                                          | Box error, filter switch, domains, lists       |
| `GET /api/check?domain=`  |                                          | The analysis                                   |
| `GET /api/stats?hours=`   |                                          | Statistics intervals, at most 30 days          |
| `POST /api/domains`       | `domain`, `action`, `enabled`, `comment` | Add or switch an allow/deny entry              |
| `POST /api/lists/toggle`  | `url`, `enabled`                         | Switch a filter list                           |
| `POST /api/filter/toggle` | `enabled`                                | Switch the whole DNS filter                    |
| `POST /api/lists/refresh` |                                          | Download the lists again                       |

Every write body also takes `dryRun`. `readBody()` checks that the body is a JSON object, and `str()`, `bool()` and
`optionalStr()` check each field, answering `400` otherwise. An `HttpError` sets the status; any other error is
reported as `502`, since it almost always comes from the box.

With `UI_PASSWORD` set, the server listens on all interfaces behind basic auth; without it, only on `127.0.0.1`.
Requests other than `GET` need the header `X-WhyBlocked: 1`, which a cross-site form cannot send.

## Single-file build

`src/scripts/build.ts` bundles `src/server.ts` with `Bun.build` and replaces `src/embedded.ts` with a module holding
`public/index.html` as a string, stamped with the commit and build time. During development `embedded.ts` reads the
file from disk instead. The build writes `bun-version` next to the bundle, so the server can run each release on the
Bun that built it (`docs/deployment.md`).

## Tests

Tests sit beside their module as `*.test.ts` and use `bun:test`. They never reach a box or the network: `analyze()`
gets a fake `QueryFn`, DNS parsing is tested on hand-built packets, and the box helpers are pure functions. The build
test runs a real build into a temporary directory.
