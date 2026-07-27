// Regression suite for the six findings from the second external review of
// the published package. Each test reproduces the reviewer's scenario as
// closely as it can be reproduced in-repo, so a future change that
// reintroduces any of them fails here rather than in someone's project.
//
// Numbering matches the review.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  copyFileSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  rmdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { REPO_ROOT, runCli, openMcp, cleanEnv, row } from "./helpers.js";
import { PACKAGES_COLUMNS } from "../src/store/schema.js";
import { getPackage } from "../src/store/db.js";
import { checkTyposquat } from "../src/store/typosquat.js";
import { normalizeLimit, MAX_LIMIT, checkPackage, recommend } from "../src/data.js";
import { validatePackageName, fetchPackageDoc, fetchWeeklyDownloads } from "../src/sources/npm.js";
import { isRecommendable, checkRecommendable } from "../src/store/eligibility.js";

let workDir: string;
// Every MCP session in this file points here, never at data/store.json. An
// earlier revision of this suite forgot, and a single `check_package` for
// "react" wrote an uncategorised row straight into the artifact that ships
// inside the package — the exact pollution bug the corpus suite exists to
// catch, which is how it was found.
let storePath: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "dep-rec-review-"));
  storePath = join(workDir, "mcp-store.json");
  copyFileSync(join(REPO_ROOT, "data/store.json"), storePath);
  // This file also calls checkPackage() in-process, not just through a
  // subprocess, so the in-process store has to be redirected too.
  process.env.DEP_REC_DB_PATH = storePath;
});

after(() => {
  // Windows holds handles briefly; a failed cleanup must not fail the suite.
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* temp dir, the OS will get it */
  }
});

// ---------------------------------------------------------------------------
// #1 — the `overrides` entry was a no-op for consumers
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

describe("#1 transitive advisory: the fix must not be a no-op", () => {

  test("no `overrides` field is published", () => {
    // npm ignores `overrides` inside a dependency's package.json. Shipping
    // one made the package look like it had patched GHSA-frvp-7c67-39w9 for
    // its consumers when it had patched nothing outside this repo.
    assert.equal(
      pkg.overrides,
      undefined,
      "`overrides` in a published package.json only affects this repo and misleads anyone reading it as a fix"
    );
  });

  test("the package has no runtime dependencies of any kind", () => {
    // 0.1.3 made the SDK optional, which still shipped the advisory to
    // anyone doing a plain `npm install` and put the burden on them to know
    // about --omit=optional. A tool about dependency hygiene should not have
    // an opt-out flag for its own; MCP is now spoken directly.
    assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
    assert.equal(pkg.optionalDependencies, undefined, "no optional dependencies either — the flag was the problem");
    assert.equal(pkg.peerDependencies, undefined, "no peer dependencies");
    assert.ok(
      pkg.devDependencies["@modelcontextprotocol/sdk"],
      "the SDK stays as a devDependency: tests/helpers.ts drives the server with the real client"
    );
  });

  test("nothing shipped in dist imports the SDK or zod", () => {
    // The devDependency must never leak into the published code. Walking
    // from both entry points covers everything `files` actually ships.
    const seen = new Set<string>();
    const offenders: string[] = [];

    const walk = (file: string): void => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?[^"']*from\s+["']([^"']+)["']/g)) {
        const spec = m[1];
        if (spec.startsWith(".")) {
          walk(join(file, "..", spec.replace(/\.js$/, ".ts")));
        } else if (spec === "zod" || spec.startsWith("@modelcontextprotocol/")) {
          // A type-only import is erased at runtime and is therefore safe.
          if (!/import\s+type\s/.test(m[0])) offenders.push(`${file} -> ${spec}`);
        }
      }
    };

    walk(join(REPO_ROOT, "src/cli.ts"));
    walk(join(REPO_ROOT, "src/server.ts"));
    assert.deepEqual(offenders, [], "shipped code must not import a devDependency");
    assert.ok(seen.size > 5, `expected to walk the real graph, only saw ${seen.size} files`);
  });

  test("no source file that imports a devDependency ends up in the tarball", () => {
    // Walking from the entry points is not enough. `src/test-client.ts` was
    // reachable from neither, so it passed that check while still being
    // compiled into dist/ and published — a dead ESM file importing
    // @modelcontextprotocol/sdk, which consumers do not install. It has
    // since been deleted rather than excluded, but the guard stays: this one
    // checks the publish list itself, so a future file cannot reintroduce
    // the problem by simply not being imported from an entry point.
    const patterns: string[] = pkg.files;
    const excluded = patterns.filter((f) => f.startsWith("!")).map((f) => f.slice(1));

    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const src = readFileSync(full, "utf8");
        if (!/from\s+["'](zod|@modelcontextprotocol\/[^"']+)["']/.test(src)) continue;
        // Would this file's compiled output ship?
        const distPath = `dist/${relative(join(REPO_ROOT, "src"), full).replaceAll("\\", "/").replace(/\.ts$/, ".js")}`;
        if (!excluded.includes(distPath)) offenders.push(distPath);
      }
    };
    scan(join(REPO_ROOT, "src"));

    assert.deepEqual(offenders, [], `these ship but import a devDependency: ${offenders.join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// #7 — a `constructor`-keyed payload escaped as a protocol-level error
// ---------------------------------------------------------------------------

describe("#7 prototype-shaped argument keys must be ordinary bad input", () => {
  // One payload out of 77 in the fuzzing run broke the pattern: every other
  // malformed input produced a clean isError tool result, but
  // { constructor: { prototype: {} } } produced a raw JSON-RPC
  // "-32603: expected record, received object". Not exploitable, but an
  // inconsistent error path is exactly the kind of thing a model handles
  // badly — a tool result it can read beats a protocol failure it cannot.
  const PAYLOADS: Array<Record<string, unknown>> = [
    { name: "react", constructor: { prototype: { polluted: true } } },
    { name: "react", __proto__: { polluted: true } },
    { name: "react", prototype: { polluted: true } },
    { name: "react", toString: "not-a-function" },
    { name: "react", hasOwnProperty: 1 },
    { name: "react", valueOf: null },
    { constructor: { prototype: {} } },
    { __proto__: { name: "react" } },
  ];

  test("every prototype-shaped payload gets a tool-level answer, not -32603", async () => {
    const mcp = await openMcp({ dbPath: storePath });
    try {
      for (const args of PAYLOADS) {
        let protocolError: string | null = null;
        const r = await mcp.call("check_package", args).catch((e) => {
          protocolError = e instanceof Error ? e.message : String(e);
          return { isError: true, text: "", json: null as any };
        });
        assert.equal(protocolError, null, `payload ${JSON.stringify(args)} escaped as a protocol error: ${protocolError}`);
        assert.ok(r.text.length > 0, "a tool result must carry readable text");
        assert.doesNotMatch(r.text, /-32603|internal error/i, `payload ${JSON.stringify(args)} leaked an internal error`);
      }
    } finally {
      await mcp.close();
    }
  });

  test("responses still in flight when stdin closes are not dropped", async () => {
    // Found by piping three requests into the built server: the first two
    // answered from memory, the third needed a network call, stdin hit EOF
    // and the process exited before replying. A long-lived client keeps
    // stdin open so it never surfaced there, but closing stdin and reading
    // the answers is a legitimate way to drive a stdio server.
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drain-test", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_package", arguments: { name: "zod" } } },
    ];

    const stdout = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src/server.ts")], {
        cwd: REPO_ROOT,
        env: cleanEnv({ DEP_REC_DB_PATH: storePath }),
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("close", () => resolve(out));
      child.stdin.end(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
    });

    const ids = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).id);
    assert.deepEqual(ids.sort(), [1, 2, 3], `expected a reply to every request, got ids ${JSON.stringify(ids)}`);
  });

  test("nothing in the payloads reaches Object.prototype", () => {
    assert.equal(({} as any).polluted, undefined, "Object.prototype was polluted by the test payloads");
  });

  test("the server reports the package's real version", async () => {
    // It used to be a hardcoded literal, and it drifted: the package was
    // bumped to 0.3.1 while every MCP client was still told 0.3.0.
    const mcp = await openMcp({ dbPath: storePath });
    try {
      const info = (mcp.raw as { getServerVersion(): { name: string; version: string } }).getServerVersion();
      assert.equal(info.version, pkg.version, "advertised version must track package.json");
      assert.equal(info.name, "dep-rec-engine");
    } finally {
      await mcp.close();
    }
  });

  test("a well-formed call still works after the sweep", async () => {
    const mcp = await openMcp({ dbPath: storePath });
    try {
      const r = await mcp.call("check_package", { name: "zod" });
      assert.equal(r.json?.name, "zod");
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// #8 — a failed downloads lookup was silently read as zero
// ---------------------------------------------------------------------------

describe("#8 unknown adoption must never be treated as zero", () => {
  test("an unverified subject download count disables the ratio test entirely", async () => {
    // The vector: `target >= subject * 100` is trivially true when subject is
    // a spurious 0, so one rate-limited request could brand any package with
    // a popular near-neighbour a typosquat.
    const store = new Map<string, number>([["react", 150_000_000]]);
    const verified = await checkTyposquat("reactt", 0, store, true);
    assert.equal(verified.suspicious, true, "premise: a genuine zero against react is a squat");

    const unverified = await checkTyposquat("reactt", 0, store, false);
    assert.equal(unverified.suspicious, false, "an unverified count must not satisfy the ratio");
  });

  test("a failed downloads fetch reports null rather than zero", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    try {
      assert.equal(await fetchWeeklyDownloads("react"), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a 404 from the downloads endpoint is still an honest zero", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch;
    try {
      assert.equal(await fetchWeeklyDownloads("some-real-but-unused-package"), 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a rate-limited response is unknown, not zero", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response("rate limited", { status: 429 }))) as unknown as typeof fetch;
    try {
      assert.equal(await fetchWeeklyDownloads("react"), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a package with an unverified zero count is not recommendable", () => {
    assert.equal(isRecommendable(row({ weekly_downloads: 0, downloads_check_failed: true })), false);
    const failures = checkRecommendable(row({ weekly_downloads: 0, downloads_check_failed: true })).failures;
    assert.ok(
      failures.some((f) => /could not be verified/i.test(f)),
      `expected an explicit unverified-adoption reason, got: ${JSON.stringify(failures)}`
    );
  });

  test("a carried-over count from a previous good fetch still counts", () => {
    // Keeping the last real figure is the point of not writing a zero.
    assert.equal(isRecommendable(row({ weekly_downloads: 5_000_000, downloads_check_failed: true })), true);
  });
});

// ---------------------------------------------------------------------------
// #9 — an uncovered domain got five confident, unrelated answers
// ---------------------------------------------------------------------------

describe("#9 a need outside the ten categories must return nothing", () => {
  // Found by asking the obvious question: what happens if I want a PDF
  // library? The answer was vitest, jose, hono, xstate and zod — a test
  // runner, a JWT library, a web framework, a state machine and a validator,
  // each ranked and scored as though it answered. Only a `note` said
  // otherwise, and `caveats` was empty. By this project's own rule that is a
  // bug, not a gap: a missed detection is a documented gap, a confident
  // wrong answer is a bug.
  // The corpus-wide top scorers, i.e. exactly what the old fallback returned
  // for any unmatched need regardless of what was asked.
  const CORPUS_TOP_SCORERS = ["vitest", "jose", "hono", "xstate", "zod"];

  // Live: each of these searches npm and then fetches every candidate, so the
  // list is kept short deliberately. The stress harness covers breadth.
  const UNCOVERED = ["pdf", "qr code"];

  for (const need of UNCOVERED) {
    test(`"${need}" is answered by discovery, never by unrelated corpus leaders`, async () => {
      const r = await recommend({ need });
      assert.equal(r.matchedCategory, null, `premise: "${need}" is outside the curated categories`);
      assert.equal(r.discoveredVia, "npm-search", "an uncovered need must be routed to live discovery");
      assert.ok(r.caveats.length > 0, "discovered results need the not-a-curated-category caveat");
      assert.match(r.caveats[0], /not one of the .* curated categories/i);

      const returned = r.recommendations.map((x) => x.package);
      const leaked = returned.filter((p) => CORPUS_TOP_SCORERS.includes(p));
      assert.deepEqual(leaked, [], `answered "${need}" with corpus-wide top scorers: ${leaked.join(", ")}`);
    });
  }

  test("discovered candidates actually relate to what was asked", async () => {
    const r = await recommend({ need: "pdf" });
    if (r.recommendations.length === 0) return; // eligibility may exclude everything; that is honest
    assert.ok(
      r.recommendations.every((x) => /pdf/i.test(x.package)),
      `expected PDF packages, got: ${r.recommendations.map((x) => x.package).join(", ")}`
    );
  });

  test("a wrong category match is refused rather than guessed", async () => {
    // "web scraping" contains "web", which the synonym map used to resolve to
    // the web-framework category — answering a scraping question with hono
    // and @nestjs/swagger. One unrecognised word now invalidates the match.
    const r = await recommend({ need: "web scraping" });
    assert.equal(r.matchedCategory, null, "'scraping' is not a word this map knows, so it must not claim a match");
    assert.equal(r.discoveredVia, "npm-search");
  });

  test("covered needs are unaffected", async () => {
    for (const [need, expected] of [
      ["jwt library", "auth-jwt"],
      ["csv parser", "csv-parsing"],
      ["orm", "orm-database"],
      ["testing", "testing"],
    ] as const) {
      const r = await recommend({ need, limit: 3 });
      assert.equal(r.matchedCategory, expected);
      assert.ok(r.recommendations.length > 0, `${need} lost its results`);
    }
  });

  // The cooldown logic existed, was tested, was stored — and stopped there.
  // recommend() returned a package name with no version, so the only thing a
  // caller could do with the answer was `npm install <name>`, resolving to
  // whatever shipped that morning. Measured before the fix: 0 of 499 seeded
  // rows carried version guidance, and the recommendation shape had nowhere
  // to put it. A safety feature that never reaches the install decision is
  // not a safety feature.
  test("every recommendation names a version to install", async () => {
    for (const need of ["jwt library", "csv parser", "orm"]) {
      const r = await recommend({ need, limit: 5 });
      assert.ok(r.recommendations.length > 0, `${need} returned nothing`);
      for (const rec of r.recommendations) {
        assert.ok(
          typeof rec.recommendedVersion === "string" && rec.recommendedVersion.length > 0,
          `${rec.package} has no install version, so a caller can only take latest`
        );
        assert.match(rec.recommendedVersion, /^\d/, `${rec.package}: implausible version ${rec.recommendedVersion}`);
      }
    }
  });

  test("a version note appears exactly when the pick differs from latest", async () => {
    const cmp = (a: string, b: string): number => {
      const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
      const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
      return 0;
    };

    for (const need of ["jwt library", "csv parser", "orm", "testing", "logger"]) {
      for (const rec of (await recommend({ need, limit: 5 })).recommendations) {
        const differs = rec.recommendedVersion !== rec.latestVersion;
        if (differs) {
          assert.ok(rec.versionNote, `${rec.package}: pinned ${rec.recommendedVersion} over ${rec.latestVersion} with no explanation`);
          assert.ok(rec.versionNote!.length > 20, `${rec.package}: version note too thin to be a justification`);
        } else {
          assert.equal(rec.versionNote, undefined, `${rec.package}: note attached to a no-op version choice`);
        }
        // Holding a package back is the whole point; pushing it forward past
        // what the maintainer tagged as latest is never this tool's call.
        if (rec.recommendedVersion && rec.latestVersion) {
          assert.ok(
            cmp(rec.recommendedVersion, rec.latestVersion) <= 0,
            `${rec.package}: suggested ${rec.recommendedVersion}, which is newer than latest ${rec.latestVersion}`
          );
        }
      }
    }
  });

  test("the tool description warns the model about limited coverage", async () => {
    const mcp = await openMcp({ dbPath: storePath });
    try {
      const { tools } = await mcp.listTools();
      const d = tools.find((t: any) => t.name === "recommend_package").description as string;
      assert.match(d, /CURATED|ten categories/i);
      assert.match(d, /discoveredVia/, 'must tell the model how to spot a discovered result');
      assert.match(d, /screened shortlist/i, 'must say discovered results are not a ranked verdict');
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// #2 — a store created by an older release crashed instead of migrating
// ---------------------------------------------------------------------------

// A record exactly as an older release wrote it: no has_install_scripts, no
// security_check_failed, no recommended_version, no version_guidance, no
// version_decision — and the array fields still JSON-encoded strings with
// 0/1 integers for booleans, which is how SQLite held them before the store
// became a JSON document in 0.6.0.
//
// So this covers both halves of the compatibility question at once: fields
// that did not exist yet, and fields whose representation changed.
function buildLegacyStore(file: string): void {
  const legacy = {
    name: "left-pad",
    categories: '["testing"]',
    license: null,
    maintainers: 0,
    created_at: null,
    modified_at: null,
    latest_version: null,
    dependencies_count: 0,
    deprecated: 0,
    esm_support: 0,
    typescript_support: 0,
    release_cadence_days: null,
    weekly_downloads: 500000,
    vulnerability_ids: "[]",
    raw_fetched_at: "2020-01-01T00:00:00.000Z",
    first_seen_at: "2020-01-01T00:00:00.000Z",
    score_total: 42.0,
    score_reasons: "[]",
  };
  writeFileSync(file, JSON.stringify({ formatVersion: 1, packages: [legacy] }));
}

// No module cache-busting needed: the store resolves DEP_REC_DB_PATH on every
// call and keys its in-memory copy by path, so pointing the variable at
// another file is enough to read that file.
function readLegacyRow(file: string): any {
  const previous = process.env.DEP_REC_DB_PATH;
  process.env.DEP_REC_DB_PATH = file;
  try {
    return getPackage("left-pad");
  } finally {
    process.env.DEP_REC_DB_PATH = previous;
  }
}

describe("#2 legacy store must migrate, not crash", () => {
  test("reading a 0.1.0-shaped store yields every current field", async () => {
    const file = join(workDir, "legacy-read.json");
    buildLegacyStore(file);

    const res = await runCli(["categories", "--json"], { dbPath: file });
    assert.equal(res.code, 0, `expected clean exit, got ${res.code}\n${res.stderr}`);
    assert.ok(!/no column named|undefined/i.test(res.stderr), res.stderr);

    const row = readLegacyRow(file);
    assert.ok(row, "the legacy record must still be readable");
    const missing = PACKAGES_COLUMNS.map((c) => c.name).filter((n) => !(n in row));
    assert.deepEqual(missing, [], "fields absent from an old record must still read back");
  });

  test("pre-existing records survive with their data intact", async () => {
    const file = join(workDir, "legacy-data.json");
    buildLegacyStore(file);
    await runCli(["categories", "--json"], { dbPath: file });

    const row = readLegacyRow(file);
    assert.equal(row.weekly_downloads, 500000, "existing data must not be reset");
    assert.equal(row.score_total, 42.0);
    // The old SQLite representations must still be understood.
    assert.deepEqual(row.categories, ["testing"], "a JSON-encoded array field must still parse");
    assert.equal(row.deprecated, false, "an integer 0 must still read as false");
    // Fields that did not exist take their declared defaults, not undefined.
    assert.equal(row.has_install_scripts, false);
    assert.equal(row.security_check_failed, false);
    assert.equal(row.recommended_version, null);
    assert.equal(row.version_decision, null);
    assert.equal(row.store_row_damaged, false, "an old-but-valid record is not damaged");
  });

  test("reading an old store twice is stable", async () => {
    const file = join(workDir, "legacy-twice.json");
    buildLegacyStore(file);
    const first = await runCli(["categories", "--json"], { dbPath: file });
    const second = await runCli(["categories", "--json"], { dbPath: file });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, `second open must be a no-op, got:\n${second.stderr}`);
    assert.equal(first.stdout, second.stdout);
  });

  test("the declared Node floor matches the newest API actually used", () => {
    // The previous floor said ">=22.0.0" while the code imported node:sqlite,
    // which landed in 22.5.0 — so 22.0 through 22.4 installed the package and
    // crashed on first use. The floor is a claim about what runs, and it was
    // wrong by four minor versions. Pinning it here because getting it wrong
    // is silent: nothing in a normal test run executes on the floor version.
    const declared = pkg.engines.node as string;
    assert.match(declared, /^>=18\.3\.0$/, `engines.node is "${declared}"`);

    // The two constraints that set it. node:sqlite is gone; util.parseArgs
    // (18.3.0) and global fetch (18.0.0) are what remain, so 18.3.0 it is.
    const walk = (dir: string, hits: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, hits);
        else if (entry.name.endsWith(".ts") && /from\s+["']node:sqlite["']/.test(readFileSync(full, "utf8"))) {
          hits.push(full);
        }
      }
      return hits;
    };
    assert.deepEqual(
      walk(join(REPO_ROOT, "src")),
      [],
      "importing node:sqlite again would silently raise the real floor to 22.5 without changing engines"
    );
  });

  test("an unreadable store fails loudly instead of being silently replaced", async () => {
    // Starting from empty would be friendlier right up until the first write
    // replaced a damaged-but-recoverable file with an empty one.
    const file = join(workDir, "corrupt.json");
    writeFileSync(file, '{"formatVersion":1,"packages":[{"name":"left-pad"');
    const res = await runCli(["categories", "--json"], { dbPath: file });
    assert.notEqual(res.code, 0, "a corrupt store must not be treated as an empty one");
    assert.match(res.stderr, /not valid JSON/i);
    assert.match(res.stderr, /refusing to overwrite/i);
    assert.equal(
      readFileSync(file, "utf8"),
      '{"formatVersion":1,"packages":[{"name":"left-pad"',
      "the damaged file must be left exactly as it was"
    );
  });
});

// ---------------------------------------------------------------------------
// #3 — concurrent access died with "database is locked"
// ---------------------------------------------------------------------------

describe("#3 concurrent store access must wait, not fail", () => {
  // Contention has to be *guaranteed*, not hoped for. An earlier version of
  // this had the holder release on a timer, which made both tests unsound
  // under load: spawning a tsx child can take seconds, by which point the
  // timer had already fired and there was no lock left to contend with —
  // the control case then failed, and the positive case would have passed
  // without ever proving anything. So the holder now keeps the lock until
  // it is explicitly told to let go, and the writer announces itself on
  // stdout immediately before it blocks.
  interface Holder {
    release(): void;
    kill(): void;
  }

  // Holds the store lock the same way the store itself does — by creating the
  // lock directory. Using the real protocol rather than an API call keeps this
  // honest: if the locking scheme changes, this stops contending and the
  // control case below fails, which is exactly the signal wanted.
  function spawnLockHolder(dbFile: string): Promise<Holder> {
    const script = join(workDir, "hold-lock.mjs");
    writeFileSync(
      script,
      `import { mkdirSync, rmdirSync } from "node:fs";
const lock = ${JSON.stringify(dbFile)} + ".lock";
mkdirSync(lock);
console.log("LOCKED");
process.stdin.resume();
process.stdin.once("data", () => { try { rmdirSync(lock); } catch {} process.exit(0); });
process.on("exit", () => { try { rmdirSync(lock); } catch {} });
`
    );

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], env: cleanEnv() });
      const timer = setTimeout(() => reject(new Error("lock holder never reported LOCKED")), 30_000);
      child.stdout.on("data", (d) => {
        if (String(d).includes("LOCKED")) {
          clearTimeout(timer);
          resolve({
            release: () => child.stdin.write("go\n"),
            kill: () => child.kill(),
          });
        }
      });
      child.on("error", reject);
    });
  }

  interface WriteAttempt {
    code: number | null;
    stderr: string;
    waitedMs: number;
    /** Resolves once the child is about to issue the blocking write. */
    started: Promise<void>;
  }

  function writeInChild(dbFile: string, value: number, timeoutOverride?: string): WriteAttempt {
    const script = join(workDir, `write-${value}.mjs`);
    writeFileSync(
      script,
      `const { upsertScore } = await import(${JSON.stringify(
        "file:///" + join(REPO_ROOT, "src/store/db.ts").replaceAll("\\", "/")
      )});
// Touch the store first so connection setup (open, pragmas, migration) is
// done before the announcement — otherwise "STARTING" would be printed
// before the work that itself needs the lock.
const { getPackage } = await import(${JSON.stringify(
        "file:///" + join(REPO_ROOT, "src/store/db.ts").replaceAll("\\", "/")
      )});
getPackage("left-pad");
console.log("STARTING");
const t0 = Date.now();
upsertScore("left-pad", { total: ${value}, security: 1, maintenance: 1, compatibility: 1, community: 1, supplyChain: 1, reasons: [], method: "absolute" });
console.log("WAITED " + (Date.now() - t0));
`
    );

    const env = cleanEnv({ DEP_REC_DB_PATH: dbFile, ...(timeoutOverride ? { DEP_REC_BUSY_TIMEOUT_MS: timeoutOverride } : {}) });
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "pipe"], env, cwd: REPO_ROOT });

    let stdout = "";
    let stderr = "";
    let announce: () => void;
    const started = new Promise<void>((res) => (announce = res));
    child.stdout.on("data", (c) => {
      stdout += c;
      if (stdout.includes("STARTING")) announce();
    });
    child.stderr.on("data", (c) => (stderr += c));

    const done = new Promise<{ code: number | null }>((res) => child.on("close", (code) => res({ code })));

    // The object is filled in as the child progresses; callers await
    // `started` before releasing the lock and `finished` before asserting.
    const attempt = { code: null as number | null, stderr: "", waitedMs: -1, started } as WriteAttempt & { finished: Promise<void> };
    attempt.finished = done.then(({ code }) => {
      attempt.code = code;
      attempt.stderr = stderr;
      // A child killed before it announced never reaches the timer.
      attempt.waitedMs = Number(/WAITED (\d+)/.exec(stdout)?.[1] ?? -1);
      announce(); // unblock anyone still waiting if the child died early
    });
    return attempt;
  }

  test("a write blocked by another process waits for the lock instead of dying", async () => {
    const file = join(workDir, "contended.json");
    buildLegacyStore(file);
    await runCli(["categories", "--json"], { dbPath: file });

    const holder = await spawnLockHolder(file);
    const attempt = writeInChild(file, 77) as WriteAttempt & { finished: Promise<void> };
    await attempt.started;

    // Hold the lock a little longer so the write is provably blocked, then
    // let go and confirm it went through rather than erroring out.
    await new Promise((r) => setTimeout(r, 600));
    holder.release();
    await attempt.finished;
    holder.kill();

    assert.equal(attempt.code, 0, `contending write should have waited and succeeded:\n${attempt.stderr}`);
    assert.ok(!/store is locked/i.test(attempt.stderr), attempt.stderr);
    assert.ok(
      attempt.waitedMs >= 250,
      `the write must actually have blocked on the lock, but returned in ${attempt.waitedMs}ms — the test proved nothing`
    );
  });

  test("the busy timeout is what makes that work (control case)", async () => {
    // With a zero wait budget the contending write gives up instantly — the
    // reviewer's exact original failure. Asserting it here proves the test
    // above is load-bearing rather than an accident of timing. The lock is
    // held for the whole lifetime of the child, so there is no window in
    // which this can pass by luck.
    const file = join(workDir, "contended-control.json");
    buildLegacyStore(file);
    await runCli(["categories", "--json"], { dbPath: file });

    const holder = await spawnLockHolder(file);
    const attempt = writeInChild(file, 88, "0") as WriteAttempt & { finished: Promise<void> };
    await attempt.finished;
    holder.release();
    holder.kill();

    assert.notEqual(attempt.code, 0, "with a zero busy timeout the contending write is expected to fail");
    assert.match(attempt.stderr, /store is locked/i);
  });

  test("a lock left behind by a dead process is reclaimed, not waited on forever", async () => {
    // The cost of hand-rolled locking: a process killed mid-write leaves the
    // lock directory behind, and without this the store stays wedged until
    // someone deletes it by hand. SQLite recovered from that on its own.
    const file = join(workDir, "stale-lock.json");
    buildLegacyStore(file);
    const lock = `${file}.lock`;
    mkdirSync(lock);

    // Age it well past the reclaim threshold (wait budget + 30s grace).
    const ancient = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, ancient, ancient);

    const res = await runCli(["categories", "--json"], { dbPath: file }, { DEP_REC_BUSY_TIMEOUT_MS: "500" });
    assert.equal(res.code, 0, `a stale lock must be reclaimed:\n${res.stderr}`);
    try {
      rmdirSync(lock);
    } catch {
      /* already reclaimed, which is the point */
    }
  });

  test("several processes reading the same store concurrently all succeed", async () => {
    const file = join(workDir, "concurrent-read.json");
    copyFileSync(join(REPO_ROOT, "data/store.json"), file);

    const runs = await Promise.all([
      runCli(["categories", "--json"], { dbPath: file }),
      runCli(["categories", "--json"], { dbPath: file }),
      runCli(["recommend", "csv parser", "--json"], { dbPath: file }),
      runCli(["recommend", "jwt library", "--json"], { dbPath: file }),
      runCli(["categories", "--json"], { dbPath: file }),
      runCli(["recommend", "logging", "--json"], { dbPath: file }),
    ]);

    for (const [i, r] of runs.entries()) {
      assert.equal(r.code, 0, `process ${i} failed (${r.code}):\n${r.stderr}`);
      assert.ok(!/store is locked/i.test(r.stderr), `process ${i}: ${r.stderr}`);
    }
  });
});

// ---------------------------------------------------------------------------
// #4 — an absolute download floor silently overrode the ratio check
// ---------------------------------------------------------------------------

describe("#4 typosquat floor must not exempt curated targets", () => {
  // Real numbers from the review: parcel sits well under the old flat 1M
  // floor, so an 82,000x-ratio squat of it was waved through.
  const PARCEL = 409_799;

  test("a squat of a curated target under 1M downloads is flagged", async () => {
    const store = new Map<string, number>([["parcel", PARCEL]]);
    const res = await checkTyposquat("parcell", 5, store);
    assert.equal(res.suspicious, true, "deletion/insertion squat of parcel must be caught");
    assert.equal(res.targetPackage, "parcel");
  });

  test("the same holds for the other curated names the review named", async () => {
    for (const [target, downloads] of [
      ["gatsby", 300_000],
      ["angular", 250_000],
    ] as const) {
      const store = new Map<string, number>([[target, downloads]]);
      const res = await checkTyposquat(target + target.slice(-1), 4, store);
      assert.equal(res.suspicious, true, `${target} should be protected at ${downloads} downloads`);
    }
  });

  test("a non-curated store name still needs real popularity to be a target", async () => {
    // The store deliberately tracks obscure packages; two of those one edit
    // apart is a coincidence, not an attack, and must not be flagged.
    const store = new Map<string, number>([["obscure-thing", 60_000]]);
    const res = await checkTyposquat("obscure-things", 5, store);
    assert.equal(res.suspicious, false, "a 60k-download non-curated name is not a squat target");
  });

  test("the ratio requirement still applies to curated targets", async () => {
    const store = new Map<string, number>([["parcel", PARCEL]]);
    // Candidate is nearly as popular as the target -> not a squat.
    const res = await checkTyposquat("parcell", PARCEL / 2, store);
    assert.equal(res.suspicious, false, "a comparably-popular neighbour is not a squat");
  });

  test("an unreachable downloads endpoint yields no opinion, not an exception", async () => {
    // Surfaced while chasing an intermittent CI failure: an unreachable
    // api.npmjs.org threw straight out through check_package, so a partial
    // npm outage took down every lookup rather than degrading one advisory
    // signal. Detection is allowed to go quiet; the call is not allowed to
    // die, and it is certainly not allowed to accuse on missing data.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    try {
      const res = await checkTyposquat("reactt", 10, new Map());
      assert.equal(res.suspicious, false, "unknown target popularity must never produce an accusation");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a curated target that has collapsed to nothing protects nobody", async () => {
    const store = new Map<string, number>([["browserify", 900]]);
    const res = await checkTyposquat("browserifyy", 5, store);
    assert.equal(res.suspicious, false, "below even the curated floor there is no target worth squatting");
  });
});

// ---------------------------------------------------------------------------
// #5 — an invalid --limit produced an empty list instead of an error
// ---------------------------------------------------------------------------

describe("#5 invalid limit must be an error, never an empty result", () => {
  for (const bad of [0, -1, -5, 2.7, Number.NaN, Number.POSITIVE_INFINITY, 1e9, MAX_LIMIT + 1]) {
    test(`normalizeLimit rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => normalizeLimit(bad), RangeError);
    });
  }

  test("normalizeLimit accepts the documented range", () => {
    assert.equal(normalizeLimit(undefined), 5);
    assert.equal(normalizeLimit(1), 1);
    assert.equal(normalizeLimit(MAX_LIMIT), MAX_LIMIT);
  });

  for (const bad of ["banana", "0", "-5", "2.7", "1e9", "999", ""]) {
    test(`CLI --limit ${JSON.stringify(bad)} exits non-zero with a message about the flag`, async () => {
      const res = await runCli(["recommend", "csv parser", "--limit", bad, "--json"], { dbPath: storePath });
      assert.notEqual(res.code, 0, `--limit ${bad} was accepted; stdout was:\n${res.stdout}`);
      assert.match(res.stderr, /limit/i);
      assert.ok(
        !/"recommendations":\s*\[\s*\]/.test(res.stdout),
        "must not print an empty recommendation list for a bad flag"
      );
    });
  }

  test("MCP rejects an out-of-range limit rather than returning nothing", async () => {
    const mcp = await openMcp({ dbPath: storePath });
    try {
      for (const bad of [0, -5, 2.7, 1e9]) {
        const res = await mcp.call("recommend_package", { need: "csv parser", limit: bad });
        assert.equal(res.isError, true, `limit ${bad} should be a protocol-level error`);
      }
    } finally {
      await mcp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// #6 — a malformed name was reported as "does not exist"
// ---------------------------------------------------------------------------

describe("#6 a lookup miss must say which kind of miss it was", () => {
  test("real names, including legacy shapes, stay valid", () => {
    for (const name of ["react", "@types/node", "left-pad", "JSONStream", "a.b.c", "x-y_z", "@scope/a.b-c"]) {
      assert.equal(validatePackageName(name).valid, true, `${name} must be accepted`);
    }
  });

  test("structurally impossible names are rejected before any network call", () => {
    for (const name of ["", " ", "x".repeat(5000), "@scope/name/extra", "has space", ".dot", "_under", "no/slash"]) {
      assert.equal(validatePackageName(name).valid, false, `${JSON.stringify(name.slice(0, 20))} must be rejected`);
    }
  });

  test("an oversized name is reported as malformed, not as nonexistent", async () => {
    const doc = await fetchPackageDoc("x".repeat(5000));
    assert.equal(doc.found, false);
    assert.equal(doc.found === false && doc.code, "invalid-name");
    assert.match(doc.found === false ? doc.reason : "", /214/);
  });

  test("the malformed-name note never claims the package is hallucinated", async () => {
    const result = await checkPackage("@scope/name/extra");
    assert.equal(result.found, false);
    assert.equal(result.reasonCode, "invalid-name");
    // Only the accusation matters. The note is allowed to say "do not
    // report this as 'the package does not exist'" — that phrase appearing
    // inside its own prohibition is the opposite of the bug.
    assert.ok(
      !/hallucinat|typosquat/i.test(result.note),
      `an unasked question cannot have that answer; note was:\n${result.note}`
    );
    assert.match(result.note, /never queried/i, "the note must say the registry was not consulted");
  });

  test("the hallucination warning appears if and only if the registry returned 404", async () => {
    // Stated as an iff so it holds with or without a reachable network. A
    // registry outage during this test is not a failure — it is the second
    // half of the property, and the half the old code got wrong.
    const result = await checkPackage("this-package-truly-does-not-exist-9e3f1a7c");
    assert.equal(result.found, false);
    assert.ok(
      ["not-found", "registry-error"].includes(result.reasonCode!),
      `unexpected miss code: ${result.reasonCode}`
    );
    assert.equal(
      /hallucinated or typosquatted/i.test(result.note),
      result.reasonCode === "not-found",
      `the warning must track the 404 exactly; code was ${result.reasonCode} and note was:\n${result.note}`
    );
  });

  test("the MCP tool description tells the model how to read reasonCode", async () => {
    // The distinction is worthless if the model reading the response has not
    // been told that only one of the four codes is an accusation.
    const mcp = await openMcp({ dbPath: storePath });
    try {
      const { tools } = await mcp.listTools();
      const d = tools.find((t: any) => t.name === "check_package").description as string;
      assert.match(d, /reasonCode/, "the model needs to know the field exists");
      assert.match(d, /registry-error/, "must name the outage case explicitly");
      assert.match(d, /never be reported as/i, "must forbid reporting an outage as nonexistence");
    } finally {
      await mcp.close();
    }
  });

  test("a multi-slash name cannot build a registry URL at all", () => {
    // The old `name.replace("/", "%2F")` escaped only the first slash, so
    // "@scope/name/extra" produced a malformed request path.
    assert.equal(validatePackageName("@scope/name/extra").valid, false);
    assert.equal(validatePackageName("a/b/c").valid, false);
  });
});
