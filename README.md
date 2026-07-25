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
- [x] **Proof 3** — wrap it as an MCP tool, prove an assistant can call it
      ([`mcp-server/`](mcp-server)) — verified via a real MCP client/server
      round trip, not yet wired into a live editor's MCP config
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

mcp-server/           Wraps the scored dataset as an MCP server
                      (list_categories, recommend_package) so an AI
                      assistant can call it directly. Includes a real
                      test client that spawns the server and calls it
                      over the actual MCP protocol.
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
