# dep-rec

**Stop AI assistants from recommending npm packages that don't exist, aren't maintained, or are one keystroke away from something malicious.**

A dependency checker built for the way software is written now: an assistant
suggests a package, and something has to verify it against reality before it
lands in a `package.json`. `dep-rec` answers from live npm registry and OSV
data with a deterministic score — never from a model's memory of what was
popular when it was trained.

Works as an **MCP server** an assistant calls mid-conversation, and as a
plain **CLI** for humans, scripts and CI.

```bash
npm install --save-dev dep-rec
```

Zero dependencies. Node 22+.

---

## The problem

An LLM's package knowledge is a snapshot of its training data, and it is
confidently wrong in four specific ways:

| Failure | What it looks like |
|---|---|
| **Hallucinated names** | Confidently suggests a plausible-sounding helper package that was never published. If an attacker notices the same name being suggested repeatedly and registers it, the hallucination becomes a supply-chain attack — *slopsquatting*. |
| **Stale recommendations** | Suggests `request`, `tslint`, `node-sass` or `istanbul`. Every one of them was the right answer once; every one is now marked deprecated on npm. |
| **Near-miss names** | `csvparser` instead of `csv-parser`. It resolves, it installs, and it has 86 weekly downloads against the real package's 3.3 million. |
| **Confident silence on risk** | Suggests a package with an active CVE, a `postinstall` script, or no release since 2021 — and says nothing, because it has no way to know. |

Asking the model to be more careful does not fix any of these. The
information is not in the weights. `dep-rec` puts it in the context window
instead.

## Why "AI-first"

This is not a security scanner with an MCP wrapper bolted on. The design
assumes the caller is a model, and that changes almost every decision:

**It refuses rather than guesses.** A tool that returns a plausible answer to
a question it cannot answer is worse than useless to a model, because the
model cannot tell the difference. Ask `recommend "pdf"` and an earlier
version returned `vitest`, `jose`, `hono`, `xstate`, `zod` — ranked, scored,
explained, and completely wrong. Now an uncovered need is either answered
from a live search or not answered at all.

**Every miss says *why* it missed.** A lookup failure returns a
`reasonCode`, and only one of them is an accusation:

```
not-found       real 404 — treat as possibly hallucinated or typosquatted
invalid-name    malformed; the registry was never asked
registry-error  npm was unreachable; this says nothing about the package
no-manifest     resolves, but nothing installable
```

Collapsing these is how a tool tells a model that every real package is fake
during an npm outage.

**Scores are deterministic; the model only narrates.** The tool computes,
the model explains. Every result carries a `reasons` array, and both tool
descriptions instruct the model to cite those reasons and never invent a
score of its own.

**Unverified is never reported as clean.** If the OSV lookup fails, the
response says the vulnerability status is *unknown* — not "no known
vulnerabilities". Same for adoption data. Failing closed matters more when
the reader is a model inclined to summarise optimistically.

**Output is bounded.** When the consumer is a context window, response size
is a correctness property, not a performance one — so per-row output is
capped. A single corrupt row was enough to produce a 216 KB response before
that cap existed.

**The tool descriptions are part of the product.** They are long on purpose —
they tell the model how to read `reasonCode`, when a resolvable package is
still a typosquat, and why a `discoveredVia: "npm-search"` result is a
shortlist rather than a verdict. They are covered by tests.

## Use it with an assistant (MCP)

Add to your assistant's MCP config — Claude Code's `.mcp.json`, Cursor's
`mcp.json`, or equivalent:

```json
{
  "mcpServers": {
    "dep-rec": {
      "command": "npx",
      "args": ["-y", "-p", "dep-rec", "dep-rec-mcp-server"]
    }
  }
}
```

The `-p dep-rec` matters: the binary is `dep-rec-mcp-server` but the package
is `dep-rec`, and a bare `npx -y dep-rec-mcp-server` would go looking for a
package by that name and get a 404.

Already installed in the project? Point at it directly instead:

```json
{
  "mcpServers": {
    "dep-rec": {
      "command": "node",
      "args": ["node_modules/dep-rec/dist/server.js"]
    }
  }
}
```

Then the conversation goes differently:

> **You:** I need to parse CSV in this project.
>
> **Assistant** *(calls `recommend_package`)*: `csv-parse` — score 91.4, no
> known vulnerabilities affecting the current version, ships ESM and
> TypeScript types, 40 alternatives were excluded for failing the
> recommendation bar.
>
> **You:** What about `csvparser`?
>
> **Assistant** *(calls `check_package`)*: Don't. It resolves, but it has 86
> weekly downloads and its name is one character from `csv-parser`
> (3.3M/week) — that is the typosquat pattern.

### What the model actually receives

Every field exists to stop a specific misreading. This is real output from
`check_package` on `csvparser`, unedited:

```json
{
  "name": "csvparser",
  "found": true,
  "servedFrom": "cache",
  "score": 46.6,
  "reasons": [
    "no known vulnerabilities affecting the current version",
    "no recent release relative to category peers",
    "single maintainer — bus-factor risk",
    "no ESM or bundled TS types detected",
    "zero direct dependencies"
  ],
  "npm": {
    "license": null,
    "maintainers": 1,
    "latestVersion": "0.1.4",
    "dependenciesCount": 0,
    "deprecated": false
  },
  "weeklyDownloads": 86,
  "typosquatWarning": {
    "targetPackage": "csv-parser",
    "targetWeeklyDownloads": 3288172,
    "reason": "Name is one character away from \"csv-parser\" (3,288,172 weekly downloads vs. this package's 86) — classic typosquat pattern. Verify this is really the package you meant before installing."
  },
  "recommendable": false,
  "notRecommendableBecause": [
    "only 86 weekly downloads (recommendation floor is 10,000)",
    "no release in 1503 days (limit is 1000 at this adoption level)"
  ],
  "note": "In a known category — this score is ranked against real category competitors."
}
```

Note what is *not* there: no bare boolean verdict for the model to
misinterpret. `score` is meaningless on its own, so `reasons` always
accompanies it. `recommendable: false` is never left unexplained —
`notRecommendableBecause` says which bar was missed and by how much. And
`deprecated: false` sits right next to a `recommendable: false`, because
"not formally deprecated" and "safe to recommend" are different claims and
the tool must not let a model conflate them.

### The three tools

| Tool | What it answers |
|---|---|
| **`check_package`** | *"Is this specific package safe to install?"* Any package on npm. Returns score, reasons, typosquat warning, version guidance, and whether it is recommendation-grade at all. |
| **`recommend_package`** | *"What should I use for X?"* Ranked candidates for a described need. |
| **`list_categories`** | The curated categories and how many packages clear the bar in each. |

`check_package` is the stronger half, and the one to reach for by default:
verifying a name an assistant already produced is a well-defined question.
"What should I use for X" is not.

## Use it from the terminal

```bash
npx dep-rec check left-pad
npx dep-rec check csvparser
npx dep-rec recommend "jwt library"
npx dep-rec recommend "csv parser" --limit 3
npx dep-rec categories
```

```
$ npx dep-rec check csvparser
🚨 csvparser  score 46.6  [cache]
  TYPOSQUAT WARNING: Name is one character away from "csv-parser" (3,288,172 weekly downloads vs. this package's 86) — classic typosquat pattern. Verify this is really the package you meant before installing.
  license: unknown  maintainers: 1  deps: 0  weekly downloads: 86
  - no known vulnerabilities affecting the current version
  - no recent release relative to category peers
  - single maintainer — bus-factor risk
  - no ESM or bundled TS types detected
  - zero direct dependencies
  NOT RECOMMENDATION-GRADE — this tool would not put this package forward:
    - only 86 weekly downloads (recommendation floor is 10,000)
    - no release in 1503 days (limit is 1000 at this adoption level)
```

Add `--json` to any command for machine-readable output. `--db <path>` uses a
different store file. Full flags: `dep-rec --help`.

Scores move with the underlying data, so your numbers will not match the
sample above exactly — and `[cache]` reads `[live-fetch]` the first time a
package is seen.

Useful in CI, too — `check` exits non-zero when a package cannot be resolved,
so a hallucinated name in a PR fails the build.

## What it actually checks

Five weighted signals, all from live data:

- **Security (25%)** — OSV vulnerabilities scoped to the *current version*.
  Querying by name alone reports long-patched CVEs as current; this does not.
- **Maintenance (25%)** — release recency, cadence, maintainer count.
- **Compatibility (20%)** — ESM and bundled TypeScript types.
- **Community (20%)** — downloads relative to real category competitors.
- **Supply chain (10%)** — dependency count, and `preinstall`/`install`/
  `postinstall` scripts, weighted heavily. That is the
  event-stream/ua-parser-js vector: arbitrary code execution at install
  time, before anyone reviews anything.

Plus **typosquat detection** on resolvable names (edit-distance-1 against
popular packages, filtered to typo-shaped edits so `next`/`nuxt` are not
accused of each other), and **version guidance** — prefer the newest release
past a 30-day observation window, unless a fresher one demonstrably fixes a
vulnerability, verified by version-scoped OSV lookups on both.

**A package can be answered for and still not be recommendable.** Deprecated,
under 10k weekly downloads, under 30 days old, or no release in ~1000 days
disqualifies it from being *put forward* — while `check_package` still
answers for it in full. Refusing to answer for obscure packages would defeat
the point; recommending them would too.

## Coverage

Ten curated categories — auth-jwt, csv-parsing, date-time, http-client,
logging, orm-database, state-management, testing, validation, web-framework —
are ranked by percentile against a real competitor set.

Anything else is discovered live: `dep-rec` searches npm, fetches each
candidate, runs the identical checks, and returns what clears the bar,
marked `discoveredVia: "npm-search"`.

```
$ dep-rec recommend "pdf"
1. @react-pdf/pdfkit  81.4     2. @react-pdf/renderer  90.8
3. pdf-merger-js      80.8     4. ng2-pdf-viewer       69.6
```

Discovered results keep **npm's relevance ordering**, not a re-rank by score.
Sorting by health promoted internal sub-packages nobody installs above the
obvious answer. Relevance is npm's job; screening for security, maintenance
and adoption is this tool's, and doing only the second — while saying so — is
better than doing both badly. First call for a new domain is slow; every
candidate is stored, so the next one is served from disk.

## Zero dependencies

```
dep-rec@0.3.0
└── (end)
```

`npm install dep-rec` adds one package and `npm audit` reports nothing. That
took removing the MCP SDK and speaking JSON-RPC over stdio directly, because
the SDK pulled in an advisory no consumer could patch — `overrides` do not
apply from inside a dependency. A tool about dependency hygiene should not
ship a default install with a known advisory and an opt-out flag in its
README. [The full story](docs/reviews-and-hardening.md#second-review--v012--v020).

## Honest limits

Documented rather than hidden, because a tool that overstates itself is the
problem it is trying to solve:

- **`recommend_package` is weaker than `check_package`.** Generic queries can
  surface vendor-internal libraries that score well but no human would pick
  (`http client` → `gaxios`). The category matcher is a keyword map, not
  semantic search.
- **Abandoned-but-popular packages slip through.** 6 of 24 tested still clear
  the bar, including `colors` — sabotaged by its own maintainer in 2022 —
  because none are *formally* deprecated and all still have large download
  counts. Catching that needs a signal not collected here.
- **24-hour cache window.** A CVE disclosed in the last day can be masked on
  a cached lookup. `servedFrom` discloses the provenance.
- **No GitHub signals** (stars, bus factor, archived status) and **no
  transitive dependency analysis** — direct dependency count only.
- **Edge Runtime fit is not sandbox-tested.** `runtime: "edge"` returns an
  explicit caveat rather than answering from ESM support alone.
- **npm only.** No PyPI, crates.io or Maven.
- **`node:sqlite` is an experimental Node API**, so this needs Node 22+ and
  the API may change.

## More

- [Architecture](docs/architecture.md) — the persistent store, scoring
  internals, the eligibility gate
- [Development](docs/development.md) — running from source, `npm link`,
  packing
- [Reviews and hardening](docs/reviews-and-hardening.md) — every external
  review finding, the stress harness, and the bugs both found
- [Test suite](tests/README.md) — 428 adversarial scenarios across seven
  suites

MIT licensed. Issues and PRs:
[github.com/AshishPodtech/package_rec](https://github.com/AshishPodtech/package_rec)
