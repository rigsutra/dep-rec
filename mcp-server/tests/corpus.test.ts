// Corpus-scale tests: every package actually in the shipped store (499 real
// ones), plus generated rows, plus a false-positive sweep of the typosquat
// detector across every real name we track. Anything that only breaks at
// scale — a tie-ranking flaw, a NaN from one odd row, a detector that libels
// a real package — shows up here and nowhere else.
//
// Runs against a COPY of the store so a test can never corrupt the artifact
// that ships inside the package.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, row, iso } from "./helpers.js";
import { scoreAbsolute, scoreCategoryGroup } from "../src/store/scoring.js";
import { checkTyposquat } from "../src/store/typosquat.js";
import type { PackageRow } from "../src/store/db.js";

let allRows: PackageRow[] = [];
let categoryKeys: string[] = [];
let nameDownloads = new Map<string, number>();

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dep-rec-corpus-"));
  const dbCopy = join(dir, "store.db");
  copyFileSync(join(REPO_ROOT, "data/store.db"), dbCopy);
  process.env.DEP_REC_DB_PATH = dbCopy;

  const db = await import("../src/store/db.js");
  allRows = db.listAll();
  categoryKeys = db.listAllCategoryCounts().map((c) => c.key);
  nameDownloads = db.listNameDownloads();
});

describe("shipped store integrity", () => {
  test("contains the expected corpus scale", () => {
    assert.ok(allRows.length >= 499, `expected the full curated corpus, found ${allRows.length}`);
  });

  test("every row has a usable primary key", () => {
    const bad = allRows.filter((r) => typeof r.name !== "string" || r.name.trim() === "");
    assert.deepEqual(bad.map((r) => r.name), []);
  });

  test("no duplicate names", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const r of allRows) {
      if (seen.has(r.name)) dupes.push(r.name);
      seen.add(r.name);
    }
    assert.deepEqual(dupes, []);
  });

  test("every name is a syntactically valid npm package name", () => {
    const valid = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
    const bad = allRows.filter((r) => !valid.test(r.name) || r.name.length > 214).map((r) => r.name);
    assert.deepEqual(bad, [], "an invalid name in the store means the collector accepted junk");
  });

  test("every row carries at least one category (it came from the curated set)", () => {
    const uncategorised = allRows.filter((r) => r.categories.length === 0).map((r) => r.name);
    assert.deepEqual(uncategorised, []);
  });

  test("all ten categories are populated", () => {
    assert.equal(categoryKeys.length, 10, `expected 10 categories, found ${categoryKeys.length}`);
  });

  test("no row reports a negative download count", () => {
    const bad = allRows.filter((r) => r.weekly_downloads < 0).map((r) => `${r.name}:${r.weekly_downloads}`);
    assert.deepEqual(bad, []);
  });

  test("no row has a zero download count (the silent-throttle bug that shipped once)", () => {
    // A 429 from the downloads endpoint used to be recorded as 0 downloads,
    // silently zeroing ~80% of the corpus. Zero across the board is the
    // signature of that failure returning.
    const zeros = allRows.filter((r) => r.weekly_downloads === 0).map((r) => r.name);
    assert.ok(zeros.length <= 2, `${zeros.length} packages report 0 downloads: ${zeros.slice(0, 10).join(", ")}`);
  });

  test("every timestamp in the store is parseable", () => {
    const bad: string[] = [];
    for (const r of allRows) {
      for (const [field, v] of [["created_at", r.created_at], ["modified_at", r.modified_at], ["raw_fetched_at", r.raw_fetched_at], ["first_seen_at", r.first_seen_at]] as const) {
        if (v !== null && !Number.isFinite(new Date(v).getTime())) bad.push(`${r.name}.${field}=${v}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test("every row has a stored score, and it is well formed", () => {
    const bad: string[] = [];
    for (const r of allRows) {
      if (r.score_total === null) {
        bad.push(`${r.name}: no score`);
        continue;
      }
      if (!Number.isFinite(r.score_total) || r.score_total < 0 || r.score_total > 100) {
        bad.push(`${r.name}: total=${r.score_total}`);
      }
      for (const [k, v] of [["security", r.score_security], ["maintenance", r.score_maintenance], ["compatibility", r.score_compatibility], ["community", r.score_community], ["supplyChain", r.score_supply_chain]] as const) {
        if (v === null || !Number.isFinite(v) || v < 0 || v > 100) bad.push(`${r.name}.${k}=${v}`);
      }
    }
    assert.deepEqual(bad.slice(0, 20), []);
  });

  test("every row explains its score", () => {
    const silent = allRows.filter((r) => r.score_reasons.length === 0).map((r) => r.name);
    assert.deepEqual(silent, [], "an unexplained score is exactly what this project exists to avoid");
  });

  test("no stored reason claims cleanliness while also flagging an unverified check", () => {
    const contradictory = allRows
      .filter((r) => {
        const hasClean = r.score_reasons.some((x) => /^no known vulnerabilit/i.test(x.trim()));
        const hasUnverified = r.score_reasons.some((x) => /could not be verified|unreachable/i.test(x));
        return hasClean && hasUnverified;
      })
      .map((r) => r.name);
    assert.deepEqual(contradictory, []);
  });

  test("a package with recorded vulnerabilities never claims to have none", () => {
    const lying = allRows
      .filter((r) => r.vulnerability_ids.length > 0 && r.score_reasons.some((x) => /^no known vulnerabilit/i.test(x.trim())))
      .map((r) => `${r.name} (${r.vulnerability_ids.length} vulns)`);
    assert.deepEqual(lying, []);
  });
});

describe("rescoring the whole corpus in memory", () => {
  test("every real row scores cleanly under absolute mode", () => {
    const bad: string[] = [];
    for (const r of allRows) {
      const s = scoreAbsolute(r);
      for (const [k, v] of Object.entries(s)) {
        if (k === "reasons") continue;
        if (!Number.isFinite(v as number) || (v as number) < 0 || (v as number) > 100) bad.push(`${r.name}.${k}=${v}`);
      }
      if (s.reasons.length === 0) bad.push(`${r.name}: no reasons`);
    }
    assert.deepEqual(bad.slice(0, 20), []);
  });

  test("every category rescores cleanly and completely", async () => {
    const db = await import("../src/store/db.js");
    for (const cat of categoryKeys) {
      const peers = db.listByCategory(cat);
      assert.ok(peers.length > 0, `${cat} resolved no members`);
      const scored = scoreCategoryGroup(peers);
      assert.equal(scored.size, peers.length, `${cat}: scored ${scored.size} of ${peers.length}`);
      for (const [name, s] of scored) {
        assert.ok(Number.isFinite(s.total) && s.total >= 0 && s.total <= 100, `${cat}/${name}: total=${s.total}`);
      }
    }
  });

  test("rescoring is deterministic across runs for every category", async () => {
    const db = await import("../src/store/db.js");
    for (const cat of categoryKeys) {
      const peers = db.listByCategory(cat);
      const a = scoreCategoryGroup(peers);
      const b = scoreCategoryGroup([...peers].reverse());
      const drift: string[] = [];
      for (const [name, s] of a) {
        const other = b.get(name);
        if (!other || Math.abs(other.total - s.total) > 0.05) {
          drift.push(`${cat}/${name}: ${s.total} vs ${other?.total}`);
        }
      }
      assert.deepEqual(drift.slice(0, 10), [], `${cat}: score depends on input ordering`);
    }
  });

  test("category ranking produces a defensible leader for every category", async () => {
    const db = await import("../src/store/db.js");
    for (const cat of categoryKeys) {
      const peers = db.listByCategory(cat);
      const scored = scoreCategoryGroup(peers);
      const ranked = [...scored.entries()].sort((x, y) => y[1].total - x[1].total);
      const [topName, topScore] = ranked[0];
      assert.ok(topScore.total > 50, `${cat}: best candidate only scored ${topScore.total} (${topName})`);
      const leader = peers.find((p) => p.name === topName)!;
      assert.equal(leader.deprecated, false, `${cat}: recommending a deprecated package (${topName})`);
      assert.equal(leader.vulnerability_ids.length, 0, `${cat}: recommending ${topName} which has known vulnerabilities`);
    }
  });
});

describe("typosquat false-positive sweep across every tracked package", () => {
  test("no meaningfully-adopted package in the corpus is flagged as a typosquat", async () => {
    // The bar: anything with real adoption (>=10k weekly downloads) is a
    // package people actually depend on, and accusing it is a defamation-shaped
    // bug. This caught two genuine false positives — `rest` branded a squat of
    // `jest`, and `js-logger` of `bs-logger` — both arbitrary single-character
    // substitutions between unrelated legitimate names, now excluded by
    // requiring substitutions to be keyboard-adjacent or visually confusable.
    const accused: string[] = [];
    for (const r of allRows) {
      if (r.weekly_downloads < 10_000) continue;
      const res = await checkTyposquat(r.name, r.weekly_downloads, nameDownloads);
      if (res.suspicious) accused.push(`${r.name} (${r.weekly_downloads}/wk) -> ${res.targetPackage} (${res.targetWeeklyDownloads}/wk)`);
    }
    assert.deepEqual(accused, [], `adopted packages branded as typosquats:\n  ${accused.join("\n  ")}`);
  });

  test("any near-zero-adoption corpus entry that trips the detector is reported, not hidden", async () => {
    // Entries with almost no adoption that sit one typo-shaped edit from a
    // far more popular package are ambiguous: possibly real squats that npm's
    // relevance search swept into the curated set, possibly just abandoned
    // packages. Either way the detector firing on them is defensible — but a
    // "recommended packages" corpus containing them is a collector-quality
    // problem worth surfacing rather than asserting away.
    const flagged: string[] = [];
    for (const r of allRows) {
      if (r.weekly_downloads >= 10_000) continue;
      const res = await checkTyposquat(r.name, r.weekly_downloads, nameDownloads);
      if (res.suspicious) flagged.push(`${r.name} (${r.weekly_downloads}/wk) -> ${res.targetPackage}`);
    }
    if (flagged.length > 0) {
      console.log(`\n  [corpus-quality] ${flagged.length} low-adoption curated entries look squat-shaped:`);
      for (const f of flagged) console.log(`    - ${f}`);
    }
    // Guard against this becoming systemic rather than incidental.
    assert.ok(
      flagged.length <= 5,
      `${flagged.length} curated entries look like typosquats — the collector's relevance filter needs a downloads floor`
    );
  });

  test("the sweep completes in reasonable time (variant generation is on the hot path)", async () => {
    const started = Date.now();
    for (const r of allRows.slice(0, 150)) {
      await checkTyposquat(r.name, r.weekly_downloads, nameDownloads);
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30_000, `150 checks took ${elapsed}ms — too slow for a per-request code path`);
  });

  test("a synthetic squat of every top-20 corpus package is caught", async () => {
    const top = [...allRows]
      .sort((a, b) => b.weekly_downloads - a.weekly_downloads)
      // Names under 4 characters are deliberately out of scope: every short
      // name sits one edit from many others, so accusing them produces more
      // false positives than it prevents attacks (see MIN_CANDIDATE_LENGTH).
      .filter((r) => (r.name.startsWith("@") ? r.name.slice(r.name.indexOf("/") + 1) : r.name).length >= 4)
      .slice(0, 20);
    assert.ok(top.length === 20, "premise check: enough long-named popular packages to sample");

    const missed: string[] = [];
    for (const r of top) {
      // Duplicate the final character — a distance-1, unambiguously
      // typo-shaped edit for any name.
      const squat = r.name + r.name[r.name.length - 1];
      const res = await checkTyposquat(squat, 5, nameDownloads);
      if (!res.suspicious) missed.push(`${squat} (target ${r.name}, ${r.weekly_downloads}/wk)`);
    }
    assert.deepEqual(missed, [], "failed to catch synthetic squats of the most popular tracked packages");
  });
});

describe("generated corpus — 600 fuzzed rows", () => {
  const generated: PackageRow[] = Array.from({ length: 600 }, (_, i) =>
    row({
      name: `gen-${i}`,
      categories: i % 5 === 0 ? [] : [`gen-cat-${i % 7}`],
      weekly_downloads: [0, 1, 42, 1_000, 250_000, 90_000_000, Number.MAX_SAFE_INTEGER][i % 7],
      maintainers: [0, 1, 2, 5, 40][i % 5],
      dependencies_count: [0, 1, 3, 28, 120, 900][i % 6],
      has_install_scripts: i % 11 === 0,
      deprecated: i % 13 === 0,
      esm_support: i % 2 === 0,
      typescript_support: i % 3 === 0,
      release_cadence_days: [null, 0, 1, 14, 400, 9_999][i % 6],
      modified_at: [iso(0), iso(3), iso(45), iso(900), iso(4_000), null, "garbage"][i % 7],
      created_at: [iso(1), iso(30), iso(5_000), null][i % 4],
      vulnerability_ids: i % 9 === 0 ? Array.from({ length: (i % 4) + 1 }, (_, k) => `GHSA-gen-${i}-${k}`) : [],
      security_check_failed: i % 17 === 0,
    })
  );

  test("all 600 score cleanly in absolute mode", () => {
    const bad: string[] = [];
    for (const r of generated) {
      const s = scoreAbsolute(r);
      for (const [k, v] of Object.entries(s)) {
        if (k === "reasons") continue;
        if (!Number.isFinite(v as number) || (v as number) < 0 || (v as number) > 100) bad.push(`${r.name}.${k}=${v}`);
      }
    }
    assert.deepEqual(bad.slice(0, 20), []);
  });

  test("all 600 score cleanly when grouped by category", () => {
    const byCat = new Map<string, PackageRow[]>();
    for (const r of generated) {
      for (const c of r.categories) {
        if (!byCat.has(c)) byCat.set(c, []);
        byCat.get(c)!.push(r);
      }
    }
    const bad: string[] = [];
    for (const [cat, peers] of byCat) {
      const scored = scoreCategoryGroup(peers);
      assert.equal(scored.size, peers.length, `${cat}: incomplete scoring`);
      for (const [name, s] of scored) {
        if (!Number.isFinite(s.total) || s.total < 0 || s.total > 100) bad.push(`${cat}/${name}=${s.total}`);
      }
    }
    assert.deepEqual(bad.slice(0, 20), []);
  });

  test("combined real + generated corpus exceeds 1000 packages scored", () => {
    const total = allRows.length + generated.length;
    assert.ok(total > 1000, `only exercised ${total} packages`);
  });

  test("a deprecated generated row never outranks its clean twin", () => {
    const clean = scoreAbsolute(row({ name: "twin", deprecated: false }));
    const dep = scoreAbsolute(row({ name: "twin", deprecated: true }));
    assert.ok(dep.total < clean.total);
  });
});
