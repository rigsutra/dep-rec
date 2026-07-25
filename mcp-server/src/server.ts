#!/usr/bin/env node
// Proof 3 — expose the scored dataset as an MCP server so an AI coding
// assistant can call it directly, mid-conversation, before recommending or
// installing a package. This is the part of the roadmap that actually
// tests the thesis: does an assistant use this instead of guessing from
// training data?

import { listCategories, recommend, checkPackage, MAX_LIMIT } from "./data.js";

// The MCP SDK and zod are loaded dynamically, and declared as OPTIONAL
// dependencies, because only this file needs them — the CLI (`dep-rec`) and
// every scoring/store module underneath it have zero runtime dependencies.
//
// That split is the only real mitigation available for GHSA-frvp-7c67-39w9:
// the advisory lives in `@hono/node-server`, which `@modelcontextprotocol/
// sdk` pins to a range with no patched version in it, and a package cannot
// fix a transitive dependency for its own consumers (`overrides` only
// applies to the project that declares it). What it CAN do is stop forcing
// that subtree on people who only want the CLI:
//
//   npm install -D dep-rec --omit=optional
//
// installs a zero-dependency CLI. A default install still pulls the SDK, so
// `npx dep-rec-mcp-server` keeps working with no extra steps.
async function loadMcpRuntime() {
  try {
    const [mcp, stdio, zod] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("zod"),
    ]);
    return { McpServer: mcp.McpServer, StdioServerTransport: stdio.StdioServerTransport, z: zod.z };
  } catch (err) {
    console.error(
      [
        "dep-rec: cannot start the MCP server — its optional dependencies are not installed.",
        `  (${err instanceof Error ? err.message : String(err)})`,
        "",
        "  The MCP server needs @modelcontextprotocol/sdk and zod. They are optional",
        "  dependencies, so an install with --omit=optional skips them. Either:",
        "    npm install @modelcontextprotocol/sdk zod",
        "  or reinstall dep-rec without --omit=optional.",
        "",
        "  The `dep-rec` CLI needs none of this and works either way.",
      ].join("\n")
    );
    process.exit(1);
  }
}

const { McpServer, StdioServerTransport, z } = await loadMcpRuntime();

const server = new McpServer({ name: "dep-rec-engine", version: "0.1.3" });

server.registerTool(
  "list_categories",
  {
    title: "List package categories",
    description:
      "List the competing-package categories in the recommendation dataset (auth-jwt, orm-database, testing, etc.) with how many packages are scored in each.",
  },
  async () => {
    const categories = await listCategories();
    return { content: [{ type: "text", text: JSON.stringify(categories, null, 2) }] };
  }
);

server.registerTool(
  "recommend_package",
  {
    title: "Recommend an npm package",
    description:
      "Recommend the best-fit npm package for a described need (e.g. 'JWT library', 'csv parser'), ranked by a " +
      "deterministic score — security (OSV vulnerabilities scoped to the current version), maintenance " +
      "(release recency/cadence, maintainer count), compatibility (ESM/TypeScript support), community adoption " +
      "(downloads relative to same-category competitors), and supply-chain footprint (dependency count) — " +
      "computed from real npm registry / OSV data, never guessed from training data. Only packages that clear a " +
      "recommendation bar are considered at all — deprecated, barely-adopted (<10k weekly downloads), brand-new " +
      "(<30 days) and unmaintained (no release in ~1000 days) packages are excluded rather than merely scored " +
      "low, because putting them forward would undermine the point of the recommendation. Always cite the " +
      "returned `reasons` when explaining a recommendation; never invent a score or reason of your own.",
    inputSchema: {
      need: z.string().describe("What you need, in plain language, e.g. 'JWT auth library' or 'CSV parser'"),
      runtime: z
        .enum(["node", "edge"])
        .optional()
        .describe("Target runtime, if it matters — pass 'edge' if this needs to run in a Vercel/Cloudflare-style Edge Function"),
      license: z.string().optional().describe("Required license, e.g. 'MIT', if any"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`How many ranked candidates to return (default 5, max ${MAX_LIMIT})`),
    },
  },
  async (args) => {
    const result = await recommend(args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "check_package",
  {
    title: "Check any npm package",
    description:
      "Look up and score ANY npm package by name — not limited to the 10 curated categories. Backed by a " +
      "persistent store: a package checked recently is served straight from storage (no network call); a new or " +
      "stale one is fetched live, stored, and from then on kept fresh by a background refresh job — so the first " +
      "person to ask about a package pays the fetch cost, not everyone after them. When the lookup fails, ALWAYS " +
      "read `reasonCode` before saying anything about the name: only `not-found` (a real registry 404) is evidence " +
      "the name may be hallucinated or typosquatted, and that is a strong signal worth verifying before installing. " +
      "`invalid-name` means the string is not a well-formed npm name so the registry was never asked; " +
      "`registry-error` means the registry was unreachable or errored, which says nothing about the package and " +
      "must never be reported as 'this package does not exist' — retry instead. Even when a name DOES resolve, " +
      "check the returned typosquatWarning: " +
      "a resolvable, installable package with a name one character off from a much more popular one (e.g. " +
      "'reactt' vs 'react') is the actual typosquat attack pattern, not just nonexistent names — if present, treat " +
      "it as seriously as a 404 and confirm the name was really intended before installing. Also returns " +
      "`recommendable`, with `notRecommendableBecause` listing why not — this tool answers for any package, " +
      "including ones it would never put forward itself (too little adoption to have a real review surface, no " +
      "release in years, deprecated). A low-adoption or unmaintained package can be a genuine risk even when " +
      "nothing is formally wrong with it, so surface that to the user rather than just reporting the score. Also " +
      "returns versionGuidance when relevant: if the latest " +
      "release is under 30 days old, it recommends the newest version that's cleared that observation window " +
      "instead — UNLESS the fresher release fixes a real vulnerability the older one has, which is verified via " +
      "version-scoped OSV lookups on both versions, never assumed from recency alone. Prefer recommend_package " +
      "instead when the package fits one of the known categories, since that score is ranked against real " +
      "competitors rather than on an absolute scale.",
    inputSchema: {
      name: z.string().describe("Exact npm package name to check, e.g. 'left-pad' or '@scope/package'"),
    },
  },
  async ({ name }) => {
    const result = await checkPackage(name);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
