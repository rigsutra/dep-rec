// Proof 0 — Tier 3 signal check
//
// Question: is "does this package actually run under the Edge Runtime"
// a real, cheap, deterministic signal we can compute — or just a nice
// idea that falls apart on contact with real packages?
//
// Method: bundle each package with esbuild, resolving package.json
// "exports" the way real edge bundlers do (worker/workerd/edge-light
// conditions, not the Node-optimized entry), so every inlineable npm
// dependency gets inlined and only genuine Node-only built-ins survive
// as unresolved `require(...)` calls. Then evaluate that bundle inside
// a real @edge-runtime/vm context. Any Node built-in reference that
// reaches the sandbox — whether esbuild refuses to resolve it at bundle
// time, or our shim catches a runtime require() — is exactly the thing
// that breaks on Vercel/Cloudflare/Workers-style edge runtimes.
// We log what actually happens; nothing here is guessed.

import { EdgeVM } from "@edge-runtime/vm";
import * as esbuild from "esbuild";

type Verdict = "pass" | "warn" | "fail";

interface CheckResult {
  package: string;
  verdict: Verdict;
  reason: string;
  builtinsTouched: string[];
}

async function bundlePackage(pkgName: string): Promise<string> {
  // platform: "browser" + explicit conditions makes esbuild resolve
  // package.json "exports" the same way Vercel/Cloudflare edge bundlers do —
  // preferring the "worker" / "workerd" / "edge-light" / "browser" entry
  // over the Node-optimized "require"/"import" entry. Using platform:"node"
  // here would silently pick the Node-fast-path build of edge-first
  // packages (e.g. jose, nanoid resolve to a `node:crypto`-based entry)
  // and produce false negatives that have nothing to do with real
  // Edge Runtime compatibility.
  const result = await esbuild.build({
    entryPoints: [pkgName],
    bundle: true,
    platform: "browser",
    conditions: ["edge-light", "workerd", "worker"],
    format: "cjs",
    write: false,
    logLevel: "silent",
    absWorkingDir: process.cwd(),
  });
  return result.outputFiles[0].text;
}

function makeEdgeRequire(touched: Set<string>) {
  return (id: string) => {
    touched.add(id);
    throw new Error(`Node built-in "${id}" is not available in the Edge Runtime`);
  };
}

function unresolvedBuiltinsFrom(buildError: unknown): string[] {
  const errors = (buildError as { errors?: Array<{ text: string }> }).errors ?? [];
  const found = new Set<string>();
  for (const e of errors) {
    const match = e.text.match(/Could not resolve "([^"]+)"/);
    if (match) found.add(match[1]);
  }
  return [...found];
}

async function checkPackage(pkgName: string): Promise<CheckResult> {
  let code: string;
  try {
    code = await bundlePackage(pkgName);
  } catch (err) {
    const builtins = unresolvedBuiltinsFrom(err);
    return {
      package: pkgName,
      verdict: "fail",
      reason: builtins.length
        ? `Bundle can't resolve ${builtins.length} Node-only built-in(s) — this package cannot load on the Edge Runtime as-is.`
        : `Bundle failed: ${(err as Error).message.split("\n")[0]}`,
      builtinsTouched: builtins,
    };
  }

  const touched = new Set<string>();
  const vm = new EdgeVM({
    extend: (context) => {
      context.__edgeRequire = makeEdgeRequire(touched);
      return context;
    },
  });

  // CJS wrapper: gives the bundle the module/exports/require triplet it
  // expects, with `require` routed to our sandbox shim instead of Node's.
  const wrapped = `
    (function (module, exports, require) {
      ${code}
      return module.exports;
    })({ exports: {} }, {}, __edgeRequire);
  `;

  try {
    vm.evaluate(wrapped);
    if (touched.size > 0) {
      return {
        package: pkgName,
        verdict: "warn",
        reason:
          "Loaded without throwing, but internally touched a Node built-in " +
          "(likely caught in a try/catch fallback) — worth a manual look.",
        builtinsTouched: [...touched],
      };
    }
    return {
      package: pkgName,
      verdict: "pass",
      reason: "Loaded cleanly — no Node-only built-in was touched.",
      builtinsTouched: [],
    };
  } catch (err) {
    return {
      package: pkgName,
      verdict: "fail",
      reason: (err as Error).message,
      builtinsTouched: [...touched],
    };
  }
}

const TEST_PACKAGES = [
  "jose", // expected pass — Web Crypto based, edge-first by design
  "nanoid", // expected pass — pure JS, no I/O
  "zod", // expected pass — pure JS validation
  "jsonwebtoken", // expected fail — requires Node's `crypto` module directly
  "bcryptjs", // borderline — pure JS reimplementation, worth confirming
  "express", // expected fail — requires `http`, `net`, and friends
];

const MARK: Record<Verdict, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };

async function main() {
  console.log("Proof 0 — Edge Runtime compatibility check\n");

  const results: CheckResult[] = [];
  for (const pkg of TEST_PACKAGES) {
    process.stdout.write(`checking ${pkg} ... `);
    const result = await checkPackage(pkg);
    results.push(result);
    console.log(MARK[result.verdict]);
  }

  console.log("\n---\n");
  for (const r of results) {
    console.log(`[${MARK[r.verdict]}] ${r.package}`);
    console.log(`   ${r.reason}`);
    if (r.builtinsTouched.length) {
      console.log(`   builtins touched: ${r.builtinsTouched.join(", ")}`);
    }
  }

  const passed = results.filter((r) => r.verdict === "pass").length;
  console.log(`\n${passed}/${results.length} packages loaded cleanly under the Edge Runtime.`);
}

main();
