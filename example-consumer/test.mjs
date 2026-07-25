// Proves the package works purely as an installed dependency — this
// script only ever touches node_modules/, never the monorepo source. It
// also proves the actual "check once, serve everyone else from storage"
// claim: two SEPARATE spawned server processes (simulating two different
// people, each with their own editor session) share the same on-disk
// store, so only the first one pays the network cost.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function textOf(result) {
  return result.content.find((c) => c.type === "text")?.text ?? "(no text)";
}

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["node_modules/dep-rec/dist/server.js"],
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
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

await withClient(async (client) => {
  const tools = await client.listTools();
  console.log("Installed package exposes:", tools.tools.map((t) => t.name).join(", "));

  console.log("\n--- recommend_package({need:'jwt library'}) ---");
  console.log(textOf(await client.callTool({ name: "recommend_package", arguments: { need: "jwt library" } })));
});

const PROBE_PACKAGE = "camelcase"; // real package, not yet in the bundled store

console.log(`\n--- "person A" spawns their own server, checks '${PROBE_PACKAGE}' ---`);
await withClient(async (client) => {
  const result = await client.callTool({ name: "check_package", arguments: { name: PROBE_PACKAGE } });
  console.log(textOf(result));
});

console.log(`\n--- "person B" spawns a SEPARATE server process, checks the same package ---`);
await withClient(async (client) => {
  const result = await client.callTool({ name: "check_package", arguments: { name: PROBE_PACKAGE } });
  console.log(textOf(result));
});
