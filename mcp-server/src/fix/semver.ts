// Just enough semver to plan fixes: parse and compare versions, and test a
// version against the range syntax npm writes into package.json and
// lockfiles. In-house because the package has no runtime dependencies.
//
// Anything that is not a semver range (git URLs, file:, npm: aliases, dist
// tags) evaluates to null, "cannot tell", and callers must not read that as
// either answer.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parse(version: string): SemVer | null {
  const m = VERSION.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

export function compare(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // A prerelease sorts below its release.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isPrerelease(v: SemVer): boolean {
  return v.pre.length > 0;
}

/**
 * The versions a caret range on `v` would accept: same major, or for 0.x the
 * same minor, or for 0.0.x nothing else. This is what "not a major upgrade"
 * means in npm terms, since a 0.x minor bump is allowed to break.
 */
export function sameLine(a: SemVer, b: SemVer): boolean {
  if (a.major !== b.major) return false;
  if (a.major > 0) return true;
  if (a.minor !== b.minor) return false;
  return a.minor > 0 || a.patch === b.patch;
}

/** A range string covering `v`'s line, for scoping an npm override key. */
export function lineRange(v: SemVer): string {
  if (v.major > 0) return `${v.major}`;
  if (v.minor > 0) return `0.${v.minor}`;
  return `0.0.${v.patch}`;
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

type Op = "<" | "<=" | ">" | ">=" | "=";
interface Comparator {
  op: Op;
  v: SemVer;
}

// A partial version: undefined means a wildcard or missing part.
interface Partial {
  major?: number;
  minor?: number;
  patch?: number;
  pre: string[];
}

const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parsePartial(s: string): Partial | null {
  const m = PARTIAL.exec(s);
  if (!m) return null;
  const part = (x: string | undefined) => (x === undefined || /^[xX*]$/.test(x) ? undefined : Number(x));
  const major = part(m[1]);
  const minor = major === undefined ? undefined : part(m[2]);
  const patch = minor === undefined ? undefined : part(m[3]);
  return { major, minor, patch, pre: patch !== undefined && m[4] ? m[4].split(".") : [] };
}

const v = (major: number, minor: number, patch: number, pre: string[] = []): SemVer => ({ major, minor, patch, pre });
// Lowest possible version on a line, so `<2.0.0-0` excludes 2.0.0 prereleases.
const floor = (major: number, minor: number, patch: number) => v(major, minor, patch, ["0"]);

function filled(p: Partial): SemVer {
  return v(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.pre);
}

// Exclusive upper bound of a partial: 1 -> 2.0.0, 1.2 -> 1.3.0.
function nextAfter(p: Partial): SemVer {
  if (p.minor === undefined) return floor((p.major ?? 0) + 1, 0, 0);
  return floor(p.major ?? 0, p.minor + 1, 0);
}

function desugar(op: string, p: Partial): Comparator[] | null {
  const any: Comparator[] = [];
  if (p.major === undefined) return op === "<" || op === ">" ? null : any;
  const full = p.patch !== undefined;
  switch (op) {
    case "":
    case "=":
      return full ? [{ op: "=", v: filled(p) }] : [{ op: ">=", v: filled(p) }, { op: "<", v: nextAfter(p) }];
    case "~":
      return [{ op: ">=", v: filled(p) }, { op: "<", v: p.minor === undefined ? floor(p.major + 1, 0, 0) : floor(p.major, p.minor + 1, 0) }];
    case "^": {
      const lo = filled(p);
      let hi: SemVer;
      if (p.major > 0 || p.minor === undefined) hi = floor(p.major + 1, 0, 0);
      else if (p.minor > 0 || p.patch === undefined) hi = floor(0, p.minor + 1, 0);
      else hi = floor(0, 0, p.patch + 1);
      return [{ op: ">=", v: lo }, { op: "<", v: hi }];
    }
    case ">":
      return full ? [{ op: ">", v: filled(p) }] : [{ op: ">=", v: nextAfter(p) }];
    case ">=":
      return [{ op: ">=", v: filled(p) }];
    case "<":
      return [{ op: "<", v: full ? filled(p) : floor(p.major, p.minor ?? 0, 0) }];
    case "<=":
      return full ? [{ op: "<=", v: filled(p) }] : [{ op: "<", v: nextAfter(p) }];
    default:
      return null;
  }
}

function parseSet(set: string): Comparator[] | null {
  const s = set.trim();
  if (s === "" || s === "*" || s === "x" || s === "X") return [];

  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
  if (hyphen) {
    const lo = parsePartial(hyphen[1]);
    const hi = parsePartial(hyphen[2]);
    if (!lo || !hi) return null;
    const out: Comparator[] = [{ op: ">=", v: filled(lo) }];
    if (hi.major !== undefined) out.push(hi.patch !== undefined ? { op: "<=", v: filled(hi) } : { op: "<", v: nextAfter(hi) });
    return out;
  }

  const out: Comparator[] = [];
  for (const token of s.replace(/([<>=~^]+)\s+/g, "$1").split(/\s+/)) {
    const m = /^(<=|>=|<|>|=|~>|~|\^)?(.*)$/.exec(token)!;
    const p = parsePartial(m[2]);
    if (!p) return null;
    const c = desugar(m[1] === "~>" ? "~" : m[1] ?? "", p);
    if (!c) return null;
    out.push(...c);
  }
  return out;
}

function test(c: Comparator, ver: SemVer): boolean {
  const d = compare(ver, c.v);
  switch (c.op) {
    case "<":
      return d < 0;
    case "<=":
      return d <= 0;
    case ">":
      return d > 0;
    case ">=":
      return d >= 0;
    case "=":
      return d === 0;
  }
}

function setMatches(set: Comparator[], ver: SemVer): boolean {
  if (!set.every((c) => test(c, ver))) return false;
  if (ver.pre.length === 0) return true;
  // npm only lets a prerelease satisfy a range that names a prerelease on the
  // same major.minor.patch. The ["0"] floors above are internal, not named.
  return set.some(
    (c) => c.v.pre.length > 0 && !(c.v.pre.length === 1 && c.v.pre[0] === "0") &&
      c.v.major === ver.major && c.v.minor === ver.minor && c.v.patch === ver.patch,
  );
}

/** true/false when `range` is a semver range, null when it is anything else. */
export function satisfies(version: string, range: string): boolean | null {
  const ver = parse(version);
  if (!ver) return null;
  const sets: Comparator[][] = [];
  for (const part of range.split("||")) {
    const set = parseSet(part);
    if (!set) return null;
    sets.push(set);
  }
  return sets.some((set) => setMatches(set, ver));
}
