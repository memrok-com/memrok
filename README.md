![Memrok](https://raw.githubusercontent.com/memrok-com/memrok/main/assets/2026-memrok-logo.svg)

*Memory with judgment.*

---

Memrok is an open-source plugin for [OpenClaw](https://github.com/openclaw/openclaw) that adds a graph-based memory **curation layer** on top of OpenClaw’s built-in recall and dreaming systems. It watches your conversations, learns what matters, and brings relevant context into every interaction — not just as raw recall, but as judged, structured memory.

## Why Memrok?

OpenClaw’s built-in memory is getting good at **recall, dreaming, promotion, and operator tooling**. Memrok is not trying to be Yet Another Memory. Its job is the part that still needs sharper structure and judgment:

- building and maintaining a **graph** of durable facts, patterns, decisions, and collaboration dynamics
- handling **supersession, expiry, and stale-node cleanup**
- doing **topic-aware selection** so the right nodes win for the current conversation
- surfacing memory as **curation and interpretation**, not just retrieved snippets

If OpenClaw recall answers “what happened?”, Memrok is trying to answer “what still matters, what changed, and what should win now?”

Memrok runs small "scribe" agents alongside your main assistant that continuously curate what they learn about:

- **You** — preferences, context, history
- **The agent** — capabilities, learned behaviors, evolved identity
- **Your collaboration** — patterns, decisions, what works

All of this data stays on your device. Nothing leaves unless you choose a remote scribe model.

## Design Principles

- **Local-first.** Your memory lives on your machine in SQLite. Always yours, always portable.
- **Model-agnostic.** Swap your main model, swap your scribe model — memory persists through both.
- **Biological, not mechanical.** Memrok doesn't consolidate on a timer. It waits for material to accumulate and a quiet moment to think — like how humans process experience.
- **Judged, not just retrieved.** The point is not more memory text, but better memory selection, supersession, and expiry.

## How It Works

Memrok sits between your conversations and your agent's context window:

1. **Watch** — Memrok reads session transcripts and ambient signals as they happen
2. **Curate** — Two scribes process what they see:
   - A _transcript scribe_ extracts facts, preferences, and patterns in near-real-time
   - A _reflective scribe_ periodically steps back to find deeper insights and meta-patterns
3. **Inject** — On every agent turn, Memrok assembles a memory header from its knowledge graph, scored for relevance, and prepends it to the conversation

The result: your agent starts each session already knowing what matters.

## Quick Start

```sh
openclaw plugins install clawhub:memrok
```

Then activate Memrok as your context engine. Add to your `openclaw.json` (or use `openclaw config`):

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "memrok"
    },
    "entries": {
      "memrok": {
        "enabled": true,
        "config": {
          "scribeProvider": "openai",
          "scribeModel": "gpt-5-mini",
          "reflection": {
            "provider": "openai",
            "model": "gpt-5"
          },
          "bootstrap": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

Restart OpenClaw. Memrok watches session transcripts automatically and begins curating after the first idle window.

Set both transcript and reflection provider/model explicitly in the plugin config if you do not want Memrok falling back to its built-in defaults.
Bootstrap is now **opt-in**. Enable it only if you explicitly want Memrok to seed itself from existing Markdown memory files.

## Privacy & Data Flow

Memrok is local-first, but not magically offline.

- **Local database:** Memrok stores memory in a local SQLite database at `~/.memrok/memrok.db` by default.
- **Transcript and file access:** it watches OpenClaw session directories and any configured `watchPaths`. If bootstrap is enabled, it may also scan workspace Markdown files.
- **Default posture:** bootstrap is disabled by default; broad file scanning should be an explicit choice.
- **Remote model providers:** if you configure a remote provider for scribe passes, transcript and file content will be sent to that provider as part of normal operation.
- **Risk controls:** narrow `watchPaths`, disable bootstrap if you do not want broad file scanning, prefer local models where available, and consider disabling the reflective scribe if you want to minimize exfiltration risk.
- **Operational hygiene:** treat `~/.memrok/memrok.db` as sensitive data; back it up and secure it accordingly.

## Hardened / low-exfiltration posture

If you want a stricter setup:

- set `scribeProvider` / `scribeModel` to a local provider when possible
- keep `bootstrap.enabled` off unless you explicitly need seeding from Markdown files
- narrow `watchPaths` to only what Memrok should ingest
- disable or narrow reflection if you want less model-side synthesis

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

|         | Transcript Scribe                           | Reflective Scribe                        |
| ------- | ------------------------------------------- | ---------------------------------------- |
| Trigger | Event-driven: delta threshold + idle window | Periodic (configurable, default nightly) |
| Input   | Raw session transcripts                     | Accumulated graph state                  |
| Output  | Facts, preferences, patterns                | Insights, meta-patterns, coaching notes  |
| Model   | Lightweight (Haiku-class)                   | Capable recommended (Sonnet-class)       |

### Configuration

Most options are optional, but scribe provider/model should be set explicitly through OpenClaw config instead of relying on Memrok-owned defaults.

| Option                     | Type     | Default        | Description                              |
| -------------------------- | -------- | -------------- | ---------------------------------------- |
| `dbPath`                   | string   | state dir      | Path to the SQLite database              |
| `scribeProvider`           | string   | none           | Model provider for the transcript scribe; set explicitly in OpenClaw config |
| `scribeModel`              | string   | none           | Model for the transcript scribe; set explicitly in OpenClaw config |
| `watchPaths`               | string[] | session dirs   | Additional transcript paths to watch     |
| `bootstrap.enabled`        | boolean  | false          | Opt in to seeding from existing Markdown memory files |
| `deltaThreshold`           | number   | 20             | Messages before triggering consolidation |
| `idleMinutes`              | number   | 15             | Quiet time required before scribe runs   |
| `tokenBudget`              | number   | 1000           | Max tokens for injected memory headers   |
| `reflection.enabled`       | boolean  | true           | Enable the reflective scribe             |
| `reflection.deltaPasses`   | number   | 5              | Transcript passes between reflections    |
| `reflection.cooldownHours` | number   | 24             | Minimum hours between reflection runs    |
| `reflection.model`         | string   | scribeModel    | Override model for reflection; otherwise inherits explicit transcript model |
| `reflection.provider`      | string   | scribeProvider | Override provider for reflection; otherwise inherits explicit transcript provider |

## Status

Deployed as an OpenClaw context engine plugin with dual-scribe architecture. 93 tests across the monorepo.

Memrok also writes a small health snapshot to `~/.memrok/memrok.status.json`, including recent transcript-scribe, reflective-scribe, and injection activity plus last error and node count.

For the full technical design, see [`docs/architecture.md`](docs/architecture.md).

## License

MIT
