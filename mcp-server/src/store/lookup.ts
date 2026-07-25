// The actual "check once, serve the other 99 from what's stored" logic.
// A package enters the store (and therefore future background surveillance
// — see refresh-worker.ts) the moment anyone looks it up, whether that's a
// curated seed package or a one-off check_package call.

import { getPackage, listByCategory, upsertRaw, upsertScore, upsertVersionGuidance, type PackageRow } from "./db.js";
import { fetchPackageDoc, fetchWeeklyDownloads } from "../sources/npm.js";
import { queryVulnerabilities } from "../sources/osv.js";
import { scoreCategoryGroup, scoreAbsolute } from "./scoring.js";
import { resolveRecommendedVersion } from "./version-safety.js";

// How long stored raw data is trusted before a request triggers a live
// refetch. Deliberately a plain constant, not a config file — tune this
// once real usage patterns are known. 24h means: worst case, a package's
// data is a day stale for the person who happens to trigger the refetch;
// everyone else in that window gets served from storage with zero network
// calls.
const STALE_MS = 24 * 60 * 60 * 1000;

export function rescoreCategory(category: string): void {
  const peers = listByCategory(category);
  const scores = scoreCategoryGroup(peers);
  for (const [name, score] of scores) {
    upsertScore(name, { ...score, method: "category-relative" });
  }
}

function rescoreRow(row: PackageRow): void {
  if (row.categories.length > 0) {
    // Recompute the WHOLE peer group, not just this row — this package's
    // updated numbers shift everyone else's percentile in that category too.
    for (const cat of row.categories) rescoreCategory(cat);
  } else {
    const score = scoreAbsolute(row);
    upsertScore(row.name, { ...score, method: "absolute" });
  }
}

async function fetchAndStore(name: string, existing: PackageRow | null): Promise<{ found: true; row: PackageRow } | { found: false; reason: string }> {
  const doc = await fetchPackageDoc(name);
  if (!doc.found) return { found: false, reason: doc.reason };

  const [weeklyDownloads, vulnResult] = await Promise.all([
    fetchWeeklyDownloads(name),
    doc.latestVersion
      ? queryVulnerabilities(name, doc.latestVersion)
      : Promise.resolve({ ok: true as const, vulnerabilityIds: [] as string[] }),
  ]);

  // A failed OSV check is NOT "confirmed zero vulnerabilities." Keep the
  // last successfully-fetched list rather than overwriting good data with
  // an empty one, and flag that the most recent attempt couldn't verify it
  // fresh — scoring.ts turns that flag into an honest reason string instead
  // of a false "no known vulnerabilities."
  const securityCheckFailed = !vulnResult.ok;
  const vulnerabilityIds = vulnResult.ok ? vulnResult.vulnerabilityIds : existing?.vulnerability_ids ?? [];

  const nowIso = new Date().toISOString();
  upsertRaw({
    name,
    categories: existing?.categories ?? [],
    license: doc.license,
    maintainers: doc.maintainersCount,
    created_at: doc.createdAt,
    modified_at: doc.modifiedAt,
    latest_version: doc.latestVersion,
    dependencies_count: doc.dependenciesCount,
    has_install_scripts: doc.hasInstallScripts,
    deprecated: doc.deprecated,
    esm_support: doc.esmSupport,
    typescript_support: doc.typescriptSupport,
    release_cadence_days: doc.releaseCadenceDays,
    weekly_downloads: weeklyDownloads,
    vulnerability_ids: vulnerabilityIds,
    security_check_failed: securityCheckFailed,
    raw_fetched_at: nowIso,
    first_seen_at: existing?.first_seen_at ?? nowIso,
  });

  if (doc.latestVersion) {
    const guidance = await resolveRecommendedVersion(name, doc.latestVersion, doc.versionHistory, vulnResult);
    upsertVersionGuidance(name, guidance.recommendedVersion, guidance.reason);
  }

  const row = getPackage(name)!;
  rescoreRow(row);
  return { found: true, row: getPackage(name)! };
}

export interface LookupResult {
  found: boolean;
  row?: PackageRow;
  reason?: string;
  servedFrom?: "cache" | "live-fetch";
}

export async function getOrFetchPackage(name: string): Promise<LookupResult> {
  const existing = getPackage(name);
  const isFresh = existing && Date.now() - new Date(existing.raw_fetched_at).getTime() < STALE_MS;

  if (existing && isFresh) {
    return { found: true, row: existing, servedFrom: "cache" };
  }

  const result = await fetchAndStore(name, existing);
  if (!result.found) return { found: false, reason: result.reason };
  return { found: true, row: result.row, servedFrom: "live-fetch" };
}

// Used by the refresh worker, which deliberately bypasses the freshness
// check above — it exists specifically to refresh stale rows.
export async function forceRefreshPackage(name: string): Promise<LookupResult> {
  const existing = getPackage(name);
  const result = await fetchAndStore(name, existing);
  if (!result.found) return { found: false, reason: result.reason };
  return { found: true, row: result.row, servedFrom: "live-fetch" };
}
