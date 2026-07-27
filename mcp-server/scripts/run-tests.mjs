// Discovers test files and runs them, instead of relying on a glob.
//
// `node --import tsx --test tests/*.test.ts` looks portable and is not. npm
// runs scripts through cmd.exe on Windows, which does not expand globs, and
// Node's own --test glob support only arrived in 22. So that command quietly
// depends on *either* a POSIX shell *or* Node 22 — and on Windows + Node 18,
// the combination this package's `engines` explicitly promises to support, it
// fails with "Could not find 'tests\*.test.ts'" before running a single test.
//
// Expanding the list here makes the invocation identical on every shell and
// every supported Node.
//
// Usage: node scripts/run-tests.mjs [basename-prefix]

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(root, "tests");
const prefix = process.argv[2] ?? "";

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.ts") && f.startsWith(prefix))
  .sort()
  .map((f) => join(testsDir, f));

if (files.length === 0) {
  console.error(
    prefix
      ? `No test files in tests/ matching "${prefix}*.test.ts".`
      : "No *.test.ts files found in tests/.",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  cwd: root,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
