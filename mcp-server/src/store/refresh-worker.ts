// The background surveillance job: re-checks the oldest (most stale)
// tracked packages against the live registry/OSV, so requests almost
// always hit fresh-enough stored data instead of triggering a live fetch.
// Meant to be run on a schedule (cron, a scheduled task, whatever the
// deployment has available) — this script itself does one bounded batch
// and exits; it is NOT a long-running daemon.
//
// Every package ever looked up via check_package (or seeded from the
// curated dataset) has a row in the store, and therefore is automatically
// covered by this — there's no separate "add to watchlist" step.

import { listStalest, countPackages } from "./db.js";
import { forceRefreshPackage } from "./lookup.js";

const BATCH_SIZE = Number(process.env.REFRESH_BATCH_SIZE ?? 50);
const PACING_MS = 300; // stay well under npm's/OSV's throttling thresholds

async function main() {
  const total = countPackages();
  const batch = listStalest(BATCH_SIZE);
  console.log(`Store has ${total} tracked package(s). Refreshing the ${batch.length} oldest...`);

  let refreshed = 0;
  let failed = 0;
  for (const row of batch) {
    const ageHours = Math.round((Date.now() - new Date(row.raw_fetched_at).getTime()) / 3_600_000);
    try {
      await forceRefreshPackage(row.name);
      refreshed++;
      console.log(`  refreshed ${row.name} (was ${ageHours}h stale)`);
    } catch (err) {
      failed++;
      console.log(`  FAILED to refresh ${row.name}: ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PACING_MS));
  }

  console.log(`\nDone. Refreshed ${refreshed}, failed ${failed}, ${total - batch.length} not due yet this run.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
