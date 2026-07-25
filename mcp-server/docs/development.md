# Development

Working on `dep-rec` itself: running it from source, linking it locally,
and packing it the way npm would.

## Running the CLI locally as `dep-rec`

To use the real command name instead of `npx`, link the built package once:

```bash
npm run build
npm link
```

`dep-rec` is then on your PATH from any directory. **One trap worth knowing
about:** a linked install points at this repo's own `data/store.db`, so
every lookup writes into the artifact that ships inside the package —
`dep-rec check chalk` from a scratch directory added `chalk` to it as row
500 the first time this was tried. Use a scratch store while developing:

```bash
cp data/store.db /tmp/mystore.db
dep-rec check express --db /tmp/mystore.db
dep-rec recommend "pdf" --db /tmp/mystore.db
```

`--db` and `DEP_REC_DB_PATH` do the same thing. `npm unlink -g dep-rec`
removes the link.

### About the SQLite warning

Node used to print this on every single invocation:

```
(node:24808) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

That is Node telling *us* that an API we chose is experimental — it is not
something a user of the CLI can act on, and it was the first line of every
run. It is now filtered, narrowly:
[`src/quiet-sqlite-warning.ts`](../src/quiet-sqlite-warning.ts) suppresses
that one warning and nothing else, rather than reaching for
`NODE_NO_WARNINGS=1` and hiding real deprecations along with it.

Getting it to actually work needed one non-obvious change. ES modules link
the entire graph before evaluating any of it, so a static
`import { DatabaseSync } from "node:sqlite"` fires the warning before a
single line of our code has run — the filter was installed too late to
catch anything. `store/db.ts` now loads `node:sqlite` on first use instead,
with a type-only import for the types.

The underlying tradeoff is unchanged and still disclosed: `node:sqlite`
requires Node 22+ and its API can change. Silencing the warning does not
make that go away, it just stops repeating it at someone who has no say in
it.


## Try it from source (fast local loop)

```bash
npm install
npm run test:mcp
```

This spawns the server as a real subprocess and drives it with the actual
MCP client SDK — the same mechanism Claude Code, Cursor, etc. use — across
63 protocol-level scenarios: handshake, published schemas, every tool,
concurrent calls, cross-process store sharing, and the full hostile-input
sweep.

There used to be a smaller `npm run test-client` script doing a hand-rolled
version of this. It was deleted rather than kept once the suite above
covered strictly more, because it was still being compiled into `dist/` and
published — a dead file importing a devDependency no consumer installs.
Excluding it from the tarball would have left the same dead code in the
repo; deleting it removes the question.


## Try it as an actual installed dependency

This is the part that matters for "can a project just add this as a
dependency": it's built, packed with `npm pack`, and installed into a
completely separate scratch project the same way any real npm package
would be.

```bash
npm run build        # tsc -> dist/, shebang preserved on dist/server.js
npm pack              # produces dep-rec-0.3.0.tgz — exactly what
                      # `npm publish` would upload, done locally
```

Worth noting what that scratch project's own `package.json` now looks like:
installing `dep-rec` adds **one** package and `npm audit` reports zero
findings. `example-consumer` does carry `@modelcontextprotocol/sdk` as its
own devDependency — it needs a *client* to drive the server
programmatically — and that reintroduces `GHSA-frvp-7c67-39w9` in the
example project. That is the cost of the SDK client, not of `dep-rec`, and
it is exactly the cost this package no longer passes on. Anyone pointing
an editor at the MCP server needs no client of their own.

See [`../example-consumer`](../../example-consumer) for a from-scratch project
that installs that tarball with `npm install --save-dev <path-to-tgz>` and
calls all three tools purely from `node_modules/` — no access to this
monorepo's source. That's the actual proof this behaves like a real
dependency, not just "runs from source when I `cd` into the right folder."
The CLI is even simpler to check this way — `npx dep-rec check <name>`
works immediately once installed, no client code needed.

`example-consumer/test.mjs` also proves the store-sharing claim
specifically: it spawns the server *twice*, as two fully separate
subprocesses (simulating two different people, each with their own editor
session), and checks the same never-before-seen package from each. The
first spawn gets `servedFrom: "live-fetch"`; the second, completely
independent process gets `servedFrom: "cache"` with identical data — proof
the shared on-disk file is doing its job across process boundaries, not
just within one long-lived connection.

