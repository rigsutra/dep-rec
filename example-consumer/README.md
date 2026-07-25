# example-consumer

A from-scratch project with no access to the monorepo's source — the
actual proof that `drec` behaves like a real npm dependency, not just
"runs from source when I `cd` into the right folder."

## Setup

```bash
cd ../mcp-server && npm run build && npm pack
cd ../example-consumer && npm install --save-dev ../mcp-server/drec-0.1.0.tgz
```

## Two interfaces, same installed package

**CLI** — works immediately via `npx` once installed:

```bash
npx drec check left-pad
npx drec recommend "jwt library" --runtime edge
npx drec categories --json
```

**MCP server**, proven with a real client in [`test.mjs`](test.mjs):

```bash
node test.mjs
```

That script spawns `node_modules/drec/dist/server.js` as a
subprocess and talks to it with the actual MCP client SDK — including the
cross-process cache-sharing test (two fully separate spawned servers,
simulating two different people, checking the same never-before-seen
package: the first pays the network cost, the second gets identical data
from the shared store with zero network calls).

See [`../mcp-server/README.md`](../mcp-server/README.md) for what each tool
does and how the persistent store behind both interfaces works.
