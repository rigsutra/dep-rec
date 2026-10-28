# dep-rec

npm package `dep-rec` (CLI `dep-rec` + MCP stdio server `dep-rec-mcp-server`). Recommends npm packages and checks package health/security live (npm registry + OSV). Product lives in `mcp-server/`; everything else is support.

## Layout
- `mcp-server/src/cli.ts`, `server.ts`: entry points. `data.ts`: shared logic.
- `src/mcp/`: hand-rolled JSON-RPC/MCP stdio (`protocol.ts`) + arg validation. No SDK at runtime.
- `src/sources/`: npm registry + OSV clients.
- `src/fix/`: `dep-rec fix` (lockfile scan, semver subset, planner, apply with rollback).
- `src/hook/`: `dep-rec hook`, Claude Code PreToolUse hook (command tokenizer + install verdicts). Never emits "allow"; fails open.
- `src/store/`: JSON store (`db.ts`, file lock), scoring, eligibility, typosquat, version-safety (30-day cooldown).
- `data/store.json`: shipped curated store (499 rows, read-only at runtime; users write `~/.dep-rec/store.json`), seeded from `stage1-collector/data/packages.json` via `npm run seed-db`.
- `stage1-collector/`: dataset collector, feeds seed. `example-consumer/`: black-box install test.

## Commands (run in `mcp-server/`)
- `npm run build`: clean + tsc into `dist/`.
- `npm test`: all suites via `scripts/run-tests.mjs` (needs network; ~2.5 min).
- `npm run test:unit` / `test:cli` / `test:mcp` / `test:corpus` / `test:gaps` / `test:review`.
- `npx tsc --noEmit`: typecheck against Node 18 types.
- `npm run test:floor`: run built `dist/` checks on the engines floor.
- `npm run stress`: live-network stress run, not in CI.

## Conventions and gotchas
- Engines floor is Node `>=18.3.0`. `@types/node` is pinned to 18 on purpose so tsc rejects newer APIs. Don't bump it.
- CI (`.github/workflows/test.yml`): suite on 18.20.8/20/22, floor job on 18.3.0 running `dist/`, typecheck.
- Tests import `../src/*.ts` via `node --import tsx`. No shell globs in npm scripts (cmd.exe doesn't expand them); add files through `run-tests.mjs`.
- `@modelcontextprotocol/sdk` is a devDependency only (used by `tests/helpers.ts`). A test asserts it stays out of `dependencies`.
- SQLite store was dropped for a JSON store in 0.6.0; mentions in docs are history only.
- Store writes go through `withStoreLock`/`withTransaction` in `db.ts`. Never write `store.json` directly.
- Tool descriptions in `server.ts` are pinned by tests; update both together.
- Root `README.md` mirrors `mcp-server/README.md`; keep them in sync.
