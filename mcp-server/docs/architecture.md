# Architecture

How the store, scoring and eligibility gate actually work. For what the
package is and how to use it, see the [README](../README.md).

## The persistent store (`src/store/`)

Originally this server just read a static JSON snapshot. It's now backed by a
read-write store — one JSON document, replaced atomically, with a lock
directory beside it for cross-process exclusion — holding **both** the raw
registry/downloads/OSV data and the computed scores, so:

- if 100 people ask about the same package, only the first one triggers a
  live fetch — the other 99 are served straight from disk;
- a package that's never been checked before gets fetched, stored, and
  scored on the spot, and from that moment on it's permanently tracked —
  there's no separate "add to watchlist" step;
- a background job (`npm run refresh`, see below) re-checks the *oldest*
  tracked packages against the live registry on a schedule, so stored data
  doesn't just go stale forever.

```
src/store/
  schema.ts           the field set as data; normalises records read from
                      disk and drops anything not declared there
  db.ts               store access (get/list/upsert), the cross-process
                      lock, atomic replace, transactions
  scoring.ts          the ONE scoring implementation, two modes:
                      category-relative (percentile vs. real peers) and
                      absolute (fixed curves, for uncategorized lookups)
  version-safety.ts   the 30-day cooldown: which version to install, and
                      re-deciding it against today's date on every read
  lookup.ts           getOrFetchPackage() — the cache-or-fetch logic
                      itself, and rescoreCategory()
  seed.ts             dev-time bootstrap from stage1-collector's raw output
  refresh-worker.ts   the background "surveillance" job
```

A package enters the store — and therefore future background refreshing —
the instant anyone looks it up, whether that's one of the original curated
500 or a totally new `check_package` call. There's no meaningful
distinction between "curated" and "tracked" anymore; `inCuratedDataset` in
`check_package`'s response really just means "does it currently belong to
one of the 10 categories," which determines *how* it's scored (relative vs.
absolute), not *whether* it's stored.

### Refreshing stale data

```bash
npm run refresh
```

Re-fetches the oldest N tracked packages (default 50, `REFRESH_BATCH_SIZE`
env var to change it) and rescores whatever categories they touch. This is
meant to run on a schedule — cron, a scheduled task, whatever the
deployment has — not as a long-running daemon. A request for a package
older than the freshness window (`STALE_MS` in `lookup.ts`, currently 24h)
triggers an on-demand refresh anyway, so this job is about keeping the
*common* case fast, not correctness.

### Bootstrapping the store from scratch

```bash
npm run seed-db   # imports stage1-collector/data/packages.json, then scores every category
```

`data/store.json` is the artifact that actually ships inside the package —
regenerate it with `seed-db` (for the curated baseline) whenever
`stage1-collector`'s output changes, not by hand-editing the database.


## What is eligible to be recommended

`recommend_package` will not put a package forward just because it scores well
relative to its peers. A package must first clear an absolute bar
(`src/store/eligibility.ts`):

| Rule | Threshold |
|---|---|
| Not deprecated | — |
| Real adoption | ≥ 10,000 weekly downloads |
| Has a track record | ≥ 30 days since first publish |
| Still maintained | released within ~1000 days (~1095 above 5M weekly downloads) |

The staleness rule is adoption-aware on purpose. `redux` has ~39M weekly
downloads and had not cut a release in 810 days — that reads as *stable*, not
abandoned, and excluding it would be a worse error than keeping it.

This exists because measuring the corpus found that **192 of 499** curated
entries fail the bar: packages with 2–6 weekly downloads, and several abandoned
for 4+ years. A security-focused recommender that surfaces those undermines its
own purpose.

The age floor is deliberately low (30 days) on the reasoning that adoption is
itself evidence — a package pulling 13M weekly downloads is demonstrably in real
use whatever its age. The tradeoff is explicit: at this setting a package a
couple of months old can be recommended, and two currently are
(`@supabase/phoenix` at 158 days, `@earendil-works/pi-agent-core` at 79 days,
both with >1M weekly downloads). Raising `MIN_AGE_DAYS` in
`src/store/eligibility.ts` is the single knob that changes this.

Two deliberate consequences:

- **`check_package` still answers for anything.** Asking "I was told to install
  this — is it any good?" about an obscure package is the entire point, so it
  never refuses. It returns `recommendable: false` with
  `notRecommendableBecause` instead.
- **The gate runs at serve time, not only at build time.** A package can
  degrade after it was collected — get deprecated, stop being released, lose
  adoption — and the refresh worker updates that data without anything
  otherwise stopping it from still being recommended.

`recommend_package` reports `excludedAsUnrecommendable` so the narrowing is
visible rather than silent.


## A real gotcha this caught: spawned-process environment

`check_package` makes outbound HTTPS calls (npm registry, OSV) at request
time, and so does `recommend_package` when a need falls outside the curated
categories and is answered by live npm search. Only `list_categories` reads
the bundled local file alone. The MCP SDK's *default* environment for a spawned
server process on Windows is a short allowlist (`APPDATA`, `PATH`,
`SYSTEMROOT`, a handful of others) — it does **not** pass through
whatever a given machine's network layer needs for outbound HTTPS to
actually work. The symptom is a bare, unhelpful `fetch failed` with no
further detail.

If you're writing your own MCP client against this server (as both
`tests/helpers.ts` and `example-consumer/test.mjs` do), pass `env:
process.env` (filtered to drop `undefined` values) explicitly in the
`StdioClientTransport` config. If you're pointing a real assistant's MCP
host at this server instead, check whether that host restricts the spawned
process's environment — if `check_package` fails with `fetch failed` and
`recommend_package` works fine, this is almost certainly why.

