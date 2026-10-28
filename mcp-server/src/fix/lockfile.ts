// Reads an npm v2/v3 lockfile into installed nodes plus the dependency edges
// pointing at each one, which is what deciding *how* a node can be upgraded
// needs: an upgrade every requester's range already admits is a re-resolve,
// one a direct dependency's range blocks is a package.json bump, and one a
// transitive parent blocks needs an override.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LockNode {
  /** Lockfile key, e.g. "node_modules/a/node_modules/b". */
  path: string;
  name: string;
  version: string;
  dev: boolean;
}

export interface Edge {
  /** Requesting path; "" is the project itself. */
  from: string;
  name: string;
  range: string;
  /** package.json field the edge comes from. */
  field: DepField;
}

export type DepField = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";

export interface Lockfile {
  file: string;
  nodes: Map<string, LockNode>;
  edgesIn: Map<string, Edge[]>;
}

const NM = "node_modules/";

export function lockfilePath(dir: string): string | null {
  for (const f of ["npm-shrinkwrap.json", "package-lock.json"]) {
    if (existsSync(join(dir, f))) return join(dir, f);
  }
  return null;
}

function nameFromPath(path: string): string {
  return path.slice(path.lastIndexOf(NM) + NM.length);
}

export function readLockfile(dir: string): Lockfile {
  const file = lockfilePath(dir);
  if (!file) throw new Error(`No package-lock.json or npm-shrinkwrap.json in ${dir}. Run npm install first.`);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const packages = doc?.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error(`${file} is lockfileVersion ${doc?.lockfileVersion ?? "?"}; dep-rec fix needs v2 or v3. Run npm install with npm 7+ to upgrade it.`);
  }

  const nodes = new Map<string, LockNode>();
  const requesters: Array<[string, Record<string, any>]> = [];
  for (const [path, entry] of Object.entries<Record<string, any>>(packages)) {
    if (!entry || typeof entry !== "object" || entry.link) continue;
    requesters.push([path, entry]);
    if (path.includes(NM) && typeof entry.version === "string") {
      nodes.set(path, { path, name: entry.name ?? nameFromPath(path), version: entry.version, dev: Boolean(entry.dev) });
    }
  }

  const edgesIn = new Map<string, Edge[]>();
  for (const [from, entry] of requesters) {
    // Only the project and workspace roots install their devDependencies.
    const fields: DepField[] = from.includes(NM)
      ? ["dependencies", "optionalDependencies", "peerDependencies"]
      : ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
    for (const field of fields) {
      for (const [name, range] of Object.entries<string>(entry[field] ?? {})) {
        const target = resolveFrom(nodes, from, name);
        if (!target) continue; // unmet optional/peer
        const list = edgesIn.get(target) ?? [];
        list.push({ from, name, range, field });
        edgesIn.set(target, list);
      }
    }
  }
  return { file, nodes, edgesIn };
}

// Node's resolution: the nearest node_modules/<name> walking up from `from`.
function resolveFrom(nodes: Map<string, LockNode>, from: string, name: string): string | null {
  let base = from;
  for (;;) {
    const candidate = `${base ? `${base}/` : ""}${NM}${name}`;
    if (nodes.has(candidate)) return candidate;
    if (!base) return null;
    const i = base.lastIndexOf(`/${NM}`);
    base = i === -1 ? "" : base.slice(0, i);
  }
}
