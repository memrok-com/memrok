# Memrok Graph Schema

*Draft · March 2026*

## Design Constraints

- SQLite, single file, no external dependencies
- Append-only mutation log (the source of truth)
- Materialized graph view (derived from the log, rebuildable)
- Vector embeddings on node values for semantic retrieval
- Must support the scribe's output format directly (minimal transformation)

---

## Tables

### `mutations` (append-only log)

The immutable history. Every scribe pass appends mutations here. The graph is always reconstructable from this log.

```sql
CREATE TABLE mutations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pass_id     TEXT NOT NULL,           -- scribe pass identifier
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    operation   TEXT NOT NULL,           -- 'add', 'update', 'expire'
    layer       TEXT NOT NULL,           -- 'user', 'agent', 'collaboration'
    category    TEXT NOT NULL,           -- 'fact', 'preference', 'pattern', etc.
    key         TEXT NOT NULL,           -- stable dot-notated identifier
    value       TEXT NOT NULL,           -- human-readable knowledge
    evidence    TEXT,                    -- supporting quote from transcript
    source      TEXT,                    -- transcript/observation identifier
    emotional_weight REAL DEFAULT 0.0,  -- 0.0–1.0
    explicit    BOOLEAN DEFAULT 1,      -- stated vs inferred
    correction  BOOLEAN DEFAULT 0,      -- correcting prior belief/behavior
    
    CHECK (operation IN ('add', 'update', 'expire')),
    CHECK (layer IN ('user', 'agent', 'collaboration'))
);

CREATE INDEX idx_mutations_key ON mutations(key);
CREATE INDEX idx_mutations_pass ON mutations(pass_id);
CREATE INDEX idx_mutations_layer ON mutations(layer);
CREATE INDEX idx_mutations_timestamp ON mutations(timestamp);
```

### `nodes` (materialized graph view)

Current state of all knowledge nodes. Rebuilt from mutations. This is the read-optimized view that the injector queries.

```sql
CREATE TABLE nodes (
    key         TEXT PRIMARY KEY,        -- stable dot-notated identifier
    layer       TEXT NOT NULL,
    category    TEXT NOT NULL,
    value       TEXT NOT NULL,           -- latest value
    evidence    TEXT,                    -- latest evidence
    created_at  TEXT NOT NULL,           -- first seen
    updated_at  TEXT NOT NULL,           -- last mutation
    expired_at  TEXT,                    -- NULL if active, timestamp if expired
    version     INTEGER DEFAULT 1,       -- mutation count for this key
    
    -- Relevance signals (updated from mutations + feedback)
    emotional_weight    REAL DEFAULT 0.0,
    reference_count     INTEGER DEFAULT 1,
    correction_count    INTEGER DEFAULT 0,
    last_referenced     TEXT,            -- last time this appeared in a scribe pass
    
    -- Source tracking
    first_pass_id   TEXT NOT NULL,
    last_pass_id    TEXT NOT NULL,
    
    CHECK (layer IN ('user', 'agent', 'collaboration'))
);

CREATE INDEX idx_nodes_layer ON nodes(layer);
CREATE INDEX idx_nodes_category ON nodes(category);
CREATE INDEX idx_nodes_active ON nodes(expired_at) WHERE expired_at IS NULL;
```

### `embeddings` (vector index)

Vector embeddings on node values for semantic retrieval by the injector.

```sql
CREATE TABLE embeddings (
    key         TEXT PRIMARY KEY REFERENCES nodes(key),
    vector      BLOB NOT NULL,          -- serialized float array
    model       TEXT NOT NULL,           -- embedding model used
    dimensions  INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);
```

*Note: If sqlite-vec is available, this becomes a virtual table for accelerated search. Fallback is in-process cosine similarity.*

### `passes` (scribe pass metadata)

Track what the scribe has processed and when.

```sql
CREATE TABLE passes (
    pass_id     TEXT PRIMARY KEY,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    source      TEXT,                    -- transcript/observation identifier
    model       TEXT,                    -- which model ran this pass
    turns_processed INTEGER,
    mutations_count INTEGER,
    observations TEXT,                   -- scribe's meta.observations
    duration_ms INTEGER                  -- how long the pass took
);
```

### `weight_adjustments` (self-tuning audit trail)

Track relevance weight drift from the feedback loop.

```sql
CREATE TABLE weight_adjustments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    signal      TEXT NOT NULL,           -- which signal changed
    old_weight  REAL NOT NULL,
    new_weight  REAL NOT NULL,
    reason      TEXT,                    -- what pattern triggered the adjustment
    pass_id     TEXT,                    -- which scribe pass detected this
    acknowledged BOOLEAN DEFAULT 0       -- user saw/approved this change
);
```

### `config` (runtime configuration)

Relevance weights and operational settings.

```sql
CREATE TABLE config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Default relevance weights (inserted on init)
-- recency_weight, frequency_weight, emotional_weight, 
-- correction_weight, semantic_weight, stability_weight
```

---

## Operations

### Applying a scribe pass

When a scribe pass completes:

1. Insert a row in `passes`
2. For each mutation:
   - Insert into `mutations` (always — this is the log)
   - Update `nodes`:
     - `add`: INSERT new node
     - `update`: UPDATE existing node (value, evidence, signals, version++, updated_at)
     - `expire`: SET expired_at on existing node
   - Update `reference_count`, `correction_count` on affected nodes
3. Invalidate embeddings for updated/new nodes (re-embed on next query or async)

### Querying for context injection

The injector runs this on every `assemble()` call:

1. Select active nodes (`expired_at IS NULL`)
2. Filter by semantic proximity to current conversation (vector similarity on embeddings)
3. Compute composite relevance score per node:
   ```
   score = w_recency * recency(updated_at)
         + w_frequency * normalize(reference_count)
         + w_emotional * emotional_weight
         + w_correction * normalize(correction_count)
         + w_semantic * semantic_similarity
         + w_stability * stability(version, age)
   ```
4. Rank by score, take top N within token budget
5. Group by layer, format as context header

### Rebuilding nodes from mutations

If `nodes` gets corrupted or schema changes:

```sql
-- Clear and rebuild
DELETE FROM nodes;

INSERT INTO nodes (key, layer, category, value, evidence, 
                   created_at, updated_at, version, ...)
SELECT ... FROM mutations
GROUP BY key
-- Apply mutations in timestamp order, last write wins
-- Expired keys get expired_at set
```

---

## Edges (future)

The current schema is node-centric. Relationships between nodes (e.g., "this preference was learned from that correction") are implicit via shared pass_id and key references.

When we need explicit edges (for the collaboration model especially):

```sql
CREATE TABLE edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key  TEXT NOT NULL REFERENCES nodes(key),
    target_key  TEXT NOT NULL REFERENCES nodes(key),
    relation    TEXT NOT NULL,           -- 'caused_by', 'contradicts', 'supports', etc.
    weight      REAL DEFAULT 1.0,
    created_at  TEXT NOT NULL,
    pass_id     TEXT NOT NULL
);
```

Not in MVP scope. The scribe doesn't currently output edge data — the node model is sufficient for Phase 1.

---

## Migration Path

Schema versioning via a simple `schema_version` table:

```sql
CREATE TABLE schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT
);
```

---

*This schema is designed to be implemented directly in the `packages/store` package.*
