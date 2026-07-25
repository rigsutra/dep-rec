# Proof 3 — MCP server

Wraps the scored dataset ([`../stage1-collector`](../stage1-collector)) as
an MCP server so an AI assistant can call it directly, mid-conversation,
before recommending or installing a package — the actual thesis this whole
project is testing.

## Tools exposed

- **`list_categories`** — the 10 competing-package categories and how many
  packages are scored in each.
- **`recommend_package`** — given a plain-language need (`"JWT library"`,
  `"csv parser"`), optional runtime/license constraints, and a result limit,
  returns ranked candidates with their score and the concrete reasons
  behind it. The tool description explicitly tells the calling model to
  cite those reasons and never invent its own score — the same
  scores-are-deterministic-the-LLM-only-narrates split from the product spec.

## Run the server directly

```bash
npm install
npm run server
```

It speaks MCP over stdio — nothing will print, it just waits for a client.

## Test it for real, without touching your editor config

```bash
npm run test-client
```

This spawns the server as a real subprocess and talks to it with the actual
MCP client SDK — the same mechanism Claude Code, Cursor, etc. use — so it
proves the round trip works without needing to edit anyone's live MCP
configuration. See the printed output for four real calls, including one
query that doesn't map to any category (to check the fallback behavior)
and one Edge-runtime query (to check the honesty caveat about Proof 0 not
being merged in yet).

## To actually point a live assistant at it

Add an entry like this to the assistant's MCP config (e.g. Claude Code's
`.mcp.json`, Cursor's `mcp.json`):

```json
{
  "mcpServers": {
    "dep-rec-engine": {
      "command": "node",
      "args": ["--import", "tsx/esm", "src/server.ts"],
      "cwd": "/absolute/path/to/prs/mcp-server"
    }
  }
}
```

That's a change to your own editor/assistant configuration, so it's left
as a manual step rather than something done for you here.

## Known gaps, carried over honestly from Proof 1/2

- Free-text -> category matching (`data.ts`) is a small keyword/synonym
  map, not real search — good enough to prove the protocol round-trips
  correctly, not a real query understanding layer.
- Edge Runtime fit is not sandbox-tested for this dataset yet (Proof 0 only
  ran against 6 hand-picked packages). The `runtime: "edge"` input returns
  an explicit caveat rather than silently answering from ESM-support alone.
- No GitHub-derived signals (stars, bus factor) or deps.dev transitive
  dependency health — same gap as Proof 1.
