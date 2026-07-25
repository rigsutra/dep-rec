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
- [ ] Proof 2 — rank packages within a category better than raw popularity
- [ ] Proof 3 — wrap it as an MCP tool, get an AI assistant to actually use it
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
                      for each. Output: stage1-collector/data/packages.json
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

## Not yet wired in

- GitHub-derived signals (stars, forks, bus factor) — needs an authenticated
  token to get a usable rate limit at this package count; deliberately left
  out of v1 rather than blocked on it.
- deps.dev transitive-dependency and OpenSSF Scorecard enrichment.
- Tier 3 (Proof 0's edge-runtime check) has not yet been run across the full
  Proof 1 dataset — it currently only runs against the 6 hand-picked test
  packages in `proof0/`.
