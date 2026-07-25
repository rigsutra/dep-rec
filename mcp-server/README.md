# Proof 3 — MCP server, packaged as a real installable dependency

Wraps the scored dataset ([`../stage1-collector`](../stage1-collector)) as
an MCP server so an AI assistant can call it directly, mid-conversation,
before recommending or installing a package — the actual thesis this whole
project is testing. Ships as a proper npm package (`npm run build` + a
`bin` entry + the dataset bundled inside `data/`), not just something you
run from source inside this monorepo.

## Tools exposed

- **`list_categories`** — the 10 competing-package categories and how many
  packages are scored in each.
- **`recommend_package`** — given a plain-language need (`"JWT library"`,
  `"csv parser"`), optional runtime/license constraints, and a result limit,
  returns ranked candidates from the curated 500-package dataset, scored
  *relative to their actual category competitors*.
- **`check_package`** — look up and score **any** npm package by name,
  live, not limited to the curated 500. Fetches real registry/OSV data on
  demand and scores it on an absolute scale (no peer group to rank
  against, unlike `recommend_package`). If the name doesn't resolve on the
  registry at all, that's a strong signal it may be hallucinated or
  typosquatted — the tool says so explicitly rather than just erroring.

Both scoring tools tell the calling model to cite the returned `reasons`
and never invent its own score — the scores-are-deterministic-the-LLM-
only-narrates split from the product spec.

## Try it from source (fast local loop)

```bash
npm install
npm run test-client
```

This spawns the server as a real subprocess and talks to it with the
actual MCP client SDK — the same mechanism Claude Code, Cursor, etc.
use — covering all three tools including two `check_package` calls
(a real uncurated package, and a nonexistent one).

## Try it as an actual installed dependency

This is the part that matters for "can a project just add this as a
dependency": it's built, packed with `npm pack`, and installed into a
completely separate scratch project the same way any real npm package
would be.

```bash
npm run build        # tsc -> dist/, shebang preserved on dist/server.js
npm pack              # produces dep-rec-mcp-server-0.1.0.tgz — exactly
                      # what `npm publish` would upload, done locally
```

See [`../example-consumer`](../example-consumer) for a from-scratch project
that installs that tarball with `npm install --save-dev <path-to-tgz>` and
calls all three tools purely from `node_modules/` — no access to this
monorepo's source. That's the actual proof this behaves like a real
dependency, not just "runs from source when I `cd` into the right folder."

**Not done yet, deliberately:** an actual `npm publish` to the public
registry. `private: true` is set on purpose so that can't happen by
accident — publishing is a one-way, visible-to-others action, worth a
separate explicit decision (and a trademark/name-availability check,
per the earlier "avoid anything that reads like an npm sub-brand" note)
rather than something that happens as a side effect of packaging work.

## To actually point a live assistant at it

Add an entry like this to the assistant's MCP config (e.g. Claude Code's
`.mcp.json`, Cursor's `mcp.json`):

```json
{
  "mcpServers": {
    "dep-rec-engine": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/absolute/path/to/prs/mcp-server"
    }
  }
}
```

or, once installed as a real dependency in a project, point at
`node_modules/dep-rec-mcp-server/dist/server.js` directly (that's exactly
what `example-consumer/test.mjs` does). That's a change to your own
editor/assistant configuration, so it's left as a manual step rather than
something done for you here.

## A real gotcha this caught: spawned-process environment

`check_package` makes outbound HTTPS calls (npm registry, OSV) at request
time — unlike `recommend_package`/`list_categories`, which only read the
bundled local file. The MCP SDK's *default* environment for a spawned
server process on Windows is a short allowlist (`APPDATA`, `PATH`,
`SYSTEMROOT`, a handful of others) — it does **not** pass through
whatever a given machine's network layer needs for outbound HTTPS to
actually work. The symptom is a bare, unhelpful `fetch failed` with no
further detail.

If you're writing your own MCP client against this server (as both
`test-client.ts` and `example-consumer/test.mjs` do), pass `env:
process.env` (filtered to drop `undefined` values) explicitly in the
`StdioClientTransport` config. If you're pointing a real assistant's MCP
host at this server instead, check whether that host restricts the spawned
process's environment — if `check_package` fails with `fetch failed` and
`recommend_package` works fine, this is almost certainly why.

## Known gaps, carried over honestly from Proof 1/2

- Free-text -> category matching (`data.ts`) is a small keyword/synonym
  map, not real search — good enough to prove the protocol round-trips
  correctly, not a real query understanding layer.
- Edge Runtime fit is not sandbox-tested for this dataset yet (Proof 0 only
  ran against 6 hand-picked packages). The `runtime: "edge"` input returns
  an explicit caveat rather than silently answering from ESM-support alone.
- No GitHub-derived signals (stars, bus factor) or deps.dev transitive
  dependency health — same gap as Proof 1. `check_package` has the same
  gap for live lookups too.
- `data/scored.json` is a copied snapshot of `stage1-collector`'s output,
  not a live link — run `npm run sync-data` after re-running the collector
  or scorer to refresh it before rebuilding.
