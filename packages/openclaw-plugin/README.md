![Memrok](https://raw.githubusercontent.com/memrok-com/memrok/main/assets/2026-memrok-logo.svg)

*Memory with judgment.*

---

Memrok is an open-source plugin for [OpenClaw](https://github.com/openclaw/openclaw) that adds a graph-based memory **curation layer** on top of OpenClaw’s built-in recall and dreaming systems. It watches your conversations, archives raw observations, derives curation artifacts, and brings relevant context into every interaction as judged, structured memory rather than raw recall.

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

1. **Archive** — Memrok persists raw observations such as transcript chunks, bootstrap file contents, and reflection inputs
2. **Derive** — Scribes process those observations into persisted derived artifacts:
   - A _transcript scribe_ extracts facts, preferences, and patterns in near-real-time
   - A _reflective scribe_ periodically steps back to find deeper insights and meta-patterns
3. **Curate** — Derived artifacts update the memory graph, where supersession, expiry, and judged curation live
4. **Inject** — On every agent turn, Memrok selects a typed working set from the graph using semantic ranking plus stable structural priors such as topical anchors, renders a header from that working set, and prepends it to the conversation. Working-set traces keep a cheap shortcut back to the latest supporting mutation while full lineage remains in graph history.

The result: your agent starts each session already knowing what matters, with a cleaner provenance trail from raw observation to injected context.

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
          "bootstrap": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

Config lives under `plugins.entries.memrok.config`. Install puts the plugin in place, but your running gateway still needs a restart before it begins using the new build.

Restart OpenClaw. Memrok watches session transcripts automatically and begins curating after the first idle window.

By default, Memrok uses the OpenClaw provider/model configuration already active in your runtime. Set transcript or reflection provider/model explicitly only when you want Memrok to diverge from the OpenClaw defaults.
Bootstrap is **opt-in**. Enable it only if you explicitly want Memrok to seed itself from existing Markdown memory files. When enabled, Memrok scans `MEMORY.md` and `memory/` across configured OpenClaw agents, not just the current workspace.
By default, Memrok stores its database and status files under the active OpenClaw state directory, typically `~/.openclaw/plugins/memrok/`.

## Commands

Memrok also registers a `/memrok` command for operator tasks:

- `/memrok status` shows the current database path, watch targets, discovered memory targets, and recent Memrok activity
- `/memrok scan-memory` scans configured `MEMORY.md` files and `memory/` directories now
- `/memrok scan-memory force` reruns memory bootstrap even for files that were already bootstrapped
- `/memrok flush-sessions` runs transcript scribing immediately for any pending session chunks already seen by the watcher
- `/memrok index-sessions` replays unread session JSONL deltas from watched session paths
- `/memrok index-sessions full` rescans full watched session JSONL files from disk

## Privacy & Data Flow

Memrok is local-first, but not magically offline.

- **Local database:** Memrok stores memory in a local SQLite database under the active OpenClaw state directory, typically `~/.openclaw/plugins/memrok/memrok.db`.
- **Transcript and file access:** it watches OpenClaw session directories by default and any configured `watchPaths`. If bootstrap is enabled, it may also scan `MEMORY.md` and `memory/` across configured OpenClaw agents.
- **Default posture:** bootstrap is disabled by default; broad file scanning should be an explicit choice.
- **Remote model providers:** if you configure a remote provider for scribe passes, transcript and file content will be sent to that provider as part of normal operation.
- **Risk controls:** narrow `watchPaths`, disable bootstrap if you do not want broad file scanning, prefer local models where available, and consider disabling the reflective scribe if you want to minimize exfiltration risk.
- **Operational hygiene:** treat `~/.openclaw/plugins/memrok/memrok.db` as sensitive data; back it up and secure it accordingly.

## Hardened / low-exfiltration posture

If you want a stricter setup:

- keep OpenClaw’s default provider/model local when possible, or set `scribeProvider` / `scribeModel` explicitly for Memrok
- keep `bootstrap.enabled` off unless you explicitly need seeding from Markdown files
- narrow `watchPaths` to only what Memrok should ingest
- disable or narrow reflection if you want less model-side synthesis

## Architecture

Memrok is a monorepo with clean separation of concerns:

```
packages/
├── daemon/           → transcript watcher, scribe scheduler, consolidation engine
├── scribe/           → scribe protocol, system prompts, model interface
├── store/            → archive observations, derived artifacts, graph state, working-set traces
├── injector/         → graph selection into typed working sets, then header rendering
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

Most options are optional. Memrok inherits OpenClaw’s default provider/model unless you override them here.

| Option                     | Type     | Default        | Description                              |
| -------------------------- | -------- | -------------- | ---------------------------------------- |
| `dbPath`                   | string   | `${OPENCLAW_STATE_DIR}/plugins/memrok/memrok.db` | Path to the SQLite database |
| `scribeProvider`           | string   | OpenClaw default | Override provider for the transcript scribe |
| `scribeModel`              | string   | OpenClaw default | Override model for the transcript scribe |
| `watchPaths`               | string[] | auto-detected OpenClaw session dirs | Additional transcript paths to watch |
| `bootstrap.enabled`        | boolean  | false          | Opt in to seeding from existing Markdown memory files |
| `bootstrap.scanConfiguredAgents` | boolean | true | Scan `MEMORY.md` and `memory/` across configured OpenClaw agents |
| `bootstrap.memoryDirs`     | string[] | auto-discovered agent memory dirs | Extra memory directories to seed from |
| `bootstrap.memoryIndexes`  | string[] | auto-discovered agent `MEMORY.md` files | Extra `MEMORY.md` files to seed from |
| `deltaThreshold`           | number   | 20             | Messages before triggering consolidation |
| `idleMinutes`              | number   | 15             | Quiet time required before scribe runs   |
| `tokenBudget`              | number   | 1000           | Max tokens for injected memory headers   |
| `reflection.enabled`       | boolean  | true           | Enable the reflective scribe             |
| `reflection.deltaPasses`   | number   | 5              | Transcript passes between reflections    |
| `reflection.cooldownHours` | number   | 24             | Minimum hours between reflection runs    |
| `reflection.model`         | string   | OpenClaw / scribe model | Override model for reflection |
| `reflection.provider`      | string   | OpenClaw / scribe provider | Override provider for reflection |

## Status

Deployed as an OpenClaw context engine plugin with dual-scribe architecture. 93 tests across the monorepo.

Memrok also writes a small health snapshot under the OpenClaw state dir, typically `~/.openclaw/plugins/memrok/memrok.status.json`, including recent transcript-scribe, reflective-scribe, and injection activity plus last error and node count.

For the full technical design, see [`docs/architecture.md`](docs/architecture.md).

## License

MIT
