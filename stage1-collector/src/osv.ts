const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";

export interface OsvQuery {
  name: string;
  version: string;
}

// Querying OSV by package name alone returns every vulnerability ever
// recorded against ANY version of that package, including ones long since
// patched. That systematically punishes exactly the packages that get the
// most security scrutiny (axios showed 44 "known vulnerabilities" this way
// — 0 of which affect the actual current release). Scoping each query to
// the package's current latest version fixes that: OSV's batch endpoint
// accepts a `version` alongside `package`, and only returns vulnerabilities
// whose affected range actually includes that version.
export async function queryVulnerabilitiesBatch(pkgs: OsvQuery[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const BATCH = 500;

  for (let i = 0; i < pkgs.length; i += BATCH) {
    const chunk = pkgs.slice(i, i + BATCH);
    const body = {
      queries: chunk.map(({ name, version }) => ({ version, package: { name, ecosystem: "npm" } })),
    };

    const res = await fetch(OSV_BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) continue;

    const data = (await res.json()) as { results?: Array<{ vulns?: Array<{ id: string }> }> };
    (data.results ?? []).forEach((r, idx) => {
      out[chunk[idx].name] = (r.vulns ?? []).map((v) => v.id);
    });
  }

  return out;
}
