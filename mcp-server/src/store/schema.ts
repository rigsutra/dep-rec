// Single source of truth for the shape of a stored package record.
//
// This used to declare a SQLite table and drive both `CREATE TABLE` and an
// `ALTER TABLE` migration, because a store written by an older release keeps
// its old columns forever and the first INSERT would otherwise die with
// "table packages has no column named has_install_scripts".
//
// The store is now a JSON document (see db.ts for why), which makes that
// entire class of problem disappear: a record missing a field reads back as
// `undefined`, and every field is normalised on read anyway. What remains
// worth declaring is the field list itself — it documents the record shape in
// one place, and `normalizeStored` uses it to drop anything a hand-edited or
// foreign file might have added.

export type FieldType = "string" | "number" | "boolean" | "string[]";

export interface ColumnDef {
  name: string;
  type: FieldType;
  /** Value used when the field is absent. Absent means "null is fine". */
  default?: unknown;
}

export const PACKAGES_COLUMNS: ColumnDef[] = [
  { name: "name", type: "string" },
  { name: "categories", type: "string[]", default: [] },
  { name: "license", type: "string" },
  { name: "maintainers", type: "number", default: 0 },
  { name: "created_at", type: "string" },
  { name: "modified_at", type: "string" },
  { name: "latest_version", type: "string" },
  { name: "dependencies_count", type: "number", default: 0 },
  { name: "has_install_scripts", type: "boolean", default: false },
  { name: "deprecated", type: "boolean", default: false },
  { name: "esm_support", type: "boolean", default: false },
  { name: "typescript_support", type: "boolean", default: false },
  { name: "release_cadence_days", type: "number" },
  { name: "weekly_downloads", type: "number", default: 0 },
  { name: "vulnerability_ids", type: "string[]", default: [] },
  { name: "security_check_failed", type: "boolean", default: false },
  { name: "downloads_check_failed", type: "boolean", default: false },
  { name: "raw_fetched_at", type: "string", default: "" },
  { name: "first_seen_at", type: "string", default: "" },
  { name: "recommended_version", type: "string" },
  { name: "version_guidance", type: "string" },
  // The cooldown decision as structured JSON — which version, on what basis,
  // and the release dates of every candidate that could overtake it. Lets the
  // 30-day window be re-evaluated against today's date on every read instead
  // of being frozen at the moment the row was written. See version-safety.ts;
  // `recommended_version` and `version_guidance` above are the rendering of
  // this as it stood at write time, kept for callers that just want a string.
  { name: "version_decision", type: "string" },
  { name: "score_total", type: "number" },
  { name: "score_security", type: "number" },
  { name: "score_maintenance", type: "number" },
  { name: "score_compatibility", type: "number" },
  { name: "score_community", type: "number" },
  { name: "score_supply_chain", type: "number" },
  { name: "score_reasons", type: "string[]", default: [] },
  { name: "score_method", type: "string" },
  { name: "score_computed_at", type: "string" },
];

const FIELD_NAMES = new Set(PACKAGES_COLUMNS.map((c) => c.name));

/** The on-disk record. Deliberately loose — db.ts validates on read. */
export type StoredRecord = Record<string, unknown> & { name: string };

/**
 * Keeps only declared fields, so a record carrying junk (hand-edited file,
 * a document from some other tool) cannot smuggle extra keys into a response.
 * Values are NOT coerced here: db.ts does that, and it needs to see the
 * original value to decide whether the row is damaged.
 */
export function normalizeStored(raw: Record<string, unknown>): StoredRecord | null {
  if (typeof raw.name !== "string" || raw.name.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (FIELD_NAMES.has(key)) out[key] = raw[key];
  }
  return out as StoredRecord;
}
