# Task: Implement Memrok Daemon Package

## What This Is

`memrokd` — the orchestrator. Watches for new conversation data, triggers scribe passes when conditions are met, and exposes an API for the OpenClaw plugin.

## Dependencies

- `@memrok/store` — graph storage
- `@memrok/injector` — context header assembly
- `chokidar` — file watching (for JSONL transcript monitoring)

## Deliverables

### 1. Transcript Watcher

Watches OpenClaw session JSONL files for changes.

```typescript
interface WatcherConfig {
  paths: string[]              // directories to watch for .jsonl files
  debounceMs?: number          // debounce file changes (default 5000)
}
```

- Uses `chokidar` to watch directories
- Tracks per-file position (byte offset) to only read new content
- Emits events when new transcript data is available
- Maintains a cursor file (`.memrok-cursors.json`) to survive daemon restarts

### 2. Consolidation Engine

Triggers scribe passes based on configurable thresholds.

```typescript
interface ConsolidationConfig {
  deltaThreshold?: number      // min new messages before triggering (default 20)
  idleMinutes?: number         // min idle time before triggering (default 15)
  maxInterval?: number         // max minutes between passes regardless (default 120)
}
```

**Trigger logic:**
- Track accumulated new messages since last scribe pass
- When `deltaThreshold` is met AND no new messages for `idleMinutes`, trigger
- Also trigger if `maxInterval` elapsed since last pass regardless of delta
- Expose `forceTrigger()` for explicit consolidation

### 3. Scribe Interface

Calls the scribe model to process accumulated observations.

```typescript
interface ScribeConfig {
  provider: 'anthropic' | 'openai' | 'ollama' | 'custom'
  model: string                // e.g., 'claude-haiku-3.5-20241022'
  apiKey?: string              // for cloud providers
  baseUrl?: string             // for ollama or custom endpoints
  systemPromptPath?: string    // path to scribe system prompt (default: bundled)
}
```

- Reads new transcript chunks since last pass
- Calls the configured model with the scribe system prompt + transcript
- Parses the JSON response into a `ScribePass`
- Applies the pass to the store via `store.applyPass()`
- Invalidates the injector cache

**For Phase 1:** Support Anthropic Messages API and OpenAI-compatible API (covers Ollama and custom endpoints). Use `fetch()` directly — no SDK dependencies.

### 4. HTTP API

Local HTTP server for the OpenClaw plugin to communicate with.

```typescript
interface DaemonConfig {
  port?: number                // default 18790
  host?: string                // default '127.0.0.1' (loopback only!)
}
```

**Endpoints:**

- `GET /health` — daemon status + last pass info
- `GET /header` — get current context header (calls injector.assemble())
- `POST /header` — get context header with conversation hints in body
- `POST /notify` — notify daemon of new transcript data (from afterTurn hook)
- `POST /trigger` — force a scribe pass
- `GET /nodes` — query nodes (query params: layer, category, active)
- `GET /nodes/:key` — get single node
- `GET /weights` — current relevance weights
- `PUT /weights/:signal` — update a weight

### 5. Daemon Lifecycle

```typescript
interface MemrokDaemon {
  start(): Promise<void>       // start watcher + API server
  stop(): Promise<void>        // graceful shutdown
  getStatus(): DaemonStatus
}

function createDaemon(config: DaemonConfig): MemrokDaemon
```

- Loads config from `memrok.config.json` (or passed in)
- Opens/creates SQLite store at configured path
- Starts file watcher
- Starts HTTP API server
- Runs consolidation loop
- Graceful shutdown: stop watcher, flush pending, close store, stop server

### 6. Configuration

Default config file: `memrok.config.json`

```json
{
  "store": {
    "path": "~/.memrok/memrok.sqlite"
  },
  "watcher": {
    "paths": ["~/.openclaw/agents/main/sessions"],
    "debounceMs": 5000
  },
  "consolidation": {
    "deltaThreshold": 20,
    "idleMinutes": 15,
    "maxInterval": 120
  },
  "scribe": {
    "provider": "anthropic",
    "model": "claude-haiku-3.5-20241022",
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "injector": {
    "tokenBudget": 1000
  },
  "api": {
    "port": 18790,
    "host": "127.0.0.1"
  }
}
```

Environment variable substitution: `${VAR}` in config values are resolved from env.

### 7. Tests

Using `node:test`. Test:
- Consolidation trigger logic (delta threshold, idle detection, max interval, force)
- Scribe interface (mock HTTP responses, verify pass parsing and store application)
- HTTP API endpoints (use undici or built-in fetch against running server)
- Config loading and env substitution
- Cursor file persistence (tracks what's been processed)

For watcher tests: use temp directories with test JSONL files, not real transcripts.

## Constraints

- TypeScript, ESM
- Minimal dependencies: `chokidar` for file watching, native `node:http` for API server, native `fetch()` for model calls
- **Security: API server MUST bind to loopback only (127.0.0.1) by default**
- **Security: API key in config MUST support env var substitution, never hardcoded**
- **Security: Do not log transcript content or node values at info level**
- All timestamps in ISO 8601 UTC

## Project Context

- Store: `~/memrok/packages/store/`
- Injector: `~/memrok/packages/injector/`
- Scribe system prompt: `~/memrok/packages/scribe/src/system-prompt.md`
- Architecture doc: `~/memrok/docs/architecture.md`
