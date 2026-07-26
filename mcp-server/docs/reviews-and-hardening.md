# Reviews, stress testing and the bugs they found

`dep-rec` was published early and reviewed hard afterwards. This is the
record of what those reviews found and what changed, kept in full because
the failures are more instructive than the features. Nothing here is
marketing: every item is a thing that was wrong.

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
   in `0.1.3`, then properly in `0.2.0` — see finding #1 of the second
   review below.** `GHSA-frvp-7c67-39w9` (moderate,
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
listed under [Honest limits](../README.md#honest-limits) as known, accepted
tradeoffs.

## Second review — v0.1.2 → v0.2.0

A second external review, this time run against the **published** `0.1.2`
package rather than the source, found six more. It also built a standalone
stress harness that drove the real MCP binary over stdio, hammered the
store from multiple processes at once, and fuzzed CLI argv. All six are
fixed; each has a regression test in
[`tests/review-findings.test.ts`](../tests/review-findings.test.ts)
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
   [`src/mcp/`](../src/mcp) — about 300 lines, no dependencies.

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


## Version guidance — a feature that was built and never delivered

The 30-day cooldown resolver existed, was unit-tested, and wrote its result to
the store. Measuring what actually reached a caller found three separate
problems, one of which meant the feature had never worked at all on its main
surface.

- **0 of 499 shipped rows carried version guidance.** The only caller of
  `resolveRecommendedVersion` was the live-fetch path, so a curated package
  answered from the store with `recommended_version` NULL. `recommend()` reads
  the curated categories straight from the store with no freshness check, so
  the cooldown reached nobody unless they happened to `check_package` a name by
  hand. Worse, `recommend()` returned no version field at all — the only thing
  a caller could do with the answer was `npm install <name>`, resolving to
  whatever shipped that morning. Fixed by resolving guidance during the seed
  and putting `recommendedVersion` / `latestVersion` / `versionNote` on every
  recommendation.
- **Selection was by publish date, not by version.** The resolver walked
  `versionHistory` backwards and took the first stable entry past the window —
  "last published", which is not "highest". Any project that backports to an
  older line after shipping a newer one breaks it. Measured across the corpus:
  of the 141 packages whose `latest` was inside the window, 3 picked wrong, and
  `undici` picked `6.27.0` (a backport released after 8.x shipped) when `8.5.0`
  was both newer and past the window. A two-major downgrade offered as the
  *safer* option is worse than no answer.
- **Major-version downgrades were silent.** 11 of those 141 resolved to an
  older major — `@turnkey/http` 5.0.0 → 4.1.1, `better-sqlite3` 13.0.1 →
  12.11.1, `@expressots/core` 4.0.0 → 3.0.0. A bare version number gives no
  hint the API differs, and a caller writing v5 code against v4 is worse off
  than one who took the fresh release. Those now carry an explicit caution that
  installing `latest` may be what they actually want.

Also added: nothing above the current `dist-tags.latest` is eligible. A
maintainer who rolls `latest` back to a supported line has made a deliberate
decision about what to install, and overriding it is not this tool's call.

### Open: `modified_at` is not "last release"

Surfaced by the above, not yet fixed. Both `eligibility.ts` and the maintenance
sub-score treat the registry's `time.modified` as the last-release date. It
isn't — it moves on any metadata change. `csvparser` last published `0.1.4` on
2014-01-28 but reports `modified: 2022-06-14`, so the gate says *"no release in
1504 days"* about a package that has not shipped in **4562**, understating
staleness by eight years.

The verdict happens to survive (it is excluded anyway, on adoption), but the
stated reason is wrong, and the maintenance recency score is measuring the
wrong quantity for every package whose registry document was touched after its
last publish. The real last-publish date is already fetched — it is in
`versionHistory`, which is how the discrepancy became visible. Fixing it means
a new column, a migration, and a full corpus rescore, so it is recorded here
rather than bundled into an unrelated change.


## Stress testing (`npm run stress`)

Separate from the test suite, and with a different job. A test suite
asserts known properties; [`stress/`](../stress) exists to find the point
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


## Tests

```bash
npm test             # all seven suites
npm run test:cli     # the CLI surface on its own
npm run test:mcp     # the MCP protocol surface on its own
npm run test:gaps    # what the spec claimed but was never built
npm run test:review  # regressions for every externally-reported finding
```

437 adversarial scenarios across >1000 packages, using `node:test` only (no
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
the reasoning behind each: [`tests/README.md`](../tests/README.md).

The gap suite is worth calling out separately: it does **not** fail because a
capability is missing. It fails if the tool *implies* it did something it
didn't. It prints a running inventory — currently **9 of 33 spec concepts
implemented** — which doubles as an honest backlog.

