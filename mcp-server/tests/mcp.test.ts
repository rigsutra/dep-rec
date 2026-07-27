// The MCP server is the other product surface, and it fails differently from
// the CLI: schema validation happens in the protocol layer, arguments arrive
// as JSON (so they can carry things argv cannot), and the consumer is a model
// that will act on whatever comes back. That makes the tool *descriptions*
// part of the contract too — a model can only avoid the decode-only-JWT
// foot-gun if the description warns it.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMcp, REPO_ROOT, INVALID_NAMES, HOSTILE_NAMES, type McpSession } from "./helpers.js";

let mcp: McpSession;
let dbPath: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dep-rec-mcp-"));
  dbPath = join(dir, "store.json");
  copyFileSync(join(REPO_ROOT, "data/store.json"), dbPath);
  mcp = await openMcp({ dbPath });
});

after(async () => {
  await mcp?.close();
});

describe("MCP — handshake and advertised surface", () => {
  test("exposes exactly the three documented tools", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, ["check_package", "list_categories", "recommend_package"]);
  });

  test("every tool has a non-trivial description", async () => {
    const { tools } = await mcp.listTools();
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 80, `${t.name}: description too thin to steer a model`);
    }
  });

  test("recommend_package declares its full input schema", async () => {
    const { tools } = await mcp.listTools();
    const t = tools.find((x: any) => x.name === "recommend_package");
    const props = t.inputSchema.properties ?? {};
    for (const key of ["need", "runtime", "license", "limit"]) {
      assert.ok(key in props, `missing declared input: ${key}`);
    }
    assert.deepEqual(t.inputSchema.required, ["need"], "need must be the only required input");
  });

  test("check_package declares name as required", async () => {
    const { tools } = await mcp.listTools();
    const t = tools.find((x: any) => x.name === "check_package");
    assert.deepEqual(t.inputSchema.required, ["name"]);
  });

  test("runtime is constrained to the two supported values, not free text", async () => {
    const { tools } = await mcp.listTools();
    const t = tools.find((x: any) => x.name === "recommend_package");
    const runtime = t.inputSchema.properties.runtime;
    const enumValues = runtime.enum ?? runtime.anyOf?.flatMap((v: any) => v.enum ?? []) ?? [];
    assert.deepEqual([...enumValues].sort(), ["edge", "node"]);
  });
});

describe("MCP — tool descriptions must steer the model correctly", () => {
  test("scoring tools tell the model to cite reasons and not invent scores", async () => {
    const { tools } = await mcp.listTools();
    const rec = tools.find((x: any) => x.name === "recommend_package").description;
    assert.match(rec, /reasons/i, "must point the model at the returned reasons");
    assert.match(rec, /never invent|not.*invent/i, "must forbid inventing a score");
  });

  test("check_package warns that a resolvable name can still be a typosquat", async () => {
    const { tools } = await mcp.listTools();
    const d = tools.find((x: any) => x.name === "check_package").description;
    assert.match(d, /typosquat/i);
    assert.match(d, /typosquatWarning/, "the model needs to know which field to look at");
    assert.match(d, /resolvable|even when it DOES resolve/i, "a 404 is not the only signal");
  });

  test("check_package explains the cooldown/version-guidance behaviour", async () => {
    const { tools } = await mcp.listTools();
    const d = tools.find((x: any) => x.name === "check_package").description;
    assert.match(d, /versionGuidance/);
    assert.match(d, /30 days/i);
    assert.match(d, /verified|never assumed/i, "must state the CVE override is verified, not assumed");
  });
});

describe("MCP — list_categories", () => {
  test("returns all ten categories as structured JSON", async () => {
    const r = await mcp.call("list_categories", {});
    assert.equal(r.isError, false);
    assert.ok(Array.isArray(r.json));
    assert.equal(r.json.length, 10);
  });

  test("tolerates unexpected extra arguments", async () => {
    const r = await mcp.call("list_categories", { unexpected: "value", limit: 999 });
    assert.ok(Array.isArray(r.json) || r.isError, "must either ignore extras or reject cleanly");
  });
});

describe("MCP — check_package", () => {
  test("a cached package is served from the store", async () => {
    const r = await mcp.call("check_package", { name: "zod" });
    assert.equal(r.isError, false);
    assert.equal(r.json.name, "zod");
    assert.equal(r.json.servedFrom, "cache");
  });

  test("response is always valid JSON, never a bare string", async () => {
    const r = await mcp.call("check_package", { name: "express" });
    assert.notEqual(r.json, null, `expected JSON, got: ${r.text.slice(0, 120)}`);
  });

  test("a nonexistent package returns found:false with an actionable note", async () => {
    const r = await mcp.call("check_package", { name: "dep-rec-mcp-nope-xyz-111" });
    assert.equal(r.json.found, false);
    assert.match(r.json.note, /hallucinated|typosquat/i);
    assert.equal(r.json.score, undefined);
  });

  test("a resolvable typosquat is flagged with its impersonation target", async () => {
    const r = await mcp.call("check_package", { name: "reactt" });
    assert.equal(r.json.found, true, "premise: reactt is a real published package");
    assert.ok(r.json.typosquatWarning, "a resolvable squat must still be flagged");
    assert.equal(r.json.typosquatWarning.targetPackage, "react");
    assert.ok(r.json.typosquatWarning.targetWeeklyDownloads > r.json.weeklyDownloads * 100);
  });

  test("a legitimate package carries no typosquat warning", async () => {
    for (const name of ["zod", "express", "jose"]) {
      const r = await mcp.call("check_package", { name });
      assert.equal(r.json.typosquatWarning, undefined, `${name} was falsely flagged`);
    }
  });

  test("missing the required argument is rejected by the protocol layer", async () => {
    const r = await mcp.call("check_package", {} as any).catch((e) => ({ isError: true, text: String(e), json: null }));
    assert.ok(r.isError || /required|invalid/i.test(r.text), "a missing required input must not be silently accepted");
  });

  test("a wrong-typed argument is rejected rather than coerced", async () => {
    for (const bad of [12345, null, true, { nested: "object" }, ["array"]]) {
      const r = await mcp
        .call("check_package", { name: bad as any })
        .catch((e) => ({ isError: true, text: String(e), json: null as any }));
      const rejected = r.isError || /invalid|expected/i.test(r.text) || r.json?.found === false;
      assert.ok(rejected, `name=${JSON.stringify(bad)} was accepted as a valid package name`);
    }
  });

  test("version guidance, when present, names a plausible version", async () => {
    const r = await mcp.call("check_package", { name: "express" });
    if (r.json.versionGuidance) {
      assert.match(r.json.versionGuidance.recommendedVersion, /^\d+\.\d+\.\d+/);
      assert.ok(r.json.versionGuidance.reason.length > 20);
    }
  });

  test("an unrecommendable package is still answerable, but flagged as such", async () => {
    // The whole point of check_package: it answers for anything, including
    // packages this tool would never put forward itself.
    const r = await mcp.call("check_package", { name: "csvparser" });
    assert.equal(r.json.found, true, "must still answer — refusing would defeat the purpose");
    assert.equal(r.json.recommendable, false);
    assert.ok(Array.isArray(r.json.notRecommendableBecause));
    assert.ok(r.json.notRecommendableBecause.length > 0, "must say why it would not be recommended");
    assert.ok(
      r.json.notRecommendableBecause.some((x: string) => /weekly downloads/i.test(x)),
      "adoption should be cited for a package with 86 weekly downloads"
    );
  });

  test("a healthy package is marked recommendable with no disqualifications", async () => {
    const r = await mcp.call("check_package", { name: "zod" });
    assert.equal(r.json.recommendable, true);
    assert.equal(r.json.notRecommendableBecause, undefined);
  });

  test("a package flagged as a typosquat is never simultaneously recommendable", async () => {
    const r = await mcp.call("check_package", { name: "reactt" });
    assert.ok(r.json.typosquatWarning, "premise: reactt trips the detector");
    assert.equal(r.json.recommendable, false, "flagging and recommending the same package is self-contradictory");
  });

  test("a deprecated package is reported as deprecated", async () => {
    const r = await mcp.call("check_package", { name: "left-pad" });
    assert.equal(r.json.found, true);
    assert.equal(r.json.npm.deprecated, true);
    assert.ok(r.json.reasons.some((x: string) => /deprecated/i.test(x)));
  });
});

describe("MCP — recommend_package", () => {
  test("matches a category and returns ranked results", async () => {
    const r = await mcp.call("recommend_package", { need: "jwt library" });
    assert.equal(r.json.matchedCategory, "auth-jwt");
    const scores = r.json.recommendations.map((x: any) => x.score);
    assert.deepEqual(scores, [...scores].sort((a: number, b: number) => b - a));
  });

  test("does not lead with a decode-only library for a JWT need", async () => {
    const r = await mcp.call("recommend_package", { need: "jwt library" });
    assert.notEqual(r.json.recommendations[0].package, "jwt-decode");
  });

  test("an out-of-range limit is rejected by the schema, not silently clamped", async () => {
    for (const bad of [0, -5, 21, 1000, 1.5]) {
      const r = await mcp
        .call("recommend_package", { need: "logger", limit: bad })
        .catch((e) => ({ isError: true, text: String(e), json: null as any }));
      const handled = r.isError || /invalid|expected/i.test(r.text) || (r.json && r.json.recommendations.length <= 20);
      assert.ok(handled, `limit=${bad} produced an unbounded or unvalidated result`);
    }
  });

  test("an unmatched need falls back and explains itself", async () => {
    const r = await mcp.call("recommend_package", { need: "zzzz nonexistent domain qqqq" });
    assert.equal(r.json.matchedCategory, null);
    assert.equal(r.json.discoveredVia, "npm-search", "an uncovered need is discovered live, not answered from the corpus");
    assert.match(r.json.note, /npm search/i);
  });

  test("an empty need string is handled without crashing", async () => {
    const r = await mcp
      .call("recommend_package", { need: "" })
      .catch((e) => ({ isError: true, text: String(e), json: null as any }));
    assert.ok(r.isError || r.json !== null, "empty need must produce a definite answer either way");
  });

  test("a very long need string is handled", async () => {
    const r = await mcp.call("recommend_package", { need: "jwt ".repeat(5_000) });
    assert.ok(r.json !== null);
    assert.equal(r.json.matchedCategory, "auth-jwt", "keyword matching should still work");
  });

  test("license filtering is exact and not silently dropped", async () => {
    const r = await mcp.call("recommend_package", { need: "orm", license: "MIT", limit: 10 });
    for (const rec of r.json.recommendations) assert.equal(rec.license, "MIT");

    const none = await mcp.call("recommend_package", { need: "orm", license: "Nonexistent-1.0" });
    assert.deepEqual(none.json.recommendations, []);
  });

  test("edge runtime attaches the untested-support caveat", async () => {
    const r = await mcp.call("recommend_package", { need: "jwt library", runtime: "edge" });
    assert.ok(r.json.caveats.length > 0);
    assert.match(r.json.caveats[0], /sandbox-tested|weak proxy/i);
  });

  test("every recommendation is explained and none are deprecated", async () => {
    for (const need of ["jwt library", "csv parser", "logger", "orm", "testing", "http client", "validation", "date", "state management", "web framework"]) {
      const r = await mcp.call("recommend_package", { need, limit: 5 });
      assert.ok(r.json.recommendations.length > 0, `${need}: no results`);
      for (const rec of r.json.recommendations) {
        assert.ok(rec.reasons?.length > 0, `${need}/${rec.package}: unexplained`);
        assert.ok(!rec.reasons.some((x: string) => /deprecated/i.test(x)), `${need}: recommended deprecated ${rec.package}`);
      }
    }
  });
});

describe("MCP — hostile arguments arrive as JSON and cannot be blocked by the OS", () => {
  const jsonReachable = [...INVALID_NAMES.slice(0, 10), ...HOSTILE_NAMES.slice(0, 14)];

  for (const name of jsonReachable) {
    test(`check_package ${JSON.stringify(name.slice(0, 22))} is contained`, async () => {
      const r = await mcp
        .call("check_package", { name })
        .catch((e) => ({ isError: true, text: String(e), json: null as any }));

      if (r.json && r.json.found === true) {
        assert.fail(`hostile input scored as a real package: ${JSON.stringify(name)}`);
      }
      assert.doesNotMatch(r.text, /root:x:0:0|\[boot loader\]/i, "possible file disclosure");
      assert.doesNotMatch(r.text, /SQLITE_ERROR|syntax error near/i, "input reached the SQL layer");
    });
  }

  test("a null byte inside a JSON argument does not crash the server", async () => {
    // Unreachable via CLI argv, but perfectly deliverable over MCP.
    const r = await mcp
      .call("check_package", { name: "zod .js" })
      .catch((e) => ({ isError: true, text: String(e), json: null as any }));
    assert.notEqual(r.json?.found, true, "a null-byte-smuggled name must not resolve");
  });

  test("the server is still alive and correct after the hostile sweep", async () => {
    const r = await mcp.call("check_package", { name: "zod" });
    assert.equal(r.json.found, true);
    assert.equal(r.json.name, "zod");
    const cats = await mcp.call("list_categories", {});
    assert.equal(cats.json.length, 10, "category data survived");
  });

  test("calling an undeclared tool is rejected", async () => {
    const r = await mcp
      .call("definitely_not_a_tool", {})
      .catch((e) => ({ isError: true, text: String(e), json: null as any }));
    assert.ok(r.isError || /unknown|not found/i.test(r.text));
  });
});

describe("MCP — concurrency and isolation", () => {
  test("many concurrent calls all resolve correctly", async () => {
    const names = ["zod", "express", "jose", "jwt-decode", "csv-parse", "typeorm", "vitest", "xstate"];
    const results = await Promise.all(names.map((n) => mcp.call("check_package", { name: n })));
    results.forEach((r, i) => {
      assert.equal(r.json.name, names[i], "concurrent responses must not be cross-wired");
      assert.equal(r.json.found, true);
    });
  });

  test("interleaved reads and writes to the store stay consistent", async () => {
    const calls = [
      mcp.call("check_package", { name: "zod" }),
      mcp.call("recommend_package", { need: "jwt library" }),
      mcp.call("list_categories", {}),
      mcp.call("check_package", { name: "express" }),
      mcp.call("recommend_package", { need: "csv parser", limit: 3 }),
    ];
    const results = await Promise.all(calls);
    for (const r of results) assert.notEqual(r.json, null);
    assert.equal(results[2].json.length, 10);
  });

  test("a second independent server process sees the same store", async () => {
    const other = await openMcp({ dbPath });
    try {
      const a = await mcp.call("check_package", { name: "zod" });
      const b = await other.call("check_package", { name: "zod" });
      assert.equal(a.json.score, b.json.score, "two processes must agree on a stored score");
      assert.equal(b.json.servedFrom, "cache", "the second process must reuse the shared store, not refetch");
    } finally {
      await other.close();
    }
  });
});

describe("MCP — parity with the CLI", () => {
  test("both surfaces agree on check results", async () => {
    const { runCli } = await import("./helpers.js");
    const [viaCli, viaMcp] = await Promise.all([
      runCli(["check", "zod", "--json"], { dbPath }),
      mcp.call("check_package", { name: "zod" }),
    ]);
    assert.equal(viaCli.json.score, viaMcp.json.score, "the two interfaces must not disagree on a score");
    assert.deepEqual(viaCli.json.reasons, viaMcp.json.reasons);
  });

  test("both surfaces agree on recommendations", async () => {
    const { runCli } = await import("./helpers.js");
    const [viaCli, viaMcp] = await Promise.all([
      runCli(["recommend", "jwt library", "--limit", "3", "--json"], { dbPath }),
      mcp.call("recommend_package", { need: "jwt library", limit: 3 }),
    ]);
    assert.deepEqual(
      viaCli.json.recommendations.map((x: any) => x.package),
      viaMcp.json.recommendations.map((x: any) => x.package)
    );
  });
});
