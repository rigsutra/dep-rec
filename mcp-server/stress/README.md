# Stress harness

```bash
npm run stress               # all four phases
npm run stress -- --phase=a  # one phase
DEP_REC_STRESS_KEEP=1 npm run stress   # keep the temp stores for inspection
```

Not a test suite. A test suite asserts properties that are known in
advance; this looks for the point where the thing falls over, and reports
what it does on the way down. Exit code is non-zero if any **violation**
fires — a violation is the tool being *wrong*, not the tool being slow or
declining to answer.

Everything runs against temp copies of `data/store.db`. Nothing here
writes to the shipped artifact.

| phase | what it does |
|---|---|
| **A** breadth | ~270 live npm lookups across 8 quality tiers (`corpus.ts`) — mainstream, deprecated, squat-shaped, obscure-but-real, synthetic-nonexistent, malformed, hostile, homoglyph. Checks honesty, not availability: every resolved package must carry a finite in-range score and at least one reason; every miss must carry a `reasonCode`; only a real 404 may carry the hallucination warning; nothing flagged as a typosquat may also be recommendable. |
| **B** load | Concurrency ramp (1 → 32 processes) against one shared store with every row forced stale, so all of them write. Reports failures and `database is locked` occurrences separately from latency. |
| **C** corrupt | 22 deliberately poisoned rows — `NaN`, negative counts, unparseable JSON, 1970/2999 dates, 100k-character names, out-of-range scores, a 5000-entry reasons array. Every read path must survive, and the output must stay parseable with no non-finite score. |
| **D** judgement | Runs the ten known needs and reports whether the score actually separates good packages from bad. Fails if mainstream packages do not outscore deprecated ones, if a top pick is unexplained, or if the eligibility bar rejects more than 20% of mainstream packages. |

## Reading the output

Two things are reported that are deliberately **not** violations, because
they are honest limitations rather than defects:

- `NOTE: poisoned row surfaced in recommendations` — a well-formed row with
  an implausible-but-possible value (a huge download count). Distinguishing
  it would require cross-checking npm, which the refresh job does.
- The `download count unverified` percentage — this rises under sustained
  load and, when it does, typosquat detection declines to answer for those
  packages. That is the correct behaviour (an unverified count cannot
  anchor a ratio), but the *rate* matters, so it is measured and violates
  above 10%.

Findings from this harness are written up in the main
[README](../README.md#stress-testing-npm-run-stress).
