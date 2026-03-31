# Task: Implement Memrok Injector Package

## What This Is

The context injection layer for Memrok. It reads from the graph store and assembles a dense, relevant context header for injection into LLM calls via `systemPromptAddition`.

## Dependencies

- `@memrok/store` — the graph store this reads from

## Deliverables

### 1. Core API

```typescript
import { Store } from '@memrok/store'

interface InjectorConfig {
  tokenBudget?: number        // target max tokens for header (default 1000)
  layerWeights?: {            // relative weight per layer in budget allocation
    user?: number             // default 0.5
    agent?: number            // default 0.25
    collaboration?: number    // default 0.25
  }
  relevanceWeights?: {        // weights for composite relevance scoring
    recency?: number          // default 0.3
    frequency?: number        // default 0.15
    emotional?: number        // default 0.2
    correction?: number       // default 0.15
    semantic?: number         // default 0.2
  }
  maxAge?: number             // max age in days for recency decay (default 90)
  cacheMaxAge?: number        // cache TTL in ms (default 30000)
}

interface Injector {
  // Assemble a context header from the graph, optionally tuned to current conversation
  assemble(context?: { recentMessages?: string }): ContextHeader
  
  // Invalidate the cached header (call after scribe pass)
  invalidate(): void
  
  // Get current relevance weights (for transparency/debugging)
  getWeights(): RelevanceWeights
  
  // Update a relevance weight (manual override)
  setWeight(signal: string, value: number): void
}

interface ContextHeader {
  text: string               // formatted header text for systemPromptAddition
  tokens: number             // estimated token count
  nodesUsed: number          // how many nodes contributed
  layers: {                  // breakdown by layer
    user: number
    agent: number
    collaboration: number
  }
  cachedAt?: number          // timestamp if served from cache
  assemblyMs: number         // time taken to assemble
}

function createInjector(store: Store, config?: InjectorConfig): Injector
```

### 2. Relevance Scoring

For each active node, compute a composite score:

```
score = w_recency * recencyScore(node.updated_at, maxAge)
      + w_frequency * normalize(node.reference_count)  
      + w_emotional * node.emotional_weight
      + w_correction * normalize(node.correction_count)
      + w_semantic * semanticScore (0.5 default when no context provided)
```

- `recencyScore`: exponential decay — `exp(-lambda * ageDays)` where `lambda = ln(2) / 30` (half-life 30 days)
- `normalize`: `min(1, value / 10)` for frequency/correction counts
- `semanticScore`: placeholder 0.5 when no embedding similarity available (Phase 1)

### 3. Header Formatting

Format the assembled header as structured text:

```
## Memory Context (Memrok)

### About the user
- Prefers blunt, punchy tone over polished/elegant
- Evening energy (21:00-23:30) is the creative peak
- ...

### About this agent
- Tends to open content from author's biography rather than audience's pain
- Good at pipeline design and system architecture
- ...

### About our collaboration
- User steers via conceptual framing, agent operationalizes
- High trust for infrastructure and automation work
- ...
```

Each layer gets a proportional share of the token budget based on `layerWeights`.

### 4. Caching

- Cache the assembled header after each build
- Serve cached header if within `cacheMaxAge` 
- `invalidate()` clears the cache (called after scribe passes)
- Track cache hit/miss for diagnostics

### 5. Token Estimation

Simple char-based estimation: `tokens ≈ chars / 4`. No need for a tokenizer in Phase 1.

### 6. Tests

Using `node:test`. Test:
- Assembly from a populated store (create store, apply test pass, assemble)
- Relevance scoring (verify recency decay, frequency boost, correction boost)
- Token budget enforcement (header stays within budget)
- Layer weight allocation (proportional distribution)
- Caching (same result on second call, different after invalidate)
- Empty store (graceful empty header)
- Header formatting (correct sections, no empty sections)

## Constraints

- TypeScript, ESM
- No external dependencies beyond `@memrok/store` (and transitively `better-sqlite3`)
- Semantic similarity is a placeholder in Phase 1 (always 0.5)
- Keep assembly fast — this runs on the hot path

## Security

- The injector reads from the local store only — no network calls
- Node values may contain sensitive user information — the header text should not be logged at debug level by default

## Project Context

- Store implementation: `~/memrok/packages/store/`
- Architecture doc: `~/memrok/docs/architecture.md` (see "Context Injector" section)
