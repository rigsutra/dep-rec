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
  return Math.max(lo, Math.min(hi, n));
}

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
  const ordered = [...names].sort((a, b) => {
    const diff = (values.get(a) ?? 0) - (values.get(b) ?? 0);
    return higherIsBetter ? diff : -diff;
  });
  const ranks = new Map<string, number>();
  ordered.forEach((name, i) => {
    ranks.set(name, ordered.length <= 1 ? 100 : Math.round((i / (ordered.length - 1)) * 100));
  });
  return ranks;
}

export function scoreCategoryGroup(rows: PackageRow[]): Map<string, ScoreResult> {
  const now = Date.now();
  const names = rows.map((r) => r.name);
  const byName = new Map(rows.map((r) => [r.name, r]));

  const downloadPct = percentileRanks(names, new Map(names.map((n) => [n, byName.get(n)!.weekly_downloads])), true);
  const cadencePct = percentileRanks(
    names,
    new Map(names.map((n) => [n, byName.get(n)!.release_cadence_days ?? 9999])),
    false
  );
  const maintainerPct = percentileRanks(names, new Map(names.map((n) => [n, byName.get(n)!.maintainers])), true);
  const recencyPct = percentileRanks(
    names,
    new Map(
      names.map((n) => {
        const r = byName.get(n)!;
        const days = r.modified_at ? (now - new Date(r.modified_at).getTime()) / 86_400_000 : 99999;
        return [n, days];
      })
    ),
    false
  );

  const results = new Map<string, ScoreResult>();
  for (const r of rows) {
    const reasons: string[] = [];
    const security = securityScore(r.deprecated, r.vulnerability_ids.length, r.security_check_failed, reasons);

    const recency = recencyPct.get(r.name) ?? 50;
    const cadence = cadencePct.get(r.name) ?? 50;
    const maint = maintainerPct.get(r.name) ?? 50;
    const maintenance = clamp(0.5 * recency + 0.25 * cadence + 0.25 * maint);
    if (recency < 25) reasons.push("no recent release relative to category peers");
    if (r.maintainers <= 1) reasons.push("single maintainer — bus-factor risk");

    const compatibility = compatibilityScore(r.esm_support, r.typescript_support, reasons);
    const community = clamp(downloadPct.get(r.name) ?? 50);
    const supplyChain = supplyChainScore(r.dependencies_count, r.has_install_scripts, reasons);

    const total = 0.25 * security + 0.25 * maintenance + 0.2 * compatibility + 0.2 * community + 0.1 * supplyChain;
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

  const daysSinceModified = r.modified_at ? (Date.now() - new Date(r.modified_at).getTime()) / 86_400_000 : 99999;
  const recency = clamp(100 - daysSinceModified / 5);
  const cadence = r.release_cadence_days === null ? 50 : clamp(100 - r.release_cadence_days / 10);
  const maintainerAbs = clamp(30 + r.maintainers * 25);
  const maintenance = clamp(0.5 * recency + 0.25 * cadence + 0.25 * maintainerAbs);
  if (daysSinceModified > 500) reasons.push("no release in over a year");
  if (r.maintainers <= 1) reasons.push("single maintainer — bus-factor risk");

  const compatibility = compatibilityScore(r.esm_support, r.typescript_support, reasons);
  const community = clamp(Math.log10(r.weekly_downloads + 1) * 14);
  const supplyChain = supplyChainScore(r.dependencies_count, r.has_install_scripts, reasons);

  const total = 0.25 * security + 0.25 * maintenance + 0.2 * compatibility + 0.2 * community + 0.1 * supplyChain;
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
