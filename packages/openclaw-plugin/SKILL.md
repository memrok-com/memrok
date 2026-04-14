---
name: memrok
description: Memory with judgment. Persistent, structured, intelligent memory layer for OpenClaw AI agents.
---

# Memrok

Persistent memory layer for OpenClaw AI agents. Watches conversation transcripts, extracts knowledge into a three-layer graph (user model, agent model, collaboration patterns), and injects relevant context into every session turn.

## Install

```bash
openclaw plugins install clawhub:memrok
```

Memrok configuration lives under `plugins.entries.memrok.config`. After install, restart the OpenClaw gateway so the running process picks up the plugin.

## Configuration

All options are optional. Memrok uses OpenClaw's configured provider/model by default and stores its local state under the active OpenClaw state directory, typically `~/.openclaw/plugins/memrok/`.

| Option | Description | Default |
|--------|-------------|---------|
| `scribeProvider` | Override provider for knowledge extraction | OpenClaw default |
| `scribeModel` | Override model for scribe passes | OpenClaw default |
| `watchPaths` | Directories to watch for transcript changes | auto-detected session dirs |
| `bootstrap.enabled` | Scan `MEMORY.md` and `memory/` at startup | `false` |
| `bootstrap.scanConfiguredAgents` | Include all configured OpenClaw agents in bootstrap scans | `true` |
| `bootstrap.memoryDirs` | Additional memory directories to scan | auto-discovered agent memory dirs |
| `bootstrap.memoryIndexes` | Additional `MEMORY.md` files to scan | auto-discovered agent `MEMORY.md` files |
| `tokenBudget` | Max tokens for injected context header | `1000` |
| `deltaThreshold` | Message count before triggering scribe | `20` |
| `idleMinutes` | Quiet time required before scribe runs | `15` |

## Commands

- `/memrok status` shows current Memrok paths, targets, and recent activity
- `/memrok scan-memory` scans configured Markdown memory sources now
- `/memrok scan-memory force` rescans already-bootstrapped Markdown memory sources
- `/memrok flush-sessions` runs transcript scribing immediately for pending watcher chunks
- `/memrok index-sessions` indexes unread watched session JSONL deltas from disk
- `/memrok index-sessions full` replays full watched session JSONL files from disk

## What It Does

1. **Watches** OpenClaw session transcript files for changes
2. **Discovers** configured OpenClaw agent workspaces for bootstrap scans when enabled
3. **Extracts** knowledge via scribe passes (entities, relationships, preferences, patterns)
4. **Stores** in a local SQLite knowledge graph under the OpenClaw state dir
5. **Injects** relevant context as a header into every agent session turn

## Requirements

- OpenClaw v0.30+
- A configured LLM provider for scribe unless you override Memrok with explicit provider/model values

## Links

- [GitHub](https://github.com/memrok-com/memrok)
- [Architecture](https://github.com/memrok-com/memrok/blob/main/docs/architecture.md)
