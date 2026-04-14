# Task: Implement Memrok Store Package

## What This Is

The graph storage layer for Memrok — a memory system for AI agents. This package manages a SQLite database that stores structured knowledge extracted from conversations.

## Input

The store receives scribe pass output — JSON objects with this structure:

```json
{
  "pass_id": "scribe-pass-2026-03-31-001",
  "source": "transcript-abc.jsonl",
  "mutations": [
    {
      "operation": "add",
      "layer": "user",
      "category": "preference",
      "key": "user.content.voice",
      "value": "Prefers blunt, punchy tone over polished/elegant.",
      "evidence": "\"I'd go with blunt. Dial it up a notch.\"",
      "signals": {
        "emotional_weight": 0.7,
        "explicit": true,
        "correction": true
      }
    }
  ],
  "meta": {
    "turns_processed": 20,
    "observations": "Notable corrections on content tone."
  }
}
```

## Deliverables

Implement the store as a TypeScript package with these capabilities:

### 1. Database Setup
- SQLite via Node's built-in `node:sqlite`
- Schema from `~/memrok/docs/graph-schema.md` — implement all tables: `mutations`, `nodes`, `passes`, `embeddings`, `weight_adjustments`, `config`, `schema_version`
- Auto-create on first use, migration support via schema_version

### 2. Core API

```typescript
// Initialize / open store
createStore(dbPath: string): Store

interface Store {
  // Apply a complete scribe pass (insert mutations, upsert nodes, record pass)
  applyPass(pass: ScribePass): ApplyResult
  
  // Query active nodes with optional filters
  queryNodes(filter?: NodeFilter): Node[]
  
  // Get a single node by key
  getNode(key: string): Node | null
  
  // Get mutation history for a node
  getHistory(key: string): Mutation[]
  
  // Get all passes
  listPasses(): Pass[]
  
  // Rebuild nodes table from mutation log
  rebuild(): void
  
  // Close database
  close(): void
}
```

### 3. Types

Define TypeScript types matching the schema: `ScribePass`, `Mutation`, `Node`, `Pass`, `NodeFilter`, `ApplyResult`.

`NodeFilter` should support: `layer`, `category`, `active` (default true), `key` prefix matching.

### 4. Tests

Write tests using the built-in Node.js test runner (`node:test`). Test:
- Creating a store and verifying schema
- Applying a scribe pass and reading back nodes
- Update and expire operations
- Node history (multiple mutations for same key)
- Rebuild from mutation log
- Filtering by layer, category, active/expired

Use an in-memory SQLite database (`:memory:`) for tests.

## Constraints

- TypeScript, ESM modules (`"type": "module"` in package.json)
- No additional runtime dependency for SQLite; use Node's built-in `node:sqlite`
- No ORM — raw SQL is fine and preferred for this
- Keep it simple — this is a storage layer, not a framework
- All timestamps in ISO 8601 UTC

## Project Context

- Schema doc: `~/memrok/docs/graph-schema.md`
- Architecture doc: `~/memrok/docs/architecture.md`
- Example scribe outputs (local only, not in repo): `~/memrok/packages/scribe/src/test-output-haiku-v2.json`
- This is package `@memrok/store` in a monorepo at `~/memrok/`
