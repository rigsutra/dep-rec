// Deliberately small and manually curated: packages whose name and
// category membership alone would suggest they do more than they
// actually do. This is NOT a general capability-detection system — that
// would need real API-surface or README analysis, well out of scope
// here. It exists because generic quality metrics (security, maintenance,
// compatibility, popularity) can't tell "decode-only" apart from "full
// verify/sign" within the same category, and a high score on those axes
// alone let jwt-decode outrank jose for a plain "jwt library" request
// despite jwt-decode's own docs stating it does not verify signatures.
//
// Extend this map as specific mismatches are found, the same way this
// one was — not by trying to infer capability automatically.
export const CAPABILITY_CAVEATS: Record<string, string> = {
  "jwt-decode": "DECODE-ONLY — does not verify signatures or validate claims. Do not rely on this alone for authentication/authorization; pair it with (or use instead) a verifying library like jose or jsonwebtoken if you need to trust the token's contents.",
};

// Subtracted from the final total score (not folded into any one of the
// five named sub-scores, since "does the wrong job" isn't really a
// security/maintenance/compatibility/community/supply-chain fact about
// the package — it's orthogonal to all of them).
export const CAPABILITY_CAVEAT_PENALTY = 15;

export function applyCapabilityCaveat(name: string, reasons: string[]): number {
  const caveat = CAPABILITY_CAVEATS[name];
  if (!caveat) return 0;
  reasons.unshift(`⚠ ${caveat}`);
  return CAPABILITY_CAVEAT_PENALTY;
}
