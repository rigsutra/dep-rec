// Finds the npm packages a shell command would install or execute. Deliberately
// a tokenizer, not a shell: it only has to recognise the install and
// run-a-package commands of npm, pnpm, yarn and bun, and anything it cannot
// read is simply not checked. The hook fails open, so a missed command costs
// a check, while a misread one would block a developer's shell.

export interface PackageRequest {
  /** What the agent typed, e.g. "lodash@^4". */
  raw: string;
  name: string;
  /** Version, range or tag after the name; null when none was given. */
  spec: string | null;
  /** "install" adds it to the project; "exec" runs it once (npx and friends). */
  kind: "install" | "exec";
}

// Install subcommands per manager. npm accepts every prefix of "install" and
// a few transpositions.
const INSTALL: Record<string, Set<string>> = {
  npm: new Set(["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add"]),
  pnpm: new Set(["add"]),
  yarn: new Set(["add"]),
  bun: new Set(["add", "a", "install", "i"]),
};
const EXEC_BINS = new Set(["npx", "bunx", "pnpx"]);
const EXEC_SUB: Record<string, Set<string>> = { pnpm: new Set(["dlx"]), yarn: new Set(["dlx"]), npm: new Set(["exec", "x"]) };

// Flags whose next token is a value, not a package.
const VALUE_FLAGS = new Set([
  "--registry", "--prefix", "--tag", "--omit", "--include", "--workspace", "-w", "--filter", "-F",
  "--cache", "--userconfig", "--save-prefix", "--cwd", "--dir", "-C", "--package", "-p", "--call", "-c",
]);

function tokenize(command: string): string[][] {
  const segments: string[][] = [[]];
  let token = "";
  let quote: string | null = null;
  let has = false;
  const push = () => {
    if (has) segments[segments.length - 1].push(token);
    token = "";
    has = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else token += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c) && c !== "\n") {
      push();
    } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      push();
      if (segments[segments.length - 1].length > 0) segments.push([]);
    } else {
      token += c;
      has = true;
    }
  }
  push();
  return segments.filter((s) => s.length > 0);
}

// Not a registry package: paths, URLs, git hosts, tarballs, protocols.
function isRegistrySpec(raw: string): boolean {
  if (/^(\.{1,2}[\\/]|[\\/]|~|[A-Za-z]:[\\/])/.test(raw)) return false;
  if (/^(file|link|workspace|git|git\+\w+|github|gitlab|bitbucket|gist|https?|portal|patch):/.test(raw)) return false;
  if (raw.includes("://") || /\.(tgz|tar\.gz|tar)$/.test(raw)) return false;
  // user/repo shorthand is a GitHub dependency
  if (!raw.startsWith("@") && /^[^@/]+\/[^@/]+/.test(raw)) return false;
  return true;
}

export function splitSpec(raw: string): { name: string; spec: string | null } {
  const at = raw.indexOf("@", raw.startsWith("@") ? 1 : 0);
  if (at === -1) return { name: raw, spec: null };
  const name = raw.slice(0, at);
  const spec = raw.slice(at + 1);
  // alias@npm:real@range installs `real`
  if (spec.startsWith("npm:")) return splitSpec(spec.slice(4));
  return { name, spec: spec === "" ? null : spec };
}

function packagesIn(args: string[], kind: PackageRequest["kind"]): PackageRequest[] {
  const out: PackageRequest[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      if (kind === "exec") break;
      continue;
    }
    // npx -p <pkg> <command>: the package is the flag's value and the
    // positional is a binary name, which must not be checked as a package.
    const pkgFlag = kind === "exec" ? /^(?:-p|--package)(?:=(.+))?$/.exec(a) : null;
    if (pkgFlag) {
      const value = pkgFlag[1] ?? args[i + 1];
      if (value && isRegistrySpec(value)) out.push({ raw: value, ...splitSpec(value), kind });
      return out;
    }
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    if (isRegistrySpec(a)) out.push({ raw: a, ...splitSpec(a), kind });
    // Only the first positional of an exec is the package; the rest are its args.
    if (kind === "exec") break;
  }
  return out;
}

export function findPackageRequests(command: string): PackageRequest[] {
  const out: PackageRequest[] = [];
  for (let tokens of tokenize(command)) {
    // Leading env assignments and privilege wrappers.
    while (tokens.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || tokens[0] === "sudo" || tokens[0] === "env")) {
      tokens = tokens.slice(1);
    }
    if (tokens.length === 0) continue;
    const bin = tokens[0].replace(/\.(cmd|exe|ps1)$/i, "").replace(/^.*[\\/]/, "");
    if (EXEC_BINS.has(bin)) {
      out.push(...packagesIn(tokens.slice(1), "exec"));
      continue;
    }
    // yarn global add <pkg>
    const rest = bin === "yarn" && tokens[1] === "global" ? tokens.slice(2) : tokens.slice(1);
    const sub = rest.findIndex((t) => !t.startsWith("-"));
    if (sub === -1) continue;
    if (INSTALL[bin]?.has(rest[sub])) out.push(...packagesIn(rest.slice(sub + 1), "install"));
    else if (EXEC_SUB[bin]?.has(rest[sub])) out.push(...packagesIn(rest.slice(sub + 1), "exec"));
  }
  return out;
}
