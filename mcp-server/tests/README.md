# Test suite

Adversarial by design. The goal is not to demonstrate that the code works —
it is to find the places where it lies, crashes, or quietly does the wrong
thing. Seven suites, 420 scenarios, >1000 packages exercised.

```bash
npm test             # everything
npm run test:unit    # pure logic, no network
npm run test:corpus  # every package in the shipped store + 600 generated rows
npm run test:cli     # the CLI as its own product surface
npm run test:mcp     # the MCP server at the protocol level
npm run test:gaps    # concepts from the spec that were never implemented
npm run test:review  # every externally-reported finding, as a regression
```

No test framework dependency — `node:test` and `node:assert` only, matching
the project's stance on dependencies elsewhere.

## Safety

Every suite that touches the store copies `data/store.db` to a temp
directory and points `DEP_REC_DB_PATH` at the copy, so a test can never
corrupt the artifact that ships inside the package. (`DEP_REC_DB_PATH` was
added for exactly this reason — the path used to be hardcoded.)

## The suites

| File | What it attacks |
|---|---|
| `unit-scoring.test.ts` | Score well-formedness under impossible inputs, monotonicity, determinism, tie handling, capability caveats, cooldown logic |
| `unit-typosquat.test.ts` | Detection recall against 26 verified distance-1 squats, precision against legitimate neighbours, threshold boundaries, hostile/Unicode names |
| `corpus.test.ts` | All 499 real store packages + 600 generated rows: store integrity, rescoring, and a full false-positive sweep of the detector |
| `cli.test.ts` | Argument parsing, exit codes, stream discipline, `--json` parseability, locale independence, path traversal and SQL injection through argv |
| `mcp.test.ts` | Protocol handshake, schema validation, tool *descriptions* as contract, concurrency, cross-process store sharing, CLI/MCP parity |
| `adversarial-gaps.test.ts` | Concepts the spec claimed but that were never built — asserts the tool never overclaims, and prints a coverage inventory |
| `review-findings.test.ts` | Every finding from an external review, reproduced as a regression: dependency shape, legacy-store migration, write-lock contention, typosquat floors, limit validation, lookup-miss classification, prototype-shaped argument keys, unverified-adoption handling |

## The rule the gap suite follows

A missed detection is a **documented gap**. A confident wrong answer is a
**bug**.

`adversarial-gaps.test.ts` therefore does not fail because edge-runtime
checking or multi-ecosystem support is absent. It fails if the tool *implies*
it did something it didn't — asserts edge compatibility it never sandbox-
tested, returns a `stars` field it never fetched, claims a package is clean
when the vulnerability lookup failed, or adjudicates license compatibility it
has no model for. It prints a full inventory on completion (currently
**9 of 33 concepts implemented**), which doubles as an honest backlog.

## Bugs this suite found

All of these were real, in shipped or about-to-ship code, and are now fixed:

1. **`NaN` scores from unparseable timestamps.** A malformed `time` field on a
   registry document produced `NaN` through the maintenance sub-score into the
   total, and `JSON.stringify` renders that as `null` — so a caller saw
   `"score": null` with no error. Non-finite values are now treated as the
   worst case.
2. **`NaN` scores from a negative download count.** `Math.log10` of a negative
   number, reachable from a corrupt store row.
3. **Identical packages scored differently.** Percentile ranking assigned
   ranks by sort index, so three packages with *identical* metrics scored
   0/50/100 — a package's score depended on the arbitrary order its peers came
   out of the database. Ties now share a rank.
4. **Two legitimate packages branded typosquats.** `rest` was reported as a
   squat of `jest`, and `js-logger` of `bs-logger`. Both are arbitrary
   single-character substitutions between unrelated real packages. Substitutions
   now require the characters to be keyboard-adjacent or visually confusable;
   deletions, insertions and transpositions are unaffected, so recall on the
   26 verified squat cases did not change.
5. **Short-name false positives.** `qs`/`ws` and `next`/`nuxt` are all real and
   all one edit apart. Names under 4 characters are no longer accused, and any
   name on the curated popular list is never itself accused.
6. **Test pollution baked into the shipped database.** `data/store.db` had been
   committed containing packages added by ad-hoc `check_package` calls during
   development — including `reactt`, a known typosquat, sitting in the
   "recommended packages" corpus. Rebuilt clean from the collector output.
7. **A prerelease recommended as the "safe" version.** `check typescript`
   recommended `7.0.1-rc` as the more battle-tested alternative to the latest
   stable, because the newest version past the 30-day cooldown window happened
   to be a release candidate. Prereleases are now skipped when choosing the
   cooldown-safe version — offering an rc in place of a stable release inverts
   the entire point of the cooldown.

8. **Unrecommendable packages sat in the "recommended" corpus.** The suite
   originally reported this as a collector-quality finding rather than a bug:
   `csvparser` (86 weekly downloads, one hyphen from `csv-parser` at 3.3M) was
   in the curated dataset *and* tripped the typosquat detector — the tool would
   both recommend it and warn about it. Measuring the whole corpus showed the
   scale: a large share of the corpus failed a basic recommendation bar
   (**192 of 499** at the thresholds currently set), including packages with
   2–6 weekly downloads and several abandoned for 4+ years.
   Fixed with an explicit eligibility gate (`src/store/eligibility.ts`):
   deprecated, under 10k weekly downloads, under 30 days old, or no release in
   ~1000 days disqualifies a package from being recommended. It is enforced at
   serve time as well as at dataset-build time, because a package can degrade
   after collection. Staleness is adoption-aware — `redux` has ~39M weekly
   downloads and had not released in 810 days, which reads as stable rather
   than abandoned, so a higher limit applies above 5M downloads. The
   recommendable set and the typosquat-flagged set are now asserted disjoint.

## Findings this suite did not catch

`review-findings.test.ts` exists because a second external review, run
against the **published** `0.1.2` package rather than the source, found six
things these suites missed. Worth being specific about *why* they were
missed, since that is the more useful lesson than the fixes:

1. **The `overrides` no-op** — no test ever asserted anything about the
   shape of `package.json`. A fix that lives in metadata needs a test that
   reads metadata.
2. **No schema migration** — every suite copies `data/store.db`, which is
   always current. Nothing ever opened a store written by an *older*
   version, so the one code path that crashes was the one path never
   exercised.
3. **`database is locked`** — `mcp.test.ts` tested concurrency within one
   process and cross-process store *sharing*, but never cross-process
   store *contention*. Two readers sharing a file is not the same test as
   two writers racing for it.
4. **The typosquat download floor** — the detector was tested for recall
   against known squats and precision against legitimate neighbours, both
   using targets far above the floor. No test varied the target's
   popularity, so a threshold that silently swallowed the ratio signal
   looked identical to one that worked.
5. **`--limit` validation** — the CLI suite asserted exit codes and JSON
   parseability. An empty-but-valid result is both of those things.
6. **Miss classification** — tests asserted that a nonexistent package is
   reported as nonexistent. None asserted the *converse*: that a
   non-404 failure is **not** reported that way.

The pattern in all six: every one is a case where the wrong behaviour
still produced a well-formed, plausible response. Asserting "it didn't
crash and the shape is right" cannot catch those.

Two further bugs came out of one intermittent failure in the combined run,
which is the argument against re-running until green:

9. **An unreachable downloads endpoint crashed every lookup.** A rejected
   `fetch` in `fetchWeeklyDownloads` propagated out through
   `checkTyposquat` and `check_package` to the caller, so a partial npm
   outage took the whole tool down instead of silencing one advisory
   signal. A target whose popularity can't be determined is now skipped.
10. **Three tests were asserting the old lie.** They required a
    nonexistent package to report *"does not exist"* unconditionally —
    which the fixed code correctly refuses to say when the registry is
    unreachable. Rewritten as an *iff* (the hallucination warning appears
    exactly when the registry returned 404), which is network-independent
    and would have failed on the old, lying implementation.

And one flaw in this suite's own new concurrency test: the lock holder
released on a timer, so under full-suite load the contending process took
longer to spawn than the hold lasted and the two never collided — the
control case failed and the positive case would have passed while proving
nothing. The holder now holds until told to release, the writer announces
itself before blocking, and the test asserts it actually waited.

## Known-wrong things the suite deliberately does not assert away

- The 24h cache window means a CVE disclosed in the last day can be masked on a
  cached lookup. `servedFrom: "cache"` discloses the provenance but not the age.
- One squat-shaped entry (`csvparser`) is still *tracked* and answerable via
  `check_package` — deliberately, since answering "is this package any good?"
  for an obscure name is the tool's purpose. It is excluded from
  recommendations and the suite asserts that, printing it under
  `[tracked-but-never-recommended]`.

## What the stress harness found that the suite did not

[`stress/`](../stress) (`npm run stress`) is not a test suite — it looks for
the point where things fall over rather than asserting known properties.
Three bugs came out of it that 411 assertions had not:

- **One corrupt JSON column took down the whole tool.** Every suite copies a
  *healthy* `data/store.db`, so no test had ever read a damaged row.
- **A corrupt score of `999999` was ranked #1.** Scores were validated where
  they are computed, never where they are read back.
- **One bad row produced a 216 KB response.** No test asserted anything about
  output *size* — only shape. For an MCP tool feeding a model, size is a
  correctness property.

Plus a measurement no assertion would have produced: under a 269-package
burst, 20% of adoption lookups were throttled, which silently disabled
typosquat detection on those packages (14/19 known squats caught fell to
4/19). That is the kind of finding that only shows up under load, and only
if something is counting.
