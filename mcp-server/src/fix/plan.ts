// Plans `dep-rec fix`: find every vulnerable package in the lockfile, pick the
// smallest same-line upgrade that fixes all of its known vulnerabilities and
// has been public for the cooldown window, and decide how npm can be made to
// install it. Pure apart from the injected sources, so it is testable offline.
//
// Two things separate this from `npm audit fix`:
//   - Cooldown. audit fix happily installs a version published an hour ago,
//     which is exactly how a hijacked release spreads. Every target here is
//     at least COOLDOWN_DAYS old, and npm runs with --before so nothing else
//     it resolves on the way is newer either.
//   - Overrides. When a parent pins a vulnerable child outside the fixed
//     range, audit fix gives up; this writes a same-line `overrides` entry.
//
// Major upgrades are never planned, only reported.

import { COOLDOWN_DAYS } from "../store/version-safety.js";
import { fetchPackageDoc, type VersionEntry } from "../sources/npm.js";
import { fetchVulnerability, queryVulnerabilitiesBatch, type OsvVuln } from "../sources/osv.js";
import { compare, isPrerelease, lineRange, parse, sameLine, satisfies, type SemVer } from "./semver.js";
import type { DepField, Lockfile } from "./lockfile.js";

export interface FixSources {
  queryBatch(pairs: Array<{ name: string; version: string }>): Promise<string[][]>;
  getVuln(id: string): Promise<OsvVuln>;
  /** null when the registry could not answer. */
  versionHistory(name: string): Promise<VersionEntry[] | null>;
}

export interface VulnSummary {
  id: string;
  aliases: string[];
  severity: string | null;
  summary: string | null;
}

export type Strategy = "update" | "bump" | "override";

export interface PlannedFix {
  name: string;
  from: string;
  to: string;
  toAgeDays: number;
  vulns: VulnSummary[];
  /** Lockfile paths of the vulnerable copies. */
  paths: string[];
  dev: boolean;
  strategy: Strategy;
  /** strategy "bump": the direct dependency's new range. */
  bump?: { field: DepField; range: string };
  /** strategy "override": the `overrides` entry to add. */
  override?: { key: string; value: string };
}

export type SkipReason =
  | "fresh-only"
  | "major-only"
  | "no-fix"
  | "unparseable"
  | "registry-error"
  | "non-semver-range"
  | "override-conflict";

export interface SkippedVuln {
  name: string;
  version: string;
  vulns: VulnSummary[];
  paths: string[];
  dev: boolean;
  reason: SkipReason;
  detail: string;
}

export interface FixPlan {
  scanned: number;
  cooldownDays: number;
  /** ISO date passed to npm as --before. */
  before: string;
  fixes: PlannedFix[];
  skipped: SkippedVuln[];
}

const DAY = 86_400_000;
// Aged candidates re-checked against OSV per vulnerable package, in case the
// lowest fix for the known vulns carries a different one.
const MAX_TARGET_CHECKS = 20;

// ---------------------------------------------------------------------------
// OSV affected-range evaluation
// ---------------------------------------------------------------------------

function eventVersion(raw: string): SemVer | null {
  return raw === "0" ? { major: 0, minor: 0, patch: 0, pre: ["0"] } : parse(raw);
}

export function isAffected(vuln: OsvVuln, name: string, version: string): boolean {
  const ver = parse(version);
  if (!ver) return true;
  const entries = (vuln.affected ?? []).filter((a) => a.package?.ecosystem === "npm" && a.package?.name === name);
  // No usable data for this package: assume affected rather than claim a fix.
  if (entries.length === 0) return true;
  for (const entry of entries) {
    if (entry.versions?.includes(version)) return true;
    for (const range of entry.ranges ?? []) {
      if (range.type !== "SEMVER" && range.type !== "ECOSYSTEM") continue;
      const events = (range.events ?? [])
        .map((e) => {
          const raw = e.introduced ?? e.fixed ?? e.last_affected;
          const at = raw === undefined ? null : eventVersion(raw);
          return at ? { e, at } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => compare(a.at, b.at));
      let affected = false;
      for (const { e, at } of events) {
        const d = compare(ver, at);
        if (e.introduced !== undefined && d >= 0) affected = true;
        else if (e.fixed !== undefined && d >= 0) affected = false;
        else if (e.last_affected !== undefined && d > 0) affected = false;
      }
      if (affected) return true;
    }
  }
  return false;
}

function summarize(v: OsvVuln): VulnSummary {
  return {
    id: v.id,
    aliases: v.aliases ?? [],
    severity: v.database_specific?.severity ?? null,
    summary: v.summary ?? v.details?.split("\n")[0] ?? null,
  };
}

// Keeps the range's style: ^1.2.3 -> ^1.2.5, ~1.2.3 -> ~1.2.5, 1.2.3 -> 1.2.5.
function bumpedRange(range: string, to: string): string {
  const r = range.trim();
  if (r.startsWith("^")) return `^${to}`;
  if (r.startsWith("~")) return `~${to}`;
  if (parse(r)) return to;
  return `^${to}`;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export async function planFixes(lock: Lockfile, sources: FixSources, now = Date.now()): Promise<FixPlan> {
  const cutoff = now - COOLDOWN_DAYS * DAY;
  const plan: FixPlan = {
    scanned: 0,
    cooldownDays: COOLDOWN_DAYS,
    before: new Date(cutoff).toISOString(),
    fixes: [],
    skipped: [],
  };

  // One entry per distinct name@version, with every place it is installed.
  const groups = new Map<string, { name: string; version: string; paths: string[]; dev: boolean }>();
  for (const node of lock.nodes.values()) {
    const key = `${node.name}@${node.version}`;
    const g = groups.get(key) ?? { name: node.name, version: node.version, paths: [], dev: true };
    g.paths.push(node.path);
    g.dev &&= node.dev;
    groups.set(key, g);
  }
  const list = [...groups.values()];
  plan.scanned = list.length;

  const ids = await sources.queryBatch(list.map((g) => ({ name: g.name, version: g.version })));
  const vulnCache = new Map<string, OsvVuln>();
  const historyCache = new Map<string, VersionEntry[] | null>();
  const directEdges = new Map([...lock.edgesIn.values()].flat().filter((e) => e.from === "").map((e) => [e.name, e]));

  for (let i = 0; i < list.length; i++) {
    if (ids[i].length === 0) continue;
    const g = list[i];
    const vulns: OsvVuln[] = [];
    for (const id of ids[i]) {
      if (!vulnCache.has(id)) vulnCache.set(id, await sources.getVuln(id));
      vulns.push(vulnCache.get(id)!);
    }
    const summaries = vulns.map(summarize);
    const skip = (reason: SkipReason, detail: string) =>
      plan.skipped.push({ name: g.name, version: g.version, vulns: summaries, paths: g.paths, dev: g.dev, reason, detail });

    const current = parse(g.version);
    if (!current) {
      skip("unparseable", `installed version "${g.version}" is not semver`);
      continue;
    }
    if (!historyCache.has(g.name)) historyCache.set(g.name, await sources.versionHistory(g.name));
    const history = historyCache.get(g.name);
    if (!history) {
      skip("registry-error", "could not read the package's version history from the registry");
      continue;
    }

    const fixes = history
      .map((h) => ({ ...h, v: parse(h.version), ts: new Date(h.releasedAt).getTime() }))
      .filter((h): h is typeof h & { v: SemVer } => h.v !== null && !isPrerelease(h.v) && compare(h.v, current) > 0)
      .filter((h) => vulns.every((vuln) => !isAffected(vuln, g.name, h.version)))
      .sort((a, b) => compare(a.v, b.v));

    const onLine = fixes.filter((h) => sameLine(current, h.v));
    const aged = onLine.filter((h) => h.ts <= cutoff);
    if (aged.length === 0) {
      if (onLine.length > 0) {
        const f = onLine[0];
        skip("fresh-only", `fixed in ${f.version}, but it was published ${Math.floor((now - f.ts) / DAY)} days ago (cooldown is ${COOLDOWN_DAYS})`);
      } else if (fixes.length > 0) {
        skip("major-only", `only a breaking upgrade fixes it: ${fixes[0].version}`);
      } else {
        skip("no-fix", "no published version fixes it");
      }
      continue;
    }

    // The lowest fix for these vulns may carry a different one.
    const checks = aged.slice(0, MAX_TARGET_CHECKS);
    const checkIds = await sources.queryBatch(checks.map((h) => ({ name: g.name, version: h.version })));
    const targetIdx = checkIds.findIndex((x) => x.length === 0);
    if (targetIdx === -1) {
      skip("no-fix", `every cooldown-safe same-line fix checked (${checks.map((h) => h.version).join(", ")}) has other known vulnerabilities`);
      continue;
    }
    const target = checks[targetIdx];

    // How npm can be made to install it, judged across every vulnerable copy.
    const blocking = g.paths.flatMap((p) => (lock.edgesIn.get(p) ?? []).filter((e) => satisfies(target.version, e.range) !== true));
    const base = { name: g.name, from: g.version, to: target.version, toAgeDays: Math.floor((now - target.ts) / DAY), vulns: summaries, paths: g.paths, dev: g.dev };

    if (blocking.length === 0) {
      plan.fixes.push({ ...base, strategy: "update" });
      continue;
    }
    const direct = blocking.filter((e) => e.from === "");
    if (direct.some((e) => satisfies(target.version, e.range) === null)) {
      skip("non-semver-range", `package.json's range "${direct[0].range}" is not a semver range; change it by hand`);
      continue;
    }
    const bump = direct.length > 0 ? { field: direct[0].field, range: bumpedRange(direct[0].range, target.version) } : undefined;
    if (direct.length === blocking.length) {
      plan.fixes.push({ ...base, strategy: "bump", bump });
      continue;
    }
    // A transitive parent blocks it. npm refuses an override for a package the
    // project also depends on directly unless it defers to that spec ("$name"),
    // which is only safe when that spec is on the same line as the fix.
    const rootEdge = directEdges.get(g.name);
    if (rootEdge && !bump && satisfies(target.version, rootEdge.range) !== true) {
      skip(
        "override-conflict",
        `a dependency pins ${g.name}@${g.version}, and an override would collide with the project's own "${rootEdge.range}"; ` +
          `upgrade the parent (${blocking.find((e) => e.from !== "")!.from}) instead`,
      );
      continue;
    }
    plan.fixes.push({
      ...base,
      strategy: "override",
      bump,
      override: { key: `${g.name}@${lineRange(current)}`, value: rootEdge ? `$${g.name}` : target.version },
    });
  }
  return plan;
}

export const liveSources: FixSources = {
  queryBatch: queryVulnerabilitiesBatch,
  getVuln: fetchVulnerability,
  async versionHistory(name) {
    const doc = await fetchPackageDoc(name);
    return doc.found ? doc.versionHistory : null;
  },
};
