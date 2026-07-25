import { readFile } from "node:fs/promises";
import { fetchPackageDoc, fetchWeeklyDownloads } from "./sources/npm.js";
import { queryVulnerabilities } from "./sources/osv.js";
import { scorePackageAbsolute } from "./live-score.js";

export interface ScoredPackage {
  name: string;
  categories: string[];
  npm: {
    license: string | null;
    maintainers: number;
    createdAt: string | null;
    modifiedAt: string | null;
    latestVersion: string | null;
    dependenciesCount: number;
    deprecated: boolean;
  };
  downloads: { weekly: number };
  compatibility: { esmSupport: boolean; typescriptSupport: boolean; releaseCadenceDays: number | null };
  security: { knownVulnerabilities: number; vulnerabilityIds: string[] };
  scoring: {
    total: number;
    security: number;
    maintenance: number;
    compatibility: number;
    community: number;
    supplyChain: number;
    reasons: string[];
  };
}

// Bundled inside the package itself (copied from stage1-collector/data at
// build time) so an installed copy of this package is self-contained and
// doesn't depend on the monorepo's sibling folders existing.
const DATA_URL = new URL("../data/scored.json", import.meta.url);

let cache: ScoredPackage[] | null = null;
async function loadData(): Promise<ScoredPackage[]> {
  if (!cache) cache = JSON.parse(await readFile(DATA_URL, "utf8"));
  return cache!;
}

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
  const data = await loadData();
  const counts = new Map<string, number>();
  for (const pkg of data) for (const c of pkg.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
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
  const data = await loadData();
  const categoryKeys = [...new Set(data.flatMap((p) => p.categories))];
  const matched = matchCategory(input.need, categoryKeys);

  let candidates = matched ? data.filter((p) => p.categories.includes(matched)) : data;

  if (input.license) {
    const wanted = input.license.toLowerCase();
    candidates = candidates.filter((p) => p.npm.license?.toLowerCase() === wanted);
  }

  const caveats: string[] = [];
  if (input.runtime === "edge") {
    caveats.push(
      "Edge Runtime fit has NOT been sandbox-tested for this dataset (that's Proof 0's @edge-runtime/vm check, run separately and not yet merged in). ESM support is used as a weak proxy here, not a real guarantee — verify before deploying to an edge function."
    );
  }
  const ranked = candidates
    .slice()
    .sort((a, b) => b.scoring.total - a.scoring.total)
    .slice(0, input.limit ?? 5)
    .map((p) => ({
      package: p.name,
      score: p.scoring.total,
      categories: p.categories,
      license: p.npm.license,
      weeklyDownloads: p.downloads.weekly,
      reasons: p.scoring.reasons,
    }));

  return {
    matchedCategory: matched,
    recommendations: ranked,
    caveats,
    note: matched
      ? undefined
      : `No category matched "${input.need}" — ranked across the entire dataset instead of one category. Known categories: ${categoryKeys.join(", ")}`,
  };
}

export interface CheckPackageResult {
  name: string;
  found: boolean;
  reason?: string;
  inCuratedDataset: boolean;
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
  note: string;
}

// Live, on-demand check for ANY package name — not just the curated 500.
// This is what makes the server general-purpose rather than confined to
// the 10 seeded categories, and it doubles as an existence check: a 404
// here is exactly the signature of a hallucinated or typosquatted package
// name, which is worth surfacing explicitly rather than just scoring 0.
export async function checkPackage(name: string): Promise<CheckPackageResult> {
  const curated = (await loadData()).find((p) => p.name === name);
  if (curated) {
    return {
      name,
      found: true,
      inCuratedDataset: true,
      score: curated.scoring.total,
      reasons: curated.scoring.reasons,
      npm: {
        license: curated.npm.license,
        maintainers: curated.npm.maintainers,
        latestVersion: curated.npm.latestVersion,
        dependenciesCount: curated.npm.dependenciesCount,
        deprecated: curated.npm.deprecated,
      },
      weeklyDownloads: curated.downloads.weekly,
      note: "Already in the curated dataset — this score is ranked against real category competitors (see recommend_package for the comparison). Prefer that over this absolute score when a same-category alternative matters.",
    };
  }

  const doc = await fetchPackageDoc(name);
  if (!doc.found) {
    return {
      name,
      found: false,
      reason: doc.reason,
      inCuratedDataset: false,
      note: "This package does not resolve on the npm registry. If this name came from a suggestion rather than a known dependency, treat it as a likely hallucinated or typosquatted name and verify before installing anything.",
    };
  }

  const [weeklyDownloads, vulnerabilityIds] = await Promise.all([
    fetchWeeklyDownloads(name),
    doc.latestVersion ? queryVulnerabilities(name, doc.latestVersion) : Promise.resolve([]),
  ]);

  const scoring = scorePackageAbsolute({ doc, weeklyDownloads, vulnerabilityIds });

  return {
    name,
    found: true,
    inCuratedDataset: false,
    score: scoring.total,
    reasons: scoring.reasons,
    npm: {
      license: doc.license,
      maintainers: doc.maintainersCount,
      latestVersion: doc.latestVersion,
      dependenciesCount: doc.dependenciesCount,
      deprecated: doc.deprecated,
    },
    weeklyDownloads,
    note: "Scored live on an absolute scale (fetched just now) — not ranked against category competitors like the curated dataset is. If this package fits one of the 10 known categories, recommend_package will give a more meaningful comparative score.",
  };
}
