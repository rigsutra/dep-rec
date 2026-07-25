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
