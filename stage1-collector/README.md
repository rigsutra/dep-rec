# Stage 1 / Proof 1 — package dataset collector

Builds a searchable, consistent dataset across 10 competing categories
(auth-jwt, orm-database, testing, etc.) instead of a top-500-by-downloads
list — a top-500 list gives you `react` and `lodash` with nothing to compare
them against; a category list gives you `jose` vs. `jsonwebtoken` vs.
`passport`, which is the whole point of a *recommendation* engine.

## How it builds the package list

Each category in [`categories.json`](categories.json) has:

- a handful of hand-picked **seed** packages (high-confidence anchors —
  extremely well-known packages, always included)
- 2–3 **search queries** run against npm's real search API to fill out the
  rest of the category with genuine, currently-published results

Seeds keep the well-known packages guaranteed present; live search (rather
than an LLM-authored list) keeps the long tail real instead of hallucinated
— every candidate name still gets validated against the actual registry
before it's kept.

## What gets collected per package

- **Tier 1** (raw): license, maintainer count, created/modified dates,
  dependency count, deprecated flag, weekly downloads, known vulnerabilities
  (via OSV)
- **Tier 2** (static analysis, computed from the registry's own manifest):
  ESM support, TypeScript support, median release cadence in days

## Run it

```bash
npm install
npm run collect
```

Writes `data/packages.json` (one record per package) and
`data/summary.json` (per-category candidate counts + anything dropped).

## Known gap this run caught

Both `registry.npmjs.org`'s search endpoint and `api.npmjs.org`'s downloads
endpoint throttle after roughly a dozen rapid requests from one client. The
first version of this collector treated a throttled (429) response as "zero
results" / "zero downloads" with no retry — silently corrupting data for
whichever categories or packages happened to hit the limit (non-deterministic
by run). Fixed by retrying with backoff and pacing requests; do the same for
any new data source added later rather than assuming a non-200 means "no
data."

## Not yet included

- GitHub-derived signals (stars, forks, bus factor) — needs an authenticated
  token to get a workable rate limit at ~500 packages.
- deps.dev transitive-dependency graph and OpenSSF Scorecard.
- Tier 3 (real edge-runtime execution check).

Scoring is not done here: `mcp-server`'s `npm run seed-db` reads
`data/packages.json` and scores it with `mcp-server/src/store/scoring.ts`.
