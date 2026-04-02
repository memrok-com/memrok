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

## Configuration

All options are optional — defaults work without tuning.

| Option | Description | Default |
|--------|-------------|---------|
| `scribeProvider` | LLM provider for knowledge extraction | `anthropic` |
| `scribeModel` | Model for scribe passes | `claude-sonnet-4-6` |
| `watchPaths` | Directories to watch for transcript changes | auto-detected session dirs |
| `tokenBudget` | Max tokens for injected context header | `1000` |
| `deltaThreshold` | Message count before triggering scribe | `20` |
| `idleMinutes` | Quiet time required before scribe runs | `15` |

## What It Does

1. **Watches** OpenClaw session transcript files for changes
2. **Extracts** knowledge via scribe passes (entities, relationships, preferences, patterns)
3. **Stores** in a local SQLite knowledge graph
4. **Injects** relevant context as a header into every agent session turn

## Requirements

- OpenClaw v0.30+
- A configured LLM provider for scribe (uses the OpenClaw runtime's model plumbing)

## Links

- [GitHub](https://github.com/memrok-com/memrok)
- [Architecture](https://github.com/memrok-com/memrok/blob/main/docs/architecture.md)
