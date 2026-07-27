import { listAllCategoryCounts, listByCategory, listAll, listNameDownloads } from "./store/db.js";
import { getOrFetchPackage } from "./store/lookup.js";
import { searchPackages } from "./sources/npm.js";
import type { PackageRow } from "./store/db.js";
import { checkTyposquat } from "./store/typosquat.js";
import { checkRecommendable, isRecommendable } from "./store/eligibility.js";
import { guidanceAsOf, parseDecision } from "./store/version-safety.js";
import type { RegistryMissCode } from "./sources/npm.js";

/**
 * Re-decides the 30-day cooldown against today rather than replaying whatever
 * was true when the row was written.
 *
 * The curated `recommend` path reads the store with no freshness check, so a
 * stored answer is served exactly as written — potentially for months. The
 * held-back version in it stops being the right answer the moment the release
 * it was avoiding clears the window on its own, and every held-back package
 * reaches that point eventually. Recomputing here is offline and costs a JSON
 * parse; see version-safety.ts for what is stored to make that possible.
 */
function currentGuidance(p: PackageRow): { recommendedVersion: string; reason: string } | null {
  const decision = parseDecision(p.version_decision);
  return decision ? guidanceAsOf(decision) : null;
}

export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 20;

// Crude free-text -> category mapping. A real version would need fuzzy
// matching against package descriptions (not collected yet) or embeddings;
// this is just enough to prove the MCP round trip picks the right category.
const SYNONYMS: Record<string, string> = {
  jwt: "auth-jwt",
  auth: "auth-jwt",
  authentication: "auth-jwt",
  oauth: "auth-jwt",
  http: "http-client",
  fetch: "http-client",
  request: "http-client",
  server: "web-framework",
  framework: "web-framework",
  web: "web-framework",
  validate: "validation",
  validation: "validation",
  schema: "validation",
  orm: "orm-database",
  database: "orm-database",
  sql: "orm-database",
  db: "orm-database",
  postgres: "orm-database",
  mongo: "orm-database",
  log: "logging",
  logger: "logging",
  logging: "logging",
  date: "date-time",
  time: "date-time",
  csv: "csv-parsing",
  parse: "csv-parsing",
  parsing: "csv-parsing",
  test: "testing",
  testing: "testing",
  assert: "testing",
  mock: "testing",
  state: "state-management",
};

// Counts only what could actually be recommended. Reporting the raw tracked
// count would overstate how much real choice a category offers.
export async function listCategories(): Promise<Array<{ key: string; count: number }>> {
  const counts = new Map<string, number>();
  for (const pkg of listAll()) {
    if (!isRecommendable(pkg)) continue;
    for (const c of pkg.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  // Preserve every known category even if the gate emptied it, so a caller
  // can still see it exists rather than silently losing it.
  for (const { key } of listAllCategoryCounts()) if (!counts.has(key)) counts.set(key, 0);
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
}

const STOPWORDS = new Set([
  "the", "for", "and", "with", "that", "this", "any", "some", "best", "good",
  "need", "want", "use", "using", "library", "libraries", "package", "packages",
  "module", "modules", "tool", "tools", "npm", "node", "nodejs", "javascript",
  "typescript", "how", "what", "which", "from", "into", "have", "make", "get",
]);

function needTokens(need: string): string[] {
  return need
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// Generic nouns that qualify a need without changing its domain. "http
// client" and "state management" are the http-client and state-management
// categories; the second word carries no domain of its own.
const GENERIC_NOUNS = new Set([
  "client", "management", "manager", "parser", "parsing", "handling", "handler",
  "support", "generator", "builder", "helper", "wrapper", "utility", "utilities",
]);

function isExplained(token: string, categoryKeys: string[]): boolean {
  if (STOPWORDS.has(token) || GENERIC_NOUNS.has(token)) return true;
  for (const cat of categoryKeys) {
    for (const part of cat.split("-")) {
      if (token.startsWith(part) || part.startsWith(token)) return true;
    }
  }
  for (const word of Object.keys(SYNONYMS)) {
    if (token.startsWith(word) || word.startsWith(token)) return true;
  }
  return false;
}

/**
 * Maps a plain-language need onto one of the curated categories, or gives up.
 *
 * Giving up is the important part. This is a keyword map, and a keyword map
 * that matches on any word it recognises will confidently mis-answer: "web
 * scraping" contains "web", so it used to return the web-framework category
 * and recommend hono, @nestjs/swagger and @expressots/core to someone who
 * asked about scrapers. A wrong category is worse than no category, because
 * no category now falls through to a live npm search that would have found
 * actual scrapers.
 *
 * So a match only stands when every significant word in the need is
 * accounted for. One unrecognised word ("scraping") means this map is not
 * competent to answer, and something that is gets the question instead.
 */
function matchCategory(need: string, categoryKeys: string[]): string | null {
  const lower = need.toLowerCase();
  let candidate: string | null = null;
  for (const cat of categoryKeys) {
    if (lower.includes(cat)) {
      candidate = cat;
      break;
    }
  }
  if (!candidate) {
    for (const [word, cat] of Object.entries(SYNONYMS)) {
      if (new RegExp(`\\b${word}`, "i").test(lower)) {
        candidate = cat;
        break;
      }
    }
  }
  if (!candidate) return null;

  const unexplained = needTokens(need).filter((t) => !isExplained(t, categoryKeys));
  return unexplained.length === 0 ? candidate : null;
}

export interface RecommendInput {
  need: string;
  runtime?: "node" | "edge";
  license?: string;
  limit?: number;
}

export interface Recommendation {
  package: string;
  score: number;
  categories: string[];
  license: string | null;
  weeklyDownloads: number;
  reasons: string[];
  /**
   * The version to actually install: the newest stable release that has been
   * public long enough to have been looked at (see version-safety.ts), which
   * is usually but not always `latestVersion`.
   *
   * This exists because the recommendation list used to name a package and
   * nothing else, so the only thing a caller could do with it was
   * `npm install <name>` — resolving to whatever shipped that morning. All
   * the cooldown work was computed, stored, and then never reached the one
   * surface where the install decision is actually made.
   *
   * Null only when the version could not be resolved at all.
   */
  recommendedVersion: string | null;
  latestVersion: string | null;
  /**
   * Why the recommended version differs from the latest. Present ONLY when
   * they differ — attaching a paragraph of "no cooldown concern" to all five
   * results would bury the one that matters.
   */
  versionNote?: string;
}

export interface RecommendResult {
  matchedCategory: string | null;
  /** Set when candidates came from a live npm search rather than a curated category. */
  discoveredVia?: "npm-search";
  recommendations: Recommendation[];
  caveats: string[];
  excludedAsUnrecommendable?: number;
  note?: string;
}

// An out-of-range limit used to flow straight into `.slice(0, limit)`, so
// `--limit 0` and `--limit banana` (NaN) both returned an empty
// recommendations array — indistinguishable from "nothing matches your
// need." For a tool whose whole job is telling a caller which package to
// use, silently answering "none" to a malformed question is the worst
// possible failure mode. Throw instead; every caller surfaces it.
export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be a whole number between 1 and ${MAX_LIMIT}, got ${JSON.stringify(limit)}`);
  }
  return limit;
}

// How many search hits to actually fetch and score. Each one is a live
// registry + downloads + OSV round trip, so this is the latency knob: the
// first person to ask about a new domain pays it, everyone after them is
// served from the store like any other package.
const DISCOVERY_CANDIDATES = 12;

// Search surfaces packages that exist to support other packages rather than
// to be installed. Recommending "@react-pdf/types" to someone who asked for
// a PDF library is wrong in the same way recommending a test runner is, just
// less obviously. Same reasoning as excluding @types/* — these are not
// candidate answers to a functional need.
const SUPPORTING_PACKAGE = /\b(type|typescript) definitions?\b|\bhelper functions?\b|\binternal\b|\bdo not use\b/i;

function isDirectlyUsable(hit: { name: string; description: string | null }): boolean {
  const description = hit.description ?? "";
  if (SUPPORTING_PACKAGE.test(description)) return false;

  // A scoped package whose description says it is *for* its own project is a
  // component of that project: "@react-pdf/svg — SVG parsing for react-pdf",
  // "@react-pdf/font — Register font and emoji source for react-pdf
  // documents". The umbrella package under the same scope is the answer; its
  // internals are not.
  if (hit.name.startsWith("@")) {
    const scope = hit.name.slice(1, hit.name.indexOf("/"));
    if (scope && new RegExp(`\\bfor ${escapeRegExp(scope)}\\b`, "i").test(description)) return false;
  }
  return true;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/**
 * A last relevance floor on discovered candidates. npm's search is weak for
 * some phrasings: "send email" returned a set whose only survivor of the
 * health bar was `monocart-reporter`, a test reporter — presented, with a
 * score, as the answer. Requiring the package's own name or description to
 * mention something the caller actually asked for is a crude check, but it
 * is the difference between a shortlist and a non-sequitur.
 */
function mentionsNeed(name: string, description: string | null, tokens: string[]): boolean {
  if (tokens.length === 0) return true; // nothing to match on; do not filter
  // Only the summary counts, not the whole blurb. `monocart-reporter` is a
  // Playwright test reporter whose long description mentions email somewhere
  // far down, and matching anywhere in it put a test reporter at the top of
  // "send email". A package leads with what it is for.
  const summary = (description ?? "").slice(0, 120);
  const haystack = `${name} ${summary}`.toLowerCase();
  return tokens.some((t) => haystack.includes(t));
}

/**
 * Answers a need outside the ten curated categories by discovering candidates
 * live instead of refusing — the same npm search the collector uses to build
 * the categories in the first place, just run on demand.
 *
 * Two earlier behaviours were both wrong. Ranking the whole tracked corpus
 * answered "pdf" with vitest, jose, hono, xstate and zod — a test runner, a
 * JWT library, a web framework, a state machine and a validator, each scored
 * and explained as though it answered the question. Returning nothing at all
 * was honest but needlessly so: the search endpoint was right there.
 *
 * What comes back is explicitly NOT a curated category. Search relevance is
 * npm's, not ours, so the caveat says so and the ranking is absolute rather
 * than percentile-against-peers — a percentile is only meaningful against a
 * competitor set someone actually curated.
 */
async function discoverForNeed(input: RecommendInput, limit: number): Promise<RecommendResult> {
  const hits = await searchPackages(input.need, DISCOVERY_CANDIDATES * 2);

  // Says what these results ARE and how much to trust them — deliberately
  // without naming the internal categories.
  //
  // It used to open by listing all ten of them, which was the wrong thing to
  // put in front of a model. The list reads as a statement of coverage, and
  // the tool's actual coverage is all of npm; a model that has just been told
  // "auth-jwt, csv-parsing, date-time, ..." is being nudged toward treating
  // anything else as unsupported, which is precisely backwards for the branch
  // that exists to answer everything else. The taxonomy is an implementation
  // detail of how ranking works, it is available from list_categories for
  // anyone who wants it, and `matchedCategory: null` already carries the same
  // fact in a form a caller can branch on without reading prose.
  const caveats = [
    `These candidates were found by searching npm live for "${input.need}", then screened with the same ` +
      `security, maintenance and supply-chain checks as any other answer. The ordering is npm's search ` +
      `relevance, NOT a judgement about which is best — there is no curated competitor set for this need to ` +
      `rank against, so the scores are absolute rather than percentiles. Treat it as a screened shortlist to ` +
      `verify, not a settled comparison, and confirm each one actually does what you need.`,
  ];

  if (hits.length === 0) {
    return {
      matchedCategory: null,
      discoveredVia: "npm-search",
      recommendations: [],
      caveats,
      note:
        `Searching npm for "${input.need}" returned nothing usable. ` +
        `If you already have a candidate name, check_package scores any package on npm.`,
    };
  }

  // Fetch and score sequentially-ish; getOrFetchPackage stores each one, so a
  // repeat of the same need is served from disk. Failures are skipped rather
  // than aborting the whole answer.
  const tokens = needTokens(input.need);
  const relevant = hits
    .filter(isDirectlyUsable)
    .filter((h) => mentionsNeed(h.name, h.description, tokens))
    .slice(0, DISCOVERY_CANDIDATES);

  const rows: PackageRow[] = [];
  for (const hit of relevant) {
    try {
      const result = await getOrFetchPackage(hit.name);
      if (result.found && result.row) rows.push(result.row);
    } catch {
      /* one bad candidate must not sink the query */
    }
  }

  const eligible = rows.filter(isRecommendable);
  const excludedAsUnrecommendable = rows.length - eligible.length;

  const licensed = input.license
    ? eligible.filter((p) => p.license?.toLowerCase() === input.license!.toLowerCase())
    : eligible;

  if (input.runtime === "edge") caveats.push(EDGE_CAVEAT);

  // Deliberately NOT re-sorted by score. npm's relevance ranking already
  // answers "which of these is the thing people mean", and it does that far
  // better than a health score can: sorting "pdf" purely by score promoted
  // @react-pdf/font, /fns and /svg — internal sub-packages of
  // @react-pdf/renderer that nobody installs directly — above pdf-lib,
  // purely because small single-purpose modules score well on dependency
  // count and TypeScript support. Relevance is npm's job; screening for
  // security, maintenance and adoption is this tool's. Doing only the second
  // one, and saying so, beats doing both badly.
  const ranked = licensed.slice(0, limit).map(toRecommendation);

  return {
    matchedCategory: null,
    discoveredVia: "npm-search",
    recommendations: ranked,
    caveats,
    excludedAsUnrecommendable,
    // Both branches name npm search. Provenance is not a detail that stops
    // mattering when the answer is empty — "12 candidates were found" invites
    // the reader to assume the curated store was searched, when in fact this
    // was a live lookup. It also made the empty branch untestable: whether any
    // candidate clears the gate depends on live download and maintenance
    // stats, so a test asserting provenance failed intermittently in CI
    // against a note that was only sometimes emitted.
    note:
      ranked.length > 0
        ? `${rows.length} candidates were discovered via npm search, fetched, scored and filtered down to ` +
          `${ranked.length}. They are now tracked in the store, so the same question is served from disk next time.`
        : `${rows.length} candidates were discovered via npm search, fetched and scored, but ` +
          `none cleared the recommendation bar (adoption, maintenance, deprecation) — which is itself a signal ` +
          `worth reporting rather than lowering the bar to fill the list.`,
  };
}

const EDGE_CAVEAT =
  "Edge Runtime fit has NOT been sandbox-tested for this dataset (that's Proof 0's @edge-runtime/vm check, run separately and not yet merged in). ESM support is used as a weak proxy here, not a real guarantee — verify before deploying to an edge function.";

function toRecommendation(p: PackageRow): Recommendation {
  // Falling back to latest_version when no guidance is stored is deliberate:
  // an install target the caller can use beats a null, and "latest" is what
  // they would have got anyway without this field. The fallback is silent
  // precisely because it is not a downgrade in behaviour.
  const fresh = currentGuidance(p);
  const recommendedVersion = fresh?.recommendedVersion ?? p.recommended_version ?? p.latest_version;
  const guidance = fresh?.reason ?? p.version_guidance;
  const differs = Boolean(recommendedVersion && p.latest_version && recommendedVersion !== p.latest_version);
  return {
    package: p.name,
    score: p.score_total ?? 0,
    categories: p.categories,
    license: p.license,
    weeklyDownloads: p.weekly_downloads,
    reasons: p.score_reasons,
    recommendedVersion,
    latestVersion: p.latest_version,
    versionNote: differs && guidance ? guidance : undefined,
  };
}

export async function recommend(input: RecommendInput): Promise<RecommendResult> {
  const limit = normalizeLimit(input.limit);
  const categoryKeys = listAllCategoryCounts().map((c) => c.key);
  const matched = matchCategory(input.need, categoryKeys);

  // Refusing to answer beats answering about something else.
  //
  // This used to fall back to "rank the entire tracked dataset", which for
  // an uncovered domain returns whatever scores highest overall — asking for
  // a PDF library produced vitest, jose, hono, xstate and zod: a test
  // runner, a JWT library, a web framework, a state machine and a validator,
  // each ranked, scored and explained as though it answered the question.
  // A `note` saying no category matched was the only thing distinguishing
  // that from a real recommendation, and a model skims notes.
  //
  // This project's own rule is that a missed detection is a documented gap
  // and a confident wrong answer is a bug. Five wrong packages with scores
  // attached is a confident wrong answer, so the domain gap is now reported
  // as a gap.
  if (!matched) return discoverForNeed(input, limit);

  let candidates = listByCategory(matched);

  // Enforced here as well as at dataset-build time, because a package can
  // degrade after it was collected — get deprecated, stop being released,
  // lose adoption — and the refresh worker updates the data without anything
  // otherwise stopping it from still being recommended.
  const beforeGate = candidates.length;
  candidates = candidates.filter(isRecommendable);
  const excludedAsUnrecommendable = beforeGate - candidates.length;

  if (input.license) {
    const wanted = input.license.toLowerCase();
    candidates = candidates.filter((p) => p.license?.toLowerCase() === wanted);
  }

  const caveats: string[] = [];
  if (input.runtime === "edge") caveats.push(EDGE_CAVEAT);

  const ranked = candidates
    .slice()
    .sort((a, b) => (b.score_total ?? 0) - (a.score_total ?? 0))
    .slice(0, limit)
    .map(toRecommendation);

  return { matchedCategory: matched, recommendations: ranked, caveats, excludedAsUnrecommendable };
}

export interface CheckPackageResult {
  name: string;
  found: boolean;
  reason?: string;
  /** Present only when found is false. Lets a caller branch on *why* without parsing prose. */
  reasonCode?: RegistryMissCode;
  inCuratedDataset: boolean;
  servedFrom?: "cache" | "live-fetch";
  score?: number;
  reasons?: string[];
  npm?: {
    license: string | null;
    maintainers: number;
    latestVersion: string | null;
    dependenciesCount: number;
    deprecated: boolean;
  };
  weeklyDownloads?: number;
  versionGuidance?: {
    recommendedVersion: string;
    reason: string;
  };
  typosquatWarning?: {
    targetPackage: string;
    targetWeeklyDownloads: number;
    reason: string;
  };
  recommendable?: boolean;
  notRecommendableBecause?: string[];
  note: string;
}

// Only a genuine 404 is evidence about a name's authenticity. The other
// three outcomes previously produced the same "likely hallucinated or
// typosquatted" note, which is wrong in two different directions: a
// malformed name means the registry was never asked, and a registry error
// means it refused to answer — during an npm outage that note would have
// branded every real package in a project as possibly fake.
const MISS_NOTES: Record<RegistryMissCode, string> = {
  "not-found":
    "This package does not resolve on the npm registry. If this name came from a suggestion rather than a known dependency, treat it as a likely hallucinated or typosquatted name and verify before installing anything.",
  "invalid-name":
    "This is not a well-formed npm package name, so the registry was never queried. That is a problem with the string that was passed, NOT evidence about whether any real package exists — do not report this as 'the package does not exist'. Fix the name and check again.",
  "registry-error":
    "The npm registry could not be reached or returned an error, so nothing is known about this name either way. This is NOT a 404 and NOT evidence the package is missing or fake. Retry before drawing any conclusion, and do not tell the user a package is unsafe on the strength of this.",
  "no-manifest":
    "The name exists on the registry but has no usable latest-version manifest — typically an unpublished, reserved, or placeholder record. Treat it as not installable, which is not the same as the name being fake.",
};

// Live, on-demand check for ANY package name — not just the curated 500.
// Backed by the persistent store: a package already checked recently is
// served straight from disk (servedFrom: "cache", zero network calls); a
// new or stale one triggers a real fetch, gets stored, and is from then on
// covered by the background refresh worker automatically. A 404 here is
// exactly the signature of a hallucinated or typosquatted package name.
export async function checkPackage(name: string): Promise<CheckPackageResult> {
  const result = await getOrFetchPackage(name);

  if (!result.found) {
    const code = result.code ?? "not-found";
    return {
      name,
      found: false,
      reason: result.reason,
      reasonCode: code,
      inCuratedDataset: false,
      note: MISS_NOTES[code],
    };
  }

  const row = result.row!;
  const inCuratedDataset = row.categories.length > 0;

  // A resolvable typosquat — a real, installable package one character
  // off from something hugely popular — is the actual attack pattern.
  // Checked against every name in our own store plus a small curated
  // list of famous packages outside the 10 categories, so this doesn't
  // depend on the checked name already being known-bad.
  const storeDownloads = listNameDownloads();
  const typosquat = await checkTyposquat(row.name, row.weekly_downloads, storeDownloads, !row.downloads_check_failed);

  // check_package answers for any package, including ones this tool would
  // never put forward itself. Saying so explicitly is the point: "here is
  // what I know, and no, I would not have recommended this."
  const eligibility = checkRecommendable(row);

  return {
    name: row.name,
    found: true,
    inCuratedDataset,
    servedFrom: result.servedFrom,
    score: row.score_total ?? undefined,
    reasons: row.score_reasons,
    npm: {
      license: row.license,
      maintainers: row.maintainers,
      latestVersion: row.latest_version,
      dependenciesCount: row.dependencies_count,
      deprecated: row.deprecated,
    },
    weeklyDownloads: row.weekly_downloads,
    versionGuidance:
      currentGuidance(row) ??
      (row.recommended_version && row.version_guidance
        ? { recommendedVersion: row.recommended_version, reason: row.version_guidance }
        : undefined),
    typosquatWarning: typosquat.suspicious
      ? { targetPackage: typosquat.targetPackage!, targetWeeklyDownloads: typosquat.targetWeeklyDownloads!, reason: typosquat.reason! }
      : undefined,
    recommendable: eligibility.eligible,
    notRecommendableBecause: eligibility.eligible ? undefined : eligibility.failures,
    note: inCuratedDataset
      ? "In a known category — this score is ranked against real category competitors (see recommend_package for the full comparison)."
      : "Scored on an absolute scale — not ranked against category competitors since this package isn't in a known category. Now tracked in the store either way, and will be kept fresh by the background refresh worker.",
  };
}
