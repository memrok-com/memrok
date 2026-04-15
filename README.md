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

## Inspection & Evaluation

Memrok ships with local inspection scripts so you can evaluate injected headers without writing back into Memrok state.

Examples:

```sh
node scripts/eval-sessions.mjs --all-sessions --dry-run --json
node scripts/eval-sessions.mjs --recent-sessions 10 --dry-run --headers
node scripts/eval-sessions.mjs --session-id <session-id> --dry-run --headers
npm run eval:injector -- --json
npm run eval:events -- --limit 20
```

`eval:injector` runs the seeded fixture-based critic/eval baseline under `fixtures/injection-evals/`. It uses synthetic, inspectable cases inspired by real failure patterns, not a live Memrok database dump, so contributors can run and extend it on their own forks.

`eval:events` inspects the bounded runtime injection-eval events stored locally in the Memrok DB. These are opt-in observation records for real injections and explicit probes, intended to complement the synthetic fixture suite rather than replace it.

For the full engineering workflow, including before/after comparisons, converting live probe failures into scrubbed fixtures, and release smoke checks, see [`docs/eval-loop.md`](docs/eval-loop.md).

Notes:
- `--dry-run` / `--no-persist` prevents working-set snapshot writes during probing.
- `--json` includes the full rendered header as `headerText`.
- `--headers` is for human-readable terminal/file output.
- Optional filters such as `--topic`, `--channel`, `--provider`, and `--label` narrow session selection without changing the session-first model.
- `npm run eval:injector -- --baseline <path-to-previous-run.json>` compares the current run against a saved baseline.
- Runtime event logging is off by default. Enable it through the OpenClaw plugin config under `evalEvents` if you want bounded local observation of real injections.
- Release smoke: `npm run smoke:packaged-plugin` checks the packaged OpenClaw plugin artifact after build.

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
