// Spawns server.ts as a real subprocess and talks to it over stdio using
// the actual MCP client SDK — the same mechanism Claude Code, Cursor, etc.
// use. This proves the server round-trips correctly without needing to
// touch anyone's live editor/assistant configuration.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  return block?.text ?? "(no text content)";
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx/esm", "src/server.ts"],
  });

  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("Tools exposed by the server:");
  for (const t of tools.tools) console.log(`  - ${t.name}: ${t.description}`);

  console.log("\n--- list_categories ---");
  console.log(textOf(await client.callTool({ name: "list_categories", arguments: {} }) as any));

  const queries = [
    { need: "JWT library", runtime: "edge" as const },
    { need: "csv parser" },
    { need: "orm for postgres", license: "MIT" },
    { need: "a package that doesn't map to any category, like quantum flux capacitors" },
  ];

  for (const q of queries) {
    console.log(`\n--- recommend_package(${JSON.stringify(q)}) ---`);
    console.log(textOf((await client.callTool({ name: "recommend_package", arguments: q })) as any));
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
