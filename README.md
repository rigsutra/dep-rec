<h1 align="center">dep-rec</h1>

<p align="center">
  <strong>Verify npm packages before an AI assistant talks you into installing one.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dep-rec"><img src="https://img.shields.io/npm/v/dep-rec.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dep-rec"><img src="https://img.shields.io/npm/dm/dep-rec.svg" alt="downloads"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="zero dependencies">
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/dep-rec.svg" alt="node version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/dep-rec.svg" alt="MIT license"></a>
</p>

An assistant suggests a package; something has to check it against reality
before it lands in your `package.json`. `dep-rec` answers from the live npm
registry and OSV with a deterministic score — never from a model's memory of
what was popular when it was trained.

Runs as an **MCP server** an assistant calls mid-conversation, and as a plain
**CLI** for humans, scripts and CI.

## Features

- **Catches hallucinated packages** — a real registry 404, reported as such
- **Catches typosquats that resolve** — `csvparser` vs `csv-parser`, the
  attack that a 404 check misses entirely
- **Version-scoped CVE checks** — OSV queried against the *current* version,
  so long-patched advisories aren't reported as live ones
- **Flags install scripts** — `preinstall`/`install`/`postinstall`, the
  event-stream attack vector
- **Refuses to recommend** deprecated, barely-adopted, brand-new or
  unmaintained packages, and says which bar was missed
- **Says "unknown" instead of "clean"** when a lookup fails
- **Covers all of npm** — ten curated categories, everything else discovered
  by live search
- **Zero dependencies**

## Install

```bash
npm install --save-dev dep-rec
```

Node 22+.

## Quick start

```bash
npx dep-rec check csvparser
```

```
🚨 csvparser  score 45.2  [cache]
  TYPOSQUAT WARNING: Name is one character away from "csv-parser" (3,288,172 weekly downloads vs. this package's 86) — classic typosquat pattern. Verify this is really the package you meant before installing.
  license: unknown  maintainers: 1  deps: 0  weekly downloads: 86
  - no known vulnerabilities affecting the current version
  - no recent release relative to category peers
  - no ESM or bundled TS types detected
  NOT RECOMMENDATION-GRADE — this tool would not put this package forward:
    - only 86 weekly downloads (recommendation floor is 10,000)
    - no release in 1503 days (limit is 1000 at this adoption level)
```

```bash
npx dep-rec check left-pad              # is this safe to install?
npx dep-rec recommend "jwt library"     # what should I use?
npx dep-rec recommend "pdf" --limit 3   # works outside the curated set too
npx dep-rec categories
```

Scores move with live data, so your numbers won't match the sample exactly —
and `[cache]` reads `[live-fetch]` the first time a package is seen.

## Use with an AI assistant

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

The `-p dep-rec` matters: the binary is `dep-rec-mcp-server` but the
package is `dep-rec`, so a bare `npx -y dep-rec-mcp-server` would look
for a package by that name and 404. Already installed in the project? Use
`"command": "node"` with
`["node_modules/dep-rec/dist/server.js"]` instead.

Then the conversation goes differently:

> **You:** I need to parse CSV in this project.
>
> **Assistant** *(calls `recommend_package`)*: `csv-parse` — score 91.4, no
> known vulnerabilities affecting the current version, ships ESM and
> TypeScript types. 40 alternatives were excluded for failing the
> recommendation bar.
>
> **You:** What about `csvparser`?
>
> **Assistant** *(calls `check_package`)*: Don't. It resolves, but it has 86
> weekly downloads and its name is one character from `csv-parser`
> (3.3M/week) — that's the typosquat pattern.

### Tools

| Tool | Answers | Inputs |
|---|---|---|
| `check_package` | *"Is this specific package safe to install?"* Any package on npm. | `name` |
| `recommend_package` | *"What should I use for X?"* | `need`, `runtime?`, `license?`, `limit?` |
| `list_categories` | Curated categories and how many packages clear the bar | — |

`check_package` is the stronger half and the one to reach for by default:
verifying a name an assistant already produced is a well-defined question.
"What should I use for X" is not.

### What the model receives

Real output from `check_package` on `csvparser`, unedited:

```json
{
  "name": "csvparser",
  "found": true,
  "servedFrom": "cache",
  "score": 45.2,
  "reasons": [
    "no known vulnerabilities affecting the current version",
    "no recent release relative to category peers",
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

Note what's absent: no bare boolean verdict to misread. `score` never appears
without `reasons`; `recommendable: false` never without
`notRecommendableBecause`. And `deprecated: false` sits right next to
`recommendable: false`, because those are different claims and the response
shape shouldn't let a model merge them.

When a lookup fails it returns a `reasonCode`, and only one of them is an
accusation:

| code | meaning |
|---|---|
| `not-found` | real 404 — treat as possibly hallucinated or typosquatted |
| `invalid-name` | malformed; the registry was never asked |
| `registry-error` | npm was unreachable; says nothing about the package |
| `no-manifest` | resolves, but nothing installable |

## CLI reference

```
dep-rec check <package-name> [--json] [--db <path>]
dep-rec recommend "<need>" [--runtime node|edge] [--license MIT] [--limit 1-20] [--json] [--db <path>]
dep-rec categories [--json] [--db <path>]
```

| Flag | Effect |
|---|---|
| `--json` | Machine-readable output instead of the human-readable default |
| `--limit <1-20>` | How many candidates to return (default 5) |
| `--runtime node\|edge` | Target runtime; `edge` attaches an explicit not-sandbox-tested caveat |
| `--license <id>` | Exact license match, e.g. `MIT` |
| `--db <path>` | Use a different store file (also `DEP_REC_DB_PATH`) |

`check` exits non-zero when a package can't be resolved, so a hallucinated
name in a PR fails the build.

## How it scores

Five weighted signals, all from live data:

| Signal | Weight | What it measures |
|---|---|---|
| Security | 25% | OSV vulnerabilities scoped to the current version |
| Maintenance | 25% | Release recency and cadence |
| | | *(maintainer count is reported but deliberately not scored — see below)* |
| Compatibility | 20% | ESM and bundled TypeScript types |
| Community | 20% | Downloads relative to real category competitors |
| Supply chain | 10% | Dependency count, and install scripts weighted heavily |

Plus **typosquat detection** on names that resolve (edit-distance-1 against
popular packages, restricted to typo-shaped edits so `next` and `nuxt` aren't
accused of each other), and **version guidance** — prefer the newest release
past a 30-day observation window, unless a fresher one demonstrably fixes a
vulnerability, verified by version-scoped OSV lookups on both.

**Maintainer count is reported, not scored.** It used to be a third of the
maintenance sub-score and printed *"single maintainer — bus-factor risk"*.
Measured across the corpus, that flagged 106 of 307 recommendable packages —
including `zod` (239M weekly downloads), `axios` (118M), `date-fns` (94M),
`jose` (102M) and `hono` (52M). The tool was recommending those and warning
about them in the same breath. Median score by maintainer count wasn't even
monotonic (1 → 71.9, 2 → 73.6, 3 → 80.5, 4 → 75.2, 5+ → 75.9): noise, not
signal. The underlying reason is that npm's `maintainers` field counts
publish rights, not people — an org releasing through one CI account reports
one, and so can a project with hundreds of contributors. The count is still
in `npm.maintainers` for anyone who wants to weigh it; it just isn't treated
as a verdict. Real bus-factor analysis needs contributor distribution from
the repository host, which is a documented gap rather than something to
approximate badly.

**A package can be answered for and still not be recommendable.** Deprecated,
under 10k weekly downloads, under 30 days old, or no release in ~1000 days
disqualifies it from being *put forward*, while `check_package` still answers
for it in full. Refusing to answer for obscure packages would defeat the
point; recommending them would too.

## Coverage

Ten curated categories — auth-jwt, csv-parsing, date-time, http-client,
logging, orm-database, state-management, testing, validation, web-framework —
are ranked by percentile against a real competitor set.

Anything else is discovered live: `dep-rec` searches npm, fetches each
candidate, runs the identical checks, and returns what clears the bar, marked
`discoveredVia: "npm-search"`.

```
$ dep-rec recommend "pdf"
1. @react-pdf/pdfkit  81.4     2. @react-pdf/renderer  90.8
3. pdf-merger-js      80.8     4. ng2-pdf-viewer       69.6
```

Discovered results keep **npm's relevance ordering** rather than being
re-ranked by score — sorting by health promoted internal sub-packages nobody
installs above the obvious answer. Relevance is npm's job; screening for
security, maintenance and adoption is this tool's. The first call for a new
domain is slow; every candidate is stored, so the next one is served from
disk.

## Why "AI-first"

Not a security scanner with an MCP wrapper bolted on. The design assumes the
caller is a model, and that changes most decisions:

- **It refuses rather than guesses.** A plausible answer to a question the
  tool can't answer is worse than useless, because the model can't tell the
  difference. `recommend "pdf"` once returned `vitest`, `jose`, `hono`,
  `xstate`, `zod` — ranked, scored, explained, completely wrong. Now an
  uncovered need is either answered from live search or not answered.
- **Every miss says why it missed.** Collapsing the four `reasonCode` values
  into one is how a tool tells a model that every real package is fake during
  an npm outage.
- **Scores are deterministic; the model only narrates.** Both tool
  descriptions instruct it to cite the returned `reasons` and never invent a
  score.
- **Unverified is never reported as clean.** A failed OSV lookup returns
  *unknown*, not "no known vulnerabilities". Same for adoption data.
- **Output is bounded.** When the consumer is a context window, response size
  is a correctness property. One corrupt row produced a 216 KB response
  before that cap existed.
- **The tool descriptions are part of the product** — long on purpose, and
  covered by tests.

## Limitations

Documented rather than hidden, because a tool that overstates itself is the
problem it's trying to solve:

- **`recommend_package` is weaker than `check_package`.** Generic queries can
  surface vendor-internal libraries that score well but no human would pick
  (`http client` → `gaxios`). The category matcher is a keyword map, not
  semantic search.
- **Abandoned-but-popular packages slip through.** 6 of 24 tested still clear
  the bar, including `colors` — sabotaged by its own maintainer in 2022 —
  because none are formally deprecated and all still have large download
  counts.
- **24-hour cache window.** A CVE disclosed in the last day can be masked on
  a cached lookup; `servedFrom` discloses the provenance.
- **No GitHub signals** (stars, bus factor, archived status) and **no
  transitive dependency analysis** — direct dependency count only.
- **Edge Runtime fit is not sandbox-tested.** `runtime: "edge"` returns an
  explicit caveat rather than answering from ESM support alone.
- **npm only.** No PyPI, crates.io or Maven.
- **`node:sqlite` is an experimental Node API**, so this needs Node 22+ and
  the API may change.

## Documentation

- [Architecture](mcp-server/docs/architecture.md) — the persistent store, scoring
  internals, the eligibility gate
- [Development](mcp-server/docs/development.md) — running from source, `npm link`,
  packing
- [Reviews and hardening](mcp-server/docs/reviews-and-hardening.md) — every external
  review finding, the stress harness, and the bugs both found
- [Tests](mcp-server/tests/README.md) — 428 adversarial scenarios across seven suites

## Repository layout

`drec` is the published package; the rest of this repo is what produced it.

| Directory | What it is |
|---|---|
| [`mcp-server/`](mcp-server) | The published package — CLI, MCP server, store, scoring |
| [`stage1-collector/`](stage1-collector) | Builds the curated category dataset from the npm registry |
| [`example-consumer/`](example-consumer) | A from-scratch project that installs the packed tarball and drives it, proving it behaves as a real dependency |
| [`proof0/`](proof0) | The Edge Runtime compatibility spike |

## License

MIT © Ashish Singh ·
[github.com/AshishPodtech/package_rec](https://github.com/AshishPodtech/package_rec)
