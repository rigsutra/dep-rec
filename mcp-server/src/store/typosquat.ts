// Name-similarity typosquat detection — the gap the whole project started
// from, and the specific one a post-publish review reproduced live:
// check_package only flagged "likely hallucinated or typosquatted" on a
// registry 404, so a genuinely resolvable typosquat (a real, installable
// package with a name one character off from a hugely popular one) sailed
// through with an ordinary score and zero warning.
//
// Method: generate every edit-distance-1 variant of the checked name
// (deletion, substitution, insertion, adjacent transposition — cheap,
// pure string ops, no network), then check which variants match a known
// popular package. Only bother fetching a live download count for a
// matched name that isn't already in our store, since matches are rare
// (usually zero). Flag it only if the matched package is BOTH absolutely
// popular and drastically more popular than the package being checked —
// two obscure packages one typo apart isn't suspicious, one typo away
// from a top-tier package with 100x the downloads is.

import { fetchWeeklyDownloads } from "../sources/npm.js";

// Deliberately small and hand-maintained, not a live top-10k crawl — this
// covers well-known packages outside our 10 curated categories (react,
// vue, lodash, webpack, etc.) that a typosquat would plausibly target.
// Combined at check time with every name already in our own store, which
// covers the other ~500 popular packages we already track with real
// download counts. Extend this list as gaps are found, same as any other
// part of this project.
export const KNOWN_POPULAR_PACKAGES = [
  "react", "react-dom", "vue", "angular", "svelte", "solid-js",
  "lodash", "underscore", "ramda", "jquery",
  "webpack", "rollup", "parcel", "vite", "esbuild", "gulp", "grunt", "browserify",
  "babel-core", "@babel/core", "typescript", "eslint", "prettier",
  "three", "d3", "chart.js",
  "chalk", "commander", "yargs", "inquirer", "colors", "debug", "ora", "boxen",
  "glob", "minimatch", "semver", "rimraf", "mkdirp", "fs-extra", "chokidar",
  "uuid", "nanoid", "bcrypt", "multer", "cors", "helmet", "morgan", "compression",
  "body-parser", "cookie-parser", "qs", "form-data", "classnames", "clsx",
  "styled-components", "tailwindcss", "sass", "less", "postcss", "autoprefixer",
  "prop-types", "immer", "redux-saga", "next", "nuxt", "gatsby",
  "socket.io", "ws", "request", "cross-env", "dotenv", "config", "nconf",
  "cheerio", "selenium-webdriver", "webdriverio",
  "electron", "sqlite3", "pg-pool", "mysql", "mongodb",
];

const NAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-._".split("");

// QWERTY neighbours. A substitution between adjacent keys is a plausible slip
// of the finger; an arbitrary substitution is usually just a different word.
// That distinction is what separates a real squat (react -> rezct) from two
// unrelated legitimate packages that happen to be one edit apart
// (rest / jest, js-logger / bs-logger) — both of which this detector
// previously branded as typosquats.
const KEYBOARD_NEIGHBOURS: Record<string, string> = {
  q: "wa", w: "qeas", e: "wrsd", r: "etdf", t: "ryfg", y: "tugh",
  u: "yihj", i: "uojk", o: "ipkl", p: "ol",
  a: "qwsz", s: "awedzx", d: "serfxc", f: "drtgcv", g: "ftyhvb",
  h: "gyujbn", j: "huikNM".toLowerCase(), k: "jiolm", l: "kop",
  z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk",
  "-": "._", ".": "-_", _: "-.",
};

// Visually confusable pairs: Cyrillic/Greek lookalikes and digit/letter
// swaps. A homoglyph substitution is the most deliberate kind of squat.
const CONFUSABLES: Record<string, string> = {
  a: "аα", e: "еε", o: "оο0", p: "рρ",
  c: "сς", x: "хχ", y: "уγ", i: "іι1l",
  s: "ѕ", h: "һ", k: "кκ", m: "м", t: "тτ",
  b: "в", n: "п", l: "1i", g: "ґ", d: "ԁ", u: "υ",
  "0": "o", "1": "li",
};

function isConfusablePair(a: string, b: string): boolean {
  const lower = a.toLowerCase();
  const other = b.toLowerCase();
  if ((CONFUSABLES[lower] ?? "").includes(other)) return true;
  if ((CONFUSABLES[other] ?? "").includes(lower)) return true;
  return false;
}

function isPlausibleSubstitution(a: string, b: string): boolean {
  if ((KEYBOARD_NEIGHBOURS[a.toLowerCase()] ?? "").includes(b.toLowerCase())) return true;
  if ((KEYBOARD_NEIGHBOURS[b.toLowerCase()] ?? "").includes(a.toLowerCase())) return true;
  return isConfusablePair(a, b);
}

// Classifies the single edit between two distance-1 names, and decides whether
// it is typo-shaped. Deletions, insertions and transpositions are all
// inherently slip-shaped. Substitutions are only slip-shaped when the two
// characters are neighbours on the keyboard or visually confusable.
export function isTypoShapedEdit(candidate: string, target: string): boolean {
  if (candidate === target) return false;

  if (candidate.length === target.length) {
    // Substitution or transposition.
    const diffs: number[] = [];
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] !== target[i]) diffs.push(i);
    }
    if (diffs.length === 1) {
      return isPlausibleSubstitution(candidate[diffs[0]], target[diffs[0]]);
    }
    if (diffs.length === 2 && diffs[1] === diffs[0] + 1) {
      // Adjacent transposition — always typo-shaped.
      return candidate[diffs[0]] === target[diffs[1]] && candidate[diffs[1]] === target[diffs[0]];
    }
    return false;
  }

  // Length differs by one: a pure insertion or deletion, which is always
  // slip-shaped (a dropped or doubled keystroke).
  return Math.abs(candidate.length - target.length) === 1;
}

function editDistance1Variants(name: string): Set<string> {
  const variants = new Set<string>();
  const n = name.length;

  for (let i = 0; i < n; i++) {
    variants.add(name.slice(0, i) + name.slice(i + 1)); // deletion
  }
  for (let i = 0; i < n; i++) {
    for (const c of NAME_CHARS) {
      if (c !== name[i]) variants.add(name.slice(0, i) + c + name.slice(i + 1)); // substitution
    }
  }
  for (let i = 0; i <= n; i++) {
    for (const c of NAME_CHARS) {
      variants.add(name.slice(0, i) + c + name.slice(i)); // insertion
    }
  }
  for (let i = 0; i < n - 1; i++) {
    if (name[i] !== name[i + 1]) {
      variants.add(name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2)); // transposition
    }
  }

  variants.delete(name);
  return variants;
}

export interface TyposquatCheck {
  suspicious: boolean;
  targetPackage?: string;
  targetWeeklyDownloads?: number;
  /** "typo": one slip away. "combo": the target plus an affix (express-js). */
  kind?: "typo" | "combo";
  reason?: string;
}

/**
 * Live weekly downloads for many names at once; null when the source could
 * not answer. Supplying one lets the check find a squat of ANY package on
 * npm, not just the ones in the store or the hand-kept list above.
 */
export type DownloadsProbe = (names: string[]) => Promise<Map<string, number | null> | null>;

// A target has to be worth squatting before a near-miss name means
// anything: two obscure packages one typo apart is a coincidence, not an
// attack. But a single flat floor turned out to silently gut the ratio
// check. `parcel` sits at ~410k weekly downloads — unmistakably a name
// worth impersonating, and hand-listed above as exactly that — yet a squat
// of it with 5 downloads (an ~82,000x ratio) was waved through purely
// because 410k < 1,000,000. Same for `gatsby` and `angular`. The absolute
// cutoff was overriding the signal it was supposed to support.
//
// So the floor now depends on how the target was recognised:
//   - hand-curated above: we have already asserted this is a recognisable
//     name an attacker would target, so a much lower floor applies;
//   - found by the live probe: its popularity is a fresh measurement, but
//     nobody vouched for it, so it needs more than a curated name;
//   - merely present in our store: the store deliberately tracks obscure
//     packages (that is what check_package is for, and some entries have
//     double-digit download counts), so those need real popularity before
//     they can be treated as a squat target at all.
const MIN_TARGET_DOWNLOADS = 1_000_000;
const MIN_PROBED_TARGET_DOWNLOADS = 100_000;
const MIN_CURATED_TARGET_DOWNLOADS = 50_000;
const MIN_RATIO = 100;

// Short names are inherently one edit from many other short names (`qs`/`ws`,
// `next`/`nuxt` are all real, legitimate packages), so treating them as squat
// candidates produces false positives on packages that have done nothing
// wrong. Real typosquats target recognisable, longer names.
const MIN_CANDIDATE_LENGTH = 4;

// The bulk downloads endpoint takes 128 names per request; two requests is
// the budget for one check.
const MAX_PROBE_NAMES = 256;

// Affixes attackers bolt onto a popular name (combosquatting). Stripping one
// from the checked name gives the package it may be impersonating.
const COMBO_PREFIXES = ["node-", "nodejs-", "js-", "npm-"];
const COMBO_SUFFIXES = ["-js", ".js", "js", "-node", "-nodejs", "-cli", "-utils", "-util", "-lib", "-pkg", "-npm", "-official"];

// A name already in the store costs nothing to look up. Anything else needs
// the network — and that call must never be allowed to take down the whole
// check. Typosquat detection is one advisory signal among several; if the
// downloads endpoint is unreachable, the right outcome is "no opinion",
// not an exception thrown out through check_package to the caller.
async function targetDownloads(target: string, storeDownloads: Map<string, number>): Promise<number | null> {
  const stored = storeDownloads.get(target);
  if (stored !== undefined) return stored;
  try {
    return await fetchWeeklyDownloads(target);
  } catch {
    return null;
  }
}

/**
 * The names the checked one could be a slip of, sized for the live probe.
 * Every deletion, transposition and plausible substitution, but insertions
 * only of the characters people actually drop: a doubled neighbour, a vowel,
 * or a separator. All 39 characters at every position would be ~40x the
 * requests for little gain.
 */
function probeVariants(name: string): string[] {
  const out = new Set<string>();
  const n = name.length;
  for (let i = 0; i < n; i++) out.add(name.slice(0, i) + name.slice(i + 1));
  for (let i = 0; i < n - 1; i++) {
    if (name[i] !== name[i + 1]) out.add(name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2));
  }
  for (let i = 0; i < n; i++) {
    const subs = (KEYBOARD_NEIGHBOURS[name[i]] ?? "") + (CONFUSABLES[name[i]] ?? "").replace(/[^a-z0-9]/g, "");
    for (const c of subs) out.add(name.slice(0, i) + c + name.slice(i + 1));
  }
  for (let i = 0; i <= n; i++) {
    // A dropped first or last letter is common enough to try every letter.
    const pool = i === 0 || i === n ? "abcdefghijklmnopqrstuvwxyz".split("") : [];
    const drops = new Set([name[i - 1], name[i], "a", "e", "i", "o", "u", "-", ...pool].filter((c): c is string => Boolean(c)));
    for (const c of drops) out.add(name.slice(0, i) + c + name.slice(i));
  }
  out.delete(name);
  return [...out].filter((v) => /^[a-z0-9]/.test(v) && isTypoShapedEdit(name, v)).slice(0, MAX_PROBE_NAMES);
}

function comboTargets(name: string): string[] {
  const out = new Set<string>();
  for (const p of COMBO_PREFIXES) if (name.startsWith(p)) out.add(name.slice(p.length));
  for (const s of COMBO_SUFFIXES) if (name.endsWith(s)) out.add(name.slice(0, -s.length));
  return [...out].filter((t) => t.length >= MIN_CANDIDATE_LENGTH);
}

export async function checkTyposquat(
  name: string,
  weeklyDownloads: number,
  storeDownloads: Map<string, number>,
  /**
   * Whether `weeklyDownloads` is a real measurement. When it is not, this
   * function refuses to answer — the whole test is a ratio against the
   * checked package's own popularity, so an unverified figure (which used to
   * arrive as a silent 0 from a rate-limited request) makes
   * `target >= subject * 100` collapse to `target >= 0` and every popular
   * neighbour becomes a "confirmed" impersonation target.
   */
  subjectDownloadsVerified = true,
  probe?: DownloadsProbe,
): Promise<TyposquatCheck> {
  if (!subjectDownloadsVerified) return { suspicious: false };

  const knownSet = new Set(KNOWN_POPULAR_PACKAGES);

  // Never accuse a package we have explicitly vouched for. Without this, a
  // legitimate-but-smaller package sitting one edit from a giant (`nuxt` next
  // to `next`) can be branded a squat of it.
  if (knownSet.has(name)) return { suspicious: false };

  const bareName = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  if (bareName.length < MIN_CANDIDATE_LENGTH) return { suspicious: false };

  // Candidates from what is already known locally.
  const candidates = new Map<string, "typo" | "combo">();
  for (const v of editDistance1Variants(name)) {
    if (!storeDownloads.has(v) && !knownSet.has(v)) continue;
    // Only keep matches whose single edit actually looks like a typing slip.
    if (!isTypoShapedEdit(name, v)) continue;
    candidates.set(v, "typo");
  }
  const combos = name.startsWith("@") ? [] : comboTargets(name);
  for (const c of combos) if (storeDownloads.has(c) || knownSet.has(c)) candidates.set(c, "combo");

  // Candidates from npm itself: which of the plausible source names exist,
  // and how popular they are, in one or two requests. A failed probe leaves
  // the local candidates to stand alone.
  let probed: Map<string, number | null> | null = null;
  if (probe && !name.startsWith("@")) {
    const typos = probeVariants(name);
    probed = await probe([...typos, ...combos]).catch(() => null);
    if (probed) {
      for (const t of typos) if (typeof probed.get(t) === "number" && !candidates.has(t)) candidates.set(t, "typo");
      for (const c of combos) if (typeof probed.get(c) === "number" && !candidates.has(c)) candidates.set(c, "combo");
    }
  }
  if (candidates.size === 0) return { suspicious: false };

  let best: { name: string; downloads: number; floor: number; kind: "typo" | "combo" } | null = null;
  for (const [target, kind] of candidates) {
    const live = probed?.get(target);
    const downloads = typeof live === "number" ? live : await targetDownloads(target, storeDownloads);
    // Unknown popularity means this candidate cannot be judged. Skipping it
    // is the only safe choice: guessing high would invent an accusation,
    // and there is nothing to compare a ratio against.
    if (downloads === null) continue;
    const floor = knownSet.has(target)
      ? MIN_CURATED_TARGET_DOWNLOADS
      : storeDownloads.has(target)
        ? MIN_TARGET_DOWNLOADS
        : MIN_PROBED_TARGET_DOWNLOADS;
    // Rank by how far past its own floor a candidate is, not by raw
    // downloads — otherwise a big-but-ineligible store name can shadow a
    // curated target that actually qualifies.
    if (!best || downloads / floor > best.downloads / best.floor) best = { name: target, downloads, floor, kind };
  }
  if (!best) return { suspicious: false };

  if (best.downloads >= best.floor && best.downloads >= weeklyDownloads * MIN_RATIO) {
    const shape = best.kind === "typo" ? "one character away from" : "a popular package's name plus an affix:";
    return {
      suspicious: true,
      targetPackage: best.name,
      targetWeeklyDownloads: best.downloads,
      kind: best.kind,
      reason: `Name is ${shape} "${best.name}" (${best.downloads.toLocaleString("en-US")} weekly downloads vs. this package's ${weeklyDownloads.toLocaleString("en-US")}) — classic ${best.kind === "typo" ? "typosquat" : "combosquat"} pattern. Verify this is really the package you meant before installing.`,
    };
  }

  return { suspicious: false };
}

/**
 * What separates an attack from an unlucky name. A real squat is usually
 * new, runs code on install, or has never been updated; an established
 * package that merely resembles a bigger one has none of these.
 */
export function squatRiskMarkers(
  row: { created_at: string | null; has_install_scripts: boolean; release_cadence_days: number | null },
  now = Date.now(),
): string[] {
  const markers: string[] = [];
  const created = row.created_at ? new Date(row.created_at).getTime() : NaN;
  if (Number.isFinite(created)) {
    const days = Math.floor((now - created) / 86_400_000);
    if (days < 90) markers.push(`first published ${days} day(s) ago`);
  }
  if (row.has_install_scripts) markers.push("runs install scripts");
  if (row.release_cadence_days === null) markers.push("only one version ever published");
  return markers;
}
