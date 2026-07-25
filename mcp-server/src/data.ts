import { listAllCategoryCounts, listByCategory, listAll } from "./store/db.js";
import { getOrFetchPackage } from "./store/lookup.js";

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

export async function listCategories(): Promise<Array<{ key: string; count: number }>> {
  return listAllCategoryCounts();
}

function matchCategory(need: string, categoryKeys: string[]): string | null {
  const lower = need.toLowerCase();
  for (const cat of categoryKeys) if (lower.includes(cat)) return cat;
  for (const [word, cat] of Object.entries(SYNONYMS)) if (lower.includes(word)) return cat;
  return null;
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
}

export interface RecommendResult {
  matchedCategory: string | null;
  recommendations: Recommendation[];
  caveats: string[];
  note?: string;
}

export async function recommend(input: RecommendInput): Promise<RecommendResult> {
  const categoryKeys = listAllCategoryCounts().map((c) => c.key);
  const matched = matchCategory(input.need, categoryKeys);

  let candidates = matched ? listByCategory(matched) : listAll();

  if (input.license) {
    const wanted = input.license.toLowerCase();
    candidates = candidates.filter((p) => p.license?.toLowerCase() === wanted);
  }

  const caveats: string[] = [];
  if (input.runtime === "edge") {
    caveats.push(
      "Edge Runtime fit has NOT been sandbox-tested for this dataset (that's Proof 0's @edge-runtime/vm check, run separately and not yet merged in). ESM support is used as a weak proxy here, not a real guarantee — verify before deploying to an edge function."
    );
  }

  const ranked = candidates
    .slice()
    .sort((a, b) => (b.score_total ?? 0) - (a.score_total ?? 0))
    .slice(0, input.limit ?? 5)
    .map((p) => ({
      package: p.name,
      score: p.score_total ?? 0,
      categories: p.categories,
      license: p.license,
      weeklyDownloads: p.weekly_downloads,
      reasons: p.score_reasons,
    }));

  return {
    matchedCategory: matched,
    recommendations: ranked,
    caveats,
    note: matched
      ? undefined
      : `No category matched "${input.need}" — ranked across the entire tracked dataset instead of one category. Known categories: ${categoryKeys.join(", ")}`,
  };
}

export interface CheckPackageResult {
  name: string;
  found: boolean;
  reason?: string;
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
  note: string;
}

// Live, on-demand check for ANY package name — not just the curated 500.
// Backed by the persistent store: a package already checked recently is
// served straight from disk (servedFrom: "cache", zero network calls); a
// new or stale one triggers a real fetch, gets stored, and is from then on
// covered by the background refresh worker automatically. A 404 here is
// exactly the signature of a hallucinated or typosquatted package name.
export async function checkPackage(name: string): Promise<CheckPackageResult> {
  const result = await getOrFetchPackage(name);

  if (!result.found) {
    return {
      name,
      found: false,
      reason: result.reason,
      inCuratedDataset: false,
      note: "This package does not resolve on the npm registry. If this name came from a suggestion rather than a known dependency, treat it as a likely hallucinated or typosquatted name and verify before installing anything.",
    };
  }

  const row = result.row!;
  const inCuratedDataset = row.categories.length > 0;

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
      row.recommended_version && row.version_guidance
        ? { recommendedVersion: row.recommended_version, reason: row.version_guidance }
        : undefined,
    note: inCuratedDataset
      ? "In a known category — this score is ranked against real category competitors (see recommend_package for the full comparison)."
      : "Scored on an absolute scale — not ranked against category competitors since this package isn't in a known category. Now tracked in the store either way, and will be kept fresh by the background refresh worker.",
  };
}
