// Single-package, version-scoped OSV lookup — same fix as
// stage1-collector/src/osv.ts: scope to the current version, or every
// vulnerability ever recorded against any past version counts forever.
//
// Also: a non-2xx response or network error is a DIFFERENT thing from
// "OSV confirms zero vulnerabilities," and callers must be able to tell
// them apart. Silently returning [] on failure (the original version of
// this function) made a rate limit or outage indistinguishable from a
// clean bill of health — the tool would confidently print "no known
// vulnerabilities" when it had actually checked nothing. Retries with a
// short backoff before giving up, same pattern used elsewhere in this
// codebase for npm's endpoints.

import { FETCH_TIMEOUT_MS } from "./npm.js";

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

export type OsvLookup = { ok: true; vulnerabilityIds: string[] } | { ok: false; error: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function queryVulnerabilities(name: string, version: string): Promise<OsvLookup> {
  const delays = [0, 500, 1500];
  let lastError = "unknown error";

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    try {
      const res = await fetch(OSV_QUERY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, package: { name, ecosystem: "npm" } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as { vulns?: Array<{ id: string }> };
        return { ok: true, vulnerabilityIds: (data.vulns ?? []).map((v) => v.id) };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------
// Whole-project scanning, for `dep-rec fix`. These throw instead of returning
// a failure value: a fix plan built on an unanswered query would claim the
// project is clean when nothing was checked.
// ---------------------------------------------------------------------------

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns/";
const OSV_BATCH_SIZE = 500;

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    versions?: string[];
    ranges?: Array<{ type?: string; events?: OsvEvent[] }>;
  }>;
  database_specific?: { severity?: string };
}

async function osvJson(url: string, init: RequestInit = {}): Promise<any> {
  const delays = [0, 500, 1500];
  let lastError = "unknown error";
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
      if (res.status === 404) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`OSV request failed (${lastError}): ${url}`);
}

/** Vulnerability ids per (name, version), in input order. */
export async function queryVulnerabilitiesBatch(pairs: Array<{ name: string; version: string }>): Promise<string[][]> {
  const out: string[][] = [];
  for (let i = 0; i < pairs.length; i += OSV_BATCH_SIZE) {
    const chunk = pairs.slice(i, i + OSV_BATCH_SIZE);
    const data = await osvJson(OSV_BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: chunk.map((p) => ({ version: p.version, package: { name: p.name, ecosystem: "npm" } })) }),
    });
    const results: Array<{ vulns?: Array<{ id: string }> }> = data?.results ?? [];
    if (results.length !== chunk.length) throw new Error(`OSV batch answered ${results.length} of ${chunk.length} queries`);
    for (const r of results) out.push((r.vulns ?? []).map((v) => v.id));
  }
  return out;
}

export async function fetchVulnerability(id: string): Promise<OsvVuln> {
  return (await osvJson(OSV_VULN_URL + encodeURIComponent(id))) as OsvVuln;
}
