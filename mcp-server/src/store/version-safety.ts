// Implements the "30-day cooldown" idea from the original product spec:
// prefer a version that's had time for the community/researchers to notice
// anything wrong with it, UNLESS a newer release fixes a real, VERIFIED
// vulnerability the older one has. The verification matters — recommending
// an upgrade on the assumption that "newer must have fixed it" without
// actually checking is exactly the kind of wrong claim that could steer
// someone into a false sense of security, so both versions' vulnerability
// status are queried directly (version-scoped OSV lookups), never inferred
// from recency alone.
//
// The window is measured against *today*, not against the day the data was
// collected. That distinction is the reason this module is split the way it
// is. The answer used to be resolved once, rendered to prose, and stored —
// so a row written when 7.3.0 was three days old kept saying "only 3 day(s)
// old" and kept recommending 7.1.5 forever, long after 7.3.0 had cleared the
// window on its own. Storing a rendered sentence freezes the clock inside it.
//
// So what gets stored is the *decision* (which version, on what basis, with
// which candidates and their release dates) and the prose is composed on
// every read from that decision plus the current date. One prose
// implementation, used at write time and read time alike, and no stored
// sentence can go stale.

import type { VersionEntry } from "../sources/npm.js";
import { queryVulnerabilities, type OsvLookup } from "../sources/osv.js";

export const COOLDOWN_DAYS = 30;

/**
 * Why a particular version was chosen. Stored instead of the sentence, so the
 * sentence can be regenerated with today's numbers.
 */
export type GuidanceBasis =
  | "past-window"
  | "no-history"
  | "no-fallback"
  | "clean"
  | "unverified"
  | "latest-fixes"
  | "both-vulnerable"
  | "pick-vulnerable-anyway"
  | "aged-in";

export interface VersionDecision {
  /** The version chosen when the decision was made. */
  pick: string;
  latest: string;
  latestReleasedAt: string | null;
  basis: GuidanceBasis;
  /** The version that lost, when the basis refers to one. */
  alternative: string | null;
  /** Basis-specific extra (vulnerability IDs, counts). */
  detail: string | null;
  /**
   * Stable releases that could become the answer as they age, newest-relevant
   * first, as [version, releasedAt]. Anything already older than the window at
   * write time can never change the outcome except by being the answer, so
   * only the pick and everything above it is kept.
   */
  entries: Array<[string, string]>;
}

export interface VersionGuidance {
  recommendedVersion: string;
  reason: string;
  /** Persist this; pass it back to `guidanceAsOf` on read. */
  decision: VersionDecision;
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

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

interface ProseInput {
  basis: GuidanceBasis;
  pick: string;
  latest: string;
  alternative: string | null;
  detail: string | null;
  pickAgeDays: number | null;
  latestAgeDays: number | null;
}

function composeReason(o: ProseInput): string {
  const { pick, latest, alternative, detail, pickAgeDays, latestAgeDays } = o;
  const olderThan = `past the ${COOLDOWN_DAYS}-day observation window`;

  switch (o.basis) {
    case "past-window":
      return `${latest} was released ${latestAgeDays} days ago, ${olderThan} — no cooldown concern.`;

    case "no-history":
      return `No version history available to apply the ${COOLDOWN_DAYS}-day cooldown check; showing the latest release as-is.`;

    case "no-fallback":
      return `${latest} was released only ${latestAgeDays} day(s) ago, but this package has no stable version older than ${COOLDOWN_DAYS} days to fall back to — recommending the latest.`;

    case "clean":
      return (
        `Recommending ${pick} (released ${pickAgeDays} days ago, ${olderThan}) over the newer ${latest} ` +
        `(only ${latestAgeDays} day(s) old) — OSV confirms no known vulnerabilities affect ${pick}, so there's no ` +
        `reason to run something less battle-tested yet.`
      );

    case "unverified":
      return (
        `Recommending ${pick} (released ${pickAgeDays} days ago, ${olderThan}) over the newer ${latest} ` +
        `(only ${latestAgeDays} day(s) old) — could not verify whether ${latest} actually fixes anything the older ` +
        `version doesn't (an OSV check failed), so defaulting to the cooldown-safe pick rather than assuming newer ` +
        `means safer.`
      );

    case "latest-fixes":
      return (
        `Recommending the newer ${latest} (released ${latestAgeDays} day(s) ago, inside the normal ` +
        `${COOLDOWN_DAYS}-day cooldown window) over ${alternative} — OSV confirms ${alternative} is affected by ` +
        `${detail} and ${latest} is not, verified via version-scoped lookups on both versions, not assumed from ` +
        `recency alone.`
      );

    case "both-vulnerable":
      return (
        `Both ${alternative} and ${latest} have known vulnerabilities (${detail}) — recommending whichever has ` +
        `fewer, but neither is clean; verify manually before relying on this.`
      );

    case "pick-vulnerable-anyway":
      return (
        `${pick} (released ${pickAgeDays} days ago) has ${detail} that the newer ${latest} doesn't appear to fix — ` +
        `defaulting to the cooldown-safe pick since moving to the fresher, less battle-tested release wouldn't ` +
        `resolve it anyway.`
      );

    // Reached only on a read: this version was still inside the window when
    // the package was last refreshed and has cleared it since. Saying so is
    // the honest option — the OSV lookup that backs the other branches was
    // never run against this version.
    case "aged-in":
      return (
        `Recommending ${pick} (released ${pickAgeDays} days ago, ${olderThan}) over the newer ${latest} ` +
        `(only ${latestAgeDays} day(s) old). ${pick} cleared the window after this package's data was last ` +
        `refreshed, so its vulnerability status was not checked at that time — re-run check_package on it if that ` +
        `matters to you.`
      );
  }
}

// Applied to every result that can hand back something older than `latest`.
//
// Measured on the 499-package corpus: of the 141 packages whose latest was
// inside the cooldown window, 11 (7.8%) had their cooldown-safe pick on an
// older MAJOR — @turnkey/http 5.0.0 -> 4.1.1, better-sqlite3 13.0.1 ->
// 12.11.1, @expressots/core 4.0.0 -> 3.0.0. That is a different API, not
// merely an older build, and a bare version number gives no hint of it. A
// caller reading v5 documentation while installing v4 is a worse outcome than
// the fresh-release risk the cooldown exists to avoid, so the trade is stated
// instead of being made silently on their behalf.
function withMajorCaution(pick: string, latest: string, latestAgeDays: number | null, reason: string): string {
  if (versionCore(pick)[0] >= versionCore(latest)[0]) return reason;
  return (
    `${reason} CAUTION: ${pick} is a major version behind ${latest}, so it is a different API — not just an older ` +
    `build. If you are writing code against ${latest}'s documentation, install ${latest} and accept that it is only ` +
    `${latestAgeDays} day(s) old rather than pinning ${pick}.`
  );
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Highest STABLE version at least COOLDOWN_DAYS old, never above `latest`.
 *
 * "Highest", not "most recently published". Version history arrives ordered by
 * publish time, and this used to walk it backwards and take the first eligible
 * entry — which is wrong whenever a project backports to an older line after
 * shipping a newer one, a completely ordinary release pattern. Measured across
 * the 499-package corpus, 3 of the 141 packages inside the cooldown window
 * picked the wrong version that way, and undici was severe: publish order
 * chose 6.27.0 (a backport released after 8.x shipped) when 8.5.0 was both
 * semver-newer AND past the window. Recommending a two-major downgrade as the
 * "safer" option is worse than not answering.
 *
 * Nothing above `latest` is eligible either. A version can sit in history above
 * the current dist-tag when a maintainer rolls `latest` back to a supported
 * line; that pointer is their deliberate choice about what to install, and
 * quietly overriding it is not this function's call.
 */
function highestEligible(
  entries: Array<{ version: string; releasedAt: string }>,
  latest: string,
  now: number
): { version: string; releasedAt: string } | undefined {
  let best: { version: string; releasedAt: string } | undefined;
  for (const entry of entries) {
    if (isPrerelease(entry.version)) continue;
    if (daysAgo(entry.releasedAt, now) < COOLDOWN_DAYS) continue;
    if (compareVersions(entry.version, latest) > 0) continue;
    if (!best || compareVersions(entry.version, best.version) > 0) best = entry;
  }
  return best;
}

// Everything from the chosen version upward, which is exactly the set that can
// change the answer later: versions below the pick are already eligible and
// already lost on semver, so ageing changes nothing about them. Capped because
// a package can publish hundreds of releases inside a month and the whole set
// would otherwise land in the shipped corpus.
const MAX_STORED_ENTRIES = 40;

function timelineFrom(history: VersionEntry[], pick: string, latest: string): Array<[string, string]> {
  return history
    .filter((e) => !isPrerelease(e.version))
    .filter((e) => compareVersions(e.version, pick) >= 0 && compareVersions(e.version, latest) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version))
    .slice(-MAX_STORED_ENTRIES)
    .map((e) => [e.version, e.releasedAt] as [string, string]);
}

// ---------------------------------------------------------------------------
// Write-time resolution
// ---------------------------------------------------------------------------

export async function resolveRecommendedVersion(
  name: string,
  latestVersion: string,
  versionHistory: VersionEntry[],
  latestVulnCheck: OsvLookup
): Promise<VersionGuidance> {
  const now = Date.now();
  const latestEntry = versionHistory.find((v) => v.version === latestVersion) ?? versionHistory[versionHistory.length - 1];

  const finish = (
    basis: GuidanceBasis,
    pick: string,
    opts: { alternative?: string | null; detail?: string | null; pickReleasedAt?: string | null } = {}
  ): VersionGuidance => {
    const latestAgeDays = latestEntry ? daysAgo(latestEntry.releasedAt, now) : null;
    const pickAgeDays = opts.pickReleasedAt ? daysAgo(opts.pickReleasedAt, now) : latestAgeDays;
    const reason = composeReason({
      basis,
      pick,
      latest: latestVersion,
      alternative: opts.alternative ?? null,
      detail: opts.detail ?? null,
      pickAgeDays,
      latestAgeDays,
    });
    return {
      recommendedVersion: pick,
      reason: withMajorCaution(pick, latestVersion, latestAgeDays, reason),
      decision: {
        pick,
        latest: latestVersion,
        latestReleasedAt: latestEntry?.releasedAt ?? null,
        basis,
        alternative: opts.alternative ?? null,
        detail: opts.detail ?? null,
        entries: timelineFrom(versionHistory, pick, latestVersion),
      },
    };
  };

  if (!latestEntry) return finish("no-history", latestVersion);

  if (daysAgo(latestEntry.releasedAt, now) >= COOLDOWN_DAYS) {
    return finish("past-window", latestVersion, { pickReleasedAt: latestEntry.releasedAt });
  }

  const safeEntry = highestEligible(versionHistory, latestVersion, now);
  if (!safeEntry) return finish("no-fallback", latestVersion, { pickReleasedAt: latestEntry.releasedAt });

  // Tension: latest is fresh (<30d old), safeEntry is the cooldown-safe pick.
  // Verify both sides with real, version-scoped OSV data before deciding —
  // reuse the vulnerability check already done for latestVersion rather than
  // querying it twice.
  const safeCheck = await queryVulnerabilities(name, safeEntry.version);

  if (!safeCheck.ok || !latestVulnCheck.ok) {
    return finish("unverified", safeEntry.version, { alternative: latestVersion, pickReleasedAt: safeEntry.releasedAt });
  }

  const safeVulnIds = new Set(safeCheck.vulnerabilityIds);
  const latestVulnIds = new Set(latestVulnCheck.vulnerabilityIds);
  const fixedByLatest = [...safeVulnIds].filter((id) => !latestVulnIds.has(id));

  if (safeVulnIds.size === 0) {
    return finish("clean", safeEntry.version, { alternative: latestVersion, pickReleasedAt: safeEntry.releasedAt });
  }

  if (fixedByLatest.length > 0 && latestVulnIds.size === 0) {
    return finish("latest-fixes", latestVersion, {
      alternative: safeEntry.version,
      detail: fixedByLatest.join(", "),
      pickReleasedAt: latestEntry.releasedAt,
    });
  }

  if (fixedByLatest.length > 0) {
    const latestWins = latestVulnIds.size < safeVulnIds.size;
    return finish("both-vulnerable", latestWins ? latestVersion : safeEntry.version, {
      alternative: safeEntry.version,
      detail: `${safeVulnIds.size} vs. ${latestVulnIds.size}`,
      pickReleasedAt: latestWins ? latestEntry.releasedAt : safeEntry.releasedAt,
    });
  }

  const count = safeVulnIds.size;
  return finish("pick-vulnerable-anyway", safeEntry.version, {
    alternative: latestVersion,
    detail: `${count} known vulnerabilit${count === 1 ? "y" : "ies"}`,
    pickReleasedAt: safeEntry.releasedAt,
  });
}

// ---------------------------------------------------------------------------
// Read-time re-evaluation
// ---------------------------------------------------------------------------

export function parseDecision(raw: string | null): VersionDecision | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as VersionDecision;
    if (typeof d?.pick !== "string" || typeof d?.latest !== "string") return null;
    if (!Array.isArray(d.entries)) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Re-decides the cooldown against `now`, offline, from a stored decision.
 *
 * This is what makes the window mean "30 days before today" rather than "30
 * days before whenever this row was last refreshed". A curated package is
 * served from the store without a freshness check, so without this a shipped
 * corpus would keep recommending an older version months after the release it
 * was holding back from had itself aged past the window.
 */
export function guidanceAsOf(
  decision: VersionDecision,
  now: number = Date.now()
): { recommendedVersion: string; reason: string } {
  const { latest, latestReleasedAt } = decision;

  const render = (basis: GuidanceBasis, pick: string, pickReleasedAt: string | null, alternative: string | null): {
    recommendedVersion: string;
    reason: string;
  } => {
    const latestAgeDays = latestReleasedAt ? daysAgo(latestReleasedAt, now) : null;
    const reason = composeReason({
      basis,
      pick,
      latest,
      alternative,
      detail: decision.detail,
      pickAgeDays: pickReleasedAt ? daysAgo(pickReleasedAt, now) : latestAgeDays,
      latestAgeDays,
    });
    return { recommendedVersion: pick, reason: withMajorCaution(pick, latest, latestAgeDays, reason) };
  };

  const releasedAtOf = (version: string): string | null =>
    decision.entries.find(([v]) => v === version)?.[1] ?? (version === latest ? latestReleasedAt : null);

  // Without a release date for `latest` there is nothing to re-evaluate
  // against — replay the stored decision as it was.
  if (!latestReleasedAt) return render(decision.basis, decision.pick, releasedAtOf(decision.pick), decision.alternative);

  // Latest has cleared the window on its own since this was written. This is
  // the case that a frozen answer got wrong, and it becomes true for every
  // held-back package eventually.
  if (daysAgo(latestReleasedAt, now) >= COOLDOWN_DAYS) return render("past-window", latest, latestReleasedAt, null);

  // The write-time analysis concluded latest wins on verified vulnerability
  // grounds; ageing doesn't change that.
  if (decision.pick === latest) return render(decision.basis, latest, latestReleasedAt, decision.alternative);

  const candidates = decision.entries.map(([version, releasedAt]) => ({ version, releasedAt }));
  const best = highestEligible(candidates, latest, now);
  if (!best) return render("no-fallback", latest, latestReleasedAt, null);

  // Same version the stored OSV work was done against: keep its basis.
  if (best.version === decision.pick) return render(decision.basis, best.version, best.releasedAt, decision.alternative);

  // A version between the old pick and latest has aged past the window. It is
  // a better answer on recency, but nothing has checked it for vulnerabilities.
  return render("aged-in", best.version, best.releasedAt, decision.alternative);
}
