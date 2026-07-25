// Whether a package is fit to be RECOMMENDED — a separate question from
// whether it can be looked up.
//
// check_package answers for anything, by design: asking "is this package I
// was told to install any good?" is the whole point, and refusing to answer
// for obscure packages would defeat it. But putting a near-abandoned or
// barely-adopted package in front of someone as a *recommendation* is a
// different act, and a security-focused recommender that does it undermines
// its own purpose. A package with 86 weekly downloads has no meaningful
// review surface; one with no release in years has nobody obviously on hand
// to ship a fix when a CVE lands.
//
// The curated corpus was built from npm's relevance search, which happily
// returns both: 192 of its 499 entries fail the bar below, including packages
// with 2-6 weekly downloads and several abandoned for 4+ years.
//
// The age floor is set low on the reasoning that adoption is itself evidence —
// a package pulling 13M weekly downloads is demonstrably in real use whatever
// its age. The tradeoff that buys is explicit rather than hidden: at 30 days,
// a package a couple of months old can be recommended, and two currently are
// (@supabase/phoenix at 158 days, @earendil-works/pi-agent-core at 79 days).
// Raise MIN_AGE_DAYS if that exposure matters more than the coverage.

import type { PackageRow } from "./db.js";

export const MIN_WEEKLY_DOWNLOADS = 10_000;
export const MIN_AGE_DAYS = 30;
export const MAX_STALE_DAYS = 1000;

// Above this adoption level, a long gap between releases reads as "stable"
// rather than "abandoned" — redux has ~39M weekly downloads and had not cut a
// release in 810 days, because the core package is finished, not neglected.
// Excluding it would be a worse error than including it.
export const HIGH_ADOPTION_DOWNLOADS = 5_000_000;
export const MAX_STALE_DAYS_HIGH_ADOPTION = 1095;

function daysBetween(iso: string | null, fallback: number): number {
  if (!iso) return fallback;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return fallback;
  return Math.round((Date.now() - t) / 86_400_000);
}

export interface Eligibility {
  eligible: boolean;
  /** Human-readable disqualifications, empty when eligible. */
  failures: string[];
}

export function checkRecommendable(r: PackageRow): Eligibility {
  const failures: string[] = [];

  if (r.store_row_damaged) {
    failures.push("the stored record for this package is corrupt and could not be fully read — nothing about it can be trusted enough to recommend it");
  }

  if (r.deprecated) {
    failures.push("marked deprecated on npm");
  }

  // An unverified adoption figure cannot clear an adoption bar. Letting a
  // package through on a number the last refresh failed to confirm would be
  // the same fail-open mistake as reporting an unreachable OSV as "clean".
  if (r.downloads_check_failed && r.weekly_downloads === 0) {
    failures.push("weekly download count could not be verified (npm downloads API unreachable) — adoption is unknown, not zero");
  } else if (r.weekly_downloads < MIN_WEEKLY_DOWNLOADS) {
    failures.push(
      `only ${r.weekly_downloads.toLocaleString("en-US")} weekly downloads (recommendation floor is ${MIN_WEEKLY_DOWNLOADS.toLocaleString("en-US")})`
    );
  }

  // Missing created_at is treated as old rather than new: the alternative
  // would let a package with absent metadata slip past the track-record bar.
  const ageDays = daysBetween(r.created_at, Number.MAX_SAFE_INTEGER);
  if (ageDays < MIN_AGE_DAYS) {
    failures.push(`first published only ${ageDays} days ago (needs ${MIN_AGE_DAYS} for a track record)`);
  }

  // Missing modified_at is treated as maximally stale, so absent metadata
  // fails closed here too.
  const staleDays = daysBetween(r.modified_at, Number.MAX_SAFE_INTEGER);
  const staleLimit = r.weekly_downloads >= HIGH_ADOPTION_DOWNLOADS ? MAX_STALE_DAYS_HIGH_ADOPTION : MAX_STALE_DAYS;
  if (staleDays > staleLimit) {
    failures.push(`no release in ${staleDays} days (limit is ${staleLimit} at this adoption level)`);
  }

  return { eligible: failures.length === 0, failures };
}

export function isRecommendable(r: PackageRow): boolean {
  return checkRecommendable(r).eligible;
}
