<p align="center">
  <img src="assets/2026-memrok-logo.svg" alt="Memrok" width="320">
</p>

<p align="center"><em>The part of your agent who knows you, itself, and what you built together.</em></p>

---

Memrok is a local daemon that curates structured memory across three layers — user, agent, and collaboration — using a small "scribe" model. It reads conversation transcripts and ambient signals, maintains knowledge graphs, and injects relevant context into every LLM call.

**Not** a replacement for RAG or existing memory systems. Memrok is the *curator* — it reasons about what matters, what changed, and what to surface next.

## Status

Working implementation. 93 tests across the monorepo. Deployed as an OpenClaw context engine plugin with dual-scribe architecture (transcript + reflection).

See [`docs/architecture.md`](docs/architecture.md) for the full design.

## How It Works

**Three memory layers.** The store maintains separate knowledge graphs for the *user* (preferences, context, history), the *agent* (capabilities, learned behaviors), and *collaboration* (patterns, decisions, ongoing work). All data stays on-device in SQLite.

**Two scribes.**

| | Transcript Scribe | Reflective Scribe |
|---|---|---|
| Trigger | Event-driven: delta threshold + idle window | Periodic (configurable, default nightly) |
| Input | Raw session JSONL transcripts | Accumulated graph state |
| Output | Objective facts, preferences, patterns | Subjective insights, meta-patterns, coaching notes |
| Model | Lightweight (Haiku-class works) | Capable recommended (Sonnet-class) |

**The inject loop.** On every LLM call, OpenClaw invokes `assemble()` on the Memrok context engine. The injector queries the store, scores relevance, and prepends a memory header to the conversation — all within a latency budget, with graceful degradation to a stale cache if the store is slow.

## Quick Start

Memrok installs as an OpenClaw plugin via path-based install from this repo:

```sh
git clone https://github.com/memrok-com/memrok.git
cd memrok
npm install && npm run build
```

Then register the plugin in your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["memrok"],
    "load": {
      "paths": ["/path/to/memrok/packages/openclaw-plugin"]
    },
    "slots": {
      "contextEngine": "memrok"
    },
    "entries": {
      "memrok": {
        "enabled": true,
        "config": {
          "scribeProvider": "anthropic",
          "scribeModel": "claude-sonnet-4-6"
        }
      }
    }
  }
}
```

That's the minimal config. Memrok will watch OpenClaw's session transcripts automatically and begin consolidating after the first idle window.

## Configuration

All options are optional. Defaults are designed to work without tuning.

| Option | Type | Default | Description |
|---|---|---|---|
| `dbPath` | string | state dir | Path to the SQLite database |
| `scribeProvider` | string | — | Model provider for the transcript scribe (e.g. `anthropic`, `ollama`) |
| `scribeModel` | string | — | Model for the transcript scribe |
| `watchPaths` | string[] | session dirs | Additional transcript paths to watch |
| `deltaThreshold` | number | 10 | Turns to accumulate before triggering consolidation |
| `idleMinutes` | number | 15 | Idle window required before scribe runs |
| `tokenBudget` | number | 2000 | Max tokens for injected memory headers |
| `reflection.enabled` | boolean | true | Enable the reflective scribe |
| `reflection.deltaPasses` | number | 5 | Transcript passes between reflections |
| `reflection.cooldownHours` | number | 24 | Minimum hours between reflection runs |
| `reflection.model` | string | scribeModel | Override model for reflection (capable model recommended) |
| `reflection.provider` | string | scribeProvider | Override provider for reflection model |

## Monorepo Structure

```
packages/
├── daemon/           → memrokd: transcript watcher, scribe scheduler, consolidation engine
├── scribe/           → scribe protocol: system prompts, model interface, reflection serializer
├── store/            → SQLite + vector index + append-only mutation log
├── injector/         → context assembly, relevance scoring, token-budget-aware header builder
└── openclaw-plugin/  → OpenClaw context engine: assemble/ingest/compact lifecycle
```

## Design Principles

- **Data rests locally, reasoning happens anywhere.** Memory data stays on-device. The scribe model can be local (Ollama) or remote — same provider abstraction OpenClaw uses.
- **Model-agnostic.** Memory survives main model swaps. The scribe itself is swappable.
- **Event-driven.** Consolidation triggers are biological, not cron-based: material accumulates → idle window opens → scribe runs.
- **Self-tuning.** Relevance weights adapt based on observed interaction patterns.

## License

MIT
