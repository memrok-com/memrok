# Reflective Scribe — Feature Spec

*Draft · April 2026*

## Summary

Add a second scribe mode to Memrok: the **reflective scribe**. While the transcript scribe (existing) extracts objective facts from conversations, the reflective scribe synthesizes subjective insights from the agent's perspective — meta-patterns, lessons learned, coaching observations, and self-awareness.

## Why

Current memory architecture has a gap: transcript extraction captures *what happened* but not *what it means*. The reflective scribe fills this by periodically reviewing accumulated knowledge and producing higher-order insights.

For OpenClaw users, this means their agent doesn't just record — it *thinks about* what happened. This is a meaningful differentiator over RAG-based memory systems that only chunk and embed.

## Two Scribes, Two Purposes

| | Transcript Scribe (existing) | Reflective Scribe (new) |
|---|---|---|
| **Trigger** | Event-driven: delta threshold + idle window | Scheduled: periodic (e.g. nightly) |
| **Input** | Raw session JSONL transcripts | Graph state + recent transcript extractions + daily memory files |
| **Perspective** | Objective: extract facts, preferences, patterns | Subjective: agent's own observations, meta-patterns, coaching notes |
| **Output** | Graph mutations (user/agent/collaboration layers) | Graph mutations with `source: "reflection"` tag |
| **Model** | Can be lightweight (Haiku-class) | Should be capable (Sonnet-class) — needs reasoning about patterns |
| **Frequency** | Every consolidation cycle (~15min idle + threshold) | Daily or configurable interval |

## Architecture

### Source Type

Use `source: "reflection"` on the `ScribePass`. The store already supports this — `ScribePass.source?: string` is stored in `passes.source` and `mutations.source`. Zero schema changes needed.

Note: the `nodes` table only has `first_pass_id`/`last_pass_id`, not a `source` column. Future injector weighting by source will need either a JOIN through the mutation log or a denormalized column. Not needed for v1.

### Trigger

The reflective scribe is **event-driven with a cooldown**, consistent with the architecture's design principle ("Event-driven, not scheduled. No cron, no hard session boundaries.").

Trigger conditions (all must be met):
1. **Delta passes:** N transcript scribe passes since last reflection (default: 5)
2. **Cooldown:** minimum time since last reflection (default: 24h)
3. **Idle window:** same idle detection as transcript scribe

This means: after enough new material accumulates AND enough time has passed AND the agent is idle, a reflection fires. Not at 2am sharp — when it makes sense.

Implementation: internal timer in the plugin's registered service, checking alongside the existing consolidation loop. The reflection check piggybacks on the same interval but has its own state tracking.

### Input Assembly

The reflective scribe receives:
1. **Current graph state** — all nodes across layers, with timestamps and sources
2. **Recent transcript scribe passes** — the last N passes (mutations since last reflection)
3. **Agent identity context** — from IDENTITY.md / SOUL.md if available (so reflections are in-voice)

This is NOT raw transcripts. The reflective scribe works on *already-processed* knowledge, looking for patterns the transcript scribe can't see (cross-session themes, behavioral trends, emerging blind spots).

### Prompt Design

The reflective scribe needs its own system prompt, distinct from the transcript extraction protocol. Key differences:
- First person ("I noticed...", "A pattern I'm seeing...")
- Encouraged to be opinionated and subjective
- Focus on: meta-patterns, contradictions, growth areas, things that surprised the agent
- Quality gate: only emit mutations that pass "good thinking" or "I didn't think of that" bar
- Must not repeat what's already in the graph — only add genuinely new synthesis

### Output

Same mutation format as transcript scribe (`ScribePass` with `pass_id` + `mutations`), but:
- Mutations carry `source: "reflection"` metadata
- Typically targets `agent` and `collaboration` layers more than `user` layer
- May include `update` operations on existing nodes (deepening understanding)

### Injector Changes

The injector should:
- Include reflection-derived nodes in header assembly
- Potentially give reflections slightly higher weight (they represent synthesized understanding, not raw extraction)
- Mark reflection-sourced content distinctly in the header (e.g. under a "### Agent reflections" sub-section)

## Migration Path

Currently, nightly reflections are an OpenClaw cron job writing to `memory/reflections.md`. Migration:
1. Build the reflective scribe as described above
2. Bootstrap existing `memory/reflections.md` content into the graph
3. Deprecate the cron job
4. Morning heartbeat reads from Memrok graph instead of flat file

## Implementation Details

### Reuse ScribeInterface

No new class needed. `ScribeInterface` accepts a custom system prompt:

```typescript
const reflectionScribe = new ScribeInterface(modelCaller, {
  systemPrompt: REFLECTION_SYSTEM_PROMPT,
});
```

Same JSON output format, same `parseResponse` validation, same mutation pipeline.

### Input Label

`createModelCaller` currently hardcodes `TRANSCRIPT:\n` as input label. Add an optional `inputLabel` parameter (default: `"TRANSCRIPT"`) so reflection can use `"GRAPH_STATE"` or similar.

### Input Scoping

Don't dump the full graph. Scope to:
- Nodes modified in last 30 days
- Nodes with `reference_count >= 3` (durable regardless of age)
- Nodes with `correction_count >= 1` (corrected beliefs always worth reflecting on)

Expected: 40–80 nodes for typical usage. Serialize via a new `serializeGraphForReflection()` utility.

### Evidence Field

The transcript scribe quotes verbatim. The reflective scribe references supporting node keys: `"synthesized from: agent.failure.biography_opener + collab.pattern.user_overrides_tone"`.

### New Files

| File | Purpose |
|---|---|
| `packages/scribe/src/reflection-prompt.ts` | `REFLECTION_SYSTEM_PROMPT` string constant |
| `packages/scribe/src/reflection-serializer.ts` | `serializeGraphForReflection(store, options?)` → string |

### Modified Files

| File | Change |
|---|---|
| `packages/scribe/src/index.ts` | Re-export reflection prompt + serializer |
| `packages/openclaw-plugin/src/types.ts` | Add `reflection?` config fields |
| `packages/openclaw-plugin/src/plugin.ts` | Reflection timer + `inputLabel` param |

## Configuration

```json
{
  "plugins": {
    "entries": {
      "memrok": {
        "config": {
          "reflection": {
            "enabled": true,
            "deltaPasses": 5,
            "cooldownHours": 24,
            "model": "claude-sonnet-4-6",
            "provider": "anthropic"
          }
        }
      }
    }
  }
}
```

`model`/`provider` default to the scribe's model/provider — so users can run a cheap transcript scribe + capable reflection model separately.

## Open Questions

1. ~~Should reflections be able to `expire` transcript-derived nodes?~~ **Yes.** Recognizing that a node was situational and expiring it is one of the most valuable things reflection can do. The prompt should explicitly encourage this.
2. How deep should the graph state dump be for the reflection input? Full dump vs. only recent/active nodes?
3. Should users be able to trigger ad-hoc reflections? ("reflect on the last week")
4. Privacy: reflections contain the agent's subjective views. Should they be injected into group chat contexts or only main sessions?

## Fizzy

Card to be created after spec review.
