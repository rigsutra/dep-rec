#!/usr/bin/env node
// CLI on top of the exact same store/data.ts logic the MCP server uses —
// one source of truth, two interfaces. Useful for humans running it
// directly, and for any AI agent/script that isn't MCP-aware but can shell
// out to a devDependency's bin.

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { listCategories, recommend, checkPackage, MAX_LIMIT } from "./data.js";
import { readLockfile } from "./fix/lockfile.js";
import { planFixes, liveSources, type VulnSummary } from "./fix/plan.js";
import { applyFixes } from "./fix/apply.js";

const HELP = `dep-rec — dependency recommendation CLI

Usage:
  dep-rec check <package-name> [--json] [--db <path>]
  dep-rec recommend "<need>" [--runtime node|edge] [--license MIT] [--limit 1-20] [--json] [--db <path>]
  dep-rec categories [--json] [--db <path>]
  dep-rec fix [--apply] [--no-test] [--dir <path>] [--json]

fix:
  Finds vulnerable packages in package-lock.json (direct and transitive) and
  plans the smallest same-major upgrade that fixes them, using only versions
  at least 30 days old. Dry run by default; --apply edits package.json and the
  lockfile, runs npm test, and restores both if anything fails. Major
  upgrades are reported, never applied. Exit code 2 when vulnerabilities
  remain, 1 on error or rollback.

Examples:
  dep-rec check left-pad
  dep-rec recommend "jwt library" --runtime edge
  dep-rec recommend "csv parser" --limit 3 --json

Options:
  --db <path>   Use a different store file instead of ~/.dep-rec/store.json
                (which starts as a copy of the store shipped in the package).
                Also settable as DEP_REC_DB_PATH.
`;

// Must be applied before anything touches the store, which resolves this
// lazily on first use.
function applyDbOverride(dbPath: string | undefined): void {
  if (dbPath) process.env.DEP_REC_DB_PATH = dbPath;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printJsonOr(json: boolean | undefined, data: unknown, human: () => string): void {
  console.log(json ? JSON.stringify(data, null, 2) : human());
}

async function runCheck(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { json: { type: "boolean" }, db: { type: "string" } },
    allowPositionals: true,
  });
  applyDbOverride(values.db);
  const name = positionals[0];
  if (!name) fail('Usage: dep-rec check <package-name> [--json]');

  const result = await checkPackage(name);

  printJsonOr(values.json, result, () => {
    if (!result.found) {
      return `✗ ${result.name} — ${result.reason}\n  ${result.note}`;
    }
    const lines = [
      `${result.typosquatWarning ? "🚨" : result.score! >= 70 ? "✓" : "!"} ${result.name}  score ${result.score}  [${result.servedFrom}]`,
      ...(result.typosquatWarning ? [`  TYPOSQUAT WARNING: ${result.typosquatWarning.reason}`] : []),
      `  license: ${result.npm!.license ?? "unknown"}  maintainers: ${result.npm!.maintainers}  deps: ${result.npm!.dependenciesCount}  weekly downloads: ${result.weeklyDownloads!.toLocaleString("en-US")}`,
      ...result.reasons!.map((r) => `  - ${r}`),
      ...(result.versionGuidance
        ? [
            `  recommended version: ${result.versionGuidance.recommendedVersion}${result.versionGuidance.recommendedVersion === result.npm!.latestVersion ? " (= latest)" : ` (latest is ${result.npm!.latestVersion})`}`,
            `    ${result.versionGuidance.reason}`,
          ]
        : []),
      ...(result.recommendable === false
        ? [
            `  NOT RECOMMENDATION-GRADE — this tool would not put this package forward:`,
            ...result.notRecommendableBecause!.map((r) => `    - ${r}`),
          ]
        : []),
      `  ${result.note}`,
    ];
    return lines.join("\n");
  });
}

async function runRecommend(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      runtime: { type: "string" },
      license: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean" },
      db: { type: "string" },
    },
    allowPositionals: true,
  });
  applyDbOverride(values.db);
  const need = positionals.join(" ");
  if (!need) fail('Usage: dep-rec recommend "<need>" [--runtime node|edge] [--license MIT] [--limit N] [--json]');
  if (values.runtime && values.runtime !== "node" && values.runtime !== "edge") {
    fail(`--runtime must be "node" or "edge", got "${values.runtime}"`);
  }

  // `--limit banana` used to become NaN and `--limit 0` stayed 0; both then
  // sliced the ranking to nothing and printed an empty list, which reads as
  // "no package fits your need" rather than "you passed a bad flag".
  let limit: number | undefined;
  if (values.limit !== undefined) {
    if (!/^\d+$/.test(values.limit)) {
      fail(`--limit must be a whole number between 1 and ${MAX_LIMIT}, got "${values.limit}"`);
    }
    limit = Number(values.limit);
    if (limit < 1 || limit > MAX_LIMIT) {
      fail(`--limit must be between 1 and ${MAX_LIMIT}, got ${limit}`);
    }
  }

  const result = await recommend({
    need,
    runtime: values.runtime as "node" | "edge" | undefined,
    license: values.license,
    limit,
  });

  printJsonOr(values.json, result, () => {
    const lines: string[] = [];
    if (result.matchedCategory) lines.push(`Matched category: ${result.matchedCategory}`);
    if (result.note) lines.push(result.note);
    for (const c of result.caveats) lines.push(`Caveat: ${c}`);
    lines.push("");
    result.recommendations.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.package}  score ${r.score}  (${r.license ?? "unknown license"}, ${r.weeklyDownloads.toLocaleString("en-US")}/week)`);
      // The install line goes directly under the name rather than after the
      // reasons: it is the one part of this block that gets copied.
      if (r.recommendedVersion) {
        lines.push(`   install: ${r.package}@${r.recommendedVersion}${r.versionNote ? `  (latest is ${r.latestVersion})` : ""}`);
      }
      if (r.versionNote) lines.push(`     ${r.versionNote}`);
      for (const reason of r.reasons) lines.push(`   - ${reason}`);
    });
    return lines.join("\n");
  });
}

async function runCategories(rest: string[]): Promise<void> {
  const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" }, db: { type: "string" } } });
  applyDbOverride(values.db);
  const result = await listCategories();
  printJsonOr(values.json, result, () => result.map((c) => `${c.key}  (${c.count})`).join("\n"));
}

function vulnLabel(vulns: VulnSummary[]): string {
  return vulns.map((v) => `${v.id}${v.severity ? ` (${v.severity})` : ""}${v.summary ? ` ${v.summary}` : ""}`).join("; ");
}

async function runFix(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      apply: { type: "boolean" },
      "no-test": { type: "boolean" },
      dir: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const dir = resolve(values.dir ?? process.cwd());
  const plan = await planFixes(readLockfile(dir), liveSources);
  const applied = values.apply ? await applyFixes(dir, plan, liveSources, { runTests: !values["no-test"] }) : null;

  printJsonOr(values.json, { ...plan, applied }, () => {
    const vulnerable = plan.fixes.length + plan.skipped.length;
    const lines = [`Scanned ${plan.scanned} package versions: ${vulnerable === 0 ? "no known vulnerabilities." : `${vulnerable} vulnerable.`}`];
    if (plan.fixes.length > 0) {
      lines.push("", `Fixable without a major upgrade (only versions published before ${plan.before.slice(0, 10)}):`);
      for (const f of plan.fixes) {
        lines.push(`  ${f.name} ${f.from} -> ${f.to}  [${f.strategy}]${f.dev ? "  dev" : ""}`, `    ${vulnLabel(f.vulns)}`);
        if (f.bump) lines.push(`    package.json ${f.bump.field}: "${f.name}": "${f.bump.range}"`);
        if (f.override) lines.push(`    package.json overrides: "${f.override.key}": "${f.override.value}"`);
      }
    }
    if (plan.skipped.length > 0) {
      lines.push("", "Not fixable automatically:");
      for (const s of plan.skipped) lines.push(`  ${s.name} ${s.version}  ${s.reason}: ${s.detail}${s.dev ? "  dev" : ""}`, `    ${vulnLabel(s.vulns)}`);
    }
    if (!applied) {
      if (plan.fixes.length > 0) lines.push("", "Dry run. Re-run with --apply to change package.json and the lockfile.");
      return lines.join("\n");
    }
    lines.push("");
    if (applied.rolledBack) lines.push(`ROLLED BACK: ${applied.failure}. package.json and the lockfile are restored.`);
    else {
      for (const f of applied.fixed) lines.push(`fixed: ${f}`);
      for (const f of applied.notFixed) lines.push(`still vulnerable: ${f}`);
      lines.push(applied.testsRan ? "npm test passed." : "Tests not run.");
    }
    lines.push(`Backup of the original files: ${applied.backupDir}`);
    return lines.join("\n");
  });

  if (applied?.rolledBack) process.exit(1);
  const remaining = applied && !applied.rolledBack ? applied.notFixed.length + plan.skipped.length : plan.fixes.length + plan.skipped.length;
  if (remaining > 0) process.exitCode = 2;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "check":
      return runCheck(rest);
    case "recommend":
      return runRecommend(rest);
    case "categories":
      return runCategories(rest);
    case "fix":
      return runFix(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      fail(`Unknown command "${command}"\n\n${HELP}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
