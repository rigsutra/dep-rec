import { readFile } from "node:fs/promises";

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

const DATA_URL = new URL("../../stage1-collector/data/scored.json", import.meta.url);

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
