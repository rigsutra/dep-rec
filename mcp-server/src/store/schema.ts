export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS packages (
  name TEXT PRIMARY KEY,
  categories TEXT NOT NULL DEFAULT '[]',
  license TEXT,
  maintainers INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  modified_at TEXT,
  latest_version TEXT,
  dependencies_count INTEGER NOT NULL DEFAULT 0,
  deprecated INTEGER NOT NULL DEFAULT 0,
  esm_support INTEGER NOT NULL DEFAULT 0,
  typescript_support INTEGER NOT NULL DEFAULT 0,
  release_cadence_days REAL,
  weekly_downloads INTEGER NOT NULL DEFAULT 0,
  vulnerability_ids TEXT NOT NULL DEFAULT '[]',
  raw_fetched_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  score_total REAL,
  score_security REAL,
  score_maintenance REAL,
  score_compatibility REAL,
  score_community REAL,
  score_supply_chain REAL,
  score_reasons TEXT NOT NULL DEFAULT '[]',
  score_method TEXT,
  score_computed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_packages_raw_fetched_at ON packages(raw_fetched_at);
`;
