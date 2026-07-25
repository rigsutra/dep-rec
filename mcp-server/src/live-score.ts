// Scores a single arbitrary package on an ABSOLUTE scale — deliberately
// different from stage1-collector/src/score.ts, which ranks packages as
// percentiles against category peers. There is no peer group for an
// ad-hoc "check this one package" lookup, so downloads/recency/maintainer
// count are scored against fixed reference curves instead of relative
// rank. Same weight split as the category scorer (security 25% /
// maintenance 25% / compatibility 20% / community 20% / supply chain 10%)
// so the two numbers stay roughly comparable, but treat this as a rougher,
// context-free estimate — a package that looks mediocre here might be the
// clear best choice once compared against its actual real competitors via
// recommend_package instead.

import type { RegistryDoc } from "./sources/npm.js";

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface LiveScoreInput {
  doc: RegistryDoc;
  weeklyDownloads: number;
  vulnerabilityIds: string[];
}

export interface LiveScore {
  total: number;
  security: number;
  maintenance: number;
  compatibility: number;
  community: number;
  supplyChain: number;
  reasons: string[];
}

export function scorePackageAbsolute({ doc, weeklyDownloads, vulnerabilityIds }: LiveScoreInput): LiveScore {
  const reasons: string[] = [];

  let security = 100;
  if (vulnerabilityIds.length > 0) {
    security -= Math.min(vulnerabilityIds.length * 15, 60);
    reasons.push(`${vulnerabilityIds.length} known vulnerabilit${vulnerabilityIds.length === 1 ? "y" : "ies"} affecting the current version (${vulnerabilityIds.join(", ")})`);
  } else {
    reasons.push("no known vulnerabilities affecting the current version");
  }
  if (doc.deprecated) {
    security -= 50;
    reasons.push("marked deprecated on npm");
  }
  security = clamp(security);

  const daysSinceModified = doc.modifiedAt ? (Date.now() - new Date(doc.modifiedAt).getTime()) / 86_400_000 : 99999;
  const recency = clamp(100 - daysSinceModified / 5);
  const cadence = doc.releaseCadenceDays === null ? 50 : clamp(100 - doc.releaseCadenceDays / 10);
  const maintainerAbs = clamp(30 + doc.maintainersCount * 25);
  const maintenance = clamp(0.5 * recency + 0.25 * cadence + 0.25 * maintainerAbs);
  if (daysSinceModified > 500) reasons.push("no release in over a year");
  if (doc.maintainersCount <= 1) reasons.push("single maintainer — bus-factor risk");

  const compatibility = clamp((doc.esmSupport ? 50 : 0) + (doc.typescriptSupport ? 50 : 0));
  if (doc.esmSupport) reasons.push("ships ESM");
  if (doc.typescriptSupport) reasons.push("ships TypeScript types");
  if (!doc.esmSupport && !doc.typescriptSupport) reasons.push("no ESM or bundled TS types detected");

  // absolute log-scale popularity curve, since there's no peer group to
  // rank against for an arbitrary one-off lookup
  const community = clamp(Math.log10(weeklyDownloads + 1) * 14);

  const supplyChain = clamp(100 - doc.dependenciesCount * 2);
  if (doc.dependenciesCount === 0) reasons.push("zero direct dependencies");

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
