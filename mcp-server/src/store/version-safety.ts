// Implements the "30-day cooldown" idea from the original product spec:
// prefer a version that's had time for the community/researchers to notice
// anything wrong with it, UNLESS a newer release fixes a real, VERIFIED
// vulnerability the older one has. The verification matters — recommending
// an upgrade on the assumption that "newer must have fixed it" without
// actually checking is exactly the kind of wrong claim that could steer
// someone into a false sense of security, so both versions' vulnerability
// status are queried directly (version-scoped OSV lookups), never inferred
// from recency alone.

import type { VersionEntry } from "../sources/npm.js";
import { queryVulnerabilities, type OsvLookup } from "../sources/osv.js";

const COOLDOWN_DAYS = 30;

export interface VersionGuidance {
  recommendedVersion: string;
  reason: string;
}

function daysAgo(iso: string, now: number): number {
  return Math.round((now - new Date(iso).getTime()) / 86_400_000);
}

// A semver prerelease carries a hyphenated tag after the version core
// (1.2.3-rc.1, 7.0.1-beta, 2.0.0-canary.4). These must never be offered as
// the "safer, more battle-tested" pick: packages with an active prerelease
// train (typescript, next, vite) publish them constantly, so the newest
// version past a 30-day window is frequently an rc — and recommending an rc
// over the latest stable is worse than making no recommendation at all.
const PRERELEASE = /^\d+\.\d+\.\d+[-+]/;
function isPrerelease(version: string): boolean {
  return PRERELEASE.test(version) || /[-+](alpha|beta|rc|canary|next|dev|pre|nightly|experimental|insiders)/i.test(version);
}

export async function resolveRecommendedVersion(
  name: string,
  latestVersion: string,
  versionHistory: VersionEntry[],
  latestVulnCheck: OsvLookup
): Promise<VersionGuidance> {
  const now = Date.now();
  const latestEntry = versionHistory.find((v) => v.version === latestVersion) ?? versionHistory[versionHistory.length - 1];

  if (!latestEntry) {
    return {
      recommendedVersion: latestVersion,
      reason: "No version history available to apply the 30-day cooldown check; showing the latest release as-is.",
    };
  }

  const latestAgeDays = daysAgo(latestEntry.releasedAt, now);
  if (latestAgeDays >= COOLDOWN_DAYS) {
    return {
      recommendedVersion: latestVersion,
      reason: `${latestVersion} was released ${latestAgeDays} days ago, past the ${COOLDOWN_DAYS}-day observation window — no cooldown concern.`,
    };
  }

  // Newest STABLE version that is at least COOLDOWN_DAYS old. Prereleases are
  // skipped: offering an rc as the battle-tested alternative to a stable
  // release inverts the whole point of the cooldown.
  let safeEntry: VersionEntry | undefined;
  for (let i = versionHistory.length - 1; i >= 0; i--) {
    const entry = versionHistory[i];
    if (isPrerelease(entry.version)) continue;
    if (daysAgo(entry.releasedAt, now) >= COOLDOWN_DAYS) {
      safeEntry = entry;
      break;
    }
  }

  if (!safeEntry) {
    return {
      recommendedVersion: latestVersion,
      reason: `${latestVersion} was released only ${latestAgeDays} day(s) ago, but this package has no stable version older than ${COOLDOWN_DAYS} days to fall back to — recommending the latest.`,
    };
  }

  // Tension: latest is fresh (<30d old), safeEntry is the cooldown-safe pick.
  // Verify both sides with real, version-scoped OSV data before deciding —
  // reuse the vulnerability check already done for latestVersion rather than
  // querying it twice.
  const safeCheck = await queryVulnerabilities(name, safeEntry.version);
  const safeAgeDays = daysAgo(safeEntry.releasedAt, now);

  if (!safeCheck.ok || !latestVulnCheck.ok) {
    return {
      recommendedVersion: safeEntry.version,
      reason: `Recommending ${safeEntry.version} (released ${safeAgeDays} days ago, past the ${COOLDOWN_DAYS}-day window) over the newer ${latestVersion} (only ${latestAgeDays} day(s) old) — could not verify whether ${latestVersion} actually fixes anything the older version doesn't (an OSV check failed), so defaulting to the cooldown-safe pick rather than assuming newer means safer.`,
    };
  }

  const safeVulnIds = new Set(safeCheck.vulnerabilityIds);
  const latestVulnIds = new Set(latestVulnCheck.vulnerabilityIds);
  const fixedByLatest = [...safeVulnIds].filter((id) => !latestVulnIds.has(id));

  if (safeVulnIds.size === 0) {
    return {
      recommendedVersion: safeEntry.version,
      reason: `Recommending ${safeEntry.version} (released ${safeAgeDays} days ago, past the ${COOLDOWN_DAYS}-day observation window) over the newer ${latestVersion} (only ${latestAgeDays} day(s) old) — OSV confirms no known vulnerabilities affect ${safeEntry.version}, so there's no reason to run something less battle-tested yet.`,
    };
  }

  if (fixedByLatest.length > 0 && latestVulnIds.size === 0) {
    return {
      recommendedVersion: latestVersion,
      reason: `Recommending the newer ${latestVersion} (released ${latestAgeDays} day(s) ago, inside the normal ${COOLDOWN_DAYS}-day cooldown window) over ${safeEntry.version} — OSV confirms ${safeEntry.version} is affected by ${fixedByLatest.join(", ")} and ${latestVersion} is not, verified via version-scoped lookups on both versions, not assumed from recency alone.`,
    };
  }

  if (fixedByLatest.length > 0) {
    const winner = latestVulnIds.size < safeVulnIds.size ? latestVersion : safeEntry.version;
    return {
      recommendedVersion: winner,
      reason: `Both ${safeEntry.version} and ${latestVersion} have known vulnerabilities (${safeVulnIds.size} vs. ${latestVulnIds.size}) — recommending whichever has fewer, but neither is clean; verify manually before relying on this.`,
    };
  }

  return {
    recommendedVersion: safeEntry.version,
    reason: `${safeEntry.version} (released ${safeAgeDays} days ago) has ${safeVulnIds.size} known vulnerabilit${safeVulnIds.size === 1 ? "y" : "ies"} that the newer ${latestVersion} doesn't appear to fix — defaulting to the cooldown-safe pick since moving to the fresher, less battle-tested release wouldn't resolve it anyway.`,
  };
}
