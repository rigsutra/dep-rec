// One-time (or re-runnable) bootstrap: import stage1-collector's raw
// per-package data into the store, then run an initial scoring pass.
// This is a dev-time step — the resulting data/store.db file is what
// actually ships inside the package (see package.json's "files"), not
// this script.

import { readFile } from "node:fs/promises";
import { upsertRaw, listAll } from "./db.js";
import { rescoreCategory } from "./lookup.js";

interface CollectorRecord {
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
  security: { vulnerabilityIds: string[] };
}

async function main() {
  const raw: CollectorRecord[] = JSON.parse(
    await readFile(new URL("../../../stage1-collector/data/packages.json", import.meta.url), "utf8")
  );

  const nowIso = new Date().toISOString();
  for (const p of raw) {
    upsertRaw({
      name: p.name,
      categories: p.categories,
      license: p.npm.license,
      maintainers: p.npm.maintainers,
      created_at: p.npm.createdAt,
      modified_at: p.npm.modifiedAt,
      latest_version: p.npm.latestVersion,
      dependencies_count: p.npm.dependenciesCount,
      // stage1-collector doesn't capture this yet — the curated baseline
      // starts as "unknown/false" here and picks up the real value the
      // first time each package gets touched by check_package or the
      // refresh worker, both of which use the live-fetch path that does
      // capture it.
      has_install_scripts: false,
      deprecated: p.npm.deprecated,
      esm_support: p.compatibility.esmSupport,
      typescript_support: p.compatibility.typescriptSupport,
      release_cadence_days: p.compatibility.releaseCadenceDays,
      weekly_downloads: p.downloads.weekly,
      vulnerability_ids: p.security.vulnerabilityIds,
      security_check_failed: false, // stage1-collector's OSV batch call succeeded for these
      downloads_check_failed: false,
      raw_fetched_at: nowIso,
      first_seen_at: nowIso,
    });
  }
  console.log(`Seeded ${raw.length} packages into the store.`);

  const categories = new Set(raw.flatMap((p) => p.categories));
  for (const cat of categories) rescoreCategory(cat);
  console.log(`Scored ${categories.size} categories.`);

  // Report — not silently drop — how much of what npm's relevance search
  // returned is not actually fit to recommend. The rows stay in the store
  // (they are still legitimate lookup targets); recommend() filters them.
  // Seeing this number is how the corpus-quality problem was noticed at all.
  const { checkRecommendable } = await import("./eligibility.js");
  const stored = listAll();
  const rejected = stored.filter((r) => !checkRecommendable(r).eligible);
  console.log(`\n${stored.length - rejected.length}/${stored.length} clear the recommendation bar.`);
  if (rejected.length > 0) {
    console.log(`${rejected.length} are tracked but will not be recommended. Worst offenders by adoption:`);
    for (const r of rejected.sort((a, b) => a.weekly_downloads - b.weekly_downloads).slice(0, 8)) {
      console.log(`  - ${r.name} (${r.weekly_downloads.toLocaleString("en-US")}/wk): ${checkRecommendable(r).failures.join("; ")}`);
    }
  }

  const perCategory = new Map<string, number>();
  for (const r of stored) {
    if (!checkRecommendable(r).eligible) continue;
    for (const c of r.categories) perCategory.set(c, (perCategory.get(c) ?? 0) + 1);
  }
  const thin = [...perCategory.entries()].filter(([, n]) => n < 5);
  if (thin.length > 0) {
    console.log(`\nWARNING: thin categories after the gate (a weak comparison set): ${thin.map(([c, n]) => `${c}=${n}`).join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
