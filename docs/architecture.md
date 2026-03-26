# Memrok — Architecture

*Draft · March 2026*

## What Memrok Is

A local daemon that sits behind your AI agent, curating structured memory across three layers. It reads conversation transcripts and ambient signals, maintains knowledge graphs, and injects relevant context into every LLM call. The main model gets denser context without doing its own memory management.

**Not** a replacement for existing memory/RAG systems. Memrok is the *curator* — it reasons about what to remember, what changed, and what matters now.

---

## Design Principles

- **Async by default, latency-aware where it matters.** The scribe is async (off the hot path). The injector IS on the hot path (runs inside `assemble()` on every LLM call) and must be fast — pre-computed cache with lazy invalidation, latency budgets, graceful degradation to stale headers.
- **Data rests locally, reasoning happens anywhere.** All memory data stays on-device. The scribe model can be local (Ollama) or remote (Haiku, Gemini Flash, any provider) — same abstraction OpenClaw uses for its models. No bundled model runtime.
- **Model-agnostic.** Memory survives main model swaps. The identity lives in the graphs, not the weights. The scribe itself is also swappable — any model that can follow the extraction protocol works.
- **Event-driven, not scheduled.** Consolidation triggers are biological, not cron: unconsolidated material accumulates → idle window opens → scribe runs. No fuzzy "end of session" concept.
- **Extensible observation.** Ambient sources (transcripts, calendar, email, files, anything) are pluggable. Each source implements a watch/emit interface. Users configure which are active.
- **OpenClaw-native, protocol-portable.** Primary integration via OpenClaw plugin APIs. MCP compatibility as a secondary surface.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│ OpenClaw                                                    │
│                                                             │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐  │
│  │ Session       │   │ Context       │   │ Memory        │  │
│  │ Transcripts   │   │ Engine        │   │ Plugin        │  │
│  │ (JSONL)       │   │ (assemble)    │   │ (search)      │  │
│  └───────┬───────┘   └───────▲───────┘   └───────▲───────┘  │
│          │                   │                   │          │
└──────────┼───────────────────┼───────────────────┼──────────┘
           │                   │                   │
┌──────────▼───────────────────┴───────────────────┴──────────┐
│ Memrok Daemon                                               │
│                                                             │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐  │
│  │ Sources       │   │ Scribe        │   │ Store         │  │
│  │               │   │ (any model    │   │ (graphs       │  │
│  │ Transcripts,  │   │  via provider │   │  + vector     │  │
│  │ ambient       │   │  abstraction) │   │  + SQLite)    │  │
│  │ (pluggable)   │   │               │   │               │  │
│  └───────┬───────┘   └───────┬───────┘   └───────┬───────┘  │
│          │                   │                   │          │
│          └─────►scribe───────┴──────►store───────┘          │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Context Injector                                      │  │
│  │ Assembles header from 3 layers                        │  │
│  │ → OpenClaw context engine plugin                      │  │
│  │ → MCP resource (portable)                             │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Daemon (`memrokd`)

Long-running local process. Orchestrates everything.

- **Source manager**: pluggable source system. Each source watches a signal (JSONL transcripts, filesystem, calendar, email, etc.) and emits observation events. Sources implement a `watch → emit` interface. Users configure which are active.
- **Consolidation engine**: triggers scribe passes based on biological-analog signals (see Trigger Model below). Not cron, not "end of session."
- **API surface**: local socket or HTTP for OpenClaw plugin communication. Health, status, force-scribe, query.

### 2. Scribe

The curator. Runs against any model via a provider abstraction — local Ollama, Anthropic Haiku, Gemini Flash, OpenAI mini, whatever. Memrok doesn't run models; it interfaces with them.

**The scribe is a protocol, not a runtime.** A system prompt + structured output schema that works across a range of models. The extraction quality will vary by model capability, but the protocol is consistent.

**Input:** new observation events + current graph state + scribe system prompt.

**Operations per pass:**
- Extract entities, relationships, preferences, decisions from new material
- Classify across three layers (user / agent / collaboration)
- Detect belief revision (X changed to Y), drift (stated ≠ enacted), pattern (third time this happened)
- Score relevance signals on extracted nodes (see Relevance Model)
- Merge/deduplicate with existing graph

**Output:** graph mutations (add/update/expire nodes and edges) + optional scribe log.

**Not on the critical path.** Can take 30 seconds, 2 minutes, doesn't matter. Thoroughness over speed.

### 3. Store

Three parallel knowledge graphs + supporting indexes:

| Layer | What it models | Example nodes |
|---|---|---|
| **User** | Preferences, behaviors, decision patterns, regret profile | `prefers:direct-communication`, `stated:priority:PrioMind`, `pattern:iterates-7-times-on-design` |
| **Agent** | Self-knowledge, failure modes, effective patterns | `good-at:pipeline-design`, `tendency:over-qualifying-statements`, `learned:check-clock-before-time-reasoning` |
| **Collaboration** | Dynamic between human + agent, overrides, trust patterns | `pattern:michael-overrides-on-tone`, `trust:high:infrastructure-work`, `friction:content-marketing-pacing` |

**Storage:** Graph structure in SQLite (nodes, edges, properties, timestamps, relevance signals, provenance). Vector embeddings on node descriptions for semantic retrieval. No external DB dependency.

**Versioning:** Every mutation is an append-only log entry. Graphs are reconstructable from the log. Enables "what did the model believe about me on date X?"

### 4. Context Injector

Assembles a dense context header from the three graphs, tailored to the current conversation.

**Trigger:** called by OpenClaw's context engine `assemble()` hook before each LLM run.

**Process:**
1. Receive session context hints (topic, recent messages summary)
2. Query each graph layer for relevant nodes — multi-signal ranking (see Relevance Model)
3. Compose a structured header:
   - User context (relevant preferences, patterns, current state)
   - Agent self-context (relevant capabilities, known failure modes)
   - Collaboration context (relevant dynamics, recent friction/flow patterns)
4. Return as `systemPromptAddition` via the context engine API

**Budget:** target 500–1500 tokens. Dense, not exhaustive. The injector's job is relevance filtering.

**Latency contract:** The injector runs on the hot path — it blocks every LLM call via `assemble()`. Design constraints:

1. **Pre-computed base header.** After every scribe pass, the injector pre-computes a context-independent "base header" from the updated graph. On `assemble()`, only the semantic proximity pass against current conversation needs to run (a vector query, not a full graph traversal).
2. **Staleness is acceptable.** The header provides *background* knowledge. The conversation itself carries the last 30 seconds of context in the window. Aggressive caching with lazy invalidation is semantically correct.
3. **Latency budget.** Configurable max response time (e.g., 50ms). If the injector can't respond in time, serve the cached header and update async. Never block inference for a fresher header.
4. **Graceful degradation.** If the daemon is unreachable, serve the last cached header. If no cache exists, return empty `systemPromptAddition`. The LLM works fine without it — just without enrichment.

---

## Trigger Model

Sessions are continuous — there's no clean "end" to consolidate against. Memrok uses event-driven triggers inspired by biological memory consolidation:

| Trigger | Analog | How it works |
|---|---|---|
| **Delta threshold** | "Enough new experience to process" | N new transcript tokens or messages since last scribe pass. Configurable threshold. |
| **Idle detection** | "The brain isn't actively processing" | No conversation activity for X minutes. The closest analog to sleep consolidation — process when the human isn't actively engaged. |
| **Pre-compaction** | "Running out of working memory" | OpenClaw signals it's about to compact. Memrok piggybacks on the existing memory flush to consolidate before context is lost. |
| **Explicit** | "Deliberate reflection" | `/new` command, manual API trigger, or force-scribe call. User-initiated consolidation. |

Triggers are combinable: e.g., scribe runs when delta threshold is met AND idle time exceeds minimum. Prevents running on every small exchange while still consolidating during natural pauses.

**What's explicitly NOT a trigger:** cron schedules, "end of session" (doesn't exist), time-of-day (though idle detection naturally clusters around off-hours).

---

## Relevance Model

Graph nodes carry multiple signals that the injector combines at query time to determine what matters *right now*. This is retrieval relevance, not stored confidence.

| Signal | What it captures | Source |
|---|---|---|
| **Recency** | Exponential decay from last observation/update | Timestamp on node or edge |
| **Frequency** | How often referenced across observations | Reference count + provenance links |
| **Emotional weight** | Intensity of the originating context | Scribe extraction (explicit statements, corrections, strong reactions) |
| **Correction history** | User explicitly corrected or contradicted this | Scribe detects override/correction patterns |
| **Semantic proximity** | How close to the current conversation topic | Vector similarity at query time |
| **Stability** | Has this held steady or been revised repeatedly? | Mutation log analysis |

The injector computes a composite relevance score at query time. No single number is stored as "the confidence" — it's always a function of context.

### Self-Tuning Weights

Relevance weights aren't just configurable — they're a learning system. The strongest tuning signal comes from users interacting with their agents.

**The feedback loop:**

```
Injector serves context header
  → Agent acts on surfaced knowledge
    → User reacts (accepts, overrides, corrects, ignores)
      → Scribe observes the reaction pattern
        → Relevance weights adjust
```

If the injector consistently surfaces a certain *type* of knowledge (e.g., stated preferences) and the user consistently overrides with frustration, that's not just a correction to the fact — it's signal that the relevance model is miscalibrated for that signal class. The weights themselves should drift.

**This means the scribe has two output channels:**
1. **Graph mutations** — knowledge extraction (entities, relationships, facts)
2. **Meta-signal** — observations about which kinds of knowledge the user actually values, based on interaction patterns

**Guardrails (control metrics):**
- Weight drift is logged in the append-only store like all mutations. Full audit trail.
- Weights have bounded ranges — no single signal can dominate or zero out.
- Significant shifts surface to the user: "I've noticed I keep surfacing X-type context that you override — I've reduced its weight. Does that match your intent?"
- User can override any weight manually. Manual overrides are respected until explicitly released.
- Drift rate is capped — weights can't swing dramatically on a single interaction, only on sustained patterns.
- Periodic "weight report" available on request — full transparency into what the model thinks matters.

**The agent's role:** Just as the agent has tools and permission to update SOUL.md or AGENTS.md, it should be able to observe and adjust its own relevance tuning — with the user always able to see what changed and correct the correction. Self-improvement within visible bounds.

---

## Source Plugin System

Ambient observation is extensible. Each source is a plugin that implements:

```
interface Source {
  id: string
  watch(): AsyncIterable<Observation>  // or callback-based
  dispose(): void
}

interface Observation {
  source: string        // source plugin id
  timestamp: Date
  content: string       // raw text for scribe consumption
  metadata: Record<string, unknown>  // source-specific context
}
```

**Built-in sources (MVP+):**
- `transcript` — watches OpenClaw session JSONL files
- `memory-files` — watches MEMORY.md + memory/*.md changes

**Future sources (user-contributed or later phases):**
- `calendar` — upcoming/past events via API
- `email` — inbox summaries via API
- `filesystem` — file changes in watched directories
- `browser` — browsing context (if available)

Users configure active sources in daemon config. Sources can be enabled/disabled without touching the scribe or store.

---

## Cold Start

Bootstrap from existing memory files. `MEMORY.md` and `memory/*.md` are curated signal — essentially a pre-built user model in unstructured form.

**Bootstrap sequence:**
1. Daemon starts, detects empty graph
2. Reads `MEMORY.md` + all `memory/*.md` files as initial observations
3. Runs scribe pass to extract graph from existing material
4. Graph is pre-populated before the first live conversation

This means Memrok is immediately useful on day one for any existing OpenClaw agent.

---

## Memory Handoff (Main Model → Memrok)

The main model currently writes its own memory files (MEMORY.md, daily logs). This doesn't stop overnight — it transitions gradually:

| Phase | Main model behavior | Memrok role | Token savings |
|---|---|---|---|
| **1. Shadow** | Writes memory as before | Reads memory files + transcripts, builds graph silently. Injector active but supplementary. | None yet |
| **2. Assist** | Memory flush prompt shifts to "flag anything the memory layer might have missed" | Primary curator. Main model reviews/corrects but doesn't originate. | Partial — fewer memory writes |
| **3. Trust** | No manual memory work. Graph is the source of truth. | Full curator. Memory files become an export format, not the primary store. | Full — no memory flush turns, denser context header replaces bloated MEMORY.md injection |

The transition is configurable per agent. Some users may prefer staying in Phase 1 permanently (Memrok as enrichment, not replacement). That's fine — the graph still adds value alongside manual memory.

**How the handoff works in practice:** The main model's memory behavior is shaped by instructions scattered across workspace files (AGENTS.md: write-ahead persistence, memory maintenance; compaction memoryFlush config: "write durable notes"; SOUL.md: "persist what matters"). There's no single switch.

The mechanism is a set of known edits per phase:
- **Phase 1 → 2:** Patch AGENTS.md memory sections to say "Memrok handles memory curation — focus on flagging anything that feels important but might be missed." Reconfigure `memoryFlush` prompt to point at Memrok's review surface instead of raw file writes.
- **Phase 2 → 3:** Remove memory-write instructions from AGENTS.md entirely. Disable `memoryFlush`. Remove MEMORY.md from bootstrap injection (the graph replaces it).

This could be tooled: `memrok handoff --phase assist` generates the right AGENTS.md diffs and OpenClaw config patches for the target phase. Reversible — `memrok handoff --phase shadow` rolls back.

---

## OpenClaw Integration Points

| OpenClaw API | Memrok use |
|---|---|
| Context Engine plugin (`assemble`) | Inject context header via `systemPromptAddition` |
| Context Engine plugin (`afterTurn`) | Notify daemon of new transcript data |
| Context Engine plugin (pre-compaction) | Trigger consolidation before context is lost |
| Session JSONL transcripts | Primary observation source |
| Memory plugin slot | Optional: Memrok-backed `memory_search` replacing markdown search |
| `/new` command hook | Explicit consolidation trigger |

### Plugin architecture

The OpenClaw plugin is a thin adapter — **Option C: lightweight context engine wrapper**.

```
openclaw-plugin-memrok
├── Registers as context engine (wraps legacy engine)
├── Delegates all history/compaction to legacy — doesn't replace it
├── Connects to local memrokd via socket/HTTP
├── On assemble(): requests context header from injector → systemPromptAddition
├── On afterTurn(): notifies daemon of new transcript data
├── On pre-compaction: signals daemon to consolidate
└── Config: daemon address, token budget, layer weights, scribe provider
```

Keeps existing OpenClaw behavior 100% intact. Memrok enriches, doesn't replace.

---

## Data Flow

```
Observation events accumulate (transcript, ambient, memory files)
        │
        ▼
   Delta threshold met + idle window detected
        │
        ▼
   Scribe pass triggered
        │
        ├── Read new observations since last pass
        ├── Read current graph state
        ├── Call scribe model (local or remote, via provider abstraction)
        ├── Receive structured graph mutations
        │
        ▼
   Store applies mutations
   (append to log, update graph, reindex vectors)
        │
        ▼
   Injector cache invalidated
        │
        ▼
   Next LLM call: assemble() → fresh header from updated graphs
```

---

## MVP Scope (Phase 1)

Deliberately narrow. Prove the scribe-to-injection loop works.

| In scope | Out of scope |
|---|---|
| JSONL transcript watching | Ambient source plugins (calendar, email) |
| Memory file bootstrap (cold start) | Agent self-model, collaboration model |
| Single-layer graph (user model only) | Belief revision, drift detection |
| Context header injection via OpenClaw plugin | MCP compatibility |
| SQLite storage | Advanced relevance model (frequency, emotional weight) |
| Provider-agnostic scribe (Ollama, Haiku, Flash, etc.) | Memory handoff Phase 2+ |
| Delta threshold + idle detection triggers | Source plugin API (just hardcoded transcript source) |
| Basic relevance: recency + semantic proximity | Full multi-signal relevance scoring |

**MVP delivers:** "Every new session, the assistant already knows your preferences and recent context — without you telling it again."

---

## Monorepo Structure

```
memrok/
├── docs/                    → architecture, concept docs
├── packages/
│   ├── daemon/              → memrokd (watcher + consolidation engine + API)
│   ├── scribe/              → scribe protocol (system prompt + model interface + extraction logic)
│   ├── store/               → graph storage (SQLite + vector index + append-only log)
│   ├── injector/            → context assembly + relevance scoring
│   └── openclaw-plugin/     → OpenClaw context engine wrapper
├── package.json             → workspace root
└── README.md
```

---

## Open Questions

1. **Graph schema design.** What's the minimal node/edge schema that the scribe can reliably populate? Need to prototype with real transcripts.
2. **Scribe prompt engineering.** The extraction protocol needs to work across model tiers (Haiku-class through Sonnet-class). Quality will vary but structure must be consistent. Needs iteration with actual conversation data.
3. **Self-tuning bootstrap.** What are sensible initial weights before the feedback loop has data? How many interactions before self-tuning produces meaningful signal vs. noise? What's the minimum observation window before allowing weight drift?
4. **Context budget allocation.** How to split the ~1000 token budget across layers (once all three are active)? Static split or dynamic based on conversation topic?
5. **Scribe extraction schema.** What structured output format gives the best results across different model sizes? JSON? Function calling? Constrained generation?
6. **Injector latency benchmarks.** What's the realistic latency for a vector proximity query + header assembly? Need to measure with actual graph sizes to set the latency budget.

---

*This is a working document. It will evolve as we prototype.*
