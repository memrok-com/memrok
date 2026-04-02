---
name: memrok
description: Persistent, structured, intelligent memory layer for OpenClaw AI agents.
---

# Memrok

Persistent memory layer for OpenClaw AI agents. Watches conversation transcripts, extracts knowledge into a three-layer graph (user model, agent model, collaboration patterns), and injects relevant context into every session turn.

## Install

```bash
clawhub install @memrok/memrok
openclaw plugins install memrok
```

## Configuration

In your OpenClaw plugin config:

| Option | Description | Default |
|--------|-------------|---------|
| `scribeProvider` | LLM provider for knowledge extraction | `gemini` |
| `scribeModel` | Model for scribe passes | `gemini-2.0-flash` |
| `watchPaths` | Directories to watch for transcript changes | `["./memory"]` |
| `tokenBudget` | Max tokens for injected context header | `2000` |
| `deltaThreshold` | Minimum change score to trigger scribe | `0.3` |
| `idleMinutes` | Idle time before scribe runs | `5` |

## What It Does

1. **Watches** memory/transcript files for changes
2. **Extracts** knowledge via scribe passes (entities, relationships, preferences, patterns)
3. **Stores** in a local SQLite knowledge graph
4. **Injects** relevant context as a header into every agent session turn

## Requirements

- OpenClaw v0.30+
- A configured LLM provider for scribe (Gemini recommended for cost)

## Links

- [GitHub](https://github.com/memrok-com/memrok)
- [Architecture](https://github.com/memrok-com/memrok/blob/main/docs/architecture.md)
