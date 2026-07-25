// Proof 2 — deterministic scoring rubric applied to the Proof 1 dataset.
//
// Every sub-score is computed from data we actually collected — nothing
// here is a guess or an LLM opinion. Two axes from the original rubric
// (GitHub-derived maintenance signals, deps.dev transitive dependency
// health) aren't wired in yet, so this v1 rubric is honestly reshaped
// around what's real today rather than padded with placeholders:
//
//   Security       25%  known vulnerabilities (OSV) + deprecated flag
//   Maintenance    25%  release recency + release cadence + maintainer count
//   Compatibility  20%  ESM support + TypeScript support
//                       (Edge Runtime fit — Proof 0 — not yet merged in;
//                       see the caveat in the recommend tool later on)
//   Community      20%  weekly downloads, ranked against peers in the
//                       same category (50M downloads means something
//                       different for an HTTP client than a CSV parser)
//   Supply chain   10%  direct dependency count, absolute (not ranked
//                       against category peers — a framework legitimately
//                       needs more direct deps than a single-purpose
//                       utility, so comparing it only to same-category
//                       peers zero-sums it against packages doing a
//                       fundamentally smaller job; see score.ts note below)
//
// Community and Maintenance-recency are ranked as percentiles *within each
// package's category* rather than against the whole dataset, since
// "popular" only means something relative to direct competitors.

import { readFile, writeFile } from "node:fs/promises";

interface PackageRecord {
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

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

async function main() {
  const now = Date.now();
  const records: PackageRecord[] = JSON.parse(await readFile(new URL("../data/packages.json", import.meta.url), "utf8"));

  // group package names by category for within-category percentile ranking
  const byCategory = new Map<string, string[]>();
  for (const r of records) {
    for (const cat of r.categories) {
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(r.name);
    }
  }

  const byName = new Map(records.map((r) => [r.name, r]));

  // one percentile map per category per metric
  const downloadPercentiles = new Map<string, Map<string, number>>();
  const cadencePercentiles = new Map<string, Map<string, number>>();
  const maintainerPercentiles = new Map<string, Map<string, number>>();
  const recencyPercentiles = new Map<string, Map<string, number>>();

  for (const [cat, names] of byCategory) {
    downloadPercentiles.set(cat, percentileRanks(names, new Map(names.map((n) => [n, byName.get(n)!.downloads.weekly])), true));
    cadencePercentiles.set(
      cat,
      percentileRanks(names, new Map(names.map((n) => [n, byName.get(n)!.compatibility.releaseCadenceDays ?? 9999])), false)
    );
    maintainerPercentiles.set(cat, percentileRanks(names, new Map(names.map((n) => [n, byName.get(n)!.npm.maintainers])), true));
    recencyPercentiles.set(
      cat,
      percentileRanks(
        names,
        new Map(
          names.map((n) => {
            const modified = byName.get(n)!.npm.modifiedAt;
            const daysSince = modified ? (now - new Date(modified).getTime()) / 86_400_000 : 99999;
            return [n, daysSince];
          })
        ),
        false
      )
    );
  }

  function avgAcrossCategories(percentiles: Map<string, Map<string, number>>, name: string, categories: string[]): number {
    const vals = categories.map((c) => percentiles.get(c)?.get(name) ?? 50);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  const scored = records.map((r) => {
    const reasons: string[] = [];

    // Security — starts at 100, penalized per known vuln and for deprecation
    let security = 100;
    if (r.security.knownVulnerabilities > 0) {
      security -= Math.min(r.security.knownVulnerabilities * 15, 60);
      reasons.push(`${r.security.knownVulnerabilities} known vulnerabilit${r.security.knownVulnerabilities === 1 ? "y" : "ies"} on record`);
    } else {
      reasons.push("no known vulnerabilities on record");
    }
    if (r.npm.deprecated) {
      security -= 50;
      reasons.push("marked deprecated on npm");
    }
    security = clamp(security);

    // Maintenance — recency + cadence + maintainer count, within-category
    const recency = avgAcrossCategories(recencyPercentiles, r.name, r.categories);
    const cadence = avgAcrossCategories(cadencePercentiles, r.name, r.categories);
    const maintainerPct = avgAcrossCategories(maintainerPercentiles, r.name, r.categories);
    const maintenance = clamp(0.5 * recency + 0.25 * cadence + 0.25 * maintainerPct);
    if (recency < 25) reasons.push("no recent release relative to category peers");
    if (r.npm.maintainers <= 1) reasons.push("single maintainer — bus-factor risk");

    // Compatibility — ESM + TS support (edge fit not merged in yet)
    const compatibility = clamp((r.compatibility.esmSupport ? 50 : 0) + (r.compatibility.typescriptSupport ? 50 : 0));
    if (r.compatibility.esmSupport) reasons.push("ships ESM");
    if (r.compatibility.typescriptSupport) reasons.push("ships TypeScript types");
    if (!r.compatibility.esmSupport && !r.compatibility.typescriptSupport) reasons.push("no ESM or bundled TS types detected");

    // Community — weekly downloads, ranked against category peers
    const community = clamp(avgAcrossCategories(downloadPercentiles, r.name, r.categories));

    // Supply chain — absolute curve on direct dependency count, not ranked
    // against category peers. A web framework legitimately needs more direct
    // dependencies than a single-purpose date formatter; comparing them only
    // to same-category rivals would zero-sum every framework's score down
    // regardless of whether those dependencies are actually a problem.
    // Rough proxy either way — real supply-chain health needs the
    // transitive graph from deps.dev, not wired in yet.
    const supplyChain = clamp(100 - r.npm.dependenciesCount * 2);
    if (r.npm.dependenciesCount === 0) reasons.push("zero direct dependencies");

    const total =
      0.25 * security + 0.25 * maintenance + 0.2 * compatibility + 0.2 * community + 0.1 * supplyChain;

    return {
      ...r,
      scoring: {
        total: Math.round(total * 10) / 10,
        security: Math.round(security),
        maintenance: Math.round(maintenance),
        compatibility: Math.round(compatibility),
        community: Math.round(community),
        supplyChain: Math.round(supplyChain),
        reasons,
      },
    };
  });

  await writeFile(new URL("../data/scored.json", import.meta.url), JSON.stringify(scored, null, 2));

  console.log("Leaderboards (top 5 by total score) — manual sanity check per Proof 2:\n");
  for (const [cat, names] of byCategory) {
    const top = names
      .map((n) => scored.find((s) => s.name === n)!)
      .sort((a, b) => b.scoring.total - a.scoring.total)
      .slice(0, 5);
    console.log(`## ${cat}`);
    for (const p of top) {
      console.log(`  ${p.scoring.total.toFixed(1)}  ${p.name}  (sec ${p.scoring.security} / maint ${p.scoring.maintenance} / compat ${p.scoring.compatibility} / community ${p.scoring.community} / supply ${p.scoring.supplyChain})`);
    }
    console.log();
  }

  console.log(`Wrote ${scored.length} scored records to data/scored.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
