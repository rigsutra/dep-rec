// Verifies the `engines.node` floor against the thing consumers actually
// install: the built dist/.
//
// The normal suites cannot do this. They import `../src/*.ts`, so they need
// tsx via `--import` — a flag that did not exist until Node 18.19 — and they
// use `describe`/`it`, added in 18.6. Both are newer than this package's
// 18.3.0 floor, so `npm test` can never run there. That gap is not academic:
// this package already shipped a floor it could not honour once (see the
// header of src/store/db.ts — `engines` said 22.0 while node:sqlite needs
// 22.5, so 22.0–22.4 installed it and crashed).
//
// This script is plain ESM using only APIs present at the floor, so it can be
// executed by the oldest supported runtime directly:
//
//   npm run build
//   <node-18.3.0>/node scripts/floor-check.mjs

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const floor = String(pkg.engines.node).replace(/^[^\d]*/, "");
const parse = (v) => v.split(".").map(Number);
const cmp = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name}`);
  }
};

console.log(`engines.node floor : >=${floor}`);
console.log(`running on         : ${process.version}`);

// Running above the floor still checks that dist/ is loadable, but it is not
// evidence about the floor itself. Say so rather than let a green run imply
// more than it proved.
if (cmp(process.versions.node, floor) < 0) {
  console.error(`\nThis runtime is BELOW the declared floor. Nothing to prove.`);
  process.exit(2);
}
const atFloor = parse(process.versions.node)[0] === parse(floor)[0];
console.log(
  atFloor
    ? `verdict scope      : true floor test (same major as the floor)\n`
    : `verdict scope      : smoke test only — rerun on Node ${parse(floor)[0]} to test the floor\n`,
);

assert.ok(
  existsSync(join(root, "dist", "cli.js")),
  "dist/ is not built — run `npm run build` first",
);

// Same store-safety rule the suites follow (tests/README.md): never let a
// check touch the store.json that ships inside the package.
const dir = mkdtempSync(join(tmpdir(), "dep-rec-floor-"));
const dbPath = join(dir, "store.json");
copyFileSync(join(root, "data", "store.json"), dbPath);

const cli = (...args) =>
  spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, DEP_REC_DB_PATH: dbPath },
  });

check("cli --help exits 0 and names itself", () => {
  const r = cli("--help");
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /dep-rec/);
});

check("cli categories reads the store", () => {
  const r = cli("categories");
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.trim().length > 0, "no categories printed");
});

check("cli categories --json emits parseable JSON", () => {
  const r = cli("categories", "--json");
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed) || typeof parsed === "object");
});

check("cli rejects a bad argument without crashing", () => {
  const r = cli("--definitely-not-a-flag");
  assert.notEqual(r.status, 0, "a bad flag should be a non-zero exit");
  assert.ok(!/\bReferenceError|TypeError\b/.test(r.stderr), "crashed rather than errored");
});

check("dist/server.js (MCP entrypoint) imports cleanly", () => {
  // Must be a file:// URL — Node 18's ESM loader rejects a bare `c:\...`
  // path with ERR_UNSUPPORTED_ESM_URL_SCHEME.
  const url = pathToFileURL(join(root, "dist", "server.js")).href;
  const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(url)})`], {
    encoding: "utf8",
    env: { ...process.env, DEP_REC_DB_PATH: dbPath },
  });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
});

// Regression guard for the documented node:sqlite incident. The
// @types/node@18 typecheck catches this at compile time; this catches it in
// the emitted artifact, which is what actually ships.
//
// Matches import/require syntax, not bare occurrences: db.js carries a
// comment explaining why node:sqlite was dropped, and a substring search
// flags that prose as if it were a dependency.
check("dist/ imports no builtin newer than the floor", () => {
  const tooNew = ["node:sqlite"];
  const js = [];
  (function walk(d) {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".js")) js.push(p);
    }
  })(join(root, "dist"));

  assert.ok(js.length > 0, "no .js files found under dist/");
  for (const file of js) {
    const src = readFileSync(file, "utf8");
    for (const mod of tooNew) {
      const used = new RegExp(`(?:from|import|require)\\s*\\(?\\s*["']${mod}["']`).test(src);
      assert.ok(!used, `${file} imports ${mod}, which the floor cannot load`);
    }
  }
});

console.log("");
if (failures.length) {
  console.error(`floor check FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`floor check passed on ${process.version} against >=${floor}`);
