// Proves the package works purely as an installed dependency — this
// script only ever touches node_modules/, never the monorepo source.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function textOf(result) {
  return result.content.find((c) => c.type === "text")?.text ?? "(no text)";
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["node_modules/dep-rec-mcp-server/dist/server.js"],
  // The MCP SDK's default spawn environment on Windows is a short allowlist
  // (APPDATA, PATH, SYSTEMROOT, ...) that doesn't include whatever this
  // network layer needs for outbound HTTPS — check_package's live registry/
  // OSV calls fail with a bare "fetch failed" without this. Any real MCP
  // host that restricts the spawned process's environment will hit the
  // same thing; pass it through explicitly since this server needs real
  // network access, unlike a typical local-only MCP server.
  env: process.env,
});

const client = new Client({ name: "example-consumer-test", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("Installed package exposes:", tools.tools.map((t) => t.name).join(", "));

console.log("\n--- recommend_package({need:'jwt library'}) ---");
console.log(textOf(await client.callTool({ name: "recommend_package", arguments: { need: "jwt library" } })));

console.log("\n--- check_package({name:'is-odd'}) ---");
console.log(textOf(await client.callTool({ name: "check_package", arguments: { name: "is-odd" } })));

await client.close();
