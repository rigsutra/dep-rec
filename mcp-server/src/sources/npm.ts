// Adapted from stage1-collector/src/npm.ts, trimmed to what a single
// on-demand package lookup needs (no candidate search — that's a
// category-building concern, not a live-check concern).

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS = "https://api.npmjs.org/downloads/point/last-week";
const UA = "dep-rec-mcp-server/0.1 (live package check)";

export interface VersionEntry {
  version: string;
  releasedAt: string;
}

export interface RegistryDoc {
  found: true;
  name: string;
  license: string | null;
  maintainersCount: number;
  createdAt: string | null;
  modifiedAt: string | null;
  latestVersion: string | null;
  dependenciesCount: number;
  deprecated: boolean;
  esmSupport: boolean;
  typescriptSupport: boolean;
  releaseCadenceDays: number | null;
  // oldest -> newest, used to resolve a cooldown-safe recommended version
  versionHistory: VersionEntry[];
  // preinstall/install/postinstall present on the current version — the
  // actual event-stream/ua-parser-js attack vector (arbitrary code
  // execution on `npm install`, before anyone's reviewed anything)
  hasInstallScripts: boolean;
}

// Why a lookup produced no package. The distinction matters downstream:
// "the registry returned 404" is genuine evidence a name may be
// hallucinated or squatted, whereas "the name is malformed" or "the
// registry is down" is evidence of nothing about the name's authenticity.
// Collapsing all three into one message meant a 5000-character string got
// reported as "does not exist... likely hallucinated" (the registry
// rejected the request shape, it never answered the question), and — far
// worse — a registry outage would have reported every real package the
// same way.
export type RegistryMissCode = "invalid-name" | "not-found" | "registry-error" | "no-manifest";

export interface RegistryMiss {
  found: false;
  name: string;
  reason: string;
  code: RegistryMissCode;
}

// npm's own rule for the URL-safety of a name segment: it must survive
// encodeURIComponent unchanged. Using that rather than a hand-rolled
// character whitelist avoids rejecting legacy-but-real names (uppercase
// letters, `~`, `!`) that predate the current naming rules.
function isUrlSafeSegment(s: string): boolean {
  return s.length > 0 && encodeURIComponent(s) === s;
}

export interface NameValidity {
  valid: boolean;
  reason?: string;
}

export function validatePackageName(name: string): NameValidity {
  if (typeof name !== "string" || name.length === 0) return { valid: false, reason: "name is empty" };
  if (name.trim() !== name) return { valid: false, reason: "name has leading or trailing whitespace" };
  if (name.length > 214) {
    return { valid: false, reason: `name is ${name.length} characters; npm's limit is 214` };
  }
  if (name.startsWith(".") || name.startsWith("_")) {
    return { valid: false, reason: "name cannot start with '.' or '_'" };
  }
  // Control characters cannot appear in a real npm name and would corrupt a URL.
  if (/[\s\u0000-\u001f\u007f]/.test(name)) {
    return { valid: false, reason: "name contains whitespace or control characters" };
  }

  if (name.startsWith("@")) {
    const parts = name.slice(1).split("/");
    if (parts.length !== 2) {
      return { valid: false, reason: "a scoped name must be exactly '@scope/name'" };
    }
    const [scope, bare] = parts;
    if (!isUrlSafeSegment(scope)) return { valid: false, reason: `scope '@${scope}' contains characters npm does not allow` };
    if (!isUrlSafeSegment(bare)) return { valid: false, reason: `name segment '${bare}' contains characters npm does not allow` };
    return { valid: true };
  }

  if (name.includes("/")) {
    return { valid: false, reason: "only scoped names ('@scope/name') may contain '/'" };
  }
  if (!isUrlSafeSegment(name)) {
    return { valid: false, reason: "name contains characters npm does not allow" };
  }
  return { valid: true };
}

// A scoped name's slash is the only one that survives validation, but
// replaceAll is used rather than replace so this can't quietly build a
// malformed URL if the validator above is ever loosened.
function registryUrl(name: string): string {
  return `${REGISTRY}/${name.replaceAll("/", "%2F")}`;
}

export async function fetchPackageDoc(name: string): Promise<RegistryDoc | RegistryMiss> {
  const validity = validatePackageName(name);
  if (!validity.valid) {
    return {
      found: false,
      name,
      code: "invalid-name",
      reason: `not a valid npm package name (${validity.reason}) — the registry was never asked, so this says nothing about whether some other name exists`,
    };
  }

  let res: Response;
  try {
    res = await fetch(registryUrl(name), {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
  } catch (err) {
    return {
      found: false,
      name,
      code: "registry-error",
      reason: `could not reach the npm registry (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (res.status === 404) {
    return { found: false, name, code: "not-found", reason: "does not exist on the npm registry" };
  }
  if (!res.ok) {
    return {
      found: false,
      name,
      code: "registry-error",
      reason: `registry lookup failed (HTTP ${res.status}) — the registry did not answer whether this package exists`,
    };
  }

  const doc = (await res.json()) as any;
  const latestVersion: string | undefined = doc["dist-tags"]?.latest;
  const latestManifest = latestVersion ? doc.versions?.[latestVersion] : undefined;

  if (!latestManifest) {
    return { found: false, name, code: "no-manifest", reason: "no resolvable latest version manifest" };
  }

  const versionHistory: VersionEntry[] = Object.entries(doc.time ?? {})
    .filter(([key]) => key !== "created" && key !== "modified")
    .map(([version, iso]) => ({ version, releasedAt: iso as string, ts: new Date(iso as string).getTime() }))
    .filter((e) => !Number.isNaN(e.ts))
    .sort((a, b) => a.ts - b.ts)
    .map(({ version, releasedAt }) => ({ version, releasedAt }));

  let releaseCadenceDays: number | null = null;
  if (versionHistory.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < versionHistory.length; i++) {
      gaps.push((new Date(versionHistory[i].releasedAt).getTime() - new Date(versionHistory[i - 1].releasedAt).getTime()) / 86_400_000);
    }
    gaps.sort((a, b) => a - b);
    releaseCadenceDays = Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10;
  }

  const exportsField = latestManifest.exports;
  const esmSupport =
    latestManifest.type === "module" ||
    (typeof exportsField === "object" && exportsField !== null && JSON.stringify(exportsField).includes('"import"'));

  const typescriptSupport = Boolean(latestManifest.types || latestManifest.typings);

  const scripts = latestManifest.scripts ?? {};
  const hasInstallScripts = Boolean(scripts.preinstall || scripts.install || scripts.postinstall);

  return {
    found: true,
    name,
    license: typeof doc.license === "string" ? doc.license : doc.license?.type ?? null,
    maintainersCount: Array.isArray(doc.maintainers) ? doc.maintainers.length : 0,
    createdAt: doc.time?.created ?? null,
    modifiedAt: doc.time?.modified ?? null,
    latestVersion: latestVersion ?? null,
    dependenciesCount: latestManifest.dependencies ? Object.keys(latestManifest.dependencies).length : 0,
    deprecated: Boolean(latestManifest.deprecated),
    esmSupport: Boolean(esmSupport),
    typescriptSupport,
    releaseCadenceDays,
    versionHistory,
    hasInstallScripts,
  };
}

export async function fetchWeeklyDownloads(name: string): Promise<number> {
  // the single-package downloads endpoint accepts scoped names (@scope/name)
  // directly in the path, unlike the bulk comma-separated endpoint
  const res = await fetch(`${DOWNLOADS}/${name}`, { headers: { "User-Agent": UA } });
  if (!res.ok) return 0;
  const data = (await res.json()) as any;
  return data?.downloads ?? 0;
}
