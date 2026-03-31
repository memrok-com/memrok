# Task: Implement Memrok OpenClaw Plugin

## What This Is

A thin adapter that connects the Memrok daemon to OpenClaw's context engine API. It's the bridge — calls the daemon's HTTP API and injects the context header into every LLM run.

This is "Option C" from the architecture: lightweight context engine wrapper that delegates all history/compaction to the legacy engine, only adding Memrok's `systemPromptAddition`.

## How OpenClaw Plugins Work

OpenClaw context engine plugins register via:

```typescript
export default function register(api) {
  api.registerContextEngine("memrok", () => ({
    info: {
      id: "memrok",
      name: "Memrok Memory Layer",
      ownsCompaction: false,  // delegate to legacy
    },
    
    async assemble({ sessionId, messages, tokenBudget }) {
      // Return messages unchanged + add systemPromptAddition
      return {
        messages,
        estimatedTokens: countTokens(messages),
        systemPromptAddition: "... memrok context header ...",
      }
    },
    
    async compact({ sessionId, force }) {
      // Delegate to runtime
      return delegateCompactionToRuntime(...)
    },
    
    async ingest({ sessionId, message }) {
      // Notify daemon of new data
      return { ingested: true }
    },
    
    async afterTurn({ sessionId }) {
      // Notify daemon of completed turn
    },
  }))
}
```

## Deliverables

### 1. Plugin Registration

Register as a context engine with `ownsCompaction: false` — let OpenClaw handle all history management, compaction, and session lifecycle. Memrok only adds the context header.

### 2. assemble()

On every LLM call:
1. Call daemon HTTP API `POST /header` with recent message context
2. Receive the context header
3. Return the original messages unchanged + `systemPromptAddition` from Memrok
4. **Latency budget**: if daemon doesn't respond within configured timeout (default 50ms), use cached header or return empty string. Never block inference.
5. Cache the last successful header locally

### 3. afterTurn()

After each completed turn:
1. Call daemon HTTP API `POST /notify` to signal new transcript data available
2. Fire-and-forget — don't wait for response, don't fail the turn

### 4. ingest()

When a new message is added:
1. No-op for Phase 1 — the daemon watches JSONL files directly
2. Return `{ ingested: true }`

### 5. compact()

Delegate to OpenClaw's built-in compaction:
1. Import `delegateCompactionToRuntime` from `openclaw/plugin-sdk/core`
2. Call it and return the result

### 6. Configuration

Plugin config in `openclaw.json`:

```json5
{
  plugins: {
    slots: {
      contextEngine: "memrok"
    },
    entries: {
      "memrok": {
        enabled: true,
        config: {
          daemonUrl: "http://127.0.0.1:18790",
          timeoutMs: 50,
          retryMs: 200,
          maxRetries: 1
        }
      }
    }
  }
}
```

### 7. Graceful Degradation

This is critical — the plugin must NEVER break OpenClaw:

- Daemon unreachable → return empty `systemPromptAddition`
- Daemon slow (> timeoutMs) → return cached header
- Daemon returns error → return empty, log warning
- No cache available → return empty
- Plugin should work even if Memrok daemon is completely stopped

## Implementation Notes

Since we can't actually install this as an OpenClaw plugin in our dev environment, implement it as a standalone module with the correct interface. Structure it so it could be registered as a plugin.

Create:
- `src/plugin.ts` — the plugin registration function and context engine implementation
- `src/client.ts` — HTTP client for talking to the daemon API (with timeout, retry, caching)
- `src/types.ts` — configuration and interface types
- `src/index.ts` — exports

### Tests

Test:
- Client: successful header fetch, timeout handling, retry logic, cache behavior
- Plugin: assemble returns messages + header, afterTurn fires notify, graceful degradation
- Use a mock HTTP server (node:http) to simulate daemon responses

## Constraints

- TypeScript, ESM
- No external dependencies (use native fetch and node:http)
- **Must never throw during assemble() — graceful degradation only**
- **Must never block inference beyond timeoutMs**
- Log warnings for daemon connectivity issues, not errors

## Project Context

- Daemon API spec: `~/memrok/packages/daemon/TASK.md` (HTTP API section)
- Architecture doc: `~/memrok/docs/architecture.md` (OpenClaw Integration section)
- OpenClaw context engine docs: `~/.npm-global/lib/node_modules/openclaw/docs/concepts/context-engine.md`
