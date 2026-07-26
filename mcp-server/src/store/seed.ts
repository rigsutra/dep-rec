// One-time (or re-runnable) bootstrap: import stage1-collector's raw
// per-package data into the store, then run an initial scoring pass.
// This is a dev-time step — the resulting data/store.db file is what
// actually ships inside the package (see package.json's "files"), not
// this script.

import { readFile } from "node:fs/promises";
import { upsertRaw, listAll, upsertVersionGuidance, upsertLatestVersion } from "./db.js";
import { rescoreCategory } from "./lookup.js";
import { fetchPackageDoc } from "../sources/npm.js";
import { queryVulnerabilities } from "../sources/osv.js";
import { resolveRecommendedVersion, COOLDOWN_DAYS } from "./version-safety.js";

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

/**
 * Resolves the cooldown-safe install version for every seeded package.
 *
 * This pass exists because the feature was, in practice, not shipping. The
 * only caller of resolveRecommendedVersion was the live-fetch path, so a
 * curated package answered from the store with recommended_version NULL —
 * measured at 0 of 499 rows. recommend() reads the curated categories
 * straight from the store with no freshness check, so the cooldown never
 * reached the surface where the install decision is actually made. It
 * surfaced only if someone happened to check_package a name by hand.
 *
 * The publish history it needs isn't in the collector export, hence a
 * registry document per package. Vulnerabilities are re-queried rather than
 * reused from the snapshot: the snapshot's list belongs to whatever version
 * was latest when it was collected, and feeding a stale list in as "the
 * latest version's vulnerabilities" is exactly the unverified inference the
 * resolver documents itself as refusing to make.
 */
async function backfillVersionGuidance(records: CollectorRecord[]): Promise<void> {
  const queue = [...records];
  let resolved = 0;
  let failed = 0;
  let drifted = 0;
  const heldBack: Array<{ name: string; latest: string; pick: string }> = [];

  const worker = async (): Promise<void> => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
      const doc = await fetchPackageDoc(p.name);
      if (!doc.found || !doc.latestVersion) {
        failed++;
        continue;
      }
      if (doc.latestVersion !== p.npm.latestVersion) {
        drifted++;
        upsertLatestVersion(p.name, doc.latestVersion);
      }
      const vulnCheck = await queryVulnerabilities(p.name, doc.latestVersion);
      const guidance = await resolveRecommendedVersion(p.name, doc.latestVersion, doc.versionHistory, vulnCheck);
      upsertVersionGuidance(p.name, guidance.recommendedVersion, guidance.reason);
      resolved++;
      if (guidance.recommendedVersion !== doc.latestVersion) {
        heldBack.push({ name: p.name, latest: doc.latestVersion, pick: guidance.recommendedVersion });
      }
    }
  };

  await Promise.all(Array.from({ length: 6 }, worker));

  console.log(`\nResolved install versions for ${resolved}/${records.length} packages.`);
  if (failed > 0) console.log(`  ${failed} could not be resolved (registry miss) and keep a null recommended_version.`);
  if (drifted > 0) console.log(`  ${drifted} had a latest_version newer than the collector snapshot; corrected in place.`);
  console.log(`  ${heldBack.length} resolve to something older than latest (inside the ${COOLDOWN_DAYS}-day window):`);
  for (const h of heldBack.slice(0, 12)) console.log(`    - ${h.name}: latest ${h.latest} -> recommending ${h.pick}`);
  if (heldBack.length > 12) console.log(`    ... and ${heldBack.length - 12} more`);
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

  await backfillVersionGuidance(raw);

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
