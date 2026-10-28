#!/usr/bin/env node
// Proof 3 — expose the scored dataset as an MCP server so an AI coding
// assistant can call it directly, mid-conversation, before recommending or
// installing a package. This is the part of the roadmap that actually
// tests the thesis: does an assistant use this instead of guessing from
// training data?
//
// Speaks MCP over stdio with no dependencies at all — see mcp/protocol.ts
// for why that was worth doing rather than shipping a default install with
// an unpatchable advisory in it.

import { readFileSync } from "node:fs";
import { listCategories, recommend, checkPackage, MAX_LIMIT } from "./data.js";
import { createServer, type ToolSpec } from "./mcp/protocol.js";

const TOOLS: ToolSpec[] = [
  {
    name: "list_categories",
    title: "List package categories",
    description:
      "List the competing-package categories in the recommendation dataset (auth-jwt, orm-database, testing, etc.) with how many packages are scored in each.",
    fields: {},
    handler: () => listCategories(),
  },
  {
    name: "recommend_package",
    title: "Recommend an npm package",
    description:
      "Recommend the best-fit npm package for a described need (e.g. 'JWT library', 'csv parser'), ranked by a " +
      "deterministic score — security (OSV vulnerabilities scoped to the current version), maintenance " +
      "(release recency/cadence), compatibility (ESM/TypeScript support), community adoption " +
      "(downloads relative to same-category competitors), and supply-chain footprint (dependency count) — " +
      "computed from real npm registry / OSV data, never guessed from training data. Only packages that clear a " +
      "recommendation bar are considered at all — deprecated, barely-adopted (<10k weekly downloads), brand-new " +
      "(<30 days) and unmaintained (no release in ~1000 days) packages are excluded rather than merely scored " +
      "low, because putting them forward would undermine the point of the recommendation. Always cite the " +
      "returned `reasons` when explaining a recommendation; never invent a score or reason of your own. " +
      "Ten categories are CURATED (call list_categories); those answers are percentile-ranked against a real " +
      "competitor set. Any other need — PDF generation, image processing, QR codes, scraping — is answered by " +
      "searching npm live, fetching each candidate and running the same security/maintenance/adoption checks " +
      "on it. Those results come back with `matchedCategory: null` and `discoveredVia: \"npm-search\"`, and you " +
      "MUST treat them differently: the ordering is npm's search relevance, not a judgement about which is " +
      "best, so present them as a screened shortlist to verify rather than a ranked verdict, and confirm each " +
      "one actually does what the user asked. An empty `recommendations` array means candidates were found but " +
      "none cleared the bar (or nothing relevant was found) — report that honestly instead of substituting a " +
      "package of your own; the absence is itself the finding. A discovery call is slow the first time (it " +
      "fetches every candidate) and served from the store afterwards. " +
      "Every recommendation carries `recommendedVersion` — install THAT, not the bare package name and not " +
      "`latestVersion`. It is the newest stable release that has been public at least 30 days, so a release " +
      "published this week (which nobody has had time to find anything wrong with, and which is when a " +
      "compromised publish is most likely to still be live) is not what gets pinned. When it differs from " +
      "`latestVersion` a `versionNote` explains why; relay that note rather than silently upgrading the user to " +
      "latest. If the note says the pick is a major version behind, say so — that is a different API, and the " +
      "user may prefer latest once they know.",
    fields: {
      need: {
        type: "string",
        required: true,
        description: "What you need, in plain language, e.g. 'JWT auth library' or 'CSV parser'",
      },
      runtime: {
        type: "string",
        enum: ["node", "edge"],
        description:
          "Target runtime, if it matters — pass 'edge' if this needs to run in a Vercel/Cloudflare-style Edge Function",
      },
      license: { type: "string", description: "Required license, e.g. 'MIT', if any" },
      limit: {
        type: "integer",
        min: 1,
        max: MAX_LIMIT,
        description: `How many ranked candidates to return (default 5, max ${MAX_LIMIT})`,
      },
    },
    handler: (args) =>
      recommend({
        need: args.need as string,
        runtime: args.runtime as "node" | "edge" | undefined,
        license: args.license as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "check_package",
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
    fields: {
      name: {
        type: "string",
        required: true,
        description: "Exact npm package name to check, e.g. 'left-pad' or '@scope/package'",
      },
    },
    handler: (args) => checkPackage(args.name as string),
  },
];

// Read from package.json rather than hardcoded. The literal that used to be
// here silently drifted: the package went to 0.3.1 while the server kept
// telling every MCP client it was 0.3.0. Resolves identically from
// dist/server.js and from src/server.ts under tsx.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const server = createServer({ name: "dep-rec-engine", version }, TOOLS);

// Only start reading stdin when actually run as the server binary. Importing
// this module for its TOOLS (as the test suite does) must not hijack stdio.
if (process.env.DEP_REC_NO_LISTEN !== "1") {
  server.listen();
}
