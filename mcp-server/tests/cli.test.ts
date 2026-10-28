// The CLI is a separate product surface from the MCP server: different
// parsing, different output contract, different failure modes. It is what a
// human or a non-MCP-aware script/agent actually touches, so it gets tested
// on its own terms — argument handling, exit codes, stream discipline, and
// output that stays machine-parseable under --json no matter what.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, copyFreshStore, REPO_ROOT, INVALID_NAMES, HOSTILE_NAMES } from "./helpers.js";

let dbPath: string;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), "dep-rec-cli-"));
  dbPath = join(dir, "store.json");
  copyFreshStore(dbPath);
});

describe("CLI — help and dispatch", () => {
  test("bare invocation prints usage and exits 0", async () => {
    const r = await runCli([], { dbPath });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /dep-rec check/);
    assert.match(r.stdout, /dep-rec recommend/);
    assert.match(r.stdout, /dep-rec categories/);
  });

  for (const flag of ["--help", "-h", "help"]) {
    test(`${flag} prints usage and exits 0`, async () => {
      const r = await runCli([flag], { dbPath });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Usage:/);
    });
  }

  test("an unknown command exits non-zero and says so on stderr", async () => {
    const r = await runCli(["explode"], { dbPath });
    assert.notEqual(r.code, 0, "an unknown command must not report success");
    assert.match(r.stderr, /Unknown command/i);
    assert.equal(r.stdout, "", "usage errors belong on stderr, not stdout");
  });

  test("a command-shaped flag is not mistaken for a command", async () => {
    const r = await runCli(["--json"], { dbPath });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Unknown command/i);
  });

  test("commands are case-sensitive (CHECK is not check)", async () => {
    const r = await runCli(["CHECK", "zod"], { dbPath });
    assert.notEqual(r.code, 0);
  });
});

describe("CLI — check", () => {
  test("a cached corpus package resolves from the store with no network", async () => {
    const r = await runCli(["check", "zod", "--json"], { dbPath });
    assert.equal(r.code, 0);
    assert.equal(r.jsonParseError, undefined, `--json emitted unparseable output: ${r.jsonParseError}`);
    assert.equal(r.json.name, "zod");
    assert.equal(r.json.found, true);
    assert.equal(r.json.servedFrom, "cache");
    assert.ok(typeof r.json.score === "number");
  });

  test("missing package argument exits non-zero with usage on stderr", async () => {
    const r = await runCli(["check"], { dbPath });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Usage: dep-rec check/);
  });

  test("a nonexistent package is reported as not found, and does not exit 0 silently lying", async () => {
    const r = await runCli(["check", "dep-rec-test-nope-xyz-000", "--json"], { dbPath });
    assert.equal(r.jsonParseError, undefined);
    assert.equal(r.json.found, false);
    assert.equal(r.json.score, undefined, "an unresolvable package must not carry a score");

    // The hallucination warning is tied to a real 404 and nothing else. If
    // the registry is unreachable when this runs, the correct answer is
    // "registry-error" and the warning must be ABSENT — asserting it
    // unconditionally is what the old, lying implementation would pass.
    if (r.json.reasonCode === "not-found") {
      assert.match(r.json.reason, /does not exist/i);
      assert.match(r.json.note, /hallucinated|typosquat/i);
    } else {
      assert.equal(r.json.reasonCode, "registry-error", `unexpected miss code: ${r.json.reasonCode}`);
      assert.doesNotMatch(r.json.note, /hallucinated|typosquat/i, "an unreachable registry is not evidence of a fake name");
    }
  });

  test("human output for a not-found package is clearly negative", async () => {
    const r = await runCli(["check", "dep-rec-test-nope-xyz-000"], { dbPath });
    assert.match(r.stdout, /✗/);
    assert.doesNotMatch(r.stdout, /✓/, "must not show a success marker for a package that does not exist");
  });

  test("human output is not raw JSON when --json is absent", async () => {
    const r = await runCli(["check", "zod"], { dbPath });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.trim().startsWith("{"), "default output should be human-readable");
    assert.match(r.stdout, /zod/);
    assert.match(r.stdout, /score/);
  });

  test("download counts use international grouping, not the host locale", async () => {
    // A previous release printed 23,91,77,371 (Indian grouping) because
    // toLocaleString() inherited the machine locale.
    const r = await runCli(["check", "zod"], { dbPath });
    const grouped = r.stdout.match(/[\d,]{7,}/g) ?? [];
    assert.ok(grouped.length > 0, "expected a grouped number in the output");
    for (const g of grouped) {
      const parts = g.split(",");
      for (const p of parts.slice(1)) {
        assert.equal(p.length, 3, `"${g}" is not grouped in thousands — locale leaked into output`);
      }
    }
  });

  test("--json and human output agree on the verdict", async () => {
    const [j, h] = await Promise.all([
      runCli(["check", "zod", "--json"], { dbPath }),
      runCli(["check", "zod"], { dbPath }),
    ]);
    assert.ok(h.stdout.includes(String(j.json.score)), "human output must show the same score as --json");
  });

  test("repeated checks are stable (no score drift between identical calls)", async () => {
    const a = await runCli(["check", "zod", "--json"], { dbPath });
    const b = await runCli(["check", "zod", "--json"], { dbPath });
    assert.equal(a.json.score, b.json.score);
    assert.deepEqual(a.json.reasons, b.json.reasons);
  });

  test("a capability-caveated package leads with its warning", async () => {
    const r = await runCli(["check", "jwt-decode", "--json"], { dbPath });
    assert.equal(r.json.found, true);
    assert.match(r.json.reasons[0], /⚠/, "the caveat must be the first reason, not buried");
    assert.match(r.json.reasons[0], /DECODE-ONLY/i);
  });

  test("scoped package names are handled", async () => {
    const r = await runCli(["check", "@modelcontextprotocol/sdk", "--json"], { dbPath });
    assert.equal(r.jsonParseError, undefined);
    assert.equal(r.json.found, true);
    assert.equal(r.json.name, "@modelcontextprotocol/sdk");
  });

  test("a package name that looks like a flag is not swallowed by the parser", async () => {
    const r = await runCli(["check", "--not-a-package"], { dbPath });
    // Either it is rejected as an unknown option, or treated as a name and
    // reported not-found. It must not silently succeed with a score.
    assert.ok(r.code !== 0 || r.json?.found === false, "an option-shaped name must not produce a scored result");
  });
});

describe("CLI — recommend", () => {
  test("a matched category returns ranked results", async () => {
    const r = await runCli(["recommend", "jwt library", "--json"], { dbPath });
    assert.equal(r.code, 0);
    assert.equal(r.jsonParseError, undefined);
    assert.equal(r.json.matchedCategory, "auth-jwt");
    assert.ok(Array.isArray(r.json.recommendations));
    assert.ok(r.json.recommendations.length > 0);
  });

  test("results are ordered by descending score", async () => {
    const r = await runCli(["recommend", "csv parser", "--limit", "8", "--json"], { dbPath });
    const scores = r.json.recommendations.map((x: any) => x.score);
    const sorted = [...scores].sort((a, b) => b - a);
    assert.deepEqual(scores, sorted, "recommendations must be ranked");
  });

  test("the decode-only JWT library does not lead the auth-jwt category", async () => {
    const r = await runCli(["recommend", "jwt library", "--limit", "3", "--json"], { dbPath });
    const top = r.json.recommendations[0].package;
    assert.notEqual(top, "jwt-decode", "a decode-only library must not be the top auth recommendation");
  });

  test("--limit is respected", async () => {
    for (const n of [1, 2, 5]) {
      const r = await runCli(["recommend", "logger", "--limit", String(n), "--json"], { dbPath });
      assert.equal(r.json.recommendations.length, n);
    }
  });

  test("--limit outside the documented range is rejected or clamped, never crashes", async () => {
    for (const bad of ["0", "-1", "9999", "abc", "1.5", "1e9", "Infinity", "NaN"]) {
      const r = await runCli(["recommend", "logger", "--limit", bad, "--json"], { dbPath });
      if (r.code === 0) {
        assert.equal(r.jsonParseError, undefined, `--limit ${bad} produced unparseable JSON`);
        const n = r.json.recommendations.length;
        assert.ok(n >= 0 && n <= 500, `--limit ${bad} returned ${n} results`);
      } else {
        assert.ok(r.stderr.length > 0, `--limit ${bad} failed without explanation`);
      }
    }
  });

  test("--license filters to exactly that license", async () => {
    const r = await runCli(["recommend", "orm", "--license", "MIT", "--limit", "10", "--json"], { dbPath });
    for (const rec of r.json.recommendations) {
      assert.equal(rec.license, "MIT");
    }
  });

  test("an unsatisfiable license filter returns empty rather than ignoring the filter", async () => {
    const r = await runCli(["recommend", "orm", "--license", "NoSuchLicense-9.9", "--json"], { dbPath });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.recommendations, [], "a filter that matches nothing must not silently fall back");
  });

  test("--runtime edge attaches the honesty caveat about untested edge support", async () => {
    const r = await runCli(["recommend", "jwt library", "--runtime", "edge", "--json"], { dbPath });
    assert.ok(r.json.caveats.length > 0);
    assert.match(r.json.caveats[0], /NOT been sandbox-tested|weak proxy/i);
  });

  test("--runtime with an invalid value is rejected, not silently ignored", async () => {
    const r = await runCli(["recommend", "jwt library", "--runtime", "deno"], { dbPath });
    assert.notEqual(r.code, 0, "an unsupported runtime must be an error, not a silent no-op");
    assert.match(r.stderr, /runtime/i);
  });

  test("an unmatched need is routed to discovery and says so", async () => {
    const r = await runCli(["recommend", "quantum flux capacitor harness", "--json"], { dbPath, timeoutMs: 120_000 });
    assert.equal(r.json.matchedCategory, null);
    assert.equal(r.json.discoveredVia, "npm-search");
    // Provenance must be disclosed; the internal taxonomy must not be. The
    // caveat used to be required to name the categories — that is the thing
    // being fixed, so this now asserts the opposite.
    assert.match(r.json.note, /discovered via npm search/i);
    assert.ok(
      !r.json.caveats.some((x) => x.includes("auth-jwt")),
      "the caveat must not recite internal category keys at the caller"
    );
  });

  test("missing need argument exits non-zero", async () => {
    const r = await runCli(["recommend"], { dbPath });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Usage: dep-rec recommend/);
  });

  test("a multi-word need does not require quoting", async () => {
    const r = await runCli(["recommend", "postgres", "orm", "--json"], { dbPath });
    assert.equal(r.code, 0);
    assert.equal(r.json.matchedCategory, "orm-database");
  });

  test("every recommendation carries reasons", async () => {
    const r = await runCli(["recommend", "testing", "--limit", "10", "--json"], { dbPath });
    for (const rec of r.json.recommendations) {
      assert.ok(Array.isArray(rec.reasons) && rec.reasons.length > 0, `${rec.package} has no reasons`);
    }
  });

  test("every recommendation clears the eligibility bar", async () => {
    const { MIN_WEEKLY_DOWNLOADS } = await import("../src/store/eligibility.js");
    for (const need of ["jwt library", "csv parser", "logger", "orm", "testing", "http client", "date", "web framework", "validation", "state management"]) {
      const r = await runCli(["recommend", need, "--limit", "5", "--json"], { dbPath });
      for (const rec of r.json.recommendations) {
        assert.ok(
          rec.weeklyDownloads >= MIN_WEEKLY_DOWNLOADS,
          `${need}: recommended ${rec.package} with only ${rec.weeklyDownloads} weekly downloads`
        );
      }
    }
  });

  test("the count of packages excluded by the gate is disclosed, not hidden", async () => {
    const r = await runCli(["recommend", "csv parser", "--json"], { dbPath });
    assert.equal(typeof r.json.excludedAsUnrecommendable, "number");
    assert.ok(r.json.excludedAsUnrecommendable > 0, "the csv category is known to contain unrecommendable entries");
  });

  test("no recommendation is a deprecated package", async () => {
    for (const need of ["jwt library", "csv parser", "logger", "orm", "testing", "http client"]) {
      const r = await runCli(["recommend", need, "--limit", "5", "--json"], { dbPath });
      for (const rec of r.json.recommendations) {
        assert.ok(
          !rec.reasons.some((x: string) => /deprecated/i.test(x)),
          `${need}: recommended deprecated package ${rec.package}`
        );
      }
    }
  });
});

describe("CLI — categories", () => {
  test("lists all ten categories with counts", async () => {
    const r = await runCli(["categories", "--json"], { dbPath });
    assert.equal(r.code, 0);
    assert.equal(r.json.length, 10);
    for (const c of r.json) {
      assert.ok(typeof c.key === "string" && c.key.length > 0);
      assert.ok(Number.isInteger(c.count) && c.count > 0);
    }
  });

  test("human output is readable and lists every category", async () => {
    const r = await runCli(["categories"], { dbPath });
    for (const key of ["auth-jwt", "csv-parsing", "orm-database", "testing", "web-framework"]) {
      assert.ok(r.stdout.includes(key), `missing ${key}`);
    }
  });

  test("rejects stray positional arguments with a clean message, not a stack trace", async () => {
    const r = await runCli(["categories", "extra", "args"], { dbPath });
    assert.notEqual(r.code, 0, "strict argument handling should surface the mistake");
    assert.match(r.stderr, /Unexpected argument/i);
    assert.doesNotMatch(r.stderr, /at \w+ \(|node:internal/, "an argument mistake must not dump a stack trace at the user");
  });
});

describe("CLI — hostile input must not crash, lie, or escape", () => {
  for (const name of INVALID_NAMES.slice(0, 18)) {
    test(`check ${JSON.stringify(name.slice(0, 24))} is handled`, async () => {
      const r = await runCli(["check", name, "--json"], { dbPath, timeoutMs: 30_000 });
      assert.notEqual(r.code, null, "must not hang");
      if (r.code === 0) {
        assert.equal(r.jsonParseError, undefined, "output must stay parseable");
        assert.equal(r.json.found, false, `structurally invalid name reported as a real package`);
      } else {
        assert.ok(r.stderr.length > 0, "a non-zero exit must explain itself");
      }
      assert.doesNotMatch(r.stderr, /ENOENT.*store\.db/i, "must not lose the database");
    });
  }

  // Null bytes are excluded here because the OS process boundary rejects them
  // outright — they cannot reach a CLI through argv at all. They are still
  // exercised directly against the matcher in unit-typosquat.test.ts, which is
  // the layer where they could actually arrive (via MCP JSON, say).
  const argvSafeHostile = HOSTILE_NAMES.filter((n) => !n.includes("\0")).slice(0, 16);

  for (const name of argvSafeHostile) {
    test(`check ${JSON.stringify(name.slice(0, 24))} does not traverse or inject`, async () => {
      const r = await runCli(["check", name, "--json"], { dbPath, timeoutMs: 30_000 });
      assert.notEqual(r.code, null, "must not hang");
      // Nothing that looks like file contents or a SQL error may surface.
      assert.doesNotMatch(r.stdout + r.stderr, /root:x:0:0|\[boot loader\]/i, "possible file disclosure");
      assert.doesNotMatch(r.stderr, /SQLITE_ERROR|syntax error/i, "input reached the SQL layer");
      if (r.code === 0 && r.json) {
        assert.notEqual(r.json.found, true, `hostile input scored as a real package: ${name}`);
      }
    });
  }

  test("the database still holds the full corpus after the hostile sweep", async () => {
    const r = await runCli(["categories", "--json"], { dbPath });
    assert.equal(r.code, 0);
    // Counts are of recommendable packages, not everything tracked, so this is
    // a floor well below the raw corpus size rather than an exact figure.
    const total = r.json.reduce((sum: number, c: any) => sum + c.count, 0);
    assert.ok(total >= 200, `recommendable corpus shrank to ${total} after hostile input — data loss`);
    assert.equal(r.json.length, 10, "a category must never disappear entirely");
  });

  test("a check against an unwritable database path fails loudly rather than silently", async () => {
    const r = await runCli(["check", "zod", "--json"], {
      dbPath: join(tmpdir(), "dep-rec-nonexistent-dir-xyz", "store.json"),
      timeoutMs: 30_000,
    });
    assert.notEqual(r.code, 0, "an unusable database must be an error, not an empty success");
    assert.ok(r.stderr.length > 0);
  });

  test("with no --db, lookups write a per-user store and never the shipped one", async () => {
    const home = mkdtempSync(join(tmpdir(), "dep-rec-home-"));
    const shipped = join(REPO_ROOT, "data/store.json");
    const before = statSync(shipped).mtimeMs;

    const cats = await runCli(["categories", "--json"], {}, { HOME: home, USERPROFILE: home });
    assert.equal(cats.code, 0, cats.stderr);
    assert.equal(cats.json.length, 10, "a missing per-user store must read as the shipped corpus");

    const r = await runCli(["check", "zod", "--json"], { timeoutMs: 60_000 }, { HOME: home, USERPROFILE: home });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(home, ".dep-rec", "store.json")), "the first write must create ~/.dep-rec/store.json");
    assert.equal(statSync(shipped).mtimeMs, before, "the shipped store must not be written");
  });
});

// Real npm, real registry and OSV: minimist 1.2.5 carries GHSA-xvch-5gv4-984h,
// fixed in 1.2.6 (2022), so the fix is long past the cooldown.
describe("CLI — fix", () => {
  function vulnerableProject(testScript?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "dep-rec-fixcli-"));
    const pkg: Record<string, unknown> = { name: "fixture", version: "1.0.0", private: true };
    if (testScript) pkg.scripts = { test: testScript };
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    const win = process.platform === "win32";
    const r = spawnSync(win ? "npm.cmd" : "npm", ["install", "minimist@1.2.5", "--save-exact", "--no-audit", "--no-fund"], { cwd: dir, shell: win });
    assert.equal(r.status, 0, String(r.stderr));
    return dir;
  }

  test("dry run plans the fix, changes nothing, and exits 2", async () => {
    const dir = vulnerableProject();
    const before = readFileSync(join(dir, "package.json"), "utf8");
    const r = await runCli(["fix", "--dir", dir, "--json"], { timeoutMs: 60_000 });
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.json.fixes[0].name, "minimist");
    assert.equal(r.json.fixes[0].strategy, "bump");
    assert.equal(r.json.applied, null);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), before);
  });

  test("--apply bumps the pin and the lockfile follows", async () => {
    const dir = vulnerableProject();
    const r = await runCli(["fix", "--dir", dir, "--apply", "--json"], { timeoutMs: 120_000 });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.applied.notFixed, []);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies.minimist, r.json.fixes[0].to);
    assert.equal(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")).packages["node_modules/minimist"].version, r.json.fixes[0].to);
  });

  test("--apply restores everything when the project's tests fail", async () => {
    const dir = vulnerableProject("exit 1");
    const before = readFileSync(join(dir, "package.json"), "utf8");
    const r = await runCli(["fix", "--dir", dir, "--apply", "--json"], { timeoutMs: 120_000 });
    assert.equal(r.code, 1);
    assert.equal(r.json.applied.rolledBack, true);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), before);
    assert.equal(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")).packages["node_modules/minimist"].version, "1.2.5");
  });
});
