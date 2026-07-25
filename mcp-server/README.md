# Dependency recommendation — MCP server + CLI, packaged as a real installable dependency

Wraps a persistent package store ([`src/store/`](src/store)) behind two
interfaces sharing the exact same logic: an MCP server so an AI assistant
can call it directly mid-conversation (the actual thesis this whole
project is testing), and a plain CLI (`dep-rec`) for humans or any
non-MCP-aware script/agent. Ships as a proper npm package — `npm install
--save-dev dep-rec-mcp-server` gives you both `dep-rec` and
`dep-rec-mcp-server` commands — not just something you run from source
inside this monorepo.

## CLI

```bash
npx dep-rec check left-pad
npx dep-rec recommend "jwt library" --runtime edge
npx dep-rec recommend "csv parser" --limit 3 --json
npx dep-rec categories
```

Add `--json` to any command for machine-readable output instead of the
human-readable default — useful if a script or agent wants to parse it
without going through MCP at all.

## Tools exposed (MCP)

- **`list_categories`** — the 10 competing-package categories and how many
  packages are tracked in each.
- **`recommend_package`** — given a plain-language need (`"JWT library"`,
  `"csv parser"`), optional runtime/license constraints, and a result limit,
  returns ranked candidates from the curated dataset, scored *relative to
  their actual category competitors*.
- **`check_package`** — look up and score **any** npm package by name, not
  limited to the curated set. Served from the store if already tracked and
  fresh (no network call); fetched live, stored, and scored otherwise. If
  the name doesn't resolve on the registry at all, that's a strong signal
  it may be hallucinated or typosquatted — the tool says so explicitly
  rather than just erroring.

Both scoring tools tell the calling model to cite the returned `reasons`
and never invent its own score — the scores-are-deterministic-the-LLM-
only-narrates split from the product spec.

## The persistent store (`src/store/`)

Originally this server just read a static JSON snapshot. It's now backed
by a real store (SQLite, via Node's built-in `node:sqlite` — no native
dependency to compile) that holds **both** the raw registry/downloads/OSV
data and the computed scores, so:

- if 100 people ask about the same package, only the first one triggers a
  live fetch — the other 99 are served straight from disk;
- a package that's never been checked before gets fetched, stored, and
  scored on the spot, and from that moment on it's permanently tracked —
  there's no separate "add to watchlist" step;
- a background job (`npm run refresh`, see below) re-checks the *oldest*
  tracked packages against the live registry on a schedule, so stored data
  doesn't just go stale forever.

```
src/store/
  schema.ts           table definition
  db.ts               raw SQLite access (get/list/upsert)
  scoring.ts          the ONE scoring implementation, two modes:
                      category-relative (percentile vs. real peers) and
                      absolute (fixed curves, for uncategorized lookups)
  lookup.ts           getOrFetchPackage() — the cache-or-fetch logic
                      itself, and rescoreCategory()
  seed.ts             dev-time bootstrap from stage1-collector's raw output
  refresh-worker.ts   the background "surveillance" job
```

A package enters the store — and therefore future background refreshing —
the instant anyone looks it up, whether that's one of the original curated
500 or a totally new `check_package` call. There's no meaningful
distinction between "curated" and "tracked" anymore; `inCuratedDataset` in
`check_package`'s response really just means "does it currently belong to
one of the 10 categories," which determines *how* it's scored (relative vs.
absolute), not *whether* it's stored.

### Refreshing stale data

```bash
npm run refresh
```

Re-fetches the oldest N tracked packages (default 50, `REFRESH_BATCH_SIZE`
env var to change it) and rescores whatever categories they touch. This is
meant to run on a schedule — cron, a scheduled task, whatever the
deployment has — not as a long-running daemon. A request for a package
older than the freshness window (`STALE_MS` in `lookup.ts`, currently 24h)
triggers an on-demand refresh anyway, so this job is about keeping the
*common* case fast, not correctness.

### Bootstrapping the store from scratch

```bash
npm run seed-db   # imports stage1-collector/data/packages.json, then scores every category
```

`data/store.db` is the artifact that actually ships inside the package —
regenerate it with `seed-db` (for the curated baseline) whenever
`stage1-collector`'s output changes, not by hand-editing the database.

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
- `data/store.db`'s curated baseline is a copied snapshot of
  `stage1-collector`'s output, not a live link — run `npm run seed-db`
  after re-running the collector to refresh the baseline (this won't
  touch rows added later via `check_package`, since `upsertRaw` preserves
  `first_seen_at` and only overwrites raw fields).
- The refresh worker is a script you run, not a scheduler itself — nothing
  currently invokes `npm run refresh` on an actual cron/timer. Wiring that
  up is an infra decision (where does it run, under what identity) that
  belongs to whoever deploys this, not something to bake in silently.
- `node:sqlite` is still an experimental Node API (prints a warning on
  every start) — fine for a prototype at this scale, worth revisiting
  (e.g. `better-sqlite3`) if this ever needs to be production-hardened.
