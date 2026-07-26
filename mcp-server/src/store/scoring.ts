// One scoring module, two modes, both sharing the same security/
// compatibility/supply-chain logic (which never need a peer group):
//
//   scoreCategoryGroup — percentile-ranked against real category peers,
//                        used whenever a package has categories assigned.
//   scoreAbsolute      — fixed reference curves, used for a package with
//                        no category (an ad-hoc check_package lookup that
//                        doesn't match any of the 10 known categories).
//
// Previously these lived as separate, subtly-diverging implementations in
// stage1-collector/src/score.ts and mcp-server/src/live-score.ts. Now that
// every package lives in one store regardless of origin, there's no reason
// for two copies of the same formula to drift apart.

import type { PackageRow } from "./db.js";
import { applyCapabilityCaveat } from "./capability-caveats.js";

export interface ScoreResult {
  total: number;
  security: number;
  maintenance: number;
  compatibility: number;
  community: number;
  supplyChain: number;
  reasons: string[];
}

function clamp(n: number, lo = 0, hi = 100): number {
  // NaN must never survive into a published score. It reaches here from
  // genuinely reachable inputs — an unparseable `time` field on a registry
  // document, or a corrupted/hand-edited store row — and JSON.stringify
  // turns NaN into null, so a caller sees "score: null" with no explanation
  // rather than an error. Treat non-finite as the worst case and move on.
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// Days since an ISO timestamp, with unparseable/missing values treated as
// "very old" rather than producing NaN.
//
// Rounded to whole days deliberately. Release recency only carries meaning at
// day granularity, but percentile ranking compares raw values — so at full
// millisecond precision two packages released a millisecond apart landed at
// opposite ends of the scale (rank 0 vs rank 100), and genuine ties in
// recency were impossible to express. Rounding makes equally-fresh packages
// actually compare equal.
const VERY_OLD_DAYS = 99_999;
function daysSince(iso: string | null): number {
  if (!iso) return VERY_OLD_DAYS;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return VERY_OLD_DAYS;
  return Math.round((Date.now() - t) / 86_400_000);
}

// Download counts are non-negative by definition; a negative value means the
// row is corrupt, and log10 of a negative is NaN.
function safeDownloads(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Maintenance is release recency and cadence only. Maintainer count used to
// be a third of it, and printed "single maintainer — bus-factor risk"
// whenever npm reported one or fewer.
//
// Measured against the corpus, that was wrong in both directions. Of 307
// recommendable packages, 106 have one maintainer — including zod
// (239M weekly downloads), axios (118M), date-fns (94M), jose (102M),
// hono (52M) and csv-parse (17M). The tool was recommending those packages
// and warning about them in the same breath, which is the same
// self-contradiction as flagging a package it puts forward. Median score by
// maintainer count is not even monotonic (1 -> 71.9, 2 -> 73.6, 3 -> 80.5,
// 4 -> 75.2, 5+ -> 75.9): noise, not signal.
//
// The root problem is that npm's `maintainers` field counts publish rights,
// not people. An organisation releasing through one CI account reports one;
// a project with two hundred GitHub contributors can report one. So "bus
// factor" was an inference the underlying data cannot support — the kind of
// unverified claim this project refuses to make anywhere else.
//
// The raw count is still returned in `npm.maintainers` for anyone who wants
// to weigh it. It is a fact; it just is not a verdict. Real bus-factor
// analysis needs contributor distribution from the repository host, which
// is a documented gap rather than something to approximate badly.
const MAINTENANCE_RECENCY_WEIGHT = 0.65;
const MAINTENANCE_CADENCE_WEIGHT = 0.35;

function securityScore(deprecated: boolean, vulnCount: number, securityCheckFailed: boolean, reasons: string[]): number {
  let s = 100;
  if (securityCheckFailed) {
    // The OSV check itself failed (network/rate-limit/outage) — this is NOT
    // the same as "checked and clean." Saying so outright rather than
    // silently falling back to a confident "no known vulnerabilities,"
    // which is exactly the failure mode that made a rate limit
    // indistinguishable from a real clean bill of health.
    s -= 20;
    reasons.push(
      vulnCount > 0
        ? `vulnerability check could not be freshly verified (OSV unreachable) — showing ${vulnCount} previously known vulnerabilit${vulnCount === 1 ? "y" : "ies"}, which may be out of date`
        : "vulnerability check could not be verified (OSV unreachable) — security status is unknown, not confirmed clean"
    );
  } else if (vulnCount > 0) {
    reasons.push(`${vulnCount} known vulnerabilit${vulnCount === 1 ? "y" : "ies"} affecting the current version`);
  } else {
    reasons.push("no known vulnerabilities affecting the current version");
  }
  if (vulnCount > 0) {
    s -= Math.min(vulnCount * 15, 60);
  }
  if (deprecated) {
    s -= 50;
    reasons.push("marked deprecated on npm");
  }
  return clamp(s);
}

function compatibilityScore(esm: boolean, ts: boolean, reasons: string[]): number {
  const s = clamp((esm ? 50 : 0) + (ts ? 50 : 0));
  if (esm) reasons.push("ships ESM");
  if (ts) reasons.push("ships TypeScript types");
  if (!esm && !ts) reasons.push("no ESM or bundled TS types detected");
  return s;
}

function supplyChainScore(depCount: number, hasInstallScripts: boolean, reasons: string[]): number {
  let s = 100 - depCount * 2;
  if (hasInstallScripts) {
    // The actual event-stream/ua-parser-js attack vector: arbitrary code
    // execution on `npm install`, before anyone's reviewed anything. This
    // matters far more than dependency count and is weighted accordingly.
    s -= 40;
    reasons.push("runs a preinstall/install/postinstall script — arbitrary code executes on npm install, review before trusting");
  }
  if (depCount === 0) reasons.push("zero direct dependencies");
  return clamp(s);
}

function percentileRanks(names: string[], values: Map<string, number>, higherIsBetter: boolean): Map<string, number> {
  const valueOf = (n: string) => {
    const v = values.get(n);
    return Number.isFinite(v) ? (v as number) : higherIsBetter ? -Infinity : Infinity;
  };

  const ordered = [...names].sort((a, b) => {
    const diff = valueOf(a) - valueOf(b);
    if (diff !== 0) return higherIsBetter ? diff : -diff;
    return a.localeCompare(b); // stable, so equal values order predictably
  });

  const ranks = new Map<string, number>();
  if (ordered.length === 0) return ranks;
  if (ordered.length === 1) {
    ranks.set(ordered[0], 100);
    return ranks;
  }

  // Ties must share a rank. Ranking purely by sort index gave packages with
  // *identical* metrics wildly different percentiles (three identical rows
  // scored 0/50/100), which made a package's score depend on the arbitrary
  // order its peers came out of the database.
  let i = 0;
  while (i < ordered.length) {
    let j = i;
    const v = valueOf(ordered[i]);
    while (j + 1 < ordered.length && valueOf(ordered[j + 1]) === v) j++;
    const pct = Math.round((((i + j) / 2) / (ordered.length - 1)) * 100);
    for (let k = i; k <= j; k++) ranks.set(ordered[k], pct);
    i = j + 1;
  }
  return ranks;
}

export function scoreCategoryGroup(rows: PackageRow[]): Map<string, ScoreResult> {
  const now = Date.now();
  const names = rows.map((r) => r.name);
  const byName = new Map(rows.map((r) => [r.name, r]));

  const downloadPct = percentileRanks(names, new Map(names.map((n) => [n, safeDownloads(byName.get(n)!.weekly_downloads)])), true);
  const cadencePct = percentileRanks(
    names,
    new Map(names.map((n) => [n, byName.get(n)!.release_cadence_days ?? 9999])),
    false
  );
  const recencyPct = percentileRanks(
    names,
    new Map(names.map((n) => [n, daysSince(byName.get(n)!.modified_at)])),
    false
  );

  const results = new Map<string, ScoreResult>();
  for (const r of rows) {
    const reasons: string[] = [];
    const security = securityScore(r.deprecated, r.vulnerability_ids.length, r.security_check_failed, reasons);

    const recency = recencyPct.get(r.name) ?? 50;
    const cadence = cadencePct.get(r.name) ?? 50;
    const maintenance = clamp(MAINTENANCE_RECENCY_WEIGHT * recency + MAINTENANCE_CADENCE_WEIGHT * cadence);
    if (recency < 25) reasons.push("no recent release relative to category peers");

    const compatibility = compatibilityScore(r.esm_support, r.typescript_support, reasons);
    const community = clamp(downloadPct.get(r.name) ?? 50);
    const supplyChain = supplyChainScore(r.dependencies_count, r.has_install_scripts, reasons);

    const rawTotal = 0.25 * security + 0.25 * maintenance + 0.2 * compatibility + 0.2 * community + 0.1 * supplyChain;
    const total = clamp(rawTotal - applyCapabilityCaveat(r.name, reasons));
    results.set(r.name, {
      total: Math.round(total * 10) / 10,
      security: Math.round(security),
      maintenance: Math.round(maintenance),
      compatibility: Math.round(compatibility),
      community: Math.round(community),
      supplyChain: Math.round(supplyChain),
      reasons,
    });
  }
  return results;
}

export function scoreAbsolute(r: PackageRow): ScoreResult {
  const reasons: string[] = [];
  const security = securityScore(r.deprecated, r.vulnerability_ids.length, r.security_check_failed, reasons);

  const daysSinceModified = daysSince(r.modified_at);
  const recency = clamp(100 - daysSinceModified / 5);
  const cadence = r.release_cadence_days === null ? 50 : clamp(100 - r.release_cadence_days / 10);
  const maintenance = clamp(MAINTENANCE_RECENCY_WEIGHT * recency + MAINTENANCE_CADENCE_WEIGHT * cadence);
  if (daysSinceModified > 500) reasons.push("no release in over a year");

  const compatibility = compatibilityScore(r.esm_support, r.typescript_support, reasons);
  const community = clamp(Math.log10(safeDownloads(r.weekly_downloads) + 1) * 14);
  if (r.downloads_check_failed) {
    // Same honesty rule as the OSV check: an unconfirmed number is reported
    // as unconfirmed rather than presented as a measurement.
    reasons.push("weekly download count could not be freshly verified (npm downloads API unreachable) — adoption figure may be stale");
  }
  const supplyChain = supplyChainScore(r.dependencies_count, r.has_install_scripts, reasons);

  const rawTotal = 0.25 * security + 0.25 * maintenance + 0.2 * compatibility + 0.2 * community + 0.1 * supplyChain;
  const total = clamp(rawTotal - applyCapabilityCaveat(r.name, reasons));
  return {
    total: Math.round(total * 10) / 10,
    security: Math.round(security),
    maintenance: Math.round(maintenance),
    compatibility: Math.round(compatibility),
    community: Math.round(community),
    supplyChain: Math.round(supplyChain),
    reasons,
  };
}
