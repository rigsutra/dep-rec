# Proof 0 — Edge Runtime compatibility signal

Answers one question before the rest of the [Dependency Recommendation
Engine](../..) gets built: **is "does this package actually run on the Edge
Runtime" a real, cheap, deterministic signal — or does it fall apart on
contact with real packages?**

## Method

1. Bundle the target package with `esbuild`, resolving `package.json`
   `"exports"` the way real edge bundlers do — `worker` / `workerd` /
   `edge-light` conditions, not the Node-optimized `require`/`import` entry.
   This matters: naively using `platform: "node"` picks the Node-fast-path
   build of edge-first packages like `jose` and `nanoid` (which happens to
   call `node:crypto`/`node:buffer` directly) and produces false negatives
   that have nothing to do with real compatibility.
2. Evaluate the resulting bundle inside a real [`@edge-runtime/vm`](https://www.npmjs.com/package/@edge-runtime/vm)
   context — the same sandbox primitives Vercel's Edge Runtime uses.
3. Route `require()` inside that sandbox to a shim that records and rejects
   every call. Anything that reaches it is, by construction, a Node-only
   built-in esbuild couldn't inline — exactly what breaks in production on
   an edge deployment.

Three outcomes:

- **PASS** — loaded cleanly, touched nothing Node-only.
- **WARN** — loaded without throwing, but a Node built-in was touched
  internally (likely caught in the package's own try/catch fallback).
  Real, but needs a human look before trusting it.
- **FAIL** — either esbuild couldn't resolve a Node-only built-in at bundle
  time, or the sandbox's `require` shim was hit at runtime and nothing
  caught it.

## Run it

```bash
npm install
npm run check
```

## Current result

| package        | verdict | notes                                   |
|----------------|---------|------------------------------------------|
| `jose`         | PASS    | Web Crypto based, edge-first by design   |
| `nanoid`       | PASS    | pure JS, no I/O                          |
| `zod`          | PASS    | pure JS validation                       |
| `jsonwebtoken` | FAIL    | needs `crypto`, `buffer`, `stream`, `util` |
| `bcryptjs`     | WARN    | touches `crypto`, caught internally      |
| `express`      | FAIL    | needs 13 Node built-ins (`fs`, `net`, `http`, ...) |

## Verdict on Proof 0 itself

The signal is real, deterministic, and cheap (a few hundred ms per package).
It also survived its own bug: the first pass mis-flagged `jose` and `nanoid`
as incompatible purely because of an export-condition mistake, not because
of anything about the packages — worth remembering when the full Collector
does this at scale across ~500 packages: get the resolution conditions
right once, centrally, rather than per-package.

Next: Proof 1 — collect Tier 1 + Tier 2 data for ~500 packages across the
10 categories and normalize into one schema.
