const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";

export async function queryVulnerabilitiesBatch(names: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const BATCH = 500; // OSV's batch endpoint accepts large batches; stay well under any limit

  for (let i = 0; i < names.length; i += BATCH) {
    const chunk = names.slice(i, i + BATCH);
    const body = { queries: chunk.map((name) => ({ package: { name, ecosystem: "npm" } })) };

    const res = await fetch(OSV_BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) continue;

    const data = (await res.json()) as { results?: Array<{ vulns?: Array<{ id: string }> }> };
    (data.results ?? []).forEach((r, idx) => {
      out[chunk[idx]] = (r.vulns ?? []).map((v) => v.id);
    });
  }

  return out;
}
