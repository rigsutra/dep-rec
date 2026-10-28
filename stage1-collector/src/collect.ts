// Proof 1 — build a searchable, consistent dataset of ~500 packages across
// 10 competing categories, with Tier 1 (raw registry/downloads/OSV metadata)
// and Tier 2 (static analysis: ESM/TS support, release cadence, deprecation)
// data attached to each one.
//
// Deliberately no Tier 3 (sandbox-tested edge compatibility) here.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fetchPackageDoc, fetchWeeklyDownloadsBatch, searchNpm, type RegistryDoc } from "./npm.js";
import { queryVulnerabilitiesBatch } from "./osv.js";

const CAP_PER_CATEGORY = 50;
const CONCURRENCY = 10;

interface CategoryConfig {
  key: string;
  label: string;
  queries: string[];
  seeds: string[];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildCategoryCandidates(cat: CategoryConfig): Promise<string[]> {
  const scored = new Map<string, number>();
  for (const seed of cat.seeds) scored.set(seed, Number.POSITIVE_INFINITY); // seeds always rank first

  for (const q of cat.queries) {
    await sleep(350); // stay under the search endpoint's throttling threshold
    const hits = await searchNpm(q, CAP_PER_CATEGORY);
    for (const hit of hits) {
      const existing = scored.get(hit.name);
      if (existing === undefined || existing < hit.score) scored.set(hit.name, hit.score);
    }
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CAP_PER_CATEGORY)
    .map(([name]) => name);
}

async function main() {
  const categories: CategoryConfig[] = JSON.parse(
    await readFile(new URL("../categories.json", import.meta.url), "utf8")
  );

  console.log(`Building candidate lists for ${categories.length} categories...`);
  const nameToCategories = new Map<string, Set<string>>();
  const perCategoryCounts: Record<string, number> = {};

  for (const cat of categories) {
    const names = await buildCategoryCandidates(cat);
    perCategoryCounts[cat.key] = names.length;
    for (const name of names) {
      if (!nameToCategories.has(name)) nameToCategories.set(name, new Set());
      nameToCategories.get(name)!.add(cat.key);
    }
    console.log(`  ${cat.label}: ${names.length} candidates`);
  }

  const uniqueNames = [...nameToCategories.keys()];
  console.log(`\n${uniqueNames.length} unique packages across all categories. Fetching registry metadata...`);

  let completed = 0;
  const docs = await mapWithConcurrency(uniqueNames, CONCURRENCY, async (name) => {
    const doc = await fetchPackageDoc(name);
    completed++;
    if (completed % 50 === 0) console.log(`  ...${completed}/${uniqueNames.length}`);
    return doc;
  });

  const found: RegistryDoc[] = [];
  const notFound: Array<{ name: string; reason: string }> = [];
  for (const d of docs) {
    if (d.found) found.push(d);
    else notFound.push({ name: d.name, reason: d.reason });
  }

  console.log(`\n${found.length}/${uniqueNames.length} resolved on the registry.`);
  if (notFound.length) {
    console.log(`Dropped (${notFound.length}):`);
    for (const n of notFound) console.log(`  - ${n.name}: ${n.reason}`);
  }

  console.log("\nFetching weekly download counts...");
  const downloads = await fetchWeeklyDownloadsBatch(found.map((d) => d.name));

  console.log("Querying OSV for known vulnerabilities (scoped to each package's current version)...");
  const vulns = await queryVulnerabilitiesBatch(
    found.filter((d) => d.latestVersion).map((d) => ({ name: d.name, version: d.latestVersion! }))
  );

  const records = found.map((d) => ({
    name: d.name,
    categories: [...(nameToCategories.get(d.name) ?? [])],
    npm: {
      license: d.license,
      maintainers: d.maintainersCount,
      createdAt: d.createdAt,
      modifiedAt: d.modifiedAt,
      latestVersion: d.latestVersion,
      dependenciesCount: d.dependenciesCount,
      deprecated: d.deprecated,
    },
    downloads: { weekly: downloads[d.name] ?? 0 },
    compatibility: {
      esmSupport: d.esmSupport,
      typescriptSupport: d.typescriptSupport,
      releaseCadenceDays: d.releaseCadenceDays,
    },
    security: {
      knownVulnerabilities: (vulns[d.name] ?? []).length,
      vulnerabilityIds: vulns[d.name] ?? [],
    },
  }));

  const outDir = new URL("../data/", import.meta.url);
  await mkdir(outDir, { recursive: true });
  await writeFile(new URL("packages.json", outDir), JSON.stringify(records, null, 2));

  const summary = {
    totalUniqueCandidates: uniqueNames.length,
    resolved: found.length,
    droppedCount: notFound.length,
    dropped: notFound,
    perCategoryCandidateCounts: perCategoryCounts,
  };
  await writeFile(new URL("summary.json", outDir), JSON.stringify(summary, null, 2));

  console.log(`\nWrote ${records.length} package records to data/packages.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
