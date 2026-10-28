// `dep-rec fix` planning, offline: the semver subset, lockfile edge
// resolution, OSV range evaluation, and how each vulnerable copy is routed to
// update / bump / override / skip. Network sources are faked.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { satisfies, sameLine, parse, lineRange } from "../src/fix/semver.js";
import { readLockfile } from "../src/fix/lockfile.js";
import { planFixes, isAffected, type FixSources } from "../src/fix/plan.js";
import type { OsvVuln } from "../src/sources/osv.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("fix — semver ranges", () => {
  const cases: Array<[string, string, boolean | null]> = [
    ["1.2.6", "^1.2.0", true],
    ["2.0.0", "^1.2.0", false],
    ["0.3.1", "^0.3.0", true],
    ["0.4.0", "^0.3.0", false],
    ["0.0.4", "^0.0.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.2.6", "1.2.5", false],
    ["1.2.6", "1.2.x", true],
    ["1.9.0", "1", true],
    ["1.5.0", ">=1.2.0 <2.0.0", true],
    ["1.5.0", "1.0.0 - 1.4.0", false],
    ["1.4.9", "1.0.0 - 1.4", true],
    ["3.0.0", "^1.0.0 || ^3.0.0", true],
    ["5.0.0", "*", true],
    ["5.0.0", "", true],
    ["2.0.0-beta.1", "^1.0.0", false],
    ["1.2.4-rc.1", ">=1.2.4-rc.0 <1.3.0", true],
    ["1.0.0", "github:user/repo", null],
    ["1.0.0", "latest", null],
    ["1.0.0", "file:../x", null],
  ];
  for (const [version, range, expected] of cases) {
    test(`${version} vs "${range}" -> ${expected}`, () => assert.equal(satisfies(version, range), expected));
  }

  test("sameLine follows caret semantics, so 0.x minors count as breaking", () => {
    assert.equal(sameLine(parse("1.2.5")!, parse("1.9.0")!), true);
    assert.equal(sameLine(parse("1.2.5")!, parse("2.0.0")!), false);
    assert.equal(sameLine(parse("0.3.1")!, parse("0.3.9")!), true);
    assert.equal(sameLine(parse("0.3.1")!, parse("0.4.0")!), false);
    assert.equal(sameLine(parse("0.0.3")!, parse("0.0.4")!), false);
    assert.equal(lineRange(parse("1.2.5")!), "1");
    assert.equal(lineRange(parse("0.3.1")!), "0.3");
  });
});

describe("fix — OSV affected ranges", () => {
  const vuln: OsvVuln = {
    id: "V",
    affected: [
      { package: { ecosystem: "npm", name: "a" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.6" }] }] },
      { package: { ecosystem: "npm", name: "a" }, ranges: [{ type: "SEMVER", events: [{ introduced: "2.0.0" }, { last_affected: "2.1.0" }] }] },
    ],
  };
  test("introduced/fixed and introduced/last_affected", () => {
    assert.equal(isAffected(vuln, "a", "1.2.5"), true);
    assert.equal(isAffected(vuln, "a", "1.2.6"), false);
    assert.equal(isAffected(vuln, "a", "2.1.0"), true);
    assert.equal(isAffected(vuln, "a", "2.1.1"), false);
  });
  test("no data for the package counts as affected, never as fixed", () => {
    assert.equal(isAffected(vuln, "other", "9.9.9"), true);
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function project(packages: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "dep-rec-fix-"));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  return dir;
}

const fixedAt = (name: string, fixed: string, id = `V-${name}-${fixed}`): OsvVuln => ({
  id,
  database_specific: { severity: "HIGH" },
  affected: [{ package: { ecosystem: "npm", name }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed }] }] }],
});

function sources(vulns: OsvVuln[], history: Record<string, Array<[string, number]>>): FixSources {
  return {
    async queryBatch(pairs) {
      return pairs.map((p) => vulns.filter((v) => isAffected(v, p.name, p.version) && v.affected!.some((a) => a.package?.name === p.name)).map((v) => v.id));
    },
    async getVuln(id) {
      return vulns.find((v) => v.id === id)!;
    },
    async versionHistory(name) {
      return (history[name] ?? []).map(([version, days]) => ({ version, releasedAt: ago(days) }));
    },
  };
}

const A_HISTORY: Record<string, Array<[string, number]>> = {
  a: [["1.2.5", 400], ["1.2.6", 300], ["1.2.7", 5], ["2.0.0", 200]],
};

describe("fix — planning", () => {
  test("a range every requester admits becomes an update", async () => {
    const dir = project({ "": { dependencies: { a: "^1.2.0" } }, "node_modules/a": { version: "1.2.5" } });
    const plan = await planFixes(readLockfile(dir), sources([fixedAt("a", "1.2.6")], A_HISTORY), NOW);
    assert.equal(plan.fixes.length, 1);
    assert.deepEqual([plan.fixes[0].strategy, plan.fixes[0].to], ["update", "1.2.6"]);
    assert.equal(plan.before, ago(30));
  });

  test("an exact direct pin becomes a bump that keeps the pin style", async () => {
    const dir = project({ "": { devDependencies: { a: "1.2.5" } }, "node_modules/a": { version: "1.2.5", dev: true } });
    const plan = await planFixes(readLockfile(dir), sources([fixedAt("a", "1.2.6")], A_HISTORY), NOW);
    assert.equal(plan.fixes[0].strategy, "bump");
    assert.deepEqual(plan.fixes[0].bump, { field: "devDependencies", range: "1.2.6" });
    assert.equal(plan.fixes[0].dev, true);
  });

  test("a transitive pin becomes a same-line override", async () => {
    const dir = project({
      "": { dependencies: { p: "^1.0.0" } },
      "node_modules/p": { version: "1.0.0", dependencies: { a: "1.2.5" } },
      "node_modules/a": { version: "1.2.5" },
    });
    const plan = await planFixes(readLockfile(dir), sources([fixedAt("a", "1.2.6")], A_HISTORY), NOW);
    assert.equal(plan.fixes[0].strategy, "override");
    assert.deepEqual(plan.fixes[0].override, { key: "a@1", value: "1.2.6" });
  });

  test("an override on a package the project also depends on defers to its spec", async () => {
    const dir = project({
      "": { dependencies: { p: "^1.0.0", a: "^1.2.0" } },
      "node_modules/p": { version: "1.0.0", dependencies: { a: "1.2.5" } },
      "node_modules/a": { version: "1.2.5" },
    });
    const plan = await planFixes(readLockfile(dir), sources([fixedAt("a", "1.2.6")], A_HISTORY), NOW);
    assert.deepEqual(plan.fixes[0].override, { key: "a@1", value: "$a" });
  });

  test("an override that would collide with a direct dep on another major is skipped", async () => {
    const dir = project({
      "": { dependencies: { p: "^1.0.0", a: "^2.0.0" } },
      "node_modules/p": { version: "1.0.0", dependencies: { a: "1.2.5" } },
      "node_modules/p/node_modules/a": { version: "1.2.5" },
      "node_modules/a": { version: "2.0.0" },
    });
    const plan = await planFixes(readLockfile(dir), sources([fixedAt("a", "1.2.6")], A_HISTORY), NOW);
    assert.equal(plan.fixes.length, 0);
    assert.equal(plan.skipped[0].reason, "override-conflict");
  });

  test("a fix younger than the cooldown is reported, not applied", async () => {
    const dir = project({ "": { dependencies: { a: "^1.2.0" } }, "node_modules/a": { version: "1.2.5" } });
    const plan = await planFixes(readLockfile(dir), sources([fixedAt("a", "1.2.7")], A_HISTORY), NOW);
    assert.equal(plan.fixes.length, 0);
    assert.equal(plan.skipped[0].reason, "fresh-only");
    assert.match(plan.skipped[0].detail, /1\.2\.7.*5 days/);
  });

  test("a fix only in the next major is reported, not applied", async () => {
    const dir = project({ "": { dependencies: { a: "^1.2.0" } }, "node_modules/a": { version: "1.2.5" } });
    const plan = await planFixes(readLockfile(dir), sources([fixedAt("a", "2.0.0")], A_HISTORY), NOW);
    assert.equal(plan.skipped[0].reason, "major-only");
  });

  test("the lowest fix is passed over when it carries a different vulnerability", async () => {
    const other: OsvVuln = {
      id: "V-other",
      affected: [{ package: { ecosystem: "npm", name: "a" }, versions: ["1.2.6"] }],
    };
    const history = { a: [["1.2.5", 400], ["1.2.6", 300], ["1.2.8", 100]] as Array<[string, number]> };
    const dir = project({ "": { dependencies: { a: "^1.2.0" } }, "node_modules/a": { version: "1.2.5" } });
    const plan = await planFixes(readLockfile(dir), sources([fixedAt("a", "1.2.6"), other], history), NOW);
    assert.equal(plan.fixes[0].to, "1.2.8");
  });

  test("a v1 lockfile is refused with an actionable message", () => {
    const dir = mkdtempSync(join(tmpdir(), "dep-rec-fix-"));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
    assert.throws(() => readLockfile(dir), /v2 or v3/);
  });
});
