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

export const COOLDOWN_DAYS = 30;

export interface VersionGuidance {
  recommendedVersion: string;
  reason: string;
}

function daysAgo(iso: string, now: number): number {
  return Math.round((now - new Date(iso).getTime()) / 86_400_000);
}

// Numeric-core semver comparison. Prereleases are filtered out before any
// comparison happens, so the full prerelease-precedence rules aren't needed —
// only major.minor.patch. An unparseable segment counts as 0 rather than NaN:
// a malformed version should sort low, not poison every comparison it takes
// part in (NaN comparisons are all false, which would make the "highest"
// search silently return whichever entry it happened to start with).
function versionCore(version: string): [number, number, number] {
  const parts = version.split(".");
  const at = (i: number): number => {
    const parsed = Number.parseInt(parts[i] ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [at(0), at(1), at(2)];
}

export function compareVersions(a: string, b: string): number {
  const ca = versionCore(a);
  const cb = versionCore(b);
  for (let i = 0; i < 3; i++) {
    if (ca[i] !== cb[i]) return ca[i] < cb[i] ? -1 : 1;
  }
  return 0;
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

  // Highest STABLE version that is at least COOLDOWN_DAYS old.
  //
  // "Highest", not "most recently published". versionHistory is ordered by
  // publish time, and this used to walk it backwards and take the first
  // eligible entry — which is wrong whenever a project backports to an older
  // line after shipping a newer one, a completely ordinary release pattern.
  // Measured against the 499-package corpus, 3 of the 141 packages inside the
  // cooldown window picked the wrong version that way, and undici was severe:
  // publish order chose 6.27.0 (a backport published after 8.x shipped) when
  // 8.5.0 was both semver-newer AND past the window. Recommending a
  // two-major downgrade as the "safer" option is worse than not answering.
  //
  // Prereleases are skipped: offering an rc as the battle-tested alternative
  // to a stable release inverts the whole point of the cooldown.
  //
  // Nothing above `latestVersion` is eligible either. A version can sit in
  // history above the current dist-tag when a maintainer rolls `latest` back
  // to a supported line; that pointer is their deliberate choice about what
  // to install, and quietly overriding it is not this function's call.
  let safeEntry: VersionEntry | undefined;
  for (const entry of versionHistory) {
    if (isPrerelease(entry.version)) continue;
    if (daysAgo(entry.releasedAt, now) < COOLDOWN_DAYS) continue;
    if (compareVersions(entry.version, latestVersion) > 0) continue;
    if (!safeEntry || compareVersions(entry.version, safeEntry.version) > 0) safeEntry = entry;
  }

  if (!safeEntry) {
    return {
      recommendedVersion: latestVersion,
      reason: `${latestVersion} was released only ${latestAgeDays} day(s) ago, but this package has no stable version older than ${COOLDOWN_DAYS} days to fall back to — recommending the latest.`,
    };
  }

  // Every remaining branch can hand back something older than `latest`, so
  // they all go through here rather than each remembering to check.
  //
  // Measured on the 499-package corpus: of the 141 packages whose latest was
  // inside the cooldown window, 11 (7.8%) had their cooldown-safe pick on an
  // older MAJOR — @turnkey/http 5.0.0 -> 4.1.1, better-sqlite3 13.0.1 ->
  // 12.11.1, @expressots/core 4.0.0 -> 3.0.0. That is a different API, not
  // merely an older build, and a bare version number gives no hint of it. A
  // caller reading v5 documentation while installing v4 is a worse outcome
  // than the fresh-release risk the cooldown exists to avoid, so the trade is
  // stated instead of being made silently on their behalf.
  const decide = (version: string, reason: string): VersionGuidance => {
    if (versionCore(version)[0] >= versionCore(latestVersion)[0]) return { recommendedVersion: version, reason };
    return {
      recommendedVersion: version,
      reason:
        `${reason} CAUTION: ${version} is a major version behind ${latestVersion}, so it is a different API — not just ` +
        `an older build. If you are writing code against ${latestVersion}'s documentation, install ${latestVersion} ` +
        `and accept that it is only ${latestAgeDays} day(s) old rather than pinning ${version}.`,
    };
  };

  // Tension: latest is fresh (<30d old), safeEntry is the cooldown-safe pick.
  // Verify both sides with real, version-scoped OSV data before deciding —
  // reuse the vulnerability check already done for latestVersion rather than
  // querying it twice.
  const safeCheck = await queryVulnerabilities(name, safeEntry.version);
  const safeAgeDays = daysAgo(safeEntry.releasedAt, now);

  if (!safeCheck.ok || !latestVulnCheck.ok) {
    return decide(
      safeEntry.version,
      `Recommending ${safeEntry.version} (released ${safeAgeDays} days ago, past the ${COOLDOWN_DAYS}-day window) over the newer ${latestVersion} (only ${latestAgeDays} day(s) old) — could not verify whether ${latestVersion} actually fixes anything the older version doesn't (an OSV check failed), so defaulting to the cooldown-safe pick rather than assuming newer means safer.`
    );
  }

  const safeVulnIds = new Set(safeCheck.vulnerabilityIds);
  const latestVulnIds = new Set(latestVulnCheck.vulnerabilityIds);
  const fixedByLatest = [...safeVulnIds].filter((id) => !latestVulnIds.has(id));

  if (safeVulnIds.size === 0) {
    return decide(
      safeEntry.version,
      `Recommending ${safeEntry.version} (released ${safeAgeDays} days ago, past the ${COOLDOWN_DAYS}-day observation window) over the newer ${latestVersion} (only ${latestAgeDays} day(s) old) — OSV confirms no known vulnerabilities affect ${safeEntry.version}, so there's no reason to run something less battle-tested yet.`
    );
  }

  if (fixedByLatest.length > 0 && latestVulnIds.size === 0) {
    return {
      recommendedVersion: latestVersion,
      reason: `Recommending the newer ${latestVersion} (released ${latestAgeDays} day(s) ago, inside the normal ${COOLDOWN_DAYS}-day cooldown window) over ${safeEntry.version} — OSV confirms ${safeEntry.version} is affected by ${fixedByLatest.join(", ")} and ${latestVersion} is not, verified via version-scoped lookups on both versions, not assumed from recency alone.`,
    };
  }

  if (fixedByLatest.length > 0) {
    const winner = latestVulnIds.size < safeVulnIds.size ? latestVersion : safeEntry.version;
    return decide(
      winner,
      `Both ${safeEntry.version} and ${latestVersion} have known vulnerabilities (${safeVulnIds.size} vs. ${latestVulnIds.size}) — recommending whichever has fewer, but neither is clean; verify manually before relying on this.`
    );
  }

  return decide(
    safeEntry.version,
    `${safeEntry.version} (released ${safeAgeDays} days ago) has ${safeVulnIds.size} known vulnerabilit${safeVulnIds.size === 1 ? "y" : "ies"} that the newer ${latestVersion} doesn't appear to fix — defaulting to the cooldown-safe pick since moving to the fresher, less battle-tested release wouldn't resolve it anyway.`
  );
}
