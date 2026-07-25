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
  fresh (no network call); fetched live, stored, and scored otherwise. A
  real registry 404 is a strong signal the name may be hallucinated or
  typosquatted, and the tool says so explicitly rather than just erroring
  — but only for a genuine 404. Every miss carries a `reasonCode`
  (`not-found`, `invalid-name`, `registry-error`, `no-manifest`) so a
  malformed name or an unreachable registry is never mistaken for
  evidence that a package is fake.

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
  schema.ts           column set as data — drives both CREATE TABLE and the
                      additive ALTER TABLE migration for older stores
  db.ts               raw SQLite access (get/list/upsert), busy_timeout,
                      WAL, transactions
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
npm pack              # produces dep-rec-0.1.3.tgz — exactly what
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

The MCP SDK and `zod` are **optional** dependencies — only the MCP server
needs them, and it loads them dynamically. If you only want the CLI, skip
the whole subtree and get a package with no transitive dependencies at
all (see finding #1 in the second review below for why that matters):

```bash
npm install --save-dev dep-rec --omit=optional
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
5. **Shipped its own flagged vulnerability — attempted in `0.1.2` with an
   `overrides` entry, which turned out to be a no-op; properly addressed
   in `0.1.3`, see the section below.** `GHSA-frvp-7c67-39w9` (moderate,
   Windows path traversal) comes via `@hono/node-server <2.0.5`, pulled in
   transitively through `@modelcontextprotocol/sdk` — whose own dependency
   range (`^1.19.9`, unchanged in every release up to and including
   `1.29.0`) cannot reach the patched version at all.

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

## Second review — v0.1.2 → v0.1.3

A second external review, this time run against the **published** `0.1.2`
package rather than the source, found six more. It also built a standalone
stress harness that drove the real MCP binary over stdio, hammered the
store from multiple processes at once, and fuzzed CLI argv. All six are
fixed; each has a regression test in
[`tests/review-findings.test.ts`](tests/review-findings.test.ts)
(`npm run test:review`).

1. **The `overrides` "fix" was a no-op.** `0.1.2` added
   `"overrides": {"@hono/node-server": "^2.0.5"}` to its *own*
   package.json to patch `GHSA-frvp-7c67-39w9`. npm only honours
   `overrides` from the root project; inside a dependency it is ignored.
   The reviewer verified it directly — `npm ls @hono/node-server` still
   showed the vulnerable `1.19.15` after installing `0.1.2`. For a package
   whose entire pitch is "install me as a dependency," that fixed nothing
   for anybody.

   There is no dependency-resolution fix available: the advisory is fixed
   only in `2.0.5`, `@modelcontextprotocol/sdk` pins `^1.19.9`, and no
   published SDK release has moved that range. What a package *can* do is
   stop forcing the subtree on people who don't need it. The SDK and `zod`
   are now **optional** dependencies, loaded dynamically, used by nothing
   except `src/server.ts`:

   ```bash
   npm install -D dep-rec --omit=optional   # zero-dependency CLI
   ```

   A default install is unchanged, so `npx dep-rec-mcp-server` still works
   with no extra steps. Verified end-to-end against the real `0.1.3`
   tarball in a scratch project: `npm install -D <tgz> --omit=optional`
   reports *"added 1 package… found 0 vulnerabilities"*, `npm ls --all`
   shows both optional deps UNMET, nothing but `dep-rec` is actually on
   disk, `npx dep-rec check left-pad` works normally, and
   `node node_modules/dep-rec/dist/server.js` exits with the actionable
   message above rather than a module-resolution stack trace.

   One caveat, since the point of this entry is not to overclaim again: a
   **bare** `npm audit` still reports the advisory even with the packages
   absent, because it audits the lockfile's full dependency graph rather
   than what is on disk. `npm audit --omit=optional` reports zero, and so
   does a plain `npm audit` once `omit=optional` is in the project's
   `.npmrc`. So: the vulnerable code is genuinely never installed, and the
   audit *report* needs that one flag to agree.

   The misleading `overrides` entry is gone, and a test asserts it stays
   gone, that nothing reachable from `cli.ts` imports either optional
   dependency, and that the package declares no hard runtime dependencies.

2. **A store from an older release crashed instead of migrating.**
   `schema.ts` only ran `CREATE TABLE IF NOT EXISTS`, so an existing table
   kept its old columns forever and the first write died with
   `table packages has no column named has_install_scripts` — unhandled,
   exit code 1. This is a real path, not a hypothetical: `DEP_REC_DB_PATH`
   exists precisely so a store can live outside `node_modules`, and such a
   store survives the version bump that `node_modules` doesn't. The column
   set is now declared as data and drives both creation and an additive
   `ALTER TABLE` migration on open. Tested against a database built with
   the genuine `0.1.0` schema: columns are added, existing rows keep their
   values, new columns backfill from their defaults, and reopening is a
   no-op.

3. **Concurrent lookups died with "database is locked."** No
   `PRAGMA busy_timeout` was set, so SQLite gave up instantly instead of
   waiting — two `dep-rec check` processes started together, or an agent
   firing concurrent MCP tool calls, would lose one at random. (The
   reviewer reproduced it twice, hitting a different process each time.)
   Fixed by setting `busy_timeout` *before* switching journal mode — the
   `PRAGMA journal_mode = WAL` statement takes a lock itself, so a timeout
   applied afterwards would miss the one statement most likely to collide
   on a cold concurrent start. Category rescoring, which rewrites every
   peer row, now runs in a single transaction instead of taking one write
   lock per row. The test holds a real lock from a second process and
   asserts the contending write waits and succeeds — plus a control case
   with `DEP_REC_BUSY_TIMEOUT_MS=0` asserting it still fails, so the fix
   is proven load-bearing rather than a timing accident.

4. **A flat download floor silently overrode the typosquat ratio check.**
   A squat with 5 weekly downloads against `parcel`'s ~410k — an ~82,000x
   ratio, 800x past the threshold — returned `suspicious: false`, purely
   because 410k is under the flat 1,000,000 absolute floor. `parcel`,
   `gatsby` and `angular` are all on the hand-curated "worth squatting"
   list *and* all under that floor, so the list was silently exempting the
   names it exists to protect. The floor now depends on how the target was
   recognised: 50k for a hand-curated name (we have already asserted it is
   a recognisable target), 1M for a name merely present in the store
   (which deliberately tracks obscure packages, some with double-digit
   download counts). The ratio requirement is unchanged, and candidates
   are ranked by how far past *their own* floor they sit, so a big-but-
   ineligible store name can't shadow a curated target that qualifies.

5. **An invalid `--limit` returned an empty list instead of an error.**
   `--limit banana` became `NaN` and `--limit 0` stayed `0`; both sliced
   the ranking to nothing and printed `"recommendations": []` — which
   reads as "no package fits your need," the single worst answer a
   recommendation tool can give to a malformed question. Both interfaces
   now reject it: the CLI with a usage error naming the flag, the shared
   core with a `RangeError` for any non-integer or out-of-range value.

6. **A malformed name was reported as "does not exist."** A 5000-character
   name got a `400` from the registry, which was then relabelled
   *"does not exist… likely hallucinated or typosquatted"* — the registry
   rejected the request shape, it never answered the question. Worse than
   the reported case: the same note covered *every* non-404 failure, so a
   registry outage would have branded every real package in a project as
   possibly fake. Lookups now carry a `reasonCode` — `not-found`,
   `invalid-name`, `registry-error`, `no-manifest` — and only a genuine
   404 carries the hallucination warning. Names are validated against
   npm's own rule (a segment must survive `encodeURIComponent` unchanged,
   which keeps legacy-but-real shapes like `JSONStream` valid) before any
   request is made. Also fixed alongside it: `name.replace("/", "%2F")`
   escaped only the *first* slash, so `@scope/name/extra` built a
   malformed registry URL — that shape is now rejected as invalid, and the
   escape uses `replaceAll` regardless.

### Two more, found while fixing those six

Both surfaced from a single intermittent test failure — the sort of thing
that is tempting to re-run until it goes green:

- **An unreachable downloads endpoint crashed every lookup.**
  `fetchWeeklyDownloads` throwing propagated straight out through
  `checkTyposquat` and `check_package` to the caller, so a partial npm
  outage took down the whole tool rather than degrading one advisory
  signal. A target whose popularity can't be determined is now skipped:
  detection goes quiet, and missing data can never produce an accusation.
- **Three tests were asserting the old lie.** They required a nonexistent
  package to report *"does not exist"* unconditionally — which the fixed
  code correctly refuses to say when the registry is unreachable. They
  now assert the real property, an *iff*: the hallucination warning
  appears exactly when the registry returned 404, and never otherwise.
  That version of the test is both network-independent and strictly
  stronger; the old one would have passed on the buggy code.

There was also a flaw in the new concurrency test itself: the lock holder
released on a timer, and under full-suite load spawning the contending
process took longer than the hold, so the two never actually collided.
The holder now keeps the lock until explicitly told to let go, the writer
announces itself before blocking, and the test asserts it genuinely
waited — a version that can't pass by accident.

**Confirmed good by the same review, worth recording:** every malformed
input thrown at the MCP tools (negative/zero/float/huge/string limits,
missing fields, wrong types, `null`, arrays, a `__proto__` key) came back
as a clean `isError: true` tool response rather than a crash; and SQL
injection, null bytes, path traversal, homoglyphs, emoji and a 5000-char
name all round-tripped safely, since the store uses parameterised queries
throughout. The CLI "failures" the harness flagged for unknown
subcommands, missing arguments and an invalid `--runtime` were correct
usage errors, not bugs — its blanket "non-zero exit = flag" rule was too
blunt.

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
npm test             # all seven suites
npm run test:cli     # the CLI surface on its own
npm run test:mcp     # the MCP protocol surface on its own
npm run test:gaps    # what the spec claimed but was never built
npm run test:review  # regressions for every externally-reported finding
```

411 adversarial scenarios across >1000 packages, using `node:test` only (no
framework dependency). Every suite runs against a temp copy of the store, so
tests can never corrupt the shipped `data/store.db`.

Writing it found **eight real bugs**, all now fixed — including `NaN` scores
from unparseable registry timestamps, identical packages scoring 0/50/100
because percentile ranks were assigned by sort index, two legitimate packages
(`rest`, `js-logger`) branded typosquats, a known typosquat (`reactt`) that had
been committed into the shipped store database, `check typescript` recommending
`7.0.1-rc` as its "battle-tested" pick, and **192 of 499 curated packages
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
