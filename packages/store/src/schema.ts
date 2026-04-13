import type Database from 'better-sqlite3';

const CURRENT_VERSION = 4;

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
    derived_artifact_id INTEGER,
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

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS archive_observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    source      TEXT NOT NULL,
    session_id  TEXT,
    content     TEXT NOT NULL,
    metadata    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_archive_observations_kind ON archive_observations(kind);
CREATE INDEX IF NOT EXISTS idx_archive_observations_source ON archive_observations(source);
CREATE INDEX IF NOT EXISTS idx_archive_observations_created_at ON archive_observations(created_at);

CREATE TABLE IF NOT EXISTS derived_artifacts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    observation_id  INTEGER,
    content         TEXT NOT NULL,
    metadata        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (observation_id) REFERENCES archive_observations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_derived_artifacts_kind ON derived_artifacts(kind);
CREATE INDEX IF NOT EXISTS idx_derived_artifacts_observation_id ON derived_artifacts(observation_id);
CREATE INDEX IF NOT EXISTS idx_derived_artifacts_created_at ON derived_artifacts(created_at);

CREATE TABLE IF NOT EXISTS working_set_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT,
    query         TEXT,
    header_text   TEXT NOT NULL,
    header_tokens INTEGER NOT NULL,
    nodes_used    INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_working_set_snapshots_created_at ON working_set_snapshots(created_at);
CREATE INDEX IF NOT EXISTS idx_working_set_snapshots_session_id ON working_set_snapshots(session_id);

CREATE TABLE IF NOT EXISTS working_set_snapshot_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL,
    node_key    TEXT NOT NULL,
    pass_id     TEXT,
    mutation_id INTEGER,
    layer       TEXT NOT NULL,
    category    TEXT NOT NULL,
    value       TEXT NOT NULL,
    score       REAL NOT NULL,
    raw_score   REAL NOT NULL,
    reason      TEXT,
    FOREIGN KEY (snapshot_id) REFERENCES working_set_snapshots(id) ON DELETE CASCADE,
    FOREIGN KEY (pass_id) REFERENCES passes(pass_id) ON DELETE SET NULL,
    FOREIGN KEY (mutation_id) REFERENCES mutations(id) ON DELETE SET NULL,
    CHECK (layer IN ('user', 'agent', 'collaboration'))
);

CREATE INDEX IF NOT EXISTS idx_working_set_snapshot_items_snapshot_id ON working_set_snapshot_items(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_working_set_snapshot_items_pass_id ON working_set_snapshot_items(pass_id);
CREATE INDEX IF NOT EXISTS idx_working_set_snapshot_items_mutation_id ON working_set_snapshot_items(mutation_id);
`;

const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS node_hygiene (
    node_key      TEXT PRIMARY KEY,
    state         TEXT NOT NULL,
    action        TEXT NOT NULL,
    score         REAL NOT NULL,
    rationale     TEXT NOT NULL,
    reason_codes  TEXT,
    details       TEXT,
    source        TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (state IN ('suppressed', 'deprioritized')),
    CHECK (action IN ('exclude', 'deprioritize'))
);

CREATE INDEX IF NOT EXISTS idx_node_hygiene_state ON node_hygiene(state);
CREATE INDEX IF NOT EXISTS idx_node_hygiene_action ON node_hygiene(action);
CREATE INDEX IF NOT EXISTS idx_node_hygiene_score ON node_hygiene(score DESC);

CREATE TABLE IF NOT EXISTS node_hygiene_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    node_key      TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    state         TEXT,
    action        TEXT,
    score         REAL,
    rationale     TEXT,
    reason_codes  TEXT,
    details       TEXT,
    source        TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (event_type IN ('set', 'clear')),
    CHECK (state IS NULL OR state IN ('suppressed', 'deprioritized')),
    CHECK (action IS NULL OR action IN ('exclude', 'deprioritize'))
);

CREATE INDEX IF NOT EXISTS idx_node_hygiene_events_node_key ON node_hygiene_events(node_key);
CREATE INDEX IF NOT EXISTS idx_node_hygiene_events_created_at ON node_hygiene_events(created_at DESC);
`;

function getCurrentVersion(db: Database.Database): number {
  const row = db.prepare(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
  ).get() as { version?: number } | undefined;
  return row?.version ?? 1;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function initSchema(db: Database.Database): void {
  const hasVersionTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();

  if (!hasVersionTable) {
    db.exec(SCHEMA_V1);
    db.prepare(
      'INSERT INTO schema_version (version, description) VALUES (?, ?)'
    ).run(1, 'Initial schema');
    db.exec(SCHEMA_V2);
    db.exec(SCHEMA_V4);
    db.prepare(
      'INSERT INTO schema_version (version, description) VALUES (?, ?)'
    ).run(CURRENT_VERSION, 'Archive observations, derived artifacts, and working set traces with mutation provenance');
    return;
  }

  const currentVersion = getCurrentVersion(db);
  if (currentVersion < 2) {
    if (!columnExists(db, 'passes', 'derived_artifact_id')) {
      db.exec('ALTER TABLE passes ADD COLUMN derived_artifact_id INTEGER');
    }
    db.exec(SCHEMA_V2);
    db.prepare(
      'INSERT INTO schema_version (version, description) VALUES (?, ?)'
    ).run(2, 'Archive observations, derived artifacts, and working set traces');
  }
  if (currentVersion < 3) {
    if (!columnExists(db, 'working_set_snapshot_items', 'mutation_id')) {
      db.exec('ALTER TABLE working_set_snapshot_items ADD COLUMN mutation_id INTEGER REFERENCES mutations(id) ON DELETE SET NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_working_set_snapshot_items_mutation_id ON working_set_snapshot_items(mutation_id)');
    db.prepare(
      'INSERT INTO schema_version (version, description) VALUES (?, ?)'
    ).run(3, 'Store working set mutation provenance');
  }
  if (currentVersion < 4) {
    db.exec(SCHEMA_V4);
    db.prepare(
      'INSERT INTO schema_version (version, description) VALUES (?, ?)'
    ).run(4, 'Add reversible node hygiene state and audit events');
  }
}
