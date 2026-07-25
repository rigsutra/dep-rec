# Dependency recommendation — MCP server + CLI, packaged as a real installable dependency

Wraps a persistent package store ([`src/store/`](src/store)) behind two
interfaces sharing the exact same logic: an MCP server so an AI assistant
can call it directly mid-conversation (the actual thesis this whole
project is testing), and a plain CLI (`dep-rec`) for humans or any
non-MCP-aware script/agent. Ships as a proper npm package — `npm install
--save-dev dep-rec` gives you both a `dep-rec` command (the CLI) and a
`dep-rec-mcp-server` command (the MCP server) — not just something you
run from source inside this monorepo.

## CLI

```bash
npx dep-rec check left-pad
npx dep-rec recommend "jwt library" --runtime edge
npx dep-rec recommend "csv parser" --limit 3 --json
npx dep-rec categories
```

Add `--json` to any command for machine-readable output instead of the
human-readable default — useful if a script or agent wants to parse it
without going through MCP at all.

## Tools exposed (MCP)

- **`list_categories`** — the 10 competing-package categories and how many
  packages are tracked in each.
- **`recommend_package`** — given a plain-language need (`"JWT library"`,
  `"csv parser"`), optional runtime/license constraints, and a result limit,
  returns ranked candidates from the curated dataset, scored *relative to
  their actual category competitors*.
- **`check_package`** — look up and score **any** npm package by name, not
  limited to the curated set. Served from the store if already tracked and
  fresh (no network call); fetched live, stored, and scored otherwise. If
  the name doesn't resolve on the registry at all, that's a strong signal
  it may be hallucinated or typosquatted — the tool says so explicitly
  rather than just erroring.

Both scoring tools tell the calling model to cite the returned `reasons`
and never invent its own score — the scores-are-deterministic-the-LLM-
only-narrates split from the product spec.

## The persistent store (`src/store/`)

Originally this server just read a static JSON snapshot. It's now backed
by a real store (SQLite, via Node's built-in `node:sqlite` — no native
dependency to compile) that holds **both** the raw registry/downloads/OSV
data and the computed scores, so:

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
  schema.ts           table definition
  db.ts               raw SQLite access (get/list/upsert)
  scoring.ts          the ONE scoring implementation, two modes:
                      category-relative (percentile vs. real peers) and
                      absolute (fixed curves, for uncategorized lookups)
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

`data/store.db` is the artifact that actually ships inside the package —
regenerate it with `seed-db` (for the curated baseline) whenever
`stage1-collector`'s output changes, not by hand-editing the database.

## Try it from source (fast local loop)

```bash
npm install
npm run test-client
```

This spawns the server as a real subprocess and talks to it with the
actual MCP client SDK — the same mechanism Claude Code, Cursor, etc.
use — covering all three tools including two `check_package` calls
(a real uncurated package, and a nonexistent one).

## Try it as an actual installed dependency

This is the part that matters for "can a project just add this as a
dependency": it's built, packed with `npm pack`, and installed into a
completely separate scratch project the same way any real npm package
would be.

```bash
npm run build        # tsc -> dist/, shebang preserved on dist/server.js
npm pack              # produces dep-rec-0.1.0.tgz — exactly what
                      # `npm publish` would upload, done locally
```

See [`../example-consumer`](../example-consumer) for a from-scratch project
that installs that tarball with `npm install --save-dev <path-to-tgz>` and
calls all three tools purely from `node_modules/` — no access to this
monorepo's source. That's the actual proof this behaves like a real
dependency, not just "runs from source when I `cd` into the right folder."
The CLI is even simpler to check this way — `npx dep-rec check <name>`
works immediately once installed, no client code needed.

`example-consumer/test.mjs` also proves the store-sharing claim
specifically: it spawns the server *twice*, as two fully separate
subprocesses (simulating two different people, each with their own editor
session), and checks the same never-before-seen package from each. The
first spawn gets `servedFrom: "live-fetch"`; the second, completely
independent process gets `servedFrom: "cache"` with identical data — proof
the shared on-disk file is doing its job across process boundaries, not
just within one long-lived connection.

## It's published

`dep-rec` is live on the public npm registry (`private: false`,
name-availability checked beforehand). That was a deliberate, separate
decision made after all of the above was verified locally — not a side
effect of packaging work. Install it in any project:

```bash
npm install --save-dev dep-rec
npx dep-rec check left-pad
```

or globally:

```bash
npm install -g dep-rec
dep-rec check left-pad
```

Since publishing is effectively permanent (npm's unpublish window is 72
hours and only applies if nothing depends on the version yet), a
post-publish review is exactly what caught several of the real issues
documented throughout this README (the OSV version-scoping bug, the
supply-chain zero-sum bug, the spawned-process environment gotcha, and
more below) — publishing something and then keeping it honestly
maintained is the actual model here, not "get it perfect before anyone
can touch it."

## Post-publish security review — v0.1.1 → v0.1.2

An external review against the actually-shipped `0.1.0` source turned up
eight issues. All seven real ones are now fixed (five in `0.1.1`, the
remaining two in `0.1.2`); one was already self-disclosed and unchanged.

**Fixed:**

1. **README claimed "not published yet" after it actually was.** Stale
   doc text from before the real `npm publish` happened — fixed above.
2. **OSV checks failed open.** `sources/osv.ts` treated any non-2xx
   response as "zero vulnerabilities," making a rate limit or outage
   indistinguishable from a real clean bill of health. Now returns
   `{ok: false, error}` on failure (with retry/backoff first), and
   scoring says exactly that — *"vulnerability check could not be
   verified (OSV unreachable) — security status is unknown, not
   confirmed clean"* — instead of a false-confident "no known
   vulnerabilities." The store also keeps the last successfully-fetched
   vulnerability list rather than overwriting good data with an empty
   one when a refresh attempt fails.
3. **Package age was fetched but never used.** Turned into a real
   feature rather than a scoring input: `check_package`/`dep-rec check`
   now return `versionGuidance` — recommend the newest version that's at
   least 30 days old (a cooldown/observation window), *unless* a fresher
   release fixes a real vulnerability the older one has. That "unless" is
   verified, not assumed: both the cooldown-safe version and the latest
   are queried against OSV directly (`store/version-safety.ts`), and the
   newer version only wins when OSV confirms it's actually clean of
   something the older one isn't. If either check fails, it defaults to
   the cooldown-safe pick rather than gambling on an unverified "newer
   must be safer" claim.
4. **Supply-chain score only counted dependencies.** Now also checks for
   `preinstall`/`install`/`postinstall` scripts on the current version —
   the actual event-stream/ua-parser-js attack vector (arbitrary code
   execution on `npm install`) — and weights it far more heavily (-40)
   than dependency count. Verified against real packages: flags
   `puppeteer` (which downloads a Chromium binary via `postinstall`),
   correctly leaves `sharp` unflagged (its current version uses
   prebuilt-binary `optionalDependencies` instead of install scripts, not
   a detection gap).
5. **Shipped its own flagged vulnerability — partially fixed, and worth
   being precise about what "fixed" means here.** `GHSA-frvp-7c67-39w9`
   (moderate, Windows path traversal) comes via `@hono/node-server <2.0.5`,
   pulled in transitively through `@modelcontextprotocol/sdk` — whose own
   dependency range (`^1.19.9`, unchanged even in its latest release)
   can't reach the patched version on its own. Added a package.json
   `overrides` entry forcing `@hono/node-server` to `^2.0.5`, which makes
   `npm audit` clean **inside this repo's own `mcp-server/` workspace**.

   That override does **not** propagate to anyone who installs `dep-rec`
   as a dependency in their own project — `overrides` only affects the
   project that declares it, not downstream consumers. Verified directly:
   a clean `npm install` of the published package in `example-consumer`
   still shows the same advisory. If you want your own `npm audit` clean
   too, add the same override to your project's `package.json`:
   ```json
   "overrides": { "@hono/node-server": "^2.0.5" }
   ```
   The more meaningful mitigation: the vulnerable code (Hono's
   `serve-static` path handling) is never reachable through `dep-rec`'s
   actual runtime either way, published fix or not — this server only uses
   the SDK's stdio transport, never the Hono-based HTTP transport that
   dependency serves. Real fix is upstream, in `@modelcontextprotocol/sdk`
   bumping its own `@hono/node-server` range; tracking that, not claiming
   it's fully resolved.

6. **No name-similarity typosquat detection (`0.1.2`).**
   `check_package` only flagged "likely hallucinated or typosquatted" on a
   registry 404 — a resolvable typosquat (a real, installable package
   with a name one character off from a popular one) sailed through with
   an ordinary score. `store/typosquat.ts` now generates every
   edit-distance-1 variant of the checked name (deletion, substitution,
   insertion, transposition — cheap, pure string ops) and checks it
   against every name already in the store plus a small curated list of
   famous packages outside the 10 categories (`react`, `vue`, `lodash`,
   `webpack`, etc.). Flags only when the matched name is both absolutely
   popular (≥1M weekly downloads) and drastically more popular (≥100x)
   than the checked package — two obscure packages one typo apart isn't
   suspicious on its own. Verified against the exact reported case:
   `check reactt` now returns a `typosquatWarning` pointing at `react`
   (162,709,618 weekly downloads vs. 61) — and a real, popular package
   like `zod` correctly produces no warning.
7. **No decode-vs-verify distinction within a category (`0.1.2`).**
   `recommend "jwt library"` returned `jwt-decode` as the #1 pick despite
   its own docs stating it does not verify signatures. Rather than try to
   automatically infer "capability" (would need real API-surface or
   README analysis), added a small, deliberately manual annotation map
   (`store/capability-caveats.ts`) — currently just `jwt-decode` — that
   prepends an explicit warning to its `reasons` and applies a modest
   score penalty (-15). Verified: `jwt-decode` dropped from 93 to 78 and
   out of the top 5 for "jwt library" entirely; `jose` (a real verify/sign
   library) is now the top pick. This is intentionally a small, growable
   list, not a general fix — extend it the same way this entry was added
   if another mismatch like it is found.

**Already self-disclosed, unchanged:** the `node:sqlite` experimental
warning on every invocation, and the 24h cache window meaning a
just-disclosed CVE can be masked for up to a day on a cached lookup — both
called out earlier in this README as known, accepted tradeoffs.

## To actually point a live assistant at it

Add an entry like this to the assistant's MCP config (e.g. Claude Code's
`.mcp.json`, Cursor's `mcp.json`):

```json
{
  "mcpServers": {
    "dep-rec-engine": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/absolute/path/to/prs/mcp-server"
    }
  }
}
```

or, once installed as a real dependency in a project, point at
`node_modules/dep-rec/dist/server.js` directly (that's exactly what
`example-consumer/test.mjs` does). That's a change to your own
editor/assistant configuration, so it's left as a manual step rather than
something done for you here.

## A real gotcha this caught: spawned-process environment

`check_package` makes outbound HTTPS calls (npm registry, OSV) at request
time — unlike `recommend_package`/`list_categories`, which only read the
bundled local file. The MCP SDK's *default* environment for a spawned
server process on Windows is a short allowlist (`APPDATA`, `PATH`,
`SYSTEMROOT`, a handful of others) — it does **not** pass through
whatever a given machine's network layer needs for outbound HTTPS to
actually work. The symptom is a bare, unhelpful `fetch failed` with no
further detail.

If you're writing your own MCP client against this server (as both
`test-client.ts` and `example-consumer/test.mjs` do), pass `env:
process.env` (filtered to drop `undefined` values) explicitly in the
`StdioClientTransport` config. If you're pointing a real assistant's MCP
host at this server instead, check whether that host restricts the spawned
process's environment — if `check_package` fails with `fetch failed` and
`recommend_package` works fine, this is almost certainly why.

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

## Tests

```bash
npm test            # all six suites
npm run test:cli    # the CLI surface on its own
npm run test:mcp    # the MCP protocol surface on its own
npm run test:gaps   # what the spec claimed but was never built
```

372 adversarial scenarios across >1000 packages, using `node:test` only (no
framework dependency). Every suite runs against a temp copy of the store, so
tests can never corrupt the shipped `data/store.db`.

Writing it found **eight real bugs**, all now fixed — including `NaN` scores
from unparseable registry timestamps, identical packages scoring 0/50/100
because percentile ranks were assigned by sort index, two legitimate packages
(`rest`, `js-logger`) branded typosquats, a known typosquat (`reactt`) that had
been committed into the shipped store database, `check typescript` recommending
`7.0.1-rc` as its "battle-tested" pick, and **211 of 499 curated packages
failing a basic recommendation bar** — including entries with 2–6 weekly
downloads and several packages abandoned for 4+ years. Full inventory and
the reasoning behind each: [`tests/README.md`](tests/README.md).

The gap suite is worth calling out separately: it does **not** fail because a
capability is missing. It fails if the tool *implies* it did something it
didn't. It prints a running inventory — currently **9 of 33 spec concepts
implemented** — which doubles as an honest backlog.

## Known gaps, carried over honestly from Proof 1/2

- Free-text -> category matching (`data.ts`) is a small keyword/synonym
  map, not real search — good enough to prove the protocol round-trips
  correctly, not a real query understanding layer.
- Edge Runtime fit is not sandbox-tested for this dataset yet (Proof 0 only
  ran against 6 hand-picked packages). The `runtime: "edge"` input returns
  an explicit caveat rather than silently answering from ESM-support alone.
- No GitHub-derived signals (stars, bus factor) or deps.dev transitive
  dependency health — same gap as Proof 1. `check_package` has the same
  gap for live lookups too.
- `data/store.db`'s curated baseline is a copied snapshot of
  `stage1-collector`'s output, not a live link — run `npm run seed-db`
  after re-running the collector to refresh the baseline (this won't
  touch rows added later via `check_package`, since `upsertRaw` preserves
  `first_seen_at` and only overwrites raw fields).
- The refresh worker is a script you run, not a scheduler itself — nothing
  currently invokes `npm run refresh` on an actual cron/timer. Wiring that
  up is an infra decision (where does it run, under what identity) that
  belongs to whoever deploys this, not something to bake in silently.
- `node:sqlite` is still an experimental Node API (prints a warning on
  every start) — fine for a prototype at this scale, worth revisiting
  (e.g. `better-sqlite3`) if this ever needs to be production-hardened.
