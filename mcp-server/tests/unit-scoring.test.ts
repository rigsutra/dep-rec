// Scoring is the part of this project that has already shipped two real bugs
// (name-only OSV queries inflating vuln counts; a zero-sum supply-chain
// percentile). These tests pin the invariants those bugs violated, then push
// on shapes the real registry would rarely produce.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scoreAbsolute, scoreCategoryGroup, type ScoreResult } from "../src/store/scoring.js";
import { CAPABILITY_CAVEATS, CAPABILITY_CAVEAT_PENALTY } from "../src/store/capability-caveats.js";
import { resolveRecommendedVersion } from "../src/store/version-safety.js";
import { row, iso } from "./helpers.js";

const SUBSCORES = ["security", "maintenance", "compatibility", "community", "supplyChain"] as const;

function assertWellFormed(s: ScoreResult, label: string) {
  for (const key of [...SUBSCORES, "total"] as const) {
    const v = s[key];
    assert.ok(Number.isFinite(v), `${label}: ${key} must be finite, got ${v}`);
    assert.ok(v >= 0 && v <= 100, `${label}: ${key} must be within 0..100, got ${v}`);
  }
  assert.ok(Array.isArray(s.reasons), `${label}: reasons must be an array`);
  assert.ok(s.reasons.length > 0, `${label}: must always explain itself with at least one reason`);
  for (const r of s.reasons) {
    assert.equal(typeof r, "string", `${label}: every reason must be a string`);
    assert.ok(r.trim().length > 0, `${label}: no empty reason strings`);
  }
}

describe("scoreAbsolute — well-formedness under hostile inputs", () => {
  const cases: Array<[string, Parameters<typeof row>[0]]> = [
    ["baseline", {}],
    ["zero downloads", { weekly_downloads: 0 }],
    ["negative downloads (impossible via API, defensive)", { weekly_downloads: -5000 }],
    ["absurd downloads", { weekly_downloads: Number.MAX_SAFE_INTEGER }],
    ["zero maintainers", { maintainers: 0 }],
    ["absurd maintainers", { maintainers: 100_000 }],
    ["negative maintainers", { maintainers: -3 }],
    ["zero deps", { dependencies_count: 0 }],
    ["absurd deps", { dependencies_count: 5_000 }],
    ["negative deps", { dependencies_count: -10 }],
    ["null modified_at", { modified_at: null }],
    ["null created_at", { created_at: null }],
    ["null cadence", { release_cadence_days: null }],
    ["negative cadence", { release_cadence_days: -50 }],
    ["absurd cadence", { release_cadence_days: 500_000 }],
    ["modified in the future", { modified_at: iso(-3650) }],
    ["unparseable modified_at", { modified_at: "not-a-date" }],
    ["empty-string modified_at", { modified_at: "" }],
    ["deprecated", { deprecated: true }],
    ["deprecated + vulns + no compat + install scripts (worst case)", {
      deprecated: true,
      vulnerability_ids: ["A", "B", "C", "D", "E", "F", "G", "H"],
      esm_support: false,
      typescript_support: false,
      has_install_scripts: true,
      dependencies_count: 300,
      weekly_downloads: 0,
      maintainers: 0,
      modified_at: iso(5000),
    }],
    ["perfect case", {
      deprecated: false,
      vulnerability_ids: [],
      esm_support: true,
      typescript_support: true,
      has_install_scripts: false,
      dependencies_count: 0,
      weekly_downloads: 500_000_000,
      maintainers: 40,
      modified_at: iso(0),
      release_cadence_days: 1,
    }],
    ["huge vuln list", { vulnerability_ids: Array.from({ length: 500 }, (_, i) => `GHSA-${i}`) }],
    ["security check failed, no prior vulns", { security_check_failed: true }],
    ["security check failed, with prior vulns", { security_check_failed: true, vulnerability_ids: ["GHSA-x"] }],
    ["install scripts with zero deps", { has_install_scripts: true, dependencies_count: 0 }],
    ["unicode name", { name: "пакет" }],
    ["very long name", { name: "x".repeat(214) }],
  ];

  for (const [label, overrides] of cases) {
    test(label, () => assertWellFormed(scoreAbsolute(row(overrides)), label));
  }
});

describe("scoreAbsolute — semantics that must hold", () => {
  test("is deterministic across repeated calls", () => {
    const r = row({ name: "determinism-probe" });
    const a = scoreAbsolute(r);
    const b = scoreAbsolute(r);
    assert.deepEqual(a, b);
  });

  test("more vulnerabilities never raises the security sub-score", () => {
    let prev = 101;
    for (const n of [0, 1, 2, 3, 4, 8, 50]) {
      const s = scoreAbsolute(row({ vulnerability_ids: Array.from({ length: n }, (_, i) => `V${i}`) }));
      assert.ok(s.security <= prev, `security rose from ${prev} to ${s.security} at ${n} vulns`);
      prev = s.security;
    }
  });

  test("more direct dependencies never raises the supply-chain sub-score", () => {
    let prev = 101;
    for (const n of [0, 1, 5, 20, 49, 50, 100, 500]) {
      const s = scoreAbsolute(row({ dependencies_count: n }));
      assert.ok(s.supplyChain <= prev, `supplyChain rose from ${prev} to ${s.supplyChain} at ${n} deps`);
      prev = s.supplyChain;
    }
  });

  test("deprecation strictly lowers security", () => {
    const clean = scoreAbsolute(row({ deprecated: false }));
    const dep = scoreAbsolute(row({ deprecated: true }));
    assert.ok(dep.security < clean.security, "deprecated package should score lower on security");
    assert.ok(dep.reasons.some((r) => /deprecated/i.test(r)), "must say it is deprecated");
  });

  test("install scripts strictly lower supply chain and are called out", () => {
    const without = scoreAbsolute(row({ has_install_scripts: false, dependencies_count: 5 }));
    const withScripts = scoreAbsolute(row({ has_install_scripts: true, dependencies_count: 5 }));
    assert.ok(withScripts.supplyChain < without.supplyChain);
    assert.ok(
      withScripts.reasons.some((r) => /install/i.test(r) && /script/i.test(r)),
      "must warn that install scripts execute code"
    );
  });

  test("install-script penalty outweighs a moderate dependency count", () => {
    const manyDeps = scoreAbsolute(row({ dependencies_count: 15, has_install_scripts: false }));
    const oneScript = scoreAbsolute(row({ dependencies_count: 0, has_install_scripts: true }));
    assert.ok(
      oneScript.supplyChain < manyDeps.supplyChain,
      "an install script should be treated as worse than 15 ordinary dependencies"
    );
  });

  test("a failed security check never claims the package is clean", () => {
    const s = scoreAbsolute(row({ security_check_failed: true, vulnerability_ids: [] }));
    assert.ok(
      !s.reasons.some((r) => /^no known vulnerabilit/i.test(r.trim())),
      `must not assert cleanliness when the check failed. reasons: ${JSON.stringify(s.reasons)}`
    );
    assert.ok(
      s.reasons.some((r) => /could not be verified|unreachable|unknown/i.test(r)),
      "must state the check could not be verified"
    );
  });

  test("a failed security check scores no higher than a verified-clean one", () => {
    const verified = scoreAbsolute(row({ security_check_failed: false, vulnerability_ids: [] }));
    const unverified = scoreAbsolute(row({ security_check_failed: true, vulnerability_ids: [] }));
    assert.ok(unverified.security < verified.security, "unknown must not beat confirmed-clean");
  });

  test("a failed check that retains prior vulns still surfaces the count", () => {
    const s = scoreAbsolute(row({ security_check_failed: true, vulnerability_ids: ["GHSA-a", "GHSA-b"] }));
    assert.ok(s.reasons.some((r) => /2/.test(r)), "should mention the retained count");
    assert.ok(s.reasons.some((r) => /out of date|could not be/i.test(r)), "should flag it as possibly stale");
  });

  test("compatibility is exactly the ESM/TS combination, and each is explained", () => {
    assert.equal(scoreAbsolute(row({ esm_support: true, typescript_support: true })).compatibility, 100);
    assert.equal(scoreAbsolute(row({ esm_support: true, typescript_support: false })).compatibility, 50);
    assert.equal(scoreAbsolute(row({ esm_support: false, typescript_support: true })).compatibility, 50);
    const neither = scoreAbsolute(row({ esm_support: false, typescript_support: false }));
    assert.equal(neither.compatibility, 0);
    assert.ok(neither.reasons.some((r) => /no ESM/i.test(r)));
  });

  test("a fresher release never scores worse on maintenance recency", () => {
    const fresh = scoreAbsolute(row({ modified_at: iso(1) }));
    const stale = scoreAbsolute(row({ modified_at: iso(2000) }));
    assert.ok(fresh.maintenance > stale.maintenance);
    assert.ok(stale.reasons.some((r) => /no release in over a year/i.test(r)));
  });

  test("single-maintainer bus factor is surfaced", () => {
    assert.ok(scoreAbsolute(row({ maintainers: 1 })).reasons.some((r) => /bus-factor/i.test(r)));
    assert.ok(!scoreAbsolute(row({ maintainers: 9 })).reasons.some((r) => /bus-factor/i.test(r)));
  });
});

describe("scoreCategoryGroup — peer-relative ranking edge cases", () => {
  test("empty group returns an empty map rather than throwing", () => {
    const out = scoreCategoryGroup([]);
    assert.equal(out.size, 0);
  });

  test("single-package group is well formed and does not divide by zero", () => {
    const out = scoreCategoryGroup([row({ name: "solo", categories: ["x"] })]);
    assert.equal(out.size, 1);
    assertWellFormed(out.get("solo")!, "solo");
  });

  test("identical packages receive identical totals", () => {
    const rows = ["a", "b", "c"].map((n) => row({ name: n, categories: ["x"] }));
    const out = scoreCategoryGroup(rows);
    const totals = [...out.values()].map((s) => s.total);
    assert.equal(new Set(totals).size, 1, `expected one distinct total, got ${JSON.stringify(totals)}`);
  });

  test("every member of a large group is scored and well formed", () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      row({
        name: `pkg-${i}`,
        categories: ["bulk"],
        weekly_downloads: i * 977,
        dependencies_count: i % 60,
        maintainers: i % 12,
        modified_at: iso(i * 3),
        vulnerability_ids: i % 17 === 0 ? ["GHSA-synthetic"] : [],
        has_install_scripts: i % 23 === 0,
        deprecated: i % 41 === 0,
        esm_support: i % 2 === 0,
        typescript_support: i % 3 === 0,
      })
    );
    const out = scoreCategoryGroup(rows);
    assert.equal(out.size, 300);
    for (const [name, s] of out) assertWellFormed(s, name);
  });

  test("the most-downloaded member of a group tops the community sub-score", () => {
    const rows = [
      row({ name: "low", categories: ["x"], weekly_downloads: 10 }),
      row({ name: "mid", categories: ["x"], weekly_downloads: 10_000 }),
      row({ name: "high", categories: ["x"], weekly_downloads: 10_000_000 }),
    ];
    const out = scoreCategoryGroup(rows);
    assert.ok(out.get("high")!.community > out.get("mid")!.community);
    assert.ok(out.get("mid")!.community > out.get("low")!.community);
  });

  test("supply chain stays absolute, not zero-sum across the group (the bug that shipped in 0.1.0)", () => {
    // Two groups where every member has many dependencies. Under the old
    // percentile-based supply-chain score, the best-of-a-bad-bunch scored 100
    // regardless of how bad they all were. It must now reflect actual counts.
    const heavy = scoreCategoryGroup([
      row({ name: "h1", categories: ["x"], dependencies_count: 40 }),
      row({ name: "h2", categories: ["x"], dependencies_count: 45 }),
      row({ name: "h3", categories: ["x"], dependencies_count: 50 }),
    ]);
    for (const [name, s] of heavy) {
      assert.ok(s.supplyChain < 50, `${name}: heavy dependency count must not score high (got ${s.supplyChain})`);
    }
  });

  test("both scoring modes agree on the peer-independent sub-scores", () => {
    const r = row({
      name: "agree",
      categories: ["x"],
      vulnerability_ids: ["GHSA-1"],
      dependencies_count: 7,
      has_install_scripts: true,
      esm_support: true,
      typescript_support: false,
      deprecated: false,
    });
    const abs = scoreAbsolute(r);
    const grp = scoreCategoryGroup([r]).get("agree")!;
    assert.equal(abs.security, grp.security, "security must not depend on peers");
    assert.equal(abs.compatibility, grp.compatibility, "compatibility must not depend on peers");
    assert.equal(abs.supplyChain, grp.supplyChain, "supply chain must not depend on peers");
  });
});

describe("capability caveats (the jwt-decode foot-gun)", () => {
  const [caveatPkg] = Object.keys(CAPABILITY_CAVEATS);

  test("a caveated package is penalised and warned about in both scoring modes", () => {
    const plain = scoreAbsolute(row({ name: "no-caveat-here" }));
    const caveated = scoreAbsolute(row({ name: caveatPkg }));
    assert.ok(
      caveated.total < plain.total,
      `${caveatPkg} should score below an otherwise identical uncaveated package`
    );
    assert.ok(caveated.reasons[0].includes("⚠"), "the caveat must lead the reason list, not be buried");

    const grp = scoreCategoryGroup([row({ name: caveatPkg, categories: ["auth-jwt"] })]).get(caveatPkg)!;
    assert.ok(grp.reasons[0].includes("⚠"), "category-relative mode must apply the caveat too");
  });

  test("the penalty is exactly the documented amount", () => {
    const plain = scoreAbsolute(row({ name: "plain-pkg" }));
    const caveated = scoreAbsolute(row({ name: caveatPkg }));
    assert.equal(
      Math.round((plain.total - caveated.total) * 10) / 10,
      CAPABILITY_CAVEAT_PENALTY,
      "penalty drift would silently change published scores"
    );
  });

  test("the caveat cannot push a total below zero", () => {
    const s = scoreAbsolute(
      row({
        name: caveatPkg,
        deprecated: true,
        vulnerability_ids: Array.from({ length: 20 }, (_, i) => `V${i}`),
        esm_support: false,
        typescript_support: false,
        has_install_scripts: true,
        dependencies_count: 400,
        weekly_downloads: 0,
        maintainers: 0,
        modified_at: iso(6000),
      })
    );
    assertWellFormed(s, "floor probe");
  });

  test("caveat lookup is exact — a lookalike name is not silently caveated", () => {
    const near = scoreAbsolute(row({ name: `${caveatPkg}-extra` }));
    assert.ok(!near.reasons.some((r) => r.includes("⚠")), "must not fuzzy-match caveat keys");
    const upper = scoreAbsolute(row({ name: caveatPkg.toUpperCase() }));
    assert.ok(
      !upper.reasons.some((r) => r.includes("⚠")),
      "npm names are lowercase; an uppercased key is a different (nonexistent) package"
    );
  });
});

describe("version safety — branches decidable without network", () => {
  test("a release past the cooldown window is recommended as-is", async () => {
    const g = await resolveRecommendedVersion(
      "probe",
      "2.0.0",
      [
        { version: "1.0.0", releasedAt: iso(400) },
        { version: "2.0.0", releasedAt: iso(90) },
      ],
      { ok: true, vulnerabilityIds: [] }
    );
    assert.equal(g.recommendedVersion, "2.0.0");
    assert.match(g.reason, /past the 30-day/i);
  });

  test("empty version history falls back to the latest without throwing", async () => {
    const g = await resolveRecommendedVersion("probe", "1.2.3", [], { ok: true, vulnerabilityIds: [] });
    assert.equal(g.recommendedVersion, "1.2.3");
    assert.ok(g.reason.length > 0);
  });

  test("a brand-new package with no version past cooldown still returns something usable", async () => {
    const g = await resolveRecommendedVersion(
      "probe",
      "0.0.2",
      [
        { version: "0.0.1", releasedAt: iso(5) },
        { version: "0.0.2", releasedAt: iso(1) },
      ],
      { ok: true, vulnerabilityIds: [] }
    );
    assert.equal(g.recommendedVersion, "0.0.2");
    assert.match(g.reason, /no stable version older than 30 days/i);
  });

  test("guidance always names a version that actually exists in history", async () => {
    const history = [
      { version: "1.0.0", releasedAt: iso(500) },
      { version: "1.1.0", releasedAt: iso(300) },
      { version: "1.2.0", releasedAt: iso(2) },
    ];
    const g = await resolveRecommendedVersion("eslint", "1.2.0", history, { ok: true, vulnerabilityIds: [] });
    assert.ok(
      history.some((h) => h.version === g.recommendedVersion),
      `recommended ${g.recommendedVersion} which is not a real published version`
    );
  });

  test("a prerelease is never offered as the cooldown-safe alternative", async () => {
    // Regression: `check typescript` recommended 7.0.1-rc as the "safer,
    // battle-tested" pick, because the newest version past the 30-day window
    // happened to be a release candidate. Offering an rc in place of a stable
    // release inverts the entire point of the cooldown.
    const g = await resolveRecommendedVersion(
      "prerelease-probe",
      "3.0.0",
      [
        { version: "1.9.0", releasedAt: iso(200) },
        { version: "2.0.0", releasedAt: iso(120) },
        { version: "3.0.0-rc", releasedAt: iso(60) },
        { version: "3.0.0-beta.2", releasedAt: iso(45) },
        { version: "3.0.0", releasedAt: iso(2) },
      ],
      { ok: true, vulnerabilityIds: [] }
    );
    assert.equal(g.recommendedVersion, "2.0.0", `recommended ${g.recommendedVersion} instead of the newest stable`);
  });

  test("prerelease tags in several formats are all skipped", async () => {
    for (const tag of ["4.0.0-rc.1", "4.0.0-beta", "4.0.0-alpha.3", "4.0.0-next.7", "4.0.0-canary.2", "4.0.0-dev"]) {
      const g = await resolveRecommendedVersion(
        "probe",
        "5.0.0",
        [
          { version: "3.0.0", releasedAt: iso(300) },
          { version: tag, releasedAt: iso(90) },
          { version: "5.0.0", releasedAt: iso(1) },
        ],
        { ok: true, vulnerabilityIds: [] }
      );
      assert.equal(g.recommendedVersion, "3.0.0", `${tag} was treated as a stable fallback`);
    }
  });

  test("a package with only prereleases past the window falls back to the latest, not an rc", async () => {
    const g = await resolveRecommendedVersion(
      "probe",
      "1.0.0",
      [
        { version: "1.0.0-alpha.1", releasedAt: iso(200) },
        { version: "1.0.0-beta.1", releasedAt: iso(100) },
        { version: "1.0.0", releasedAt: iso(3) },
      ],
      { ok: true, vulnerabilityIds: [] }
    );
    assert.equal(g.recommendedVersion, "1.0.0");
    assert.match(g.reason, /no stable version older than/i);
  });

  test("latest not present in history does not crash the resolver", async () => {
    const g = await resolveRecommendedVersion(
      "probe",
      "9.9.9",
      [{ version: "1.0.0", releasedAt: iso(400) }],
      { ok: true, vulnerabilityIds: [] }
    );
    assert.ok(typeof g.recommendedVersion === "string" && g.recommendedVersion.length > 0);
  });
});
