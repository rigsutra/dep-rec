// Single source of truth for the `packages` table shape.
//
// Declared as data rather than a literal CREATE TABLE string so the same
// list can drive BOTH initial creation and migration of an existing
// database. The original version only ran `CREATE TABLE IF NOT EXISTS`,
// which meant a store created by an older release kept its old columns
// forever: `IF NOT EXISTS` sees the table, does nothing, and the first
// INSERT then dies with "table packages has no column named
// has_install_scripts" — an unhandled crash, exit code 1. That is a real
// scenario, not a hypothetical: DEP_REC_DB_PATH exists precisely so people
// can keep a store outside node_modules, and such a store survives the
// version bump that node_modules doesn't.

export interface ColumnDef {
  name: string;
  type: "TEXT" | "INTEGER" | "REAL";
  notNull?: boolean;
  /** SQL literal. Required for a NOT NULL column to be addable to an existing table. */
  default?: string;
  primaryKey?: boolean;
}

export const PACKAGES_COLUMNS: ColumnDef[] = [
  { name: "name", type: "TEXT", primaryKey: true },
  { name: "categories", type: "TEXT", notNull: true, default: "'[]'" },
  { name: "license", type: "TEXT" },
  { name: "maintainers", type: "INTEGER", notNull: true, default: "0" },
  { name: "created_at", type: "TEXT" },
  { name: "modified_at", type: "TEXT" },
  { name: "latest_version", type: "TEXT" },
  { name: "dependencies_count", type: "INTEGER", notNull: true, default: "0" },
  { name: "has_install_scripts", type: "INTEGER", notNull: true, default: "0" },
  { name: "deprecated", type: "INTEGER", notNull: true, default: "0" },
  { name: "esm_support", type: "INTEGER", notNull: true, default: "0" },
  { name: "typescript_support", type: "INTEGER", notNull: true, default: "0" },
  { name: "release_cadence_days", type: "REAL" },
  { name: "weekly_downloads", type: "INTEGER", notNull: true, default: "0" },
  { name: "vulnerability_ids", type: "TEXT", notNull: true, default: "'[]'" },
  { name: "security_check_failed", type: "INTEGER", notNull: true, default: "0" },
  { name: "downloads_check_failed", type: "INTEGER", notNull: true, default: "0" },
  { name: "raw_fetched_at", type: "TEXT", notNull: true },
  { name: "first_seen_at", type: "TEXT", notNull: true },
  { name: "recommended_version", type: "TEXT" },
  { name: "version_guidance", type: "TEXT" },
  { name: "score_total", type: "REAL" },
  { name: "score_security", type: "REAL" },
  { name: "score_maintenance", type: "REAL" },
  { name: "score_compatibility", type: "REAL" },
  { name: "score_community", type: "REAL" },
  { name: "score_supply_chain", type: "REAL" },
  { name: "score_reasons", type: "TEXT", notNull: true, default: "'[]'" },
  { name: "score_method", type: "TEXT" },
  { name: "score_computed_at", type: "TEXT" },
];

function createClause(c: ColumnDef): string {
  const parts = [c.name, c.type];
  if (c.primaryKey) parts.push("PRIMARY KEY");
  if (c.notNull) parts.push("NOT NULL");
  if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
  return parts.join(" ");
}

// SQLite refuses `ALTER TABLE ... ADD COLUMN` for a NOT NULL column with no
// default — there would be no value to backfill existing rows with. Such a
// column is added nullable instead; in practice this only affects columns
// that predate every shipped release, so it never fires, but silently
// generating invalid SQL would be worse than a slightly weaker constraint.
function addClause(c: ColumnDef): string {
  const parts = [c.name, c.type];
  if (c.notNull && c.default !== undefined) parts.push("NOT NULL");
  if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
  return parts.join(" ");
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS packages (
  ${PACKAGES_COLUMNS.map(createClause).join(",\n  ")}
);
CREATE INDEX IF NOT EXISTS idx_packages_raw_fetched_at ON packages(raw_fetched_at);
`;

export interface MigrationLike {
  prepare(sql: string): { all(): unknown[] };
  exec(sql: string): void;
}

/**
 * Brings an existing `packages` table up to the current column set.
 * Returns the columns that were added, so callers can report a migration
 * rather than have it happen invisibly. Additive only: a column that is no
 * longer in PACKAGES_COLUMNS is left alone rather than dropped, since
 * dropping data on open is not a thing a read path should ever do.
 */
export function migratePackagesTable(db: MigrationLike): string[] {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(packages)").all() as Array<{ name: string }>).map((r) => r.name)
  );
  if (existing.size === 0) return []; // table didn't exist; SCHEMA_SQL just created it correctly

  const added: string[] = [];
  for (const col of PACKAGES_COLUMNS) {
    if (existing.has(col.name)) continue;
    db.exec(`ALTER TABLE packages ADD COLUMN ${addClause(col)}`);
    added.push(col.name);
  }
  return added;
}
