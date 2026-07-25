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

export async function checkTyposquat(
  name: string,
  weeklyDownloads: number,
  storeDownloads: Map<string, number>
): Promise<TyposquatCheck> {
  const variants = editDistance1Variants(name);
  const knownSet = new Set(KNOWN_POPULAR_PACKAGES);
  const candidateTargets = new Set<string>();

  for (const v of variants) {
    if (storeDownloads.has(v) || knownSet.has(v)) candidateTargets.add(v);
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
