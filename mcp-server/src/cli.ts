#!/usr/bin/env node
// CLI on top of the exact same store/data.ts logic the MCP server uses —
// one source of truth, two interfaces. Useful for humans running it
// directly, and for any AI agent/script that isn't MCP-aware but can shell
// out to a devDependency's bin.

import { parseArgs } from "node:util";
import { listCategories, recommend, checkPackage, MAX_LIMIT } from "./data.js";

const HELP = `dep-rec — dependency recommendation CLI

Usage:
  dep-rec check <package-name> [--json]
  dep-rec recommend "<need>" [--runtime node|edge] [--license MIT] [--limit 1-20] [--json]
  dep-rec categories [--json]

Examples:
  dep-rec check left-pad
  dep-rec recommend "jwt library" --runtime edge
  dep-rec recommend "csv parser" --limit 3 --json
`;

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
    options: { json: { type: "boolean" } },
    allowPositionals: true,
  });
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
    },
    allowPositionals: true,
  });
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
      for (const reason of r.reasons) lines.push(`   - ${reason}`);
    });
    return lines.join("\n");
  });
}

async function runCategories(rest: string[]): Promise<void> {
  const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
  const result = await listCategories();
  printJsonOr(values.json, result, () => result.map((c) => `${c.key}  (${c.count})`).join("\n"));
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
