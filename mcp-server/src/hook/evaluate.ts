// Judges the packages a command would install or run. "deny" is for what
// should never reach node_modules: a name that does not exist (the
// hallucination signature), a typosquat, or a version that is inside the
// cooldown or has known vulnerabilities. "ask" puts softer problems in front
// of the human. Anything this cannot determine passes: the hook fails open.

import { checkPackage } from "../data.js";
import { fetchPackageDoc } from "../sources/npm.js";
import { queryVulnerabilities } from "../sources/osv.js";
import { COOLDOWN_DAYS } from "../store/version-safety.js";
import { compare, isPrerelease, parse, satisfies } from "../fix/semver.js";
import type { PackageRequest } from "./command.js";

export type Level = "deny" | "ask" | "pass";

export interface Finding {
  request: PackageRequest;
  level: Level;
  message: string;
}

const DAY = 86_400_000;

async function judge(req: PackageRequest, now: number): Promise<Finding> {
  const at = (level: Level, message: string): Finding => ({ request: req, level, message });
  const result = await checkPackage(req.name);

  if (!result.found) {
    switch (result.reasonCode) {
      case "not-found":
        return at("deny", `${req.name} does not exist on the npm registry, so it is most likely a hallucinated name. Do not try guessed variants; confirm the real package name with the user.`);
      case "invalid-name":
        return at("deny", `"${req.name}" is not a valid npm package name.`);
      case "no-manifest":
        return at("ask", `${req.name} exists on npm but has no installable version (unpublished or a placeholder).`);
      default:
        return at("pass", `${req.name} could not be checked: ${result.reason}`);
    }
  }
  if (result.typosquatWarning) {
    // A lookalike name alone also matches legitimate packages (preact next
    // to react); the risk markers are what make it look like an attack.
    const w = result.typosquatWarning;
    const markers = w.riskMarkers.length > 0 ? ` It also ${w.riskMarkers.join(", ")}.` : " It is an established package, so this may be intended.";
    return at(w.riskMarkers.length > 0 ? "deny" : "ask", `${req.name} looks like a ${w.kind === "combo" ? "combosquat" : "typosquat"} of ${w.targetPackage}: ${w.reason}${markers}`);
  }
  if (result.npm?.deprecated) {
    return at("ask", `${req.name} is deprecated on npm.`);
  }

  const latest = result.npm?.latestVersion ?? null;
  const recommended = result.versionGuidance?.recommendedVersion ?? null;

  // No version given: npm takes the latest dist-tag, which the stored
  // guidance has already judged against the cooldown and OSV.
  if (req.spec === null || req.spec === "latest") {
    if (latest && recommended && recommended !== latest) {
      return at("deny", `${req.name}@latest is ${latest}, which dep-rec would not install: ${result.versionGuidance!.reason} Use ${req.name}@${recommended} instead.`);
    }
    return at("pass", `${req.name}@${latest ?? "latest"} passed`);
  }

  // An explicit version or range: resolve it the way npm would.
  const doc = await fetchPackageDoc(req.name);
  if (!doc.found) return at("pass", `${req.name}: could not read version history`);
  const history = doc.versionHistory
    .map((h) => ({ ...h, v: parse(h.version), ts: new Date(h.releasedAt).getTime() }))
    .filter((h) => h.v !== null);
  const wantsPre = parse(req.spec)?.pre.length ? true : /-/.test(req.spec);
  const matching = history
    .filter((h) => satisfies(h.version, req.spec!) === true && (wantsPre || !isPrerelease(h.v!)))
    .sort((a, b) => compare(a.v!, b.v!));
  if (matching.length === 0) return at("pass", `${req.raw}: not a range dep-rec can resolve`);

  const picked = matching[matching.length - 1];
  const agedInRange = matching.filter((h) => now - h.ts >= COOLDOWN_DAYS * DAY).pop();
  const instead = agedInRange && agedInRange.version !== picked.version ? agedInRange.version : recommended;
  const insteadText = instead ? ` Use ${req.name}@${instead} instead.` : "";

  const ageDays = Math.floor((now - picked.ts) / DAY);
  if (ageDays < COOLDOWN_DAYS) {
    return at("deny", `${req.raw} resolves to ${picked.version}, published ${ageDays} day(s) ago; dep-rec only installs versions at least ${COOLDOWN_DAYS} days old, since fresh releases are how hijacked versions spread.${insteadText}`);
  }
  const vulns = await queryVulnerabilities(req.name, picked.version);
  if (vulns.ok && vulns.vulnerabilityIds.length > 0) {
    return at("deny", `${req.raw} resolves to ${picked.version}, which has known vulnerabilities (${vulns.vulnerabilityIds.join(", ")}).${insteadText}`);
  }
  return at("pass", `${req.raw} -> ${picked.version} passed`);
}

export async function evaluate(requests: PackageRequest[], now = Date.now()): Promise<{ level: Level; findings: Finding[] }> {
  const findings = await Promise.all(
    requests.map((r) => judge(r, now).catch((err): Finding => ({ request: r, level: "pass", message: `${r.name}: check failed (${(err as Error).message})` }))),
  );
  const level: Level = findings.some((f) => f.level === "deny") ? "deny" : findings.some((f) => f.level === "ask") ? "ask" : "pass";
  return { level, findings };
}
