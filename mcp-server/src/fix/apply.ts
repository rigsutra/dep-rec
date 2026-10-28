// Applies a FixPlan: back up package.json and the lockfile, write range bumps
// and overrides, let npm resolve with --before so nothing it installs is
// younger than the cooldown, confirm the vulnerable versions are gone, run the
// project's tests, and restore everything if any step fails.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readLockfile, lockfilePath } from "./lockfile.js";
import { compare, parse, sameLine } from "./semver.js";
import { isAffected, type FixPlan, type FixSources } from "./plan.js";
import type { OsvVuln } from "../sources/osv.js";

export interface ApplyOptions {
  runTests: boolean;
}

export interface ApplyResult {
  applied: boolean;
  rolledBack: boolean;
  /** Why it rolled back, or null. */
  failure: string | null;
  backupDir: string;
  fixed: string[];
  notFixed: string[];
  /** Vulnerable name@version pairs present after the change that were not before. */
  introduced: string[];
  testsRan: boolean;
}

// The names npm gets on a shell command line on Windows. Legacy names may
// carry ' ! ( ) *, which cmd.exe would interpret, so those are left to the
// override/bump path or reported.
const SHELL_SAFE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function npm(args: string[], cwd: string): { ok: boolean; output: string } {
  const win = process.platform === "win32";
  // Child stdout goes to our stderr so --json output on stdout stays parseable.
  const r = spawnSync(win ? "npm.cmd" : "npm", args, { cwd, shell: win, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (output) process.stderr.write(output);
  return { ok: r.status === 0, output: r.error ? r.error.message : output };
}

function detectIndent(raw: string): string {
  return /^([ \t]+)"/m.exec(raw)?.[1] ?? "  ";
}

function hasRealTestScript(pkg: any): boolean {
  const t = pkg?.scripts?.test;
  return typeof t === "string" && !/no test specified/.test(t);
}

export async function applyFixes(dir: string, plan: FixPlan, sources: FixSources, opts: ApplyOptions): Promise<ApplyResult> {
  const pkgPath = join(dir, "package.json");
  const lockPath = lockfilePath(dir)!;
  const pkgRaw = readFileSync(pkgPath, "utf8");
  const lockRaw = readFileSync(lockPath, "utf8");
  const beforePairs = new Set([...readLockfile(dir).nodes.values()].map((n) => `${n.name}@${n.version}`));

  const backupDir = mkdtempSync(join(tmpdir(), "dep-rec-backup-"));
  writeFileSync(join(backupDir, "package.json"), pkgRaw);
  writeFileSync(join(backupDir, basename(lockPath)), lockRaw);

  const result: ApplyResult = {
    applied: false,
    rolledBack: false,
    failure: null,
    backupDir,
    fixed: [],
    notFixed: [],
    introduced: [],
    testsRan: false,
  };
  if (plan.fixes.length === 0) return result;

  const before = `--before=${plan.before}`;
  const quiet = ["--no-audit", "--no-fund"];

  const rollback = (failure: string): ApplyResult => {
    writeFileSync(pkgPath, pkgRaw);
    writeFileSync(lockPath, lockRaw);
    const restore = npm(["ci", ...quiet], dir);
    result.rolledBack = true;
    result.failure = restore.ok ? failure : `${failure}; then npm ci failed while restoring, so run it by hand (backup in ${backupDir})`;
    return result;
  };

  // 1. package.json: range bumps and overrides.
  const pkg = JSON.parse(pkgRaw);
  let pkgChanged = false;
  const ourKeys = new Set<string>();
  for (const f of plan.fixes) {
    if (f.bump && pkg[f.bump.field]?.[f.name] !== undefined) {
      pkg[f.bump.field][f.name] = f.bump.range;
      pkgChanged = true;
    }
    if (f.override) {
      pkg.overrides ??= {};
      const { key, value } = f.override;
      const existing = pkg.overrides[key];
      // Never replace an override the project already had; verification will
      // report the package as not fixed. Two copies on one line can plan the
      // same key in this run, though, and then the higher target wins.
      const prev = ourKeys.has(key) && typeof existing === "string" ? parse(existing) : null;
      const next = parse(value);
      if (existing === undefined || (prev && next && compare(next, prev) > 0)) {
        pkg.overrides[key] = value;
        ourKeys.add(key);
        pkgChanged = true;
      }
    }
  }

  // 2. npm resolves. --before keeps everything it picks past the cooldown.
  if (pkgChanged) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, detectIndent(pkgRaw)) + (pkgRaw.endsWith("\n") ? "\n" : ""));
    const r = npm(["install", before, ...quiet], dir);
    if (!r.ok) return rollback("npm install failed");
  }
  const updates = [...new Set(plan.fixes.filter((f) => f.strategy === "update").map((f) => f.name))];
  const unsafe = updates.filter((n) => !SHELL_SAFE_NAME.test(n));
  const safe = updates.filter((n) => SHELL_SAFE_NAME.test(n));
  if (safe.length > 0) {
    const r = npm(["update", ...safe, before, ...quiet], dir);
    if (!r.ok) return rollback("npm update failed");
  }
  result.applied = true;

  // 3. Verify against the same vulnerability data the plan used.
  const after = readLockfile(dir);
  const vulnCache = new Map<string, OsvVuln>();
  for (const f of plan.fixes) {
    const label = `${f.name}@${f.from}`;
    if (unsafe.includes(f.name)) {
      result.notFixed.push(`${label} (name needs a manual npm update)`);
      continue;
    }
    // Only copies on the fixed line count: another major of the same package
    // may be vulnerable too, but it was planned (or skipped) on its own.
    const from = parse(f.from)!;
    const onLine = [...after.nodes.values()].filter((n) => n.name === f.name && parse(n.version) && sameLine(from, parse(n.version)!));
    let still = false;
    for (const node of onLine) {
      for (const v of f.vulns) {
        if (!vulnCache.has(v.id)) vulnCache.set(v.id, await sources.getVuln(v.id));
        if (isAffected(vulnCache.get(v.id)!, f.name, node.version)) still = true;
      }
    }
    const now = [...new Set(onLine.map((n) => n.version))].join(", ") || "removed";
    (still ? result.notFixed : result.fixed).push(`${label} -> ${now}`);
  }

  // Anything vulnerable now that was not before is a regression.
  const newPairs = [...new Set([...after.nodes.values()].map((n) => `${n.name}@${n.version}`))].filter((p) => !beforePairs.has(p));
  if (newPairs.length > 0) {
    const split = newPairs.map((p) => ({ name: p.slice(0, p.lastIndexOf("@")), version: p.slice(p.lastIndexOf("@") + 1) }));
    const ids = await sources.queryBatch(split);
    result.introduced = newPairs.filter((_, i) => ids[i].length > 0);
    if (result.introduced.length > 0) return rollback(`the upgrade pulled in vulnerable versions: ${result.introduced.join(", ")}`);
  }

  // 4. The project's own tests.
  if (opts.runTests && hasRealTestScript(pkg)) {
    result.testsRan = true;
    const r = npm(["test"], dir);
    if (!r.ok) return rollback("npm test failed after the upgrade");
  }
  return result;
}
