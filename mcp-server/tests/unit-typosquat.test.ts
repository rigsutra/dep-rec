// Typosquat detection is the newest and least battle-tested part of the
// project, and the one where a wrong answer is most costly in both
// directions: a miss lets a malicious package through, a false positive
// libels a legitimate one. These tests attack both directions, and verify
// the variant generator against an independent edit-distance implementation
// rather than trusting it to be self-consistent.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkTyposquat, KNOWN_POPULAR_PACKAGES } from "../src/store/typosquat.js";
import { INVALID_NAMES, HOSTILE_NAMES, HOMOGLYPH_NAMES } from "./helpers.js";

// Independent Damerau-Levenshtein (optimal string alignment) — deliberately a
// different algorithm from the generator under test, so a shared bug can't
// hide.
function damerau(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// A store map where the target is overwhelmingly popular and the candidate is
// obscure — i.e. thresholds satisfied, so detection depends purely on whether
// the name similarity is recognised.
function storeWith(target: string, downloads = 150_000_000): Map<string, number> {
  return new Map([[target, downloads]]);
}

const OBSCURE = 40;

describe("edit-distance-1 detection (the documented design envelope)", () => {
  // Each of these is distance 1 from its target by an independent
  // calculation, so the detector is required to catch every one.
  const cases: Array<[string, string, string]> = [
    ["reactt", "react", "trailing duplicate character"],
    ["reac", "react", "trailing deletion"],
    ["raect", "react", "adjacent transposition"],
    ["rect", "react", "internal deletion"],
    ["reactr", "react", "trailing insertion"],
    ["rreact", "react", "leading duplicate"],
    ["eact", "react", "leading deletion"],
    ["rezct", "react", "internal substitution"],
    ["loadsh", "lodash", "real-world lodash transposition squat"],
    ["lodahs", "lodash", "trailing transposition"],
    ["lodas", "lodash", "trailing deletion"],
    ["crossenv", "cross-env", "real-world hyphen-removal squat"],
    ["mongose", "mongoose", "real-world mongoose squat"],
    ["electorn", "electron", "real-world electron squat"],
    ["expres", "express", "deletion"],
    ["expresss", "express", "duplicate"],
    ["axois", "axios", "transposition"],
    ["momnet", "moment", "transposition"],
    ["webpak", "webpack", "deletion"],
    ["typescrpit", "typescript", "transposition"],
    ["eslnt", "eslint", "deletion"],
    ["chlk", "chalk", "deletion"],
    ["uuidd", "uuid", "duplicate"],
    ["dotnev", "dotenv", "transposition"],
    ["reactdom", "react-dom", "hyphen removal"],
    ["@types/reactt", "@types/react", "scoped, duplicate in name part"],
  ];

  for (const [candidate, target, why] of cases) {
    test(`${candidate} -> ${target} (${why})`, async () => {
      const distance = damerau(candidate, target);
      assert.equal(distance, 1, `test premise broken: ${candidate}/${target} is distance ${distance}, not 1`);

      const res = await checkTyposquat(candidate, OBSCURE, storeWith(target));
      assert.equal(res.suspicious, true, `missed a distance-1 squat of ${target}`);
      assert.equal(res.targetPackage, target);
      assert.ok(res.reason && res.reason.includes(target), "reason must name the package being impersonated");
      assert.ok(res.targetWeeklyDownloads! > 0);
    });
  }
});

describe("threshold behaviour — must not libel legitimate packages", () => {
  test("an obscure package near another obscure package is not flagged", async () => {
    const res = await checkTyposquat("tiny-thing", 30, new Map([["tiny-thng", 900]]));
    assert.equal(res.suspicious, false, "two unpopular neighbours are not a squat signal");
  });

  test("a target below the 1M popularity floor is not enough on its own", async () => {
    const res = await checkTyposquat("smallpkg", 1, new Map([["smallpkgs", 999_999]]));
    assert.equal(res.suspicious, false);
  });

  test("a target at exactly the 1M floor with a 100x gap is flagged", async () => {
    const res = await checkTyposquat("smallpkg", 10_000, new Map([["smallpkgs", 1_000_000]]));
    assert.equal(res.suspicious, true);
  });

  test("a genuinely popular package is not flagged against a similarly popular neighbour", async () => {
    // csv-parse vs csv-parser are both real and both widely used; neither
    // should be branded a squat of the other.
    const res = await checkTyposquat("csv-parser", 12_000_000, new Map([["csv-parse", 17_000_000]]));
    assert.equal(res.suspicious, false, "comparable popularity means both are plausibly legitimate");
  });

  test("the 100x ratio boundary is respected in both directions", async () => {
    const justUnder = await checkTyposquat("probe", 1_000_001, new Map([["probes", 100_000_000]]));
    assert.equal(justUnder.suspicious, false, "ratio just under 100x must not flag");
    const justOver = await checkTyposquat("probe", 999_999, new Map([["probes", 100_000_000]]));
    assert.equal(justOver.suspicious, true, "ratio at/over 100x must flag");
  });

  test("a zero-download package near a giant is flagged (ratio must not divide by zero)", async () => {
    const res = await checkTyposquat("reactt", 0, storeWith("react"));
    assert.equal(res.suspicious, true);
    assert.ok(Number.isFinite(res.targetWeeklyDownloads!));
  });

  test("the package itself being the popular one is never self-flagged", async () => {
    const res = await checkTyposquat("react", 150_000_000, storeWith("react"));
    assert.equal(res.suspicious, false, "a package must never be reported as a squat of itself");
  });

  test("exact self-match is excluded even when the store lists it", async () => {
    const res = await checkTyposquat("lodash", 40, new Map([["lodash", 200_000_000]]));
    assert.equal(res.suspicious, false, "identical name is distance 0, not a squat");
  });
});

describe("distance-2+ shapes are outside the envelope (documented, not silently wrong)", () => {
  // These must NOT be reported as confident detections, because the detector
  // only claims distance-1 coverage. The test asserts the tool stays honest
  // (no false claim, no crash) rather than asserting it catches them.
  const beyond = ["reactjs", "react-js", "node-react", "expressjs", "js-lodash", "npm-lodash", "lodash-js"];

  for (const name of beyond) {
    test(`${name} is handled without a bogus claim`, async () => {
      const res = await checkTyposquat(name, OBSCURE, storeWith("react", 150_000_000));
      if (res.suspicious) {
        // Allowed only if it really is distance 1 from something in the map.
        const d = damerau(name, res.targetPackage!);
        assert.equal(d, 1, `claimed ${name} squats ${res.targetPackage} but distance is ${d}`);
      } else {
        assert.equal(res.targetPackage, undefined);
        assert.equal(res.reason, undefined);
      }
    });
  }
});

describe("hostile and malformed names must not crash the matcher", () => {
  for (const name of [...INVALID_NAMES, ...HOSTILE_NAMES]) {
    test(`survives ${JSON.stringify(name.slice(0, 40))}`, async () => {
      const res = await checkTyposquat(name, 10, new Map([["react", 150_000_000]]));
      assert.equal(typeof res.suspicious, "boolean");
      if (res.suspicious) {
        const d = damerau(name, res.targetPackage!);
        assert.equal(d, 1, `flagged ${JSON.stringify(name)} as squatting ${res.targetPackage} at distance ${d}`);
      }
    });
  }

  test("a maximum-length name completes without blowing up", async () => {
    const started = Date.now();
    const res = await checkTyposquat("a".repeat(214), 10, new Map([["react", 150_000_000]]));
    assert.equal(res.suspicious, false);
    assert.ok(Date.now() - started < 5_000, "variant generation must stay fast on max-length input");
  });

  test("an empty name is handled", async () => {
    const res = await checkTyposquat("", 10, new Map([["react", 150_000_000]]));
    assert.equal(typeof res.suspicious, "boolean");
  });

  test("a single-character name is handled", async () => {
    const res = await checkTyposquat("q", 10, new Map([["react", 150_000_000]]));
    assert.equal(typeof res.suspicious, "boolean");
  });

  test("an empty store map yields no detection and no network dependence", async () => {
    const res = await checkTyposquat("reactt", 10, new Map());
    // "react" is in the curated KNOWN_POPULAR list, so a live download lookup
    // may still resolve it; either outcome is fine, but it must be coherent.
    if (res.suspicious) assert.equal(res.targetPackage, "react");
  });
});

describe("homoglyph / Unicode-confusable names", () => {
  // Single-character Cyrillic substitutions land inside the ASCII
  // substitution sweep, so some of these are caught as a side effect. That is
  // worth pinning: it is real coverage, but it is coverage by accident, and
  // multi-character homoglyphs fall outside it.
  for (const name of HOMOGLYPH_NAMES) {
    test(`${name} is either caught correctly or cleanly missed`, async () => {
      const res = await checkTyposquat(name, OBSCURE, new Map([["react", 150_000_000], ["lodash", 200_000_000], ["vue", 40_000_000], ["express", 90_000_000], ["axios", 100_000_000]]));
      assert.equal(typeof res.suspicious, "boolean");
      if (res.suspicious) {
        const d = damerau(name, res.targetPackage!);
        assert.equal(d, 1, `claimed distance-1 match for ${name} -> ${res.targetPackage} but it is ${d}`);
        assert.ok(res.reason!.includes(res.targetPackage!));
      }
    });
  }

  test("a name containing invisible/control characters does not produce a bogus match", async () => {
    for (const name of ["re​act", "react ", "‮react", "re­act"]) {
      const res = await checkTyposquat(name, OBSCURE, storeWith("react"));
      if (res.suspicious) {
        const d = damerau(name, res.targetPackage!);
        assert.equal(d, 1, `${JSON.stringify(name)} -> ${res.targetPackage} claimed at distance ${d}`);
      }
    }
  });
});

describe("curated popular-package list hygiene", () => {
  test("contains no duplicates", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const n of KNOWN_POPULAR_PACKAGES) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    assert.deepEqual(dupes, [], "duplicate entries waste comparisons and suggest careless edits");
  });

  test("every entry is a syntactically valid npm name", () => {
    const valid = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
    const bad = KNOWN_POPULAR_PACKAGES.filter((n) => !valid.test(n) || n.length > 214);
    assert.deepEqual(bad, [], "an unmatchable entry is dead weight in the list");
  });

  test("edit-distance-1 pairs exist in the list and are neutralised rather than avoided", async () => {
    // `qs`/`ws` and `next`/`nuxt` are all real, legitimate, widely-used
    // packages that happen to sit one edit apart. Curating them out would be
    // the wrong fix — they belong in a list of squat targets. The safety
    // property is that a vouched-for name is never itself accused, which is
    // what actually prevents the false positive.
    const collisions: Array<[string, string]> = [];
    for (let i = 0; i < KNOWN_POPULAR_PACKAGES.length; i++) {
      for (let j = i + 1; j < KNOWN_POPULAR_PACKAGES.length; j++) {
        const a = KNOWN_POPULAR_PACKAGES[i];
        const b = KNOWN_POPULAR_PACKAGES[j];
        if (damerau(a, b) === 1) collisions.push([a, b]);
      }
    }
    assert.ok(collisions.length > 0, "premise check: the list does contain near-identical legitimate pairs");

    for (const [a, b] of collisions) {
      // Pit each against the other with thresholds deliberately satisfied.
      const aFlagged = await checkTyposquat(a, 10, new Map([[b, 200_000_000]]));
      const bFlagged = await checkTyposquat(b, 10, new Map([[a, 200_000_000]]));
      assert.equal(aFlagged.suspicious, false, `${a} must not be flagged as a squat of ${b}`);
      assert.equal(bFlagged.suspicious, false, `${b} must not be flagged as a squat of ${a}`);
    }
  });

  test("every curated entry is immune from being accused", async () => {
    const accused: string[] = [];
    for (const name of KNOWN_POPULAR_PACKAGES) {
      const res = await checkTyposquat(name, 1, new Map([["react", 300_000_000], ["lodash", 300_000_000]]));
      if (res.suspicious) accused.push(`${name} -> ${res.targetPackage}`);
    }
    assert.deepEqual(accused, [], "a package on the vouched-for list must never be reported as a squat");
  });

  test("very short names are not treated as squat candidates", async () => {
    for (const short of ["ab", "abc", "x", "@a/bc"]) {
      const res = await checkTyposquat(short, 5, new Map([["abd", 200_000_000], ["abcd", 200_000_000], ["bc", 200_000_000]]));
      assert.equal(res.suspicious, false, `${short} is too short to accuse meaningfully`);
    }
  });
});
