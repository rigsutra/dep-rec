// Persistent store: raw registry/downloads/OSV data AND the computed
// scores, both kept on disk — not refetched on every request. Using
// node:sqlite (built into Node 22+, experimental but no native dependency
// to compile) rather than a static JSON file, since the whole point of
// this layer is "check once, serve everyone else from what's stored, and
// refresh it in the background" — a real query-able store, not a snapshot.

import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL, migratePackagesTable } from "./schema.js";

// `node:sqlite` is loaded on first use rather than imported at the top of
// this file, and the import above is type-only so it disappears at compile
// time. The reason is ordering: ES modules link the entire graph before
// evaluating any of it, so a static `import ... from "node:sqlite"` fires
// Node's "SQLite is an experimental feature" warning before a single line of
// our code — including the filter in quiet-sqlite-warning.ts — has run.
// Deferring the load until getDb() puts it after that filter is installed.
type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSync };
let sqlite: SqliteModule | null = null;
function loadSqlite(): SqliteModule {
  if (!sqlite) sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  return sqlite;
}

// Overridable so tests (and anyone wanting a separate store per project)
// don't mutate the store.db that ships inside the package.
//
// Resolved on first use rather than at module load. Reading it at load time
// meant an importer could not point the store somewhere else after the fact
// — which quietly bit the test suite: a test that imported checkPackage
// directly opened the SHIPPED database no matter what it set afterwards, and
// merely opening a SQLite file in WAL mode rewrites its header.
function resolveDbPath(): string {
  return process.env.DREC_DB_PATH ?? fileURLToPath(new URL("../../data/store.db", import.meta.url));
}

// How long a statement waits for another process to release the write lock
// before giving up with SQLITE_BUSY. Without this, SQLite fails instantly:
// two `drec check` processes started at the same time, or an MCP client
// firing concurrent tool calls, would have one of them die with "database
// is locked" — a real, reproducible race, not a theoretical one. WAL lets
// readers run concurrently with a writer, but writers still serialise, so
// something has to be willing to wait.
const BUSY_TIMEOUT_MS = Number(process.env.DREC_BUSY_TIMEOUT_MS ?? 10_000);

let dbInstance: DatabaseSync | null = null;
function getDb(): DatabaseSync {
  if (!dbInstance) {
    const db = new (loadSqlite().DatabaseSync)(resolveDbPath());
    // Set before anything else: switching journal mode itself takes a lock,
    // so a busy_timeout applied afterwards would be too late to protect the
    // one statement most likely to collide on a cold concurrent start.
    db.exec(`PRAGMA busy_timeout = ${Number.isFinite(BUSY_TIMEOUT_MS) ? Math.max(0, BUSY_TIMEOUT_MS) : 10_000};`);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA_SQL);
    migratePackagesTable(db);
    dbInstance = db;
  }
  return dbInstance;
}

// Groups a batch of writes into one transaction. Rescoring a category
// rewrites every peer row; as individual statements that is N separate
// write locks and N fsyncs, giving a concurrent process N chances to
// collide. One transaction holds the lock once, briefly.
export function withTransaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A rollback failure must not mask the original error.
    }
    throw err;
  }
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
  downloads_check_failed: boolean;
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
  /** Derived at read time, not a column: the stored record failed to parse cleanly. */
  store_row_damaged: boolean;
}

// SQLite is dynamically typed: a column declared INTEGER will happily hold
// the string "NaN" if something upstream ever writes one. A non-numeric value
// reaching a comparison silently evaluates false, which is how a corrupt
// download count sails through an adoption floor it should fail.
function finiteOr<T extends number | null>(value: unknown, fallback: T): number | T {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parses a JSON string-array column, returning `null` when the stored value
 * is unreadable. Every read of a JSON column goes through this: a single
 * unparseable one used to throw straight out of the row mapper, taking down
 * `categories` and every `recommend` call with a bare
 * "Expected property name or '}'" and exit 1. One damaged row made the whole
 * tool unusable, and the message did not even say which row.
 */
function parseStringArray(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return v.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

// Bounds on what a single stored row may contribute to a response. Real
// scoring emits about six reasons of well under 200 characters, so these
// never fire in normal operation — they exist because a corrupt row can, and
// a `recommend` call that returns 216 KB of text does not fail loudly, it
// just quietly consumes a model's entire context window.
const MAX_REASONS_PER_ROW = 24;
const MAX_REASON_CHARS = 400;
// npm's own hard limit. A stored name longer than this cannot correspond to
// a real package, whatever else the row says.
const MAX_NAME_CHARS = 214;

function rowToPackage(r: any): PackageRow {
  // A damaged row is readable, disclosed, and never recommendable.
  let damaged = false;
  const parseArray = (raw: unknown): string[] => {
    const parsed = parseStringArray(raw);
    if (parsed === null) {
      damaged = true;
      return [];
    }
    return parsed;
  };

  const categories = parseArray(r.categories);
  const vulnBefore = damaged;
  const vulnerability_ids = parseArray(r.vulnerability_ids);
  // An unreadable vulnerability list must not become an empty one: "[]" reads
  // as "no known vulnerabilities", which is the fail-open answer this project
  // exists to avoid. Fold it into the same flag a failed OSV lookup sets.
  const vulnUnreadable = damaged && !vulnBefore;
  const allReasons = parseArray(r.score_reasons);
  if (allReasons.length > MAX_REASONS_PER_ROW) damaged = true;
  const score_reasons = allReasons
    .slice(0, MAX_REASONS_PER_ROW)
    .map((s) => (s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS)}…` : s));

  if (typeof r.name === "string" && r.name.length > MAX_NAME_CHARS) damaged = true;

  // A stored score outside 0-100 is not a score. Left as-is it would sort to
  // the top of every ranking and be reported to a model as fact — a poisoned
  // row with score_total 999999 was ranked #1 before this.
  // Counts cannot be negative. Absurdly *large* ones are left alone — there
  // is no principled line between "very popular" and "impossible" — but a
  // negative dependency count is not a number the world can produce.
  const maintainers = finiteOr(r.maintainers, 0);
  const dependencies_count = finiteOr(r.dependencies_count, 0);
  const weekly_downloads = finiteOr(r.weekly_downloads, 0);
  if (maintainers < 0 || dependencies_count < 0 || weekly_downloads < 0) damaged = true;

  const storedScore = finiteOr(r.score_total, null);
  const scoreInRange = storedScore !== null && storedScore >= 0 && storedScore <= 100;
  if (storedScore !== null && !scoreInRange) damaged = true;

  return {
    ...r,
    categories,
    vulnerability_ids,
    score_reasons,
    maintainers,
    dependencies_count,
    weekly_downloads,
    release_cadence_days: finiteOr(r.release_cadence_days, null),
    score_total: scoreInRange ? storedScore : null,
    deprecated: Boolean(r.deprecated),
    esm_support: Boolean(r.esm_support),
    typescript_support: Boolean(r.typescript_support),
    security_check_failed: Boolean(r.security_check_failed) || vulnUnreadable,
    downloads_check_failed: Boolean(r.downloads_check_failed),
    has_install_scripts: Boolean(r.has_install_scripts),
    store_row_damaged: damaged,
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
    // A row whose category list is corrupt is skipped rather than allowed to
    // abort the whole listing.
    for (const c of parseStringArray(r.categories) ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
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
  downloads_check_failed: boolean;
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
         weekly_downloads, vulnerability_ids, security_check_failed, downloads_check_failed, raw_fetched_at, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         categories=excluded.categories, license=excluded.license, maintainers=excluded.maintainers,
         created_at=excluded.created_at, modified_at=excluded.modified_at, latest_version=excluded.latest_version,
         dependencies_count=excluded.dependencies_count, has_install_scripts=excluded.has_install_scripts,
         deprecated=excluded.deprecated, esm_support=excluded.esm_support, typescript_support=excluded.typescript_support,
         release_cadence_days=excluded.release_cadence_days, weekly_downloads=excluded.weekly_downloads,
         vulnerability_ids=excluded.vulnerability_ids, security_check_failed=excluded.security_check_failed,
         downloads_check_failed=excluded.downloads_check_failed,
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
      Number(r.downloads_check_failed),
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
