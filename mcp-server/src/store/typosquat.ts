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
  reason?: string;
}

const MIN_TARGET_DOWNLOADS = 1_000_000;
const MIN_RATIO = 100;

// Short names are inherently one edit from many other short names (`qs`/`ws`,
// `next`/`nuxt` are all real, legitimate packages), so treating them as squat
// candidates produces false positives on packages that have done nothing
// wrong. Real typosquats target recognisable, longer names.
const MIN_CANDIDATE_LENGTH = 4;

export async function checkTyposquat(
  name: string,
  weeklyDownloads: number,
  storeDownloads: Map<string, number>
): Promise<TyposquatCheck> {
  const knownSet = new Set(KNOWN_POPULAR_PACKAGES);

  // Never accuse a package we have explicitly vouched for. Without this, a
  // legitimate-but-smaller package sitting one edit from a giant (`nuxt` next
  // to `next`) can be branded a squat of it.
  if (knownSet.has(name)) return { suspicious: false };

  const bareName = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  if (bareName.length < MIN_CANDIDATE_LENGTH) return { suspicious: false };

  const variants = editDistance1Variants(name);
  const candidateTargets = new Set<string>();

  for (const v of variants) {
    if (!storeDownloads.has(v) && !knownSet.has(v)) continue;
    // Only keep matches whose single edit actually looks like a typing slip.
    if (!isTypoShapedEdit(name, v)) continue;
    candidateTargets.add(v);
  }
  if (candidateTargets.size === 0) return { suspicious: false };

  let best: { name: string; downloads: number } | null = null;
  for (const target of candidateTargets) {
    const downloads = storeDownloads.get(target) ?? (await fetchWeeklyDownloads(target));
    if (!best || downloads > best.downloads) best = { name: target, downloads };
  }
  if (!best) return { suspicious: false };

  if (best.downloads >= MIN_TARGET_DOWNLOADS && best.downloads >= weeklyDownloads * MIN_RATIO) {
    return {
      suspicious: true,
      targetPackage: best.name,
      targetWeeklyDownloads: best.downloads,
      reason: `Name is one character away from "${best.name}" (${best.downloads.toLocaleString("en-US")} weekly downloads vs. this package's ${weeklyDownloads.toLocaleString("en-US")}) — classic typosquat pattern. Verify this is really the package you meant before installing.`,
    };
  }

  return { suspicious: false };
}
