// Stress harness. Not a test suite — a test suite asserts known properties,
// this exists to find the point where the thing falls over and to say what
// it does on the way down.
//
//   npm run stress            # everything
//   npm run stress -- --phase=a
//
// Phases:
//   A  breadth   — ~250 real live lookups across 8 quality tiers
//   B  load      — concurrency ramp until something breaks
//   C  corrupt   — deliberately poisoned store rows
//   D  judgement — is the output actually usable by a model
//
// Every phase runs against a temp copy of the store. Nothing here writes to
// the shipped artifact.

import { mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { allNames, TIERS } from "./corpus.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const workDir = mkdtempSync(join(tmpdir(), "dep-rec-stress-"));

const phaseArg = process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1];
const wanted = (p: string) => !phaseArg || phaseArg.includes(p);

function freshStore(label: string): string {
  const p = join(workDir, `${label}.db`);
  copyFileSync(join(ROOT, "data/store.db"), p);
  return p;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

interface Violation {
  phase: string;
  name: string;
  detail: string;
}
const violations: Violation[] = [];
function violate(phase: string, name: string, detail: string) {
  violations.push({ phase, name, detail });
}

// ---------------------------------------------------------------------------
// Phase A — breadth against live npm
// ---------------------------------------------------------------------------

interface Outcome {
  name: string;
  tier: string;
  ms: number;
  found: boolean;
  reasonCode?: string;
  score?: number;
  recommendable?: boolean;
  squat?: string;
  threw?: string;
}

async function phaseA(): Promise<Outcome[]> {
  process.env.DEP_REC_DB_PATH = freshStore("breadth");
  const { checkPackage } = await import("../src/data.js");
  const { getPackage } = await import("../src/store/db.js");
  const { downloadsPacingMs } = await import("../src/sources/npm.js");
  let downloadsUnverified = 0;
  const unverifiedNames: string[] = [];

  const targets = allNames();
  const outcomes: Outcome[] = [];
  const CONCURRENCY = 6;
  let cursor = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const { name, tier, expectation } = targets[i];
      const t0 = Date.now();
      try {
        const r: any = await checkPackage(name);
        const o: Outcome = {
          name,
          tier,
          ms: Date.now() - t0,
          found: r.found,
          reasonCode: r.reasonCode,
          score: r.score,
          recommendable: r.recommendable,
          squat: r.typosquatWarning?.targetPackage,
        };
        outcomes.push(o);

        // Typosquat detection declines to answer when the subject's own
        // download count is unverified. That is the right call, but it means
        // the detector can go quiet under load without saying so — so the
        // rate has to be measured, not assumed.
        if (r.found && getPackage(name)?.downloads_check_failed) {
          downloadsUnverified++;
          unverifiedNames.push(name);
        }

        // --- honesty checks, not availability checks ---
        if (r.found && (r.score === null || r.score === undefined || !Number.isFinite(r.score))) {
          violate("A", name, `resolved but score is ${JSON.stringify(r.score)}`);
        }
        if (r.found && Number.isFinite(r.score) && (r.score < 0 || r.score > 100)) {
          violate("A", name, `score out of range: ${r.score}`);
        }
        if (r.found && (!Array.isArray(r.reasons) || r.reasons.length === 0)) {
          violate("A", name, "resolved with no reasons — a model would have nothing to cite");
        }
        if (!r.found && !r.reasonCode) {
          violate("A", name, "miss carries no reasonCode");
        }
        if (r.reasonCode && r.reasonCode !== "not-found" && /hallucinat|typosquat/i.test(r.note ?? "")) {
          violate("A", name, `non-404 miss (${r.reasonCode}) accused the name of being fake`);
        }
        if (r.typosquatWarning && r.recommendable === true) {
          violate("A", name, "flagged as a typosquat AND marked recommendable");
        }
        if (expectation === "invalid-name" && r.found === true) {
          violate("A", name, "structurally invalid or hostile input resolved as a real package");
        }
        if (expectation === "not-found" && r.found === true) {
          violate("A", name, "a synthetic nonexistent name resolved");
        }
        if (r.found && r.npm?.deprecated && r.recommendable === true) {
          violate("A", name, "deprecated but still recommendable");
        }
        if (typeof r.note !== "string" || r.note.length === 0) {
          violate("A", name, "no note — the field a model reads for guidance");
        }
      } catch (err) {
        outcomes.push({ name, tier, ms: Date.now() - t0, found: false, threw: String(err) });
        violate("A", name, `threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      done++;
      if (done % 25 === 0) process.stderr.write(`  …${done}/${targets.length}\n`);
    }
  }

  console.log(`\nPHASE A — ${targets.length} live lookups across ${TIERS.length} tiers, concurrency ${CONCURRENCY}`);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - t0) / 1000;

  const lat = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  console.log(`  wall clock ${elapsed.toFixed(1)}s   p50 ${quantile(lat, 0.5)}ms   p95 ${quantile(lat, 0.95)}ms   max ${lat[lat.length - 1]}ms`);
  console.log(`  threw: ${outcomes.filter((o) => o.threw).length}/${outcomes.length}`);
  const resolvedCount = outcomes.filter((o) => o.found).length;
  console.log(
    `  download count unverified on ${downloadsUnverified}/${resolvedCount} resolved packages ` +
      `(${pct(downloadsUnverified, resolvedCount)}) — typosquat detection is disabled for those`
  );
  console.log(`  adaptive downloads spacing ended at ${downloadsPacingMs()}ms`);
  if (unverifiedNames.length) console.log(`    unverified: ${unverifiedNames.slice(0, 40).join(", ")}`);
  if (downloadsUnverified / Math.max(resolvedCount, 1) > 0.1) {
    violate("A", "downloads-api", `${pct(downloadsUnverified, resolvedCount)} of lookups could not verify adoption — detection silently degrades at this rate`);
  }

  console.log("\n  tier              n   resolved  recommendable  squat-flagged  miss-codes");
  for (const tier of TIERS) {
    const rows = outcomes.filter((o) => o.tier === tier.key);
    const resolved = rows.filter((o) => o.found);
    const codes = new Map<string, number>();
    for (const r of rows.filter((o) => !o.found && o.reasonCode)) {
      codes.set(r.reasonCode!, (codes.get(r.reasonCode!) ?? 0) + 1);
    }
    const codeStr = [...codes.entries()].map(([k, v]) => `${k}:${v}`).join(" ") || "—";
    console.log(
      `  ${tier.key.padEnd(16)} ${String(rows.length).padStart(3)}   ${String(resolved.length).padStart(6)}` +
        `   ${String(resolved.filter((o) => o.recommendable).length).padStart(11)}` +
        `   ${String(rows.filter((o) => o.squat).length).padStart(11)}   ${codeStr}`
    );
  }

  const flagged = outcomes.filter((o) => o.squat);
  if (flagged.length > 0) {
    console.log("\n  typosquat flags raised:");
    for (const f of flagged) console.log(`    ${f.name} -> ${f.squat}`);
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Phase B — concurrency ramp
// ---------------------------------------------------------------------------

function runCliProc(
  dbPath: string,
  args: string[]
): Promise<{ code: number | null; ms: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/cli.ts"), ...args], {
      cwd: ROOT,
      env: { ...process.env, DEP_REC_DB_PATH: dbPath } as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderr = "";
    // BOTH streams must be drained. Leaving stdout unread deadlocks the child
    // as soon as its output exceeds the ~64KB OS pipe buffer — which a
    // poisoned store row is more than capable of producing, and which cost an
    // hour of thinking the product had hung.
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, ms: Date.now() - t0, stdout, stderr }));
  });
}

async function phaseB() {
  console.log("\nPHASE B — concurrency ramp on one shared store (all rows forced stale, so every process WRITES)");
  const dbPath = freshStore("load");
  const db = new DatabaseSync(dbPath);
  db.exec("UPDATE packages SET raw_fetched_at = '2020-01-01T00:00:00.000Z'");
  db.close();

  const pool = ["axios", "got", "ky", "undici", "zod", "yup", "joi", "pino", "winston", "dayjs",
    "date-fns", "csv-parse", "redux", "zustand", "jose", "lodash", "vite", "esbuild",
    "chalk", "commander", "uuid", "nanoid", "glob", "rimraf", "express", "fastify",
    "prisma", "knex", "vitest", "mocha", "xstate", "mobx"];

  console.log("  procs  ok   failed  locked  p50      p95      max");
  for (const n of [1, 4, 8, 16, 32]) {
    const runs = await Promise.all(
      Array.from({ length: n }, (_, i) => runCliProc(dbPath, ["check", pool[i % pool.length], "--json"]))
    );
    const failed = runs.filter((r) => r.code !== 0);
    const locked = runs.filter((r) => /database is locked/i.test(r.stderr));
    const lat = runs.map((r) => r.ms).sort((a, b) => a - b);
    console.log(
      `  ${String(n).padStart(5)}  ${String(runs.length - failed.length).padStart(3)}  ${String(failed.length).padStart(6)}` +
        `  ${String(locked.length).padStart(6)}  ${String(quantile(lat, 0.5)).padStart(6)}ms ${String(quantile(lat, 0.95)).padStart(6)}ms ${String(lat[lat.length - 1]).padStart(6)}ms`
    );
    for (const f of failed) violate("B", `concurrency-${n}`, f.stderr.split("\n")[0] || `exit ${f.code}`);
  }
}

// ---------------------------------------------------------------------------
// Phase C — poisoned store rows
// ---------------------------------------------------------------------------

const POISON: Array<[string, Record<string, unknown>]> = [
  ["nan-downloads", { weekly_downloads: NaN }],
  ["negative-downloads", { weekly_downloads: -999999 }],
  ["huge-downloads", { weekly_downloads: Number.MAX_SAFE_INTEGER }],
  ["negative-deps", { dependencies_count: -50 }],
  ["huge-deps", { dependencies_count: 1_000_000 }],
  ["negative-maintainers", { maintainers: -3 }],
  ["garbage-date", { modified_at: "not-a-date", created_at: "also-not-a-date" }],
  ["future-date", { modified_at: "2999-01-01T00:00:00.000Z", created_at: "2999-01-01T00:00:00.000Z" }],
  ["epoch-date", { modified_at: "1970-01-01T00:00:00.000Z", created_at: "1970-01-01T00:00:00.000Z" }],
  ["empty-date", { modified_at: "", created_at: "" }],
  ["null-dates", { modified_at: null, created_at: null }],
  ["bad-json-categories", { categories: "{{{not json" }],
  ["bad-json-vulns", { vulnerability_ids: "not json either" }],
  ["bad-json-reasons", { score_reasons: "[[[" }],
  ["null-json-cols", { categories: null, vulnerability_ids: null, score_reasons: null }],
  ["score-out-of-range", { score_total: 999999 }],
  ["negative-score", { score_total: -500 }],
  ["nan-cadence", { release_cadence_days: NaN }],
  ["huge-name", { name: "z".repeat(100_000) }],
  ["unicode-name", { name: "пакет-🐛-‮txt" }],
  ["empty-name", { name: "" }],
  ["giant-reasons", { score_reasons: JSON.stringify(Array.from({ length: 5000 }, (_, i) => `reason ${i}`)) }],
];

async function phaseC() {
  console.log("\nPHASE C — poisoned store rows (every read path must survive and never emit a non-finite score)");
  const dbPath = freshStore("poison");
  const db = new DatabaseSync(dbPath);

  const cols = (db.prepare("PRAGMA table_info(packages)").all() as Array<{ name: string }>).map((c) => c.name);
  const template = db.prepare("SELECT * FROM packages WHERE name = 'zod'").get() as Record<string, unknown>;

  let injected = 0;
  for (const [label, overrides] of POISON) {
    const row: Record<string, unknown> = { ...template, name: `poison-${label}`, categories: '["testing"]', ...overrides };
    // NaN cannot round-trip through SQLite bindings; store it as the text the
    // column would end up holding if something upstream wrote it.
    for (const k of Object.keys(row)) if (typeof row[k] === "number" && Number.isNaN(row[k] as number)) row[k] = "NaN";
    try {
      db.prepare(`INSERT OR REPLACE INTO packages (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
        ...cols.map((c) => (row[c] === undefined ? null : (row[c] as any)))
      );
      injected++;
    } catch (err) {
      console.log(`    (could not inject ${label}: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
  db.close();
  console.log(`  injected ${injected}/${POISON.length} poisoned rows`);

  const checks: Array<[string, string[]]> = [
    ["categories", ["categories", "--json"]],
    ["recommend testing", ["recommend", "testing", "--limit", "20", "--json"]],
    ["recommend csv", ["recommend", "csv parser", "--json"]],
    ["check poisoned row", ["check", "poison-nan-downloads", "--json"]],
    ["check healthy row", ["check", "zod", "--json"]],
  ];

  for (const [label, args] of checks) {
    const r = await runCliProc(dbPath, args);
    if (r.code !== 0) {
      violate("C", label, `exit ${r.code}: ${r.stderr.split("\n").filter(Boolean)[0] ?? ""}`);
      console.log(`  ${label.padEnd(22)} FAILED exit=${r.code} ${r.stderr.split("\n")[0]?.slice(0, 90) ?? ""}`);
    } else {
      console.log(`  ${label.padEnd(22)} ok (${r.ms}ms)`);
    }
  }

  // The output of a poisoned store must still be well-formed JSON with no
  // nulls where numbers belong — that was the original NaN-through-JSON bug.
  const rec = await runCliProc(dbPath, ["recommend", "testing", "--limit", "20", "--json"]);
  if (rec.code === 0) {
    console.log(`  recommend output size: ${(rec.stdout.length / 1024).toFixed(1)} KB`);
    try {
      const parsed = JSON.parse(rec.stdout);
      for (const r of parsed.recommendations ?? []) {
        if (!Number.isFinite(r.score)) violate("C", r.package, `recommended with a non-finite score: ${JSON.stringify(r.score)}`);
        if (String(r.package).startsWith("poison-")) {
          // Not automatically wrong — but a poisoned row reaching a
          // recommendation list is worth seeing.
          console.log(`  NOTE: poisoned row surfaced in recommendations: ${r.package} (score ${r.score})`);
        }
      }
      console.log(`  recommend output parsed cleanly, ${parsed.recommendations?.length ?? 0} entries`);
    } catch (err) {
      violate("C", "recommend-json", `unparseable output: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase D — is any of this usable by a model
// ---------------------------------------------------------------------------

async function phaseD(outcomes: Outcome[]) {
  console.log("\nPHASE D — would this actually help a model?");
  process.env.DEP_REC_DB_PATH = freshStore("judge");
  const { recommend } = await import("../src/data.js");

  const needs = ["jwt library", "csv parser", "http client", "orm", "testing", "logger", "validation", "date", "state management", "web framework"];
  let emptyResults = 0;
  let unexplained = 0;

  for (const need of needs) {
    const r = await recommend({ need, limit: 3 });
    if (r.recommendations.length === 0) {
      emptyResults++;
      console.log(`  ${need.padEnd(18)} NO RESULTS`);
      continue;
    }
    const top = r.recommendations[0];
    if (!top.reasons?.length) unexplained++;
    console.log(
      `  ${need.padEnd(18)} ${top.package.padEnd(22)} ${String(top.score).padStart(5)}  ` +
        `${r.excludedAsUnrecommendable ?? 0} excluded   "${(top.reasons?.[0] ?? "—").slice(0, 52)}"`
    );
  }
  if (emptyResults) violate("D", "coverage", `${emptyResults}/${needs.length} known needs returned nothing`);
  if (unexplained) violate("D", "explainability", `${unexplained} top picks had no reasons`);

  // Discrimination: does the score actually separate the tiers, or is it noise?
  const scored = (tier: string) => {
    const s = outcomes.filter((o) => o.tier === tier && typeof o.score === "number").map((o) => o.score!);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
  };
  const mainstream = scored("mainstream");
  const deprecated = scored("deprecated");
  const obscure = scored("obscure-real");
  console.log(
    `\n  mean score — mainstream ${mainstream.toFixed(1)} | deprecated ${deprecated.toFixed(1)} | obscure ${obscure.toFixed(1)}`
  );
  if (!(mainstream > deprecated)) violate("D", "discrimination", "mainstream packages do not outscore deprecated ones");

  const mainstreamRows = outcomes.filter((o) => o.tier === "mainstream" && o.found);
  const recRate = mainstreamRows.filter((o) => o.recommendable).length / (mainstreamRows.length || 1);
  console.log(`  mainstream packages judged recommendable: ${pct(mainstreamRows.filter((o) => o.recommendable).length, mainstreamRows.length)}`);
  if (recRate < 0.8) {
    violate("D", "false-negatives", `only ${pct(mainstreamRows.filter((o) => o.recommendable).length, mainstreamRows.length)} of mainstream packages are recommendable — the bar is rejecting good packages`);
  }

  const deprecatedRows = outcomes.filter((o) => o.tier === "deprecated" && o.found);
  const wronglyOk = deprecatedRows.filter((o) => o.recommendable);
  console.log(`  deprecated/abandoned wrongly recommendable: ${wronglyOk.length}/${deprecatedRows.length}` +
    (wronglyOk.length ? ` -> ${wronglyOk.map((o) => o.name).join(", ")}` : ""));
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`dep-rec stress run — store copies under ${workDir}`);
  let outcomes: Outcome[] = [];
  if (wanted("a")) outcomes = await phaseA();
  if (wanted("b")) await phaseB();
  if (wanted("c")) await phaseC();
  if (wanted("d")) await phaseD(outcomes);

  console.log(`\n${"=".repeat(72)}`);
  if (violations.length === 0) {
    console.log("NO VIOLATIONS");
  } else {
    console.log(`${violations.length} VIOLATIONS`);
    const byPhase = new Map<string, Violation[]>();
    for (const v of violations) byPhase.set(v.phase, [...(byPhase.get(v.phase) ?? []), v]);
    for (const [phase, vs] of [...byPhase.entries()].sort()) {
      console.log(`\n  phase ${phase} (${vs.length}):`);
      for (const v of vs.slice(0, 40)) console.log(`    ${v.name}: ${v.detail}`);
      if (vs.length > 40) console.log(`    …and ${vs.length - 40} more`);
    }
  }

  writeFileSync(join(workDir, "outcomes.json"), JSON.stringify({ outcomes, violations }, null, 2));
  console.log(`\nfull results: ${join(workDir, "outcomes.json")}`);
  process.exitCode = violations.length > 0 ? 1 : 0;
}

main().finally(() => {
  try {
    if (process.env.DEP_REC_STRESS_KEEP !== "1") rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* windows holds sqlite handles briefly; the OS will clean temp */
  }
});
