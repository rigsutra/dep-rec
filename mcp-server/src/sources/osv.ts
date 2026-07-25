// Single-package, version-scoped OSV lookup — same fix as
// stage1-collector/src/osv.ts: scope to the current version, or every
// vulnerability ever recorded against any past version counts forever.

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

export async function queryVulnerabilities(name: string, version: string): Promise<string[]> {
  const res = await fetch(OSV_QUERY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version, package: { name, ecosystem: "npm" } }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { vulns?: Array<{ id: string }> };
  return (data.vulns ?? []).map((v) => v.id);
}
