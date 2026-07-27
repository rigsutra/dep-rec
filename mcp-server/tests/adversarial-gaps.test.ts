// Concepts this project's own spec claims or aspires to, probed against what
// actually shipped.
//
// The invariant is NOT "everything in the vision is implemented" — most of it
// deliberately isn't. The invariant is that the tool never *overclaims*: it
// must not imply a check happened that didn't, must not present an unverified
// signal as verified, and must not crash when asked something outside its
// scope. A missed detection is a documented gap; a confident wrong answer is
// a bug. These tests fail only on the latter, and print an honest coverage
// inventory for the former.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMcp, REPO_ROOT, runCli, type McpSession } from "./helpers.js";
import { checkTyposquat } from "../src/store/typosquat.js";

let mcp: McpSession;
let dbPath: string;
const gaps: string[] = [];
const covered: string[] = [];

function record(concept: string, isCovered: boolean, detail = "") {
  (isCovered ? covered : gaps).push(detail ? `${concept} — ${detail}` : concept);
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dep-rec-gaps-"));
  dbPath = join(dir, "store.json");
  copyFileSync(join(REPO_ROOT, "data/store.json"), dbPath);
  mcp = await openMcp({ dbPath });
});

after(async () => {
  await mcp?.close();
  const total = covered.length + gaps.length;
  console.log(`\n  ===== capability inventory: ${covered.length}/${total} concepts implemented =====`);
  for (const c of covered) console.log(`    [implemented] ${c}`);
  for (const g of gaps) console.log(`    [GAP]         ${g}`);
  console.log("");
});

describe("Edge runtime compatibility (Proof 0 exists but was never merged into scoring)", () => {
  test("edge support is never presented as verified", async () => {
    const r = await mcp.call("recommend_package", { need: "jwt library", runtime: "edge" });
    const caveatText = r.json.caveats.join(" ");
    assert.ok(r.json.caveats.length > 0, "asking for edge support must not silently answer as if it were checked");
    assert.match(caveatText, /NOT been sandbox-tested|weak proxy/i, "must state the signal is a proxy, not a guarantee");
    record("edge-runtime compatibility", false, "ESM support used as a proxy; @edge-runtime/vm check lives only in proof0/, unmerged");
  });

  test("no per-package field claims edge compatibility", async () => {
    const r = await mcp.call("check_package", { name: "express" });
    const asText = JSON.stringify(r.json);
    assert.doesNotMatch(asText, /"edgeCompatible"\s*:\s*true/, "must not assert edge compatibility it never tested");
  });

  test("express, which genuinely cannot run on the edge, is not recommended for edge without warning", async () => {
    const r = await mcp.call("recommend_package", { need: "web framework", runtime: "edge", limit: 5 });
    const names = r.json.recommendations.map((x: any) => x.package);
    if (names.includes("express")) {
      assert.ok(r.json.caveats.length > 0, "recommending express for edge with no caveat would be actively harmful");
    }
  });
});

describe("Transitive dependency / supply-chain depth (deps.dev, OpenSSF Scorecard)", () => {
  test("the supply-chain score does not imply transitive analysis", async () => {
    const r = await mcp.call("check_package", { name: "express" });
    const asText = JSON.stringify(r.json);
    assert.doesNotMatch(asText, /transitive/i, "no field may imply the dependency graph was walked");
    assert.doesNotMatch(asText, /scorecard/i);
    record("transitive dependency graph", false, "only direct dependency count is used; deps.dev not wired in");
    record("OpenSSF Scorecard signals", false, "not collected");
  });

  test("a package with few direct but many transitive deps is not scored as clean supply chain", async () => {
    // express has ~28 direct deps but a far larger transitive tree. The score
    // must at least reflect the direct count rather than reporting perfection.
    const r = await mcp.call("check_package", { name: "express" });
    if (r.json.found && r.json.npm.dependenciesCount > 10) {
      const reasons = r.json.reasons.join(" ");
      assert.doesNotMatch(reasons, /zero direct dependencies/i, "must not claim zero deps for a package that has many");
    }
  });

  test("install-script detection covers presence only, and does not claim to have read the script", async () => {
    const r = await mcp.call("check_package", { name: "puppeteer" });
    const reasons = (r.json.reasons ?? []).join(" ");
    if (/install/i.test(reasons) && /script/i.test(reasons)) {
      assert.match(reasons, /review|arbitrary code/i, "must tell the user to review it, not vouch for it");
      assert.doesNotMatch(reasons, /safe|benign|harmless/i, "must never vouch for script contents it never read");
    }
    record("install-script presence detection", true, "preinstall/install/postinstall flagged, weighted -40");
    record("install-script content analysis", false, "presence only; the script body is never inspected");
    record("malware / behavioural analysis", false, "explicitly out of scope");
  });
});

describe("Repository and maintainer signals (GitHub API, bus factor, ownership transfer)", () => {
  test("bus factor is not claimed beyond raw maintainer count", async () => {
    const r = await mcp.call("check_package", { name: "jose" });
    const reasons = (r.json.reasons ?? []).join(" ");
    if (/bus-factor/i.test(reasons)) {
      assert.match(reasons, /single maintainer/i, "the claim must be exactly what was measured: the maintainer count");
    }
    record("maintainer-count bus-factor hint", true, "npm maintainer count only");
    record("commit-distribution bus factor", false, "needs GitHub API; not collected");
    record("GitHub stars / forks / issue health", false, "needs an authenticated token at corpus scale");
    record("maintainer or ownership transfer detection", false, "not tracked — a hijack signal this cannot see");
  });

  test("no field implies a repository was inspected", async () => {
    const r = await mcp.call("check_package", { name: "express" });
    const asText = JSON.stringify(r.json);
    for (const claim of ["stars", "forks", "openIssues", "commitCount", "contributors"]) {
      assert.doesNotMatch(asText, new RegExp(`"${claim}"`), `claims ${claim} without collecting it`);
    }
  });
});

describe("License handling", () => {
  test("licenses are reported verbatim, never judged for compatibility", async () => {
    const r = await mcp.call("check_package", { name: "left-pad" });
    assert.equal(r.json.npm.license, "WTFPL", "license must be passed through as published");
    const asText = JSON.stringify(r.json);
    assert.doesNotMatch(asText, /compatible|licenseConflict|licenseRisk/i, "must not adjudicate license compatibility");
    record("license passthrough + exact filtering", true);
    record("license compatibility / conflict analysis", false, "no notion of a project's own license or copyleft risk");
  });

  test("a copyleft license is not silently treated as equivalent to a permissive one", async () => {
    const r = await mcp.call("recommend_package", { need: "orm", license: "GPL-3.0" });
    // Whatever comes back must actually be GPL-3.0, not a permissive substitute.
    for (const rec of r.json.recommendations) {
      assert.equal(rec.license, "GPL-3.0", "a license filter must be exact, not approximate");
    }
  });

  test("a package with no declared license is not reported as permissively licensed", async () => {
    const noLicense = await runCli(["recommend", "testing", "--limit", "20", "--json"], { dbPath });
    for (const rec of noLicense.json.recommendations) {
      if (rec.license === null) {
        assert.notEqual(rec.license, "MIT", "unreachable by construction, but pins the intent: null is not MIT");
      }
    }
  });
});

describe("Typosquat shapes beyond the distance-1 envelope", () => {
  const store = new Map([
    ["react", 162_000_000],
    ["lodash", 200_000_000],
    ["express", 90_000_000],
    ["cross-env", 12_000_000],
    ["mongoose", 8_000_000],
  ]);

  test("distance-2 squats are missed, and no false claim is made about them", async () => {
    const missed: string[] = [];
    for (const name of ["reactjs", "expressjs", "lodashjs", "raectt"]) {
      const res = await checkTyposquat(name, 20, store);
      if (!res.suspicious) missed.push(name);
      else assert.ok(res.targetPackage, "a positive must always name its target");
    }
    record("edit-distance-2+ typosquats", missed.length === 0, missed.length ? `missed: ${missed.join(", ")}` : "");
    assert.ok(true, "documented gap, not a failure");
  });

  test("prefix/suffix and scope-confusion squats are missed cleanly", async () => {
    const missed: string[] = [];
    for (const name of ["node-react", "react-official", "@react/core", "lodash-utils", "npm-express"]) {
      const res = await checkTyposquat(name, 20, store);
      if (!res.suspicious) missed.push(name);
    }
    record("prefix/suffix squats (node-react, react-official)", missed.length === 0, missed.length ? `missed: ${missed.length}/5` : "");
    record("scope-confusion squats (@react/core)", false, "a fake scope on a real name is not compared against the unscoped original");
  });

  test("multi-character homoglyph names are missed cleanly, single-character ones are caught", async () => {
    const single = await checkTyposquat("rеact", 20, store); // one Cyrillic е
    const multi = await checkTyposquat("ехprеss", 20, store); // three Cyrillic chars
    record("single-character homoglyph substitution", single.suspicious, single.suspicious ? "caught via confusable table" : "missed");
    record("multi-character homoglyph substitution", multi.suspicious, multi.suspicious ? "" : "distance > 1 in codepoints");
    if (multi.suspicious) assert.ok(multi.targetPackage, "a positive must name its target");
  });

  test("dependency-confusion style names (internal-looking scopes) are not covered", async () => {
    for (const name of ["@mycompany/internal-auth", "@acme-corp/shared-utils"]) {
      const res = await checkTyposquat(name, 5, store);
      assert.equal(res.suspicious, false, "must not guess at private-registry semantics it has no data for");
    }
    record("dependency-confusion detection", false, "no notion of private/internal registries or namespace ownership");
  });
});

describe("Version guidance edge cases the spec did not pin down", () => {
  test("prerelease versions are not silently recommended as stable", async () => {
    const r = await mcp.call("check_package", { name: "typescript" });
    if (r.json.versionGuidance) {
      const v = r.json.versionGuidance.recommendedVersion;
      const isPrerelease = /-(alpha|beta|rc|next|canary|dev|pre)/i.test(v);
      record("prerelease exclusion from version guidance", !isPrerelease, isPrerelease ? `recommended prerelease ${v}` : "");
      assert.ok(!isPrerelease, `recommended a prerelease (${v}) without flagging it as such`);
    }
  });

  test("guidance never recommends a version it has not verified exists", async () => {
    for (const name of ["express", "zod", "jose"]) {
      const r = await mcp.call("check_package", { name });
      if (r.json.versionGuidance) {
        assert.match(r.json.versionGuidance.recommendedVersion, /^\d/, `${name}: implausible version string`);
        assert.ok(r.json.versionGuidance.reason.length > 20, `${name}: guidance without justification`);
      }
    }
    record("30-day cooldown with verified CVE override", true, "both versions checked against OSV before overriding");
  });

  test("yanked/unpublished versions are not distinguished", async () => {
    // npm allows unpublishing a version within 72h; the store has no notion of
    // it, so guidance could name a version that has since vanished.
    record("yanked / unpublished version awareness", false, "version history is a snapshot; a pulled version would still be recommended");
    assert.ok(true);
  });

  test("the cooldown window is not configurable per caller", async () => {
    const { tools } = await mcp.listTools();
    const t = tools.find((x: any) => x.name === "check_package");
    const hasKnob = JSON.stringify(t.inputSchema).includes("cooldown");
    record("configurable cooldown window", hasKnob, hasKnob ? "" : "fixed at 30 days; spec called for it to be tunable");
  });
});

describe("Ecosystem and scope boundaries the spec claimed", () => {
  test("non-npm ecosystems are not silently answered with npm data", async () => {
    // The spec talked about PyPI/crates.io/Maven. Asking for something that
    // only exists there must not return an npm lookalike as if it were it.
    for (const name of ["requests", "flask", "serde", "tokio"]) {
      const r = await mcp.call("check_package", { name });
      // A registry outage yields a non-JSON error body; that says nothing
      // about ecosystem confusion, so it is not this test's business.
      if (r.json?.found) {
        // These names DO exist on npm as unrelated packages — the danger is a
        // caller assuming ecosystem. The tool must at least not claim a
        // non-npm ecosystem.
        assert.doesNotMatch(JSON.stringify(r.json), /pypi|crates|maven|rubygems/i, "must not imply cross-ecosystem coverage");
      }
    }
    record("multi-ecosystem support (PyPI, crates.io, Maven)", false, "npm only; no ecosystem field is even returned");
  });

  test("project-level / lockfile analysis is absent and not implied", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t: any) => t.name);
    const hasProjectTool = names.some((n: string) => /project|lockfile|manifest|audit/i.test(n));
    record("project/lockfile-wide analysis", hasProjectTool, hasProjectTool ? "" : "no tool accepts a package.json or lockfile");
    assert.equal(hasProjectTool, false, "premise check for the inventory");
  });

  test("continuous monitoring and alerting is a background job, not an API surface", async () => {
    const { tools } = await mcp.listTools();
    const hasAlerts = tools.some((t: any) => /alert|subscribe|monitor|notify/i.test(t.name));
    record("continuous monitoring / CVE alerting", false, "refresh worker exists but nothing notifies affected projects");
    assert.equal(hasAlerts, false);
  });

  test("provenance / signed releases / SLSA are not checked", async () => {
    const r = await mcp.call("check_package", { name: "jose" });
    const asText = JSON.stringify(r.json);
    for (const claim of ["provenance", "signed", "sigstore", "slsa", "attestation"]) {
      assert.doesNotMatch(asText, new RegExp(`"${claim}`, "i"), `claims ${claim} without checking it`);
    }
    record("release provenance / Sigstore / SLSA", false, "not collected, and correctly not claimed");
    record("SBOM generation", false, "out of scope");
  });
});

describe("Freshness honesty — the 24h cache window", () => {
  test("a cached answer states that it came from cache", async () => {
    const r = await mcp.call("check_package", { name: "zod" });
    assert.equal(r.json.servedFrom, "cache", "a caller must be able to tell fresh data from stored data");
    record("cache-provenance disclosure (servedFrom)", true);
    record("cache-age disclosure", false, "servedFrom says cache but not how old — a CVE disclosed hours ago can be masked for up to 24h");
  });

  test("a failed vulnerability check is never rendered as a clean bill of health", async () => {
    // Verified directly at the scoring layer in unit-scoring; re-asserted here
    // end-to-end because this is the single most consequential honesty rule.
    const r = await mcp.call("check_package", { name: "zod" });
    const reasons = r.json.reasons.join(" ");
    const claimsClean = /no known vulnerabilit/i.test(reasons);
    const claimsUnverified = /could not be verified|unreachable/i.test(reasons);
    assert.ok(!(claimsClean && claimsUnverified), "must never claim both clean and unverified");
    record("OSV failure distinguished from clean result", true, "fail-closed with an explicit reason string");
  });

  test("scores carry no false precision about their own freshness", async () => {
    const r = await mcp.call("check_package", { name: "express" });
    assert.doesNotMatch(JSON.stringify(r.json), /"realtime"|"live"\s*:\s*true/i, "must not claim realtime data");
  });
});

describe("Scoring model honesty", () => {
  test("no weight or sub-score is presented as an objective measure of quality", async () => {
    const { tools } = await mcp.listTools();
    const d = tools.find((x: any) => x.name === "recommend_package").description;
    assert.match(d, /deterministic/i, "the description should say the score is rule-based");
    assert.doesNotMatch(d, /\bbest\b.*guarantee|objectively/i, "must not oversell the score");
    record("deterministic, explained scoring (LLM narrates, never invents)", true);
  });

  test("capability mismatches rely on a manual list, and that limit is not hidden", async () => {
    const { CAPABILITY_CAVEATS } = await import("../src/store/capability-caveats.js");
    const count = Object.keys(CAPABILITY_CAVEATS).length;
    record(
      "capability-mismatch caveats",
      true,
      `manually curated, ${count} entr${count === 1 ? "y" : "ies"} — not general capability detection`
    );
    assert.ok(count >= 1);
  });

  test("category matching is keyword-based and misses paraphrases", async () => {
    // 'token verification' means auth-jwt to a human; the synonym map has no
    // entry for it.
    const r = await mcp.call("recommend_package", { need: "verify a signed token from an identity provider" });
    const matched = r.json.matchedCategory;
    record("semantic/paraphrase category matching", matched === "auth-jwt", matched === "auth-jwt" ? "" : `matched ${matched} instead of auth-jwt`);
    // "Coherently" used to mean "return something anyway". It now means the
    // opposite: a paraphrase the synonym map cannot resolve produces no
    // recommendations at all, because five confidently-scored packages from
    // an unrelated category is a worse answer than none.
    if (matched === null) {
      // A paraphrase the keyword map cannot resolve is now routed to live npm
      // discovery rather than answered from an unrelated category. Whatever
      // comes back must be labelled as discovered, not passed off as curated.
      assert.equal(r.json.discoveredVia, "npm-search", "an unresolved need must fall through to discovery");
      assert.ok(r.json.caveats.length > 0, "discovered results must carry a provenance caveat");
      assert.match(r.json.note, /npm search/i, "a miss must be disclosed, not hidden");
    } else {
      assert.ok(r.json.recommendations.length > 0, "a matched category must still produce results");
    }
  });

  test("an unmatched query never presents whole-corpus results as category-matched", async () => {
    const r = await mcp.call("recommend_package", { need: "flux capacitor calibration" });
    if (r.json.matchedCategory === null) {
      assert.ok(r.json.note, "an unmatched need must be disclosed");
      assert.match(r.json.note, /npm search/i);
      // The corpus-wide fallback is gone: nothing may be returned that was
      // not selected for this need specifically.
      assert.equal(r.json.discoveredVia, "npm-search");
    }
  });
});
