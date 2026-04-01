<p align="center">
  <img src="assets/2026-memrok-logo.svg" alt="Memrok" width="320">
</p>

<p align="center"><em>Memory that grows with you.</em></p>

---

Memrok is an open-source plugin for [OpenClaw](https://github.com/openclaw/openclaw) that gives your AI agent persistent, structured memory. It watches your conversations, learns what matters, and brings relevant context into every interaction — so your agent actually knows you over time.

## Why Memrok?

AI agents forget everything between sessions. You repeat yourself. Context gets lost. The agent you talked to yesterday is a stranger today.

Memrok fixes this. It runs a small "scribe" model alongside your main agent that continuously curates what it learns about:

- **You** — preferences, context, history
- **The agent** — capabilities, learned behaviors, what works
- **Your collaboration** — patterns, decisions, ongoing work

All of this stays on your device. Nothing leaves unless you choose a remote scribe model.

## Design Principles

- **Local-first.** Your memory lives on your machine in SQLite. Always yours, always portable.
- **Model-agnostic.** Swap your main model, swap your scribe model — memory persists through both.
- **Biological, not mechanical.** Memrok doesn't consolidate on a timer. It waits for material to accumulate and a quiet moment to think — like how humans process experience.
- **Self-tuning.** What gets surfaced adapts based on what actually matters in your conversations.

## How It Works

Memrok sits between your conversations and your agent's context window:

1. **Watch** — Memrok reads session transcripts and ambient signals as they happen
2. **Curate** — Two scribes process what they see:
   - A *transcript scribe* extracts facts, preferences, and patterns in near-real-time
   - A *reflective scribe* periodically steps back to find deeper insights and meta-patterns
3. **Inject** — On every agent turn, Memrok assembles a memory header from its knowledge graph, scored for relevance, and prepends it to the conversation

The result: your agent starts each session already knowing what matters.

## Quick Start

```sh
git clone https://github.com/memrok-com/memrok.git
cd memrok
npm install && npm run build
```

Register the plugin in your OpenClaw config:

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

That's the minimal setup. Memrok watches OpenClaw's session transcripts automatically and begins curating after the first idle window.

## Architecture

Memrok is a monorepo with clean separation of concerns:

```
packages/
├── daemon/           → transcript watcher, scribe scheduler, consolidation engine
├── scribe/           → scribe protocol, system prompts, model interface
├── store/            → SQLite + vector index + append-only mutation log
├── injector/         → relevance scoring, token-budget-aware context assembly
└── openclaw-plugin/  → OpenClaw context engine lifecycle (assemble/ingest/compact)
```

### The Two Scribes

| | Transcript Scribe | Reflective Scribe |
|---|---|---|
| Trigger | Event-driven: delta threshold + idle window | Periodic (configurable, default nightly) |
| Input | Raw session transcripts | Accumulated graph state |
| Output | Facts, preferences, patterns | Insights, meta-patterns, coaching notes |
| Model | Lightweight (Haiku-class) | Capable recommended (Sonnet-class) |

### Configuration

All options are optional — defaults work without tuning.

| Option | Type | Default | Description |
|---|---|---|---|
| `dbPath` | string | state dir | Path to the SQLite database |
| `scribeProvider` | string | — | Model provider for the transcript scribe |
| `scribeModel` | string | — | Model for the transcript scribe |
| `watchPaths` | string[] | session dirs | Additional transcript paths to watch |
| `deltaThreshold` | number | 10 | Turns before triggering consolidation |
| `idleMinutes` | number | 15 | Quiet time required before scribe runs |
| `tokenBudget` | number | 2000 | Max tokens for injected memory headers |
| `reflection.enabled` | boolean | true | Enable the reflective scribe |
| `reflection.deltaPasses` | number | 5 | Transcript passes between reflections |
| `reflection.cooldownHours` | number | 24 | Minimum hours between reflection runs |
| `reflection.model` | string | scribeModel | Override model for reflection |
| `reflection.provider` | string | scribeProvider | Override provider for reflection |

## Status

Working implementation with 93 tests across the monorepo. Deployed as an OpenClaw context engine plugin with dual-scribe architecture.

For the full technical design, see [`docs/architecture.md`](docs/architecture.md).

## License

MIT
