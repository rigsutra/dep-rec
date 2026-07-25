# Dependency Recommendation Engine — prototype

A deterministic scoring layer that tells AI coding assistants which npm
package actually fits a given need and environment — not just which name
they remember from training data. See the full product spec and roadmap
doc for the vision, data model, and scoring rubric this repo implements
against.

## Status

Working through the roadmap's proofs, in order:

- [x] **Proof 0** — confirm the Edge Runtime compatibility signal is real
      ([`proof0/`](proof0))
- [x] **Proof 1** — collect a searchable, consistent dataset across
      competing categories ([`stage1-collector/`](stage1-collector))
- [x] **Proof 2** — rank packages within a category better than raw
      popularity ([`stage1-collector/src/score.ts`](stage1-collector/src/score.ts))
- [x] **Proof 3** — wrap it as an MCP tool *and* a CLI, prove both work as a
      real installed dependency ([`mcp-server/`](mcp-server)) — verified via
      a real MCP client/server round trip and `npx dep-rec ...` from a
      separate scratch project ([`example-consumer/`](example-consumer)),
      generalized with a `check_package`/`dep-rec check` command that scores
      *any* npm package live, and backed by a persistent store (SQLite)
      instead of a static snapshot — a package is fetched once, served from
      storage for everyone after that, and kept fresh by a background
      refresh job. Not yet wired into a live editor's MCP config, and not
      published to the public npm registry (private by design — see
      `mcp-server/README.md`).
- [ ] Proof 4 — benchmark AI-with-tool vs. AI-without

## Layout

```
proof0/              Tier 3 signal check — bundles a package the way an edge
                      bundler would, runs it inside a real @edge-runtime/vm,
                      reports pass/warn/fail with the actual error.

stage1-collector/     Tier 1 + Tier 2 data collector — builds a ~500-package
                      dataset across 10 competing categories (auth-jwt,
                      orm-database, testing, etc.), pulling npm registry
                      metadata, weekly downloads, and OSV vulnerability data
                      for each. Output: stage1-collector/data/packages.json.
                      Also has the scoring engine (src/score.ts) — applies
                      the deterministic rubric, writes data/scored.json.

mcp-server/           Wraps a persistent SQLite-backed store behind two
                      interfaces sharing the same logic: an MCP server
                      (list_categories, recommend_package, check_package)
                      for AI assistants, and a `dep-rec` CLI for humans or
                      non-MCP-aware scripts/agents. Builds to a real
                      installable package (two bin entries, bundled
                      data/store.db). Includes a real test client that
                      spawns the server over the actual MCP protocol, and
                      a background refresh worker
                      (src/store/refresh-worker.ts) that keeps tracked
                      packages' data from going stale.

example-consumer/     A from-scratch project that installs mcp-server's
                      packed tarball as a real devDependency and calls
                      both interfaces (`npx dep-rec ...` and the MCP
                      client) purely from node_modules/ — proof this
                      behaves like an actual dependency, not just "runs
                      from source."
```

Each subfolder is its own small Node/TypeScript project (own `package.json`,
run with `npm install && npm run <script>` inside that folder) rather than
one shared workspace — at this stage they don't share code, and keeping
them independent makes each one easy to run in isolation.

## Data sources used so far

- `registry.npmjs.org` — package metadata, existence checks, version history
- `api.npmjs.org` — weekly download counts
- `api.osv.dev` — known vulnerabilities (batch query)
- `@edge-runtime/vm` + `esbuild` — real Edge Runtime execution test

Both npm's search and downloads endpoints throttle after roughly a dozen
rapid requests from one client — the collector retries with backoff instead
of silently treating a throttled response as "no data," which was a real bug
caught during the first run (see [`stage1-collector/README.md`](stage1-collector/README.md)).

## A second real bug, caught by Proof 2

Scoring surfaced its own bug, not just a weighting problem: querying OSV by
package name alone returns every vulnerability ever recorded against *any*
version ever published. `axios` came back with "44 known vulnerabilities" —
0 of which affect its actual current release. Fixed by scoping every OSV
query to each package's current latest version. Also fixed: the
supply-chain sub-score was ranked as a percentile against category peers,
which zero-sums every framework's score down just for legitimately needing
more direct dependencies than a single-purpose utility — switched to an
absolute curve on dependency count instead.

One known, *undecided* tradeoff (not a bug): Compatibility (20% of the
score) rewards ESM/TypeScript support uniformly, which drags down otherwise
excellent, actively-patched CJS-only packages (`express`, `jsonwebtoken`,
`mocha`) relative to modern ESM-native ones (`hono`, `jose`, `jotai`) even
for plain Node use cases where ESM doesn't actually matter. Worth deciding
deliberately later, not silently.

## A third real bug, caught while packaging Proof 3

`check_package` makes live outbound HTTPS calls (unlike the other two
tools, which only read the bundled local dataset) — and it failed with a
bare `fetch failed` the first time it ran through a real MCP client/server
subprocess, despite the identical code working fine called directly.
Cause: the MCP SDK's default environment for a spawned server process on
Windows is a short allowlist (`APPDATA`, `PATH`, `SYSTEMROOT`, a handful of
others) that doesn't pass through whatever this machine's network layer
needs for outbound HTTPS. Fixed by passing `env: process.env` explicitly in
both test clients — but worth knowing generally: any real MCP host that
restricts a spawned server's environment will hit the same failure for any
server that needs real network access, not just this one.

## From static snapshot to persistent store

The original `mcp-server` just read a bundled `scored.json` — fine for the
curated 500, but wrong for "check any package": every `check_package` call
would refetch from the live registry, even for a package 99 other people
had already asked about seconds earlier. `mcp-server/src/store/` replaces
that with a real SQLite-backed store (`node:sqlite`, no native dependency)
holding both raw registry/OSV data and computed scores. The actual
behavior, proved with two genuinely separate spawned processes in
`example-consumer/test.mjs`: the first lookup of a never-seen package
returns `servedFrom: "live-fetch"`; a second, fully independent process
checking the same package gets `servedFrom: "cache"` with identical data —
zero network calls, because both processes share the same file on disk.

A package enters the store — and therefore future background refreshing
via `npm run refresh` — the moment anyone looks it up, whether it's one of
the curated 500 or a brand-new `check_package` call. This also unified two
scoring implementations that had started to diverge (the category-relative
percentile scorer and the absolute-scale live scorer) into one shared
module (`store/scoring.ts`), since every package now lives in the same
table regardless of where it came from.

## CLI, sharing the same logic as the MCP server

`mcp-server/src/cli.ts` (`dep-rec` once installed) is a second interface on
top of the identical `data.ts`/store logic — for humans running it
directly, or any script/agent that isn't MCP-aware but can shell out to a
devDependency's bin. One small real bug caught while testing it: the
default number formatting (`toLocaleString()` with no explicit locale)
picked up this machine's locale and printed download counts with Indian
numbering grouping (`23,91,77,371` instead of `239,177,371`) — fixed by
pinning `"en-US"` explicitly rather than trusting whatever locale the host
happens to have configured.

## Post-publish security review (v0.1.1 → v0.1.2)

Once `dep-rec` was actually live on the public registry, an external
review against the shipped source found 8 real issues. All seven real
ones are now fixed: five in `0.1.1` (a stale "not published yet" doc
line, OSV checks failing open, package age fetched but unused, supply-chain
scoring ignoring install scripts, and a transitively pulled-in moderate
vulnerability via `@hono/node-server` — that last one only partially,
since the `overrides` fix doesn't propagate to anyone installing `dep-rec`
as a dependency, verified directly against a clean install in
`example-consumer`), and the remaining two — no name-similarity typosquat
detection, and no way to tell a decode-only JWT library from a real auth
one within a category — in `0.1.2`. The typosquat fix was verified against
the exact reported case (`check reactt` now correctly flags it as one
character from `react`, 162M weekly downloads vs. 61); the capability fix
was verified by confirming `jwt-decode` drops out of the top 5 for "jwt
library" and `jose` becomes the top pick instead. Full writeup:
[`mcp-server/README.md`](mcp-server/README.md#post-publish-security-review--v011--v012).

## Not yet wired in

- GitHub-derived signals (stars, forks, bus factor) — needs an authenticated
  token to get a usable rate limit at this package count; deliberately left
  out of v1 rather than blocked on it.
- deps.dev transitive-dependency and OpenSSF Scorecard enrichment.
- Tier 3 (Proof 0's edge-runtime check) has not yet been run across the full
  Proof 1 dataset — it currently only runs against the 6 hand-picked test
  packages in `proof0/`. The MCP server's `recommend_package` tool returns
  an explicit caveat when `runtime: "edge"` is requested, rather than
  silently answering from ESM support alone.
- The MCP server isn't registered in any live editor/assistant's MCP config
  yet — that's a config change on your own machine, left as a manual step
  (see `mcp-server/README.md`) rather than done automatically.
- `npm run refresh` (the background surveillance job) is a script, not a
  scheduled one — nothing currently invokes it on a timer. Wiring that up
  is a deployment decision, not something to bake in silently.
- `node:sqlite` is still an experimental Node API. Fine for a prototype at
  this scale; worth revisiting (`better-sqlite3` or similar) before this
  goes anywhere near production.
