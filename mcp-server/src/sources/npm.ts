// Adapted from stage1-collector/src/npm.ts, trimmed to what a single
// on-demand package lookup needs (no candidate search — that's a
// category-building concern, not a live-check concern).

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS = "https://api.npmjs.org/downloads/point/last-week";
const UA = "drec-mcp-server/0.2 (live package check)";

// Measured, not guessed: a 269-lookup burst at concurrency 6 against
// api.npmjs.org left 20% of download counts unresolved. Every one of those
// disables typosquat detection for that package (correctly — an unverified
// count cannot anchor a ratio) and costs it its adoption score. A one-in-five
// silent degradation is not an acceptable resting state for a security tool,
// and the cause is ordinary throttling that a retry answers.
//
// stage1-collector already learned this lesson during corpus building; the
// live path never inherited it.
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 400;

// Retrying alone did not fix it: the failures came in one contiguous block
// spanning unrelated packages, which is the signature of a sustained
// throttling window rather than scattered transient errors. Backing off after
// the fact loses to a limiter that has already decided to say no, so the
// requests are spaced out before they are made. Single lookups are unaffected
// (one request, no queue); only bulk runs slow down, which is the correct
// trade when the alternative is one in five packages silently losing its
// typosquat check.
// A fixed spacing cannot be right for both cases: one interactive lookup
// should not be delayed at all, and a bulk sweep needs to be slowed a lot.
// (A single check_package also fans out — the typosquat step looks up each
// candidate impersonation target — so the request count is a multiple of the
// package count, which is why a plausible-looking fixed rate still got
// throttled.) So the spacing adapts: it widens on every 429 and decays back
// while requests are succeeding.
const BASE_SPACING_MS = Number(process.env.DREC_DOWNLOADS_SPACING_MS ?? 60);
const MAX_SPACING_MS = 3_000;
let currentSpacing = Number.isFinite(BASE_SPACING_MS) ? Math.max(0, BASE_SPACING_MS) : 60;
let pacingChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function noteThrottled(): void {
  currentSpacing = Math.min(MAX_SPACING_MS, Math.max(60, currentSpacing * 2));
}

function noteSucceeded(): void {
  const floor = Number.isFinite(BASE_SPACING_MS) ? Math.max(0, BASE_SPACING_MS) : 60;
  currentSpacing = Math.max(floor, currentSpacing * 0.9);
}

/** Exposed for the stress harness, which reports how hard it had to back off. */
export function downloadsPacingMs(): number {
  return Math.round(currentSpacing);
}

function paced<T>(fn: () => Promise<T>): Promise<T> {
  const slot = pacingChain.then(async () => {
    const wait = lastRequestAt + currentSpacing - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  });
  // Only the *start* of each request is serialised; the requests themselves
  // still overlap, so throughput is bounded by spacing, not by latency.
  pacingChain = slot.catch(() => {});
  return slot.then(fn);
}

function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

async function fetchWithRetry(url: string, init: RequestInit, onThrottle?: () => void): Promise<Response | null> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter, so a burst of concurrent callers
      // that all get throttled together do not all retry together.
      const wait = BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, wait));
    }
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      continue; // transient network failure: retry
    }
    if (!retryable(res.status)) return res;
    if (res.status === 429) onThrottle?.();
    lastStatus = res.status;
    // A Retry-After longer than the whole budget means backing off is
    // pointless — report the throttle rather than sleeping on it.
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 10) return res;
  }
  return lastStatus > 0 ? new Response(null, { status: lastStatus }) : null;
}

export interface SearchHit {
  name: string;
  description: string | null;
  /** npm's own blended relevance score, 0-1. Used only for ordering candidates. */
  searchScore: number;
}

/**
 * npm's registry search, the same call `stage1-collector` uses to build the
 * curated categories — just run live instead of ahead of time. This is what
 * lets a need outside the ten categories still get real candidates rather
 * than a refusal.
 *
 * Weighted towards popularity and quality over pure text relevance, matching
 * the collector, because the goal is "packages people actually use for this"
 * rather than "packages whose README mentions this most often".
 */
export async function searchPackages(query: string, size = 20): Promise<SearchHit[]> {
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${size}&popularity=1.0&quality=0.4&maintenance=0.2`;
  const res = await fetchWithRetry(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res === null || !res.ok) return [];
  try {
    const data = (await res.json()) as {
      objects?: Array<{ package?: { name?: string; description?: string }; score?: { final?: number } }>;
    };
    return (data.objects ?? [])
      .map((o) => ({
        name: o.package?.name ?? "",
        description: o.package?.description ?? null,
        searchScore: o.score?.final ?? 0,
      }))
      // @types/* are declaration packages, never the thing someone wants
      // recommended for a functional need.
      .filter((h) => h.name.length > 0 && !h.name.startsWith("@types/"));
  } catch {
    return [];
  }
}

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

  const res = await fetchWithRetry(registryUrl(name), {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (res === null) {
    return {
      found: false,
      name,
      code: "registry-error",
      reason: `could not reach the npm registry after ${MAX_ATTEMPTS} attempts`,
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

/**
 * Weekly download count, or `null` when it could not be determined.
 *
 * The null matters. This used to return 0 on any failure, which made a
 * transient rate-limit indistinguishable from a genuinely unused package —
 * the same fail-open mistake the OSV check already had fixed. It became
 * materially dangerous once typosquat detection went ratio-based: a spurious
 * 0 for the *checked* package turns `target >= subject * 100` into
 * `target >= 0`, which every popular neighbour satisfies, so one rate-limited
 * request could brand an ordinary package a typosquat. Callers must decide
 * what an unknown means for them; none of them may treat it as zero.
 */
export async function fetchWeeklyDownloads(name: string): Promise<number | null> {
  // the single-package downloads endpoint accepts scoped names (@scope/name)
  // directly in the path, unlike the bulk comma-separated endpoint
  const res = await paced(() => fetchWithRetry(`${DOWNLOADS}/${name}`, { headers: { "User-Agent": UA } }, noteThrottled));
  if (res === null) return null;
  if (res.status === 429) {
    noteThrottled();
    return null;
  }
  if (res.ok) noteSucceeded();
  // 404 from this endpoint is the one honest zero: the package exists but has
  // no downloads recorded for the period. Every other non-2xx is a failure to
  // answer, not an answer of zero.
  if (res.status === 404) return 0;
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as any;
    return typeof data?.downloads === "number" && Number.isFinite(data.downloads) ? data.downloads : null;
  } catch {
    return null;
  }
}
