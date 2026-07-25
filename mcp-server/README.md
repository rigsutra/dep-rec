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
  their actual category competitors*. For a need **outside** the ten curated
  categories (`"pdf"`, `"qr code"`, `"web scraping"`) it searches npm live,
  fetches and scores each candidate with the same checks, and returns them
  marked `discoveredVia: "npm-search"` — see
  [Beyond the ten categories](#beyond-the-ten-categories-npm-search-discovery).
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

## Running the CLI locally as `dep-rec`

To use the real command name instead of `npx`, link the built package once:

```bash
npm run build
npm link
```

`dep-rec` is then on your PATH from any directory. **One trap worth knowing
about:** a linked install points at this repo's own `data/store.db`, so
every lookup writes into the artifact that ships inside the package —
`dep-rec check chalk` from a scratch directory added `chalk` to it as row
500 the first time this was tried. Use a scratch store while developing:

```bash
cp data/store.db /tmp/mystore.db
dep-rec check express --db /tmp/mystore.db
dep-rec recommend "pdf" --db /tmp/mystore.db
```

`--db` and `DEP_REC_DB_PATH` do the same thing. `npm unlink -g dep-rec`
removes the link.

### About the SQLite warning

Node used to print this on every single invocation:

```
(node:24808) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

That is Node telling *us* that an API we chose is experimental — it is not
something a user of the CLI can act on, and it was the first line of every
run. It is now filtered, narrowly:
[`src/quiet-sqlite-warning.ts`](src/quiet-sqlite-warning.ts) suppresses
that one warning and nothing else, rather than reaching for
`NODE_NO_WARNINGS=1` and hiding real deprecations along with it.

Getting it to actually work needed one non-obvious change. ES modules link
the entire graph before evaluating any of it, so a static
`import { DatabaseSync } from "node:sqlite"` fires the warning before a
single line of our code has run — the filter was installed too late to
catch anything. `store/db.ts` now loads `node:sqlite` on first use instead,
with a type-only import for the types.

The underlying tradeoff is unchanged and still disclosed: `node:sqlite`
requires Node 22+ and its API can change. Silencing the warning does not
make that go away, it just stops repeating it at someone who has no say in
it.

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
npm pack              # produces dep-rec-0.3.0.tgz — exactly what
                      # `npm publish` would upload, done locally
```

Worth noting what that scratch project's own `package.json` now looks like:
installing `dep-rec` adds **one** package and `npm audit` reports zero
findings. `example-consumer` does carry `@modelcontextprotocol/sdk` as its
own devDependency — it needs a *client* to drive the server
programmatically — and that reintroduces `GHSA-frvp-7c67-39w9` in the
example project. That is the cost of the SDK client, not of `dep-rec`, and
it is exactly the cost this package no longer passes on. Anyone pointing
an editor at the MCP server needs no client of their own.

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

**`dep-rec` has no dependencies.** Not "few" — none. `npm install dep-rec`
adds exactly one package to your tree, and `npm audit` has nothing to say
about it. For a tool whose entire subject is dependency hygiene that felt
like the minimum bar, and getting there meant speaking MCP directly rather
than through an SDK (see finding #1 below).

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

## Second review — v0.1.2 → v0.2.0

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
   published SDK release has moved that range.

   `0.1.3` made the SDK an optional dependency, so `--omit=optional` gave
   a clean CLI. That was still the wrong answer, and the right question
   came from the person reading it: *if we don't really need it, why is a
   default install still shipping it?* A tool about dependency hygiene
   should not have an opt-out flag for its own advisory.

   So `0.2.0` removes the dependency instead of hiding it. MCP over stdio
   is newline-delimited JSON-RPC 2.0, and the SDK's only other job here
   was turning zod schemas into the JSON Schema that `tools/list`
   publishes. Both are small and now live in
   [`src/mcp/`](src/mcp) — about 300 lines, no dependencies.

   Verified rather than assumed: the entire 63-test MCP protocol suite
   still passes, driven by the **real official SDK client** over real
   stdio. If the reference client can drive it through handshake, schema
   publication, concurrent tool calls and every malformed-input case, it
   is compliant in the only way that matters. The SDK stays as a
   `devDependency` for exactly that purpose.

   ```
   dep-rec@0.2.0
   └── (end)
   ```

   A test now asserts there is no `overrides`, no `dependencies`, no
   `optionalDependencies`, no `peerDependencies`, and that nothing
   reachable from either entry point imports a devDependency.

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

7. **A `constructor`-keyed argument escaped as a protocol error.** One
   payload out of 77 in a higher-intensity fuzzing pass broke an otherwise
   uniform pattern: every malformed input — SQL shapes, traversal,
   homoglyphs, fullwidth Unicode, RTL overrides, emoji, null bytes,
   200k-character names, shell metacharacters, `NaN`/`Infinity` limits —
   produced a clean `isError: true` tool result, but
   `{ constructor: { prototype: {…} } }` produced a raw
   `MCP error -32603: expected record, received object`. Not exploitable;
   the problem is that a model can read a tool result and correct itself,
   while a protocol-level failure gives it nothing. Cause: a key named
   `constructor` on an object literal resolves to an inherited built-in
   when read with plain member access, which confuses a plain-object
   check. Every read of a caller-supplied object now goes through
   `hasOwnProperty`, and validated arguments are built on a null
   prototype. Eight prototype-shaped payloads are asserted to come back as
   ordinary bad input.

8. **A failed downloads lookup was silently read as zero.** Carried over
   from the previous review and much more consequential now that the
   typosquat floor is ratio-based: `target >= subject * 100` collapses to
   `target >= 0` when the subject's own count is a spurious `0`, so a
   single rate-limited request could brand any package with a popular
   near-neighbour a typosquat. `fetchWeeklyDownloads` now returns
   `number | null`, where only a genuine 404 is zero. A `null` carries
   through to a `downloads_check_failed` column: the last real figure is
   kept rather than overwritten, scoring says the count is unverified,
   an unverified-and-absent count fails the eligibility bar rather than
   passing it, and typosquat detection declines to answer at all. Same
   fail-closed rule the OSV check already followed.

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

## Beyond the ten categories: npm-search discovery

This started as a question — *"if we can search, why are we limited to ten
categories?"* — asked after seeing what `recommend "pdf"` actually returned:

```
1. vitest   94.4      2. jose  93.6      3. hono  93.5
4. xstate   92.3      5. zod   91.9
```

A test runner, a JWT library, a web framework, a state machine and a
validator, each ranked, scored and explained as though it answered a
question about PDFs. The only thing distinguishing that from a genuine
recommendation was a `note`, and `caveats` was empty. By this project's own
rule — *a missed detection is a documented gap, a confident wrong answer is
a bug* — that is a bug.

The question was also the answer: `stage1-collector` builds the ten
categories **from npm's search API**, so the same call can run on demand.
An uncovered need now searches npm, fetches each candidate, scores it with
the identical security/maintenance/adoption checks, stores it, and returns
what clears the bar:

```
$ dep-rec recommend "pdf"
1. @react-pdf/pdfkit  81.4     2. @react-pdf/renderer  90.8
3. pdf-merger-js      80.8     4. ng2-pdf-viewer       69.6
```

Three things had to be got right, and each was wrong first:

- **Do not re-rank by score.** Sorting discovered candidates by health score
  promoted `@react-pdf/font`, `/fns` and `/svg` — internal sub-packages of
  `@react-pdf/renderer` that nobody installs directly — above `pdf-lib`,
  purely because small single-purpose modules score well on dependency count
  and TypeScript support. npm's relevance ranking already answers "which of
  these is the thing people mean" far better than a health score can.
  Relevance is npm's job; screening for security, maintenance and adoption
  is this tool's. Doing only the second, and saying so, beats doing both
  badly.
- **Filter supporting packages.** `@react-pdf/types` ("React-pdf TypeScript
  definitions") is not an answer to "I need a PDF library", for the same
  reason `@types/*` never was. A scoped package whose description says it is
  *for* its own scope is a component of that project.
- **Require the result to be about the question.** npm's relevance is weak
  for some phrasings: `"send email"` produced a set whose only survivor of
  the health bar was `monocart-reporter`, a Playwright test reporter whose
  long description mentions email far down. Matching only the first 120
  characters of a description — a package leads with what it is for — fixes
  that. `"send email"` now honestly returns nothing.

**The keyword matcher had the same disease.** `"web scraping"` contains
"web", so the synonym map claimed the web-framework category and answered
with `hono`, `@nestjs/swagger` and `@expressots/core`. A wrong category is
worse than no category — especially now, when no category falls through to
a search that finds actual scrapers. A match now only stands when every
significant word in the need is accounted for; one unrecognised word
("scraping") means the map is not competent to answer and something that is
gets the question.

| need | route | result |
|---|---|---|
| `jwt library` | curated `auth-jwt` | jose, @vonage/jwt, … |
| `csv parser` | curated `csv-parsing` | csv-parse, fast-csv, … |
| `pdf` | npm-search | @react-pdf/pdfkit, @react-pdf/renderer, … |
| `qr code` | npm-search | react-qr-code, qr-code-styling, … |
| `web scraping` | npm-search | firecrawl-aisdk |
| `send email` | npm-search | *(nothing cleared the bar)* |

Discovered results are deliberately marked as second-class:
`matchedCategory: null`, `discoveredVia: "npm-search"`, and a caveat saying
the ordering is npm's relevance rather than a percentile against a curated
competitor set. The tool description instructs the model to present them as
a screened shortlist to verify, not a verdict. First call for a new domain
is slow — it fetches up to 12 packages — and every one is stored, so the
next caller is served from disk.

Two honest limits remain. `pdf-lib` (9.9M weekly downloads) is excluded for
having shipped nothing in 1535 days, which is the staleness bar working as
configured but will surprise people. And `@react-pdf/pdfkit` still ranks
first for "pdf" because its description ("A PDF generation library for
Node.js") gives no hint it is an internal fork.

## Stress testing (`npm run stress`)

Separate from the test suite, and with a different job. A test suite
asserts known properties; [`stress/`](stress) exists to find the point
where this falls over and report what it does on the way down. Four
phases, all against temp copies of the store.

```bash
npm run stress               # everything
npm run stress -- --phase=a  # one phase
```

**Phase A — 269 live lookups across 8 quality tiers.** Real npm traffic:
117 mainstream packages, 25 deprecated/abandoned, 19 squat-shaped, 16
obscure-but-real, 25 synthetic nonexistent, 34 structurally malformed, 25
hostile (injection/traversal/template), 8 homoglyph.

| tier | n | resolved | recommendable | squat-flagged |
|---|---|---|---|---|
| mainstream | 117 | 116 | 106 | 0 |
| deprecated | 25 | 24 | 6 | 0 |
| squat-shaped | 19 | 14 | 0 | **14** |
| obscure-real | 16 | 15 | 1 | 0 |
| nonexistent | 25 | 0 | — | — |
| malformed | 34 | 0 | — | — |
| hostile | 25 | 0 | — | — |
| homoglyph | 8 | 0 | — | — |

Zero exceptions in 269 lookups. Every malformed and hostile input was
rejected as `invalid-name` **before any network call**; every synthetic
name came back `not-found`; no hostile input ever resolved as a real
package. Homoglyph names are rejected as invalid rather than detected as
impersonation — an honest gap, since a Cyrillic `е` is not a valid npm
name character in the first place.

**What Phase A actually found — the adoption-verification hole.** The run
initially reported **20.1% of resolved packages with an unverifiable
download count**. Because an unverified count now (correctly) disables
typosquat detection, that meant *one in five packages silently lost its
squat check* — the detector went from catching 14/19 known squats down to
4/19, without saying so. Retrying didn't fix it: the failures arrived in
one contiguous block spanning unrelated packages, which is the signature
of a sustained throttling window rather than scattered transient errors.
A single `check_package` also fans out (the typosquat step looks up each
candidate impersonation target), so the request count is a multiple of the
package count.

Fixed with an adaptive client-side limiter that widens spacing on every
`429` and decays while succeeding, so a single interactive lookup pays
nothing and a bulk sweep self-throttles:

| | unverified adoption | squats caught | wall clock (269 pkgs) |
|---|---|---|---|
| before | 20.1% | 4/19 | 22s |
| after | **4.7%** | **14/19** | 105s |

Five times slower on a deliberate worst-case burst, in exchange for the
security feature not turning itself off. For interactive use — a few
lookups, 24h cache — nothing changes.

**Phase B — concurrency ramp,** every row forced stale so all processes
write:

| procs | ok | failed | "database is locked" | p50 | p95 |
|---|---|---|---|---|---|
| 1 | 1 | 0 | 0 | 2.4s | 2.4s |
| 4 | 4 | 0 | 0 | 2.9s | 3.7s |
| 8 | 8 | 0 | 0 | 2.8s | 4.3s |
| 16 | 16 | 0 | 0 | 4.9s | 8.1s |
| 32 | 32 | 0 | 0 | 13.2s | 20.5s |

No breaking point found up to 32 concurrent writing processes. Latency
degrades linearly past 16 — the write lock serialises, as designed — but
nothing fails, and the "database is locked" error that started this whole
thread does not reappear.

**Phase C — 22 poisoned store rows** (`NaN`, negative counts, unparseable
JSON, 1970/2999 dates, 100k-character names, out-of-range scores, a
5000-entry reasons array). This one found real bugs:

- **One corrupt JSON column took down the entire tool.** A single
  unparseable `categories` value threw straight out of the row mapper, so
  `categories` and every `recommend` call died with a bare
  `Expected property name or '}' in JSON at position 1` and exit 1 — no
  indication of which row. A store file can be corrupted by a partial
  write or an interrupted upgrade. Now every JSON column parses
  defensively; a damaged row is readable, disclosed via
  `store_row_damaged`, and never recommendable. An unreadable
  *vulnerability* list is folded into `security_check_failed` rather than
  becoming an empty one, because `[]` reads as "no known vulnerabilities".
- **A corrupt score of `999999` was ranked #1** and reported verbatim.
  Stored scores outside 0–100 are now rejected as damaged.
- **One bad row produced a 216 KB response.** Not a crash — worse, in
  context: it silently eats a model's context window. Reasons are now
  bounded per row (24 entries, 400 chars each). Real scoring emits about
  six short reasons, so this never fires in normal operation. **216 KB →
  6.9 KB.**
- SQLite is dynamically typed, so an `INTEGER` column will happily hold
  the string `"NaN"` — and `"NaN" < 10000` is `false`, meaning a corrupt
  download count *passed* the adoption floor it should have failed.
  Numerics are now coerced at the read boundary.

Three poisoned rows still surface in recommendations
(`huge-downloads`, `huge-deps`, `nan-cadence`). Those are well-formed rows
with implausible-but-possible values; distinguishing them would require
cross-checking npm, which the refresh job does. Left as-is rather than
overfitted to the fixture.

**Phase D — is the output usable by a model?**

```
mean score — mainstream 81.6 | deprecated 56.4 | obscure 62.4
mainstream packages judged recommendable: 87.9%
```

The score separates good from bad by ~25 points, which is the property
that matters: a model can act on it. Every recommendation carries reasons.
Two honest weaknesses it exposed, neither fixed here:

- **Vendor-specific libraries win generic queries.** `http client` returns
  `gaxios` (Google's internal client) over `axios`/`got`; `logger` returns
  `@azure/logger`; `date` returns `spacetime`. They genuinely score well —
  actively maintained, no vulnerabilities, few dependencies — but no
  human would pick them for a generic need. The ranking has no notion of
  "general-purpose" versus "vendor-internal", and the keyword→category
  map is a synonym table, not search. **This is the biggest real gap in
  the recommendation half of the tool.**
- **6 of 24 abandoned packages are still recommendable** — `babel-core`,
  `colors`, `bower`, `grunt-contrib-jshint`,
  `nodemailer-smtp-transport`, `tslint-config-prettier`. None are
  *formally* deprecated on npm and all still have large download counts,
  so they clear every mechanical bar. `colors` is the notable one: the
  package sabotaged by its own maintainer in 2022. Detecting this needs a
  signal the tool does not collect (repository archived, successor
  package, advisory-by-reputation).

The `check_package` half is in much better shape than the
`recommend_package` half, which matches what it is for: verifying a name
an assistant already produced is a well-defined question, and "what
should I use for X" is not.

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

428 adversarial scenarios across >1000 packages, using `node:test` only (no
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
