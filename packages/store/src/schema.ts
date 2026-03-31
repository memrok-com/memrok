import type Database from 'better-sqlite3';

const CURRENT_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT
);

CREATE TABLE IF NOT EXISTS mutations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pass_id     TEXT NOT NULL,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    operation   TEXT NOT NULL,
    layer       TEXT NOT NULL,
    category    TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    evidence    TEXT,
    source      TEXT,
    emotional_weight REAL DEFAULT 0.0,
    explicit    BOOLEAN DEFAULT 1,
    correction  BOOLEAN DEFAULT 0,
    CHECK (operation IN ('add', 'update', 'expire')),
    CHECK (layer IN ('user', 'agent', 'collaboration'))
);

CREATE INDEX IF NOT EXISTS idx_mutations_key ON mutations(key);
CREATE INDEX IF NOT EXISTS idx_mutations_pass ON mutations(pass_id);
CREATE INDEX IF NOT EXISTS idx_mutations_layer ON mutations(layer);
CREATE INDEX IF NOT EXISTS idx_mutations_timestamp ON mutations(timestamp);

CREATE TABLE IF NOT EXISTS nodes (
    key         TEXT PRIMARY KEY,
    layer       TEXT NOT NULL,
    category    TEXT NOT NULL,
    value       TEXT NOT NULL,
    evidence    TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    expired_at  TEXT,
    version     INTEGER DEFAULT 1,
    emotional_weight    REAL DEFAULT 0.0,
    reference_count     INTEGER DEFAULT 1,
    correction_count    INTEGER DEFAULT 0,
    last_referenced     TEXT,
    first_pass_id   TEXT NOT NULL,
    last_pass_id    TEXT NOT NULL,
    CHECK (layer IN ('user', 'agent', 'collaboration'))
);

CREATE INDEX IF NOT EXISTS idx_nodes_layer ON nodes(layer);
CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(category);
CREATE INDEX IF NOT EXISTS idx_nodes_active ON nodes(expired_at) WHERE expired_at IS NULL;

CREATE TABLE IF NOT EXISTS embeddings (
    key         TEXT PRIMARY KEY REFERENCES nodes(key),
    vector      BLOB NOT NULL,
    model       TEXT NOT NULL,
    dimensions  INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passes (
    pass_id     TEXT PRIMARY KEY,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    source      TEXT,
    model       TEXT,
    turns_processed INTEGER,
    mutations_count INTEGER,
    observations TEXT,
    duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS weight_adjustments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    signal      TEXT NOT NULL,
    old_weight  REAL NOT NULL,
    new_weight  REAL NOT NULL,
    reason      TEXT,
    pass_id     TEXT,
    acknowledged BOOLEAN DEFAULT 0
);

CREATE TABLE IF NOT EXISTS config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initSchema(db: Database.Database): void {
  const hasVersionTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();

  if (!hasVersionTable) {
    db.exec(SCHEMA_V1);
    db.prepare(
      'INSERT INTO schema_version (version, description) VALUES (?, ?)'
    ).run(CURRENT_VERSION, 'Initial schema');
  }
}
