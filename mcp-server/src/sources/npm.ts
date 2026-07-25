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

export interface RegistryMiss {
  found: false;
  name: string;
  reason: string;
}

export async function fetchPackageDoc(name: string): Promise<RegistryDoc | RegistryMiss> {
  const res = await fetch(`${REGISTRY}/${name.replace("/", "%2F")}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });

  if (res.status === 404) {
    return { found: false, name, reason: "does not exist on the npm registry" };
  }
  if (!res.ok) {
    return { found: false, name, reason: `registry lookup failed (HTTP ${res.status})` };
  }

  const doc = (await res.json()) as any;
  const latestVersion: string | undefined = doc["dist-tags"]?.latest;
  const latestManifest = latestVersion ? doc.versions?.[latestVersion] : undefined;

  if (!latestManifest) {
    return { found: false, name, reason: "no resolvable latest version manifest" };
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
