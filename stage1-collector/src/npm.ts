const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS = "https://api.npmjs.org/downloads/point/last-week";
const UA = "dep-rec-engine-stage1-collector/0.1 (prototype)";

export interface NpmSearchHit {
  name: string;
  score: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The search endpoint throttles after roughly a dozen rapid requests from the
// same client and starts returning non-200s. Retry with backoff instead of
// silently treating a throttled response as "no results" — that was the bug
// that made 6 of the 10 categories collapse to just their seed packages.
export async function searchNpm(query: string, size = 50): Promise<NpmSearchHit[]> {
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${size}&popularity=1.0&quality=0.4&maintenance=0.2`;

  const attempts = [0, 800, 2000, 4000];
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) await sleep(attempts[i]);
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const data = (await res.json()) as { objects?: Array<{ package: { name: string }; score?: { final?: number } }> };
      return (data.objects ?? [])
        .map((o) => ({ name: o.package.name, score: o.score?.final ?? 0 }))
        .filter((h) => !h.name.startsWith("@types/"));
    }
    console.log(`  search "${query}" got HTTP ${res.status} (attempt ${i + 1}/${attempts.length})`);
  }

  console.log(`  search "${query}" failed after ${attempts.length} attempts — contributing 0 results`);
  return [];
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
    return { found: false, name, reason: "404 — does not exist on the registry" };
  }
  if (!res.ok) {
    return { found: false, name, reason: `HTTP ${res.status}` };
  }

  const doc = (await res.json()) as any;
  const latestVersion: string | undefined = doc["dist-tags"]?.latest;
  const latestManifest = latestVersion ? doc.versions?.[latestVersion] : undefined;

  if (!latestManifest) {
    return { found: false, name, reason: "no resolvable latest version manifest" };
  }

  const versionTimestamps = Object.entries(doc.time ?? {})
    .filter(([key]) => key !== "created" && key !== "modified")
    .map(([, iso]) => new Date(iso as string).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);

  let releaseCadenceDays: number | null = null;
  if (versionTimestamps.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < versionTimestamps.length; i++) {
      gaps.push((versionTimestamps[i] - versionTimestamps[i - 1]) / 86_400_000);
    }
    gaps.sort((a, b) => a - b);
    releaseCadenceDays = Math.round(gaps[Math.floor(gaps.length / 2)] * 10) / 10;
  }

  const exportsField = latestManifest.exports;
  const esmSupport =
    latestManifest.type === "module" ||
    (typeof exportsField === "object" && exportsField !== null && JSON.stringify(exportsField).includes('"import"'));

  const typescriptSupport = Boolean(latestManifest.types || latestManifest.typings);

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
  };
}

// api.npmjs.org throttles the same way the search endpoint does. The first
// version of this function treated any non-200 as "0 downloads" with no
// retry, which silently zeroed out ~80% of scoped packages (@scope/name must
// be fetched one at a time, which is a lot of rapid requests) and a chunk of
// unscoped ones too whenever a bulk request got throttled mid-run.
async function fetchWithRetry(url: string, failLabel: string): Promise<Response | null> {
  const delays = [0, 800, 2000, 4000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) return res;
    if (i === delays.length - 1) {
      console.log(`  downloads lookup for ${failLabel} failed after ${delays.length} attempts (HTTP ${res.status})`);
    }
  }
  return null;
}

export async function fetchWeeklyDownloadsBatch(names: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const BATCH = 128; // registry.npmjs.org bulk endpoint's documented limit

  const bulkable = names.filter((n) => !n.startsWith("@"));
  const scoped = names.filter((n) => n.startsWith("@"));

  for (let i = 0; i < bulkable.length; i += BATCH) {
    const chunk = bulkable.slice(i, i + BATCH);
    if (chunk.length === 1) {
      const res = await fetchWithRetry(`${DOWNLOADS}/${chunk[0]}`, chunk[0]);
      if (res) out[chunk[0]] = ((await res.json()) as any)?.downloads ?? 0;
    } else {
      const res = await fetchWithRetry(`${DOWNLOADS}/${chunk.join(",")}`, `batch starting ${chunk[0]}`);
      if (res) {
        const data = (await res.json()) as Record<string, { downloads?: number } | null>;
        for (const name of chunk) out[name] = data[name]?.downloads ?? 0;
      }
    }
    await sleep(300);
  }

  // scoped packages need one request each (bulk endpoint doesn't support them) —
  // pace these too so we don't immediately re-trigger the same throttling.
  for (const name of scoped) {
    const res = await fetchWithRetry(`${DOWNLOADS}/${name}`, name);
    if (res) out[name] = ((await res.json()) as any)?.downloads ?? 0;
    await sleep(200);
  }

  return out;
}
