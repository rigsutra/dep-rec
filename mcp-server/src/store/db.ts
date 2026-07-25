// Persistent store: raw registry/downloads/OSV data AND the computed
// scores, both kept on disk — not refetched on every request. Using
// node:sqlite (built into Node 22+, experimental but no native dependency
// to compile) rather than a static JSON file, since the whole point of
// this layer is "check once, serve everyone else from what's stored, and
// refresh it in the background" — a real query-able store, not a snapshot.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "./schema.js";

// Overridable so tests (and anyone wanting a separate store per project)
// don't mutate the store.db that ships inside the package.
const DB_PATH = process.env.DEP_REC_DB_PATH ?? fileURLToPath(new URL("../../data/store.db", import.meta.url));

let dbInstance: DatabaseSync | null = null;
function getDb(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec("PRAGMA journal_mode = WAL;");
    dbInstance.exec(SCHEMA_SQL);
  }
  return dbInstance;
}

export interface PackageRow {
  name: string;
  categories: string[];
  license: string | null;
  maintainers: number;
  created_at: string | null;
  modified_at: string | null;
  latest_version: string | null;
  dependencies_count: number;
  has_install_scripts: boolean;
  deprecated: boolean;
  esm_support: boolean;
  typescript_support: boolean;
  release_cadence_days: number | null;
  weekly_downloads: number;
  vulnerability_ids: string[];
  security_check_failed: boolean;
  raw_fetched_at: string;
  first_seen_at: string;
  recommended_version: string | null;
  version_guidance: string | null;
  score_total: number | null;
  score_security: number | null;
  score_maintenance: number | null;
  score_compatibility: number | null;
  score_community: number | null;
  score_supply_chain: number | null;
  score_reasons: string[];
  score_method: "category-relative" | "absolute" | null;
  score_computed_at: string | null;
}

function rowToPackage(r: any): PackageRow {
  return {
    ...r,
    categories: JSON.parse(r.categories),
    vulnerability_ids: JSON.parse(r.vulnerability_ids),
    score_reasons: JSON.parse(r.score_reasons),
    deprecated: Boolean(r.deprecated),
    esm_support: Boolean(r.esm_support),
    typescript_support: Boolean(r.typescript_support),
    security_check_failed: Boolean(r.security_check_failed),
    has_install_scripts: Boolean(r.has_install_scripts),
  };
}

export function getPackage(name: string): PackageRow | null {
  const row = getDb().prepare("SELECT * FROM packages WHERE name = ?").get(name);
  return row ? rowToPackage(row) : null;
}

export function listByCategory(category: string): PackageRow[] {
  const rows = getDb().prepare("SELECT * FROM packages WHERE categories LIKE ?").all(`%"${category}"%`);
  return rows.map(rowToPackage);
}

export function listAll(): PackageRow[] {
  return getDb().prepare("SELECT * FROM packages").all().map(rowToPackage);
}

export function listStalest(limit: number): PackageRow[] {
  return getDb()
    .prepare("SELECT * FROM packages ORDER BY raw_fetched_at ASC LIMIT ?")
    .all(limit)
    .map(rowToPackage);
}

export function listNameDownloads(): Map<string, number> {
  const rows = getDb().prepare("SELECT name, weekly_downloads FROM packages").all() as Array<{
    name: string;
    weekly_downloads: number;
  }>;
  return new Map(rows.map((r) => [r.name, r.weekly_downloads]));
}

export function listAllCategoryCounts(): Array<{ key: string; count: number }> {
  const rows = getDb().prepare("SELECT categories FROM packages").all() as Array<{ categories: string }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const c of JSON.parse(r.categories) as string[]) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
}

export function countPackages(): number {
  return (getDb().prepare("SELECT COUNT(*) AS c FROM packages").get() as { c: number }).c;
}

export interface RawUpsert {
  name: string;
  categories: string[];
  license: string | null;
  maintainers: number;
  created_at: string | null;
  modified_at: string | null;
  latest_version: string | null;
  dependencies_count: number;
  has_install_scripts: boolean;
  deprecated: boolean;
  esm_support: boolean;
  typescript_support: boolean;
  release_cadence_days: number | null;
  weekly_downloads: number;
  vulnerability_ids: string[];
  security_check_failed: boolean;
  raw_fetched_at: string;
  first_seen_at: string;
}

// first_seen_at is deliberately excluded from the UPDATE clause below — a
// package's "surveillance start date" shouldn't move just because its raw
// data got refreshed.
export function upsertRaw(r: RawUpsert): void {
  getDb()
    .prepare(
      `INSERT INTO packages
        (name, categories, license, maintainers, created_at, modified_at, latest_version,
         dependencies_count, has_install_scripts, deprecated, esm_support, typescript_support, release_cadence_days,
         weekly_downloads, vulnerability_ids, security_check_failed, raw_fetched_at, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         categories=excluded.categories, license=excluded.license, maintainers=excluded.maintainers,
         created_at=excluded.created_at, modified_at=excluded.modified_at, latest_version=excluded.latest_version,
         dependencies_count=excluded.dependencies_count, has_install_scripts=excluded.has_install_scripts,
         deprecated=excluded.deprecated, esm_support=excluded.esm_support, typescript_support=excluded.typescript_support,
         release_cadence_days=excluded.release_cadence_days, weekly_downloads=excluded.weekly_downloads,
         vulnerability_ids=excluded.vulnerability_ids, security_check_failed=excluded.security_check_failed,
         raw_fetched_at=excluded.raw_fetched_at`
    )
    .run(
      r.name,
      JSON.stringify(r.categories),
      r.license,
      r.maintainers,
      r.created_at,
      r.modified_at,
      r.latest_version,
      r.dependencies_count,
      Number(r.has_install_scripts),
      Number(r.deprecated),
      Number(r.esm_support),
      Number(r.typescript_support),
      r.release_cadence_days,
      r.weekly_downloads,
      JSON.stringify(r.vulnerability_ids),
      Number(r.security_check_failed),
      r.raw_fetched_at,
      r.first_seen_at
    );
}

export function upsertVersionGuidance(name: string, recommendedVersion: string, guidance: string): void {
  getDb()
    .prepare(`UPDATE packages SET recommended_version=?, version_guidance=? WHERE name=?`)
    .run(recommendedVersion, guidance, name);
}

export interface ScoreUpsert {
  total: number;
  security: number;
  maintenance: number;
  compatibility: number;
  community: number;
  supplyChain: number;
  reasons: string[];
  method: "category-relative" | "absolute";
}

export function upsertScore(name: string, s: ScoreUpsert): void {
  getDb()
    .prepare(
      `UPDATE packages SET
        score_total=?, score_security=?, score_maintenance=?, score_compatibility=?,
        score_community=?, score_supply_chain=?, score_reasons=?, score_method=?, score_computed_at=?
       WHERE name=?`
    )
    .run(
      s.total,
      s.security,
      s.maintenance,
      s.compatibility,
      s.community,
      s.supplyChain,
      JSON.stringify(s.reasons),
      s.method,
      new Date().toISOString(),
      name
    );
}
