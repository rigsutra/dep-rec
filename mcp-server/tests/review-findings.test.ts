// Regression suite for the six findings from the second external review of
// the published package. Each test reproduces the reviewer's scenario as
// closely as it can be reproduced in-repo, so a future change that
// reintroduces any of them fails here rather than in someone's project.
//
// Numbering matches the review.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, runCli, openMcp, cleanEnv, row } from "./helpers.js";
import { PACKAGES_COLUMNS } from "../src/store/schema.js";
import { checkTyposquat } from "../src/store/typosquat.js";
import { normalizeLimit, MAX_LIMIT, checkPackage, recommend } from "../src/data.js";
import { validatePackageName, fetchPackageDoc, fetchWeeklyDownloads } from "../src/sources/npm.js";
import { isRecommendable, checkRecommendable } from "../src/store/eligibility.js";

let workDir: string;
// Every MCP session in this file points here, never at data/store.db. An
// earlier revision of this suite forgot, and a single `check_package` for
// "react" wrote an uncategorised row straight into the artifact that ships
// inside the package — the exact pollution bug the corpus suite exists to
// catch, which is how it was found.
let storePath: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "dep-rec-review-"));
  storePath = join(workDir, "mcp-store.db");
  copyFileSync(join(REPO_ROOT, "data/store.db"), storePath);
  // This file also calls checkPackage() in-process, not just through a
  // subprocess, so the in-process store has to be redirected too.
  process.env.DEP_REC_DB_PATH = storePath;
});

after(() => {
  // The store keeps -wal/-shm siblings and Windows holds handles briefly;
  // a failed cleanup must not fail the suite.
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* temp dir, the OS will get it */
  }
});

// ---------------------------------------------------------------------------
// #1 — the `overrides` entry was a no-op for consumers
// ---------------------------------------------------------------------------

describe("#1 transitive advisory: the fix must not be a no-op", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

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
    assert.ok(pkg.devDependencies["@modelcontextprotocol/sdk"], "the SDK stays as a devDependency: the test client uses it");
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

  test("nothing in the payloads reaches Object.prototype", () => {
    assert.equal(({} as any).polluted, undefined, "Object.prototype was polluted by the test payloads");
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

// The genuine 0.1.0 column set: no has_install_scripts, no
// security_check_failed, no recommended_version, no version_guidance.
const LEGACY_0_1_0_SCHEMA = `
CREATE TABLE packages (
  name TEXT PRIMARY KEY,
  categories TEXT NOT NULL DEFAULT '[]',
  license TEXT,
  maintainers INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  modified_at TEXT,
  latest_version TEXT,
  dependencies_count INTEGER NOT NULL DEFAULT 0,
  deprecated INTEGER NOT NULL DEFAULT 0,
  esm_support INTEGER NOT NULL DEFAULT 0,
  typescript_support INTEGER NOT NULL DEFAULT 0,
  release_cadence_days REAL,
  weekly_downloads INTEGER NOT NULL DEFAULT 0,
  vulnerability_ids TEXT NOT NULL DEFAULT '[]',
  raw_fetched_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  score_total REAL,
  score_security REAL,
  score_maintenance REAL,
  score_compatibility REAL,
  score_community REAL,
  score_supply_chain REAL,
  score_reasons TEXT NOT NULL DEFAULT '[]',
  score_method TEXT,
  score_computed_at TEXT
);
`;

function buildLegacyStore(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(LEGACY_0_1_0_SCHEMA);
  db.exec(
    `INSERT INTO packages (name, categories, raw_fetched_at, first_seen_at, weekly_downloads, score_total, score_reasons)
     VALUES ('left-pad', '["testing"]', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 500000, 42.0, '[]')`
  );
  db.close();
}

describe("#2 legacy store must migrate, not crash", () => {
  test("opening a 0.1.0-schema store adds every missing column", async () => {
    const file = join(workDir, "legacy-read.db");
    buildLegacyStore(file);

    const res = await runCli(["categories", "--json"], { dbPath: file });
    assert.equal(res.code, 0, `expected clean exit, got ${res.code}\n${res.stderr}`);
    assert.ok(!/no column named/i.test(res.stderr), res.stderr);

    const db = new DatabaseSync(file);
    const present = new Set(
      (db.prepare("PRAGMA table_info(packages)").all() as Array<{ name: string }>).map((r) => r.name)
    );
    db.close();

    const missing = PACKAGES_COLUMNS.map((c) => c.name).filter((n) => !present.has(n));
    assert.deepEqual(missing, [], "migration left columns behind");
  });

  test("pre-existing rows survive the migration with their data intact", async () => {
    const file = join(workDir, "legacy-data.db");
    buildLegacyStore(file);
    await runCli(["categories", "--json"], { dbPath: file });

    const db = new DatabaseSync(file);
    const row = db.prepare("SELECT * FROM packages WHERE name = 'left-pad'").get() as any;
    db.close();

    assert.equal(row.weekly_downloads, 500000, "existing data must not be reset by the migration");
    assert.equal(row.score_total, 42.0);
    // Added NOT NULL columns must backfill from their declared default.
    assert.equal(row.has_install_scripts, 0);
    assert.equal(row.security_check_failed, 0);
    assert.equal(row.recommended_version, null);
  });

  test("migration is idempotent", async () => {
    const file = join(workDir, "legacy-twice.db");
    buildLegacyStore(file);
    const first = await runCli(["categories", "--json"], { dbPath: file });
    const second = await runCli(["categories", "--json"], { dbPath: file });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, `second open must be a no-op, got:\n${second.stderr}`);
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

  function spawnLockHolder(dbFile: string): Promise<Holder> {
    const script = join(workDir, "hold-lock.mjs");
    writeFileSync(
      script,
      `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(dbFile)});
db.exec("PRAGMA busy_timeout = 30000;");
db.exec("PRAGMA journal_mode = WAL;");
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE packages SET score_total = score_total WHERE name = 'left-pad'").run();
console.log("LOCKED");
process.stdin.resume();
process.stdin.once("data", () => { db.exec("COMMIT"); db.close(); process.exit(0); });
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
    const file = join(workDir, "contended.db");
    buildLegacyStore(file);
    await runCli(["categories", "--json"], { dbPath: file }); // migrate first

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
    assert.ok(!/database is locked/i.test(attempt.stderr), attempt.stderr);
    assert.ok(
      attempt.waitedMs >= 250,
      `the write must actually have blocked on the lock, but returned in ${attempt.waitedMs}ms — the test proved nothing`
    );
  });

  test("the busy timeout is what makes that work (control case)", async () => {
    // Without it, SQLite gives up instantly — this is the reviewer's exact
    // failure, and asserting it here proves the fix above is load-bearing
    // rather than an accident of timing. The lock is held for the whole
    // lifetime of the child, so there is no window in which this can pass
    // by luck.
    const file = join(workDir, "contended-control.db");
    buildLegacyStore(file);
    await runCli(["categories", "--json"], { dbPath: file });

    const holder = await spawnLockHolder(file);
    const attempt = writeInChild(file, 88, "0") as WriteAttempt & { finished: Promise<void> };
    await attempt.finished;
    holder.release();
    holder.kill();

    assert.notEqual(attempt.code, 0, "with busy_timeout=0 the contending write is expected to fail");
    assert.match(attempt.stderr, /database is locked/i);
  });

  test("several processes reading the same store concurrently all succeed", async () => {
    const file = join(workDir, "concurrent-read.db");
    copyFileSync(join(REPO_ROOT, "data/store.db"), file);

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
      assert.ok(!/database is locked/i.test(r.stderr), `process ${i}: ${r.stderr}`);
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
