#!/usr/bin/env node
// Proof 3 — expose the scored dataset as an MCP server so an AI coding
// assistant can call it directly, mid-conversation, before recommending or
// installing a package. This is the part of the roadmap that actually
// tests the thesis: does an assistant use this instead of guessing from
// training data?

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listCategories, recommend, checkPackage } from "./data.js";

const server = new McpServer({ name: "dep-rec-engine", version: "0.1.0" });

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
      "computed from real npm registry / OSV data, never guessed from training data. Always cite the returned " +
      "`reasons` when explaining a recommendation; never invent a score or reason of your own.",
    inputSchema: {
      need: z.string().describe("What you need, in plain language, e.g. 'JWT auth library' or 'CSV parser'"),
      runtime: z
        .enum(["node", "edge"])
        .optional()
        .describe("Target runtime, if it matters — pass 'edge' if this needs to run in a Vercel/Cloudflare-style Edge Function"),
      license: z.string().optional().describe("Required license, e.g. 'MIT', if any"),
      limit: z.number().int().min(1).max(20).optional().describe("How many ranked candidates to return (default 5)"),
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
      "person to ask about a package pays the fetch cost, not everyone after them. If the name doesn't resolve on " +
      "the npm registry at all, treat that as a strong signal it may be hallucinated or typosquatted — verify " +
      "before installing anything with that name. Prefer recommend_package instead when the package fits one of " +
      "the known categories, since that score is ranked against real competitors rather than on an absolute scale.",
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
