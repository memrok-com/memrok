import type { Store, Node } from '@memrok/store';
import type {
  InjectorConfig,
  RelevanceWeights,
  ContextHeader,
  Injector,
} from './types.js';

const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_MAX_NODE_CHARS = 150;
const DEFAULT_MAX_AGE = 90;
const DEFAULT_CACHE_MAX_AGE = 30000;

const DEFAULT_LAYER_WEIGHTS = { user: 0.5, agent: 0.25, collaboration: 0.25 };
const DEFAULT_RELEVANCE_WEIGHTS: RelevanceWeights = {
  recency: 0.15,
  frequency: 0.1,
  emotional: 0.1,
  correction: 0.15,
  semantic: 0.5,
};

const HEADER_PREAMBLE =
  'The following memory nodes are curated hints, not authoritative facts. ' +
  'Verify against actual state (files, tools, conversation) before relying on them.\n';

const LAYER_TITLES: Record<string, string> = {
  user: 'About the user',
  agent: 'About this agent',
  collaboration: 'About our collaboration',
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or', 'but', 'not',
  'this', 'that', 'it', 'be', 'as', 'do', 'did', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'shall',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her',
  'its', 'our', 'their', 'what', 'which', 'who', 'when', 'where', 'how',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  );
}

interface KeywordCache {
  nodeKeywords: Map<string, Set<string>>;
  idf: Map<string, number>;
  timestamp: number;
}

function buildKeywordCache(nodes: Node[]): KeywordCache {
  const nodeKeywords = new Map<string, Set<string>>();
  const df = new Map<string, number>();

  for (const node of nodes) {
    const keywords = tokenize(`${node.key} ${node.value}`);
    nodeKeywords.set(node.key, keywords);
    for (const kw of keywords) {
      df.set(kw, (df.get(kw) ?? 0) + 1);
    }
  }

  const N = nodes.length;
  const idf = new Map<string, number>();
  for (const [kw, count] of df) {
    idf.set(kw, Math.log((N + 1) / (count + 1)));
  }

  return { nodeKeywords, idf, timestamp: Date.now() };
}

function computeSemanticScore(
  nodeKey: string,
  queryKeywords: Set<string>,
  kwCache: KeywordCache,
): number {
  if (queryKeywords.size === 0) return 0.5;

  const nkw = kwCache.nodeKeywords.get(nodeKey);
  if (!nkw || nkw.size === 0) return 0.5;

  let numerator = 0;
  let denominator = 0;

  for (const kw of nkw) {
    const w = kwCache.idf.get(kw) ?? 0;
    denominator += w;
    if (queryKeywords.has(kw)) {
      numerator += w;
    }
  }

  if (denominator === 0) return 0.5;
  return numerator / denominator;
}

function truncateValue(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '\u2026';
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function recencyScore(updatedAt: string, maxAge: number): number {
  const ageDays =
    (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1;
  const lambda = Math.log(2) / (maxAge / 3); // half-life at 1/3 of maxAge
  return Math.exp(-lambda * ageDays);
}

function normalize(value: number): number {
  return Math.min(1, value / 10);
}

function scoreNode(
  node: Node,
  weights: RelevanceWeights,
  maxAge: number,
  semantic: number,
): number {
  return (
    weights.recency * recencyScore(node.updated_at, maxAge) +
    weights.frequency * normalize(node.reference_count) +
    weights.emotional * node.emotional_weight +
    weights.correction * normalize(node.correction_count) +
    weights.semantic * semantic
  );
}

type LayerName = 'user' | 'agent' | 'collaboration';

export function createInjector(
  store: Store,
  config?: InjectorConfig
): Injector {
  const tokenBudget = config?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const maxNodeChars = config?.maxNodeChars ?? DEFAULT_MAX_NODE_CHARS;
  const maxAge = config?.maxAge ?? DEFAULT_MAX_AGE;
  const cacheMaxAge = config?.cacheMaxAge ?? DEFAULT_CACHE_MAX_AGE;

  const layerWeights = {
    user: config?.layerWeights?.user ?? DEFAULT_LAYER_WEIGHTS.user,
    agent: config?.layerWeights?.agent ?? DEFAULT_LAYER_WEIGHTS.agent,
    collaboration:
      config?.layerWeights?.collaboration ??
      DEFAULT_LAYER_WEIGHTS.collaboration,
  };

  const weights: RelevanceWeights = {
    recency:
      config?.relevanceWeights?.recency ?? DEFAULT_RELEVANCE_WEIGHTS.recency,
    frequency:
      config?.relevanceWeights?.frequency ??
      DEFAULT_RELEVANCE_WEIGHTS.frequency,
    emotional:
      config?.relevanceWeights?.emotional ??
      DEFAULT_RELEVANCE_WEIGHTS.emotional,
    correction:
      config?.relevanceWeights?.correction ??
      DEFAULT_RELEVANCE_WEIGHTS.correction,
    semantic:
      config?.relevanceWeights?.semantic ?? DEFAULT_RELEVANCE_WEIGHTS.semantic,
  };

  let cache: { header: ContextHeader; timestamp: number } | null = null;
  let kwCache: KeywordCache | null = null;

  function assemble(context?: { recentMessages?: string }): ContextHeader {
    const recentMessages = context?.recentMessages ?? '';

    // Header cache is only valid for context-free calls (no recentMessages)
    if (!recentMessages && cache && Date.now() - cache.timestamp < cacheMaxAge) {
      return { ...cache.header, cachedAt: cache.timestamp };
    }

    const start = performance.now();
    const nodes = store.queryNodes({ active: true });

    // Build/refresh keyword cache (independent of query, invalidated with store)
    if (!kwCache || Date.now() - kwCache.timestamp >= cacheMaxAge) {
      kwCache = buildKeywordCache(nodes);
    }

    // Tokenize query; empty query falls back to 0.5 per-node inside computeSemanticScore
    const queryKeywords = recentMessages ? tokenize(recentMessages) : new Set<string>();

    // Group by layer and score
    const layerNodes: Record<LayerName, { node: Node; score: number }[]> = {
      user: [],
      agent: [],
      collaboration: [],
    };

    for (const node of nodes) {
      const layer = node.layer as LayerName;
      if (!(layer in layerNodes)) continue;
      const semantic = computeSemanticScore(node.key, queryKeywords, kwCache);
      layerNodes[layer].push({
        node,
        score: scoreNode(node, weights, maxAge, semantic),
      });
    }

    // Sort each layer by score descending
    for (const layer of Object.keys(layerNodes) as LayerName[]) {
      layerNodes[layer].sort((a, b) => b.score - a.score);
    }

    // Allocate token budget proportionally
    const headerPrefix = '## Memory Context (Memrok)\n' + HEADER_PREAMBLE;
    const prefixTokens = estimateTokens(headerPrefix);
    const remainingBudget = tokenBudget - prefixTokens;

    const sections: string[] = [];
    const layerCounts: Record<LayerName, number> = {
      user: 0,
      agent: 0,
      collaboration: 0,
    };
    let totalNodesUsed = 0;

    for (const layer of ['user', 'agent', 'collaboration'] as LayerName[]) {
      const budget = Math.floor(remainingBudget * layerWeights[layer]);
      const entries = layerNodes[layer];
      if (entries.length === 0) continue;

      const sectionHeader = `\n### ${LAYER_TITLES[layer]}\n`;
      let sectionTokens = estimateTokens(sectionHeader);
      const lines: string[] = [];

      for (const { node } of entries) {
        const line = `- ${truncateValue(node.value, maxNodeChars)}\n`;
        const lineTokens = estimateTokens(line);
        if (sectionTokens + lineTokens > budget) break;
        lines.push(line);
        sectionTokens += lineTokens;
        layerCounts[layer]++;
        totalNodesUsed++;
      }

      if (lines.length > 0) {
        sections.push(sectionHeader + lines.join(''));
      }
    }

    const text =
      totalNodesUsed > 0 ? headerPrefix + sections.join('') : '';
    const assemblyMs = performance.now() - start;

    const header: ContextHeader = {
      text,
      tokens: estimateTokens(text),
      nodesUsed: totalNodesUsed,
      layers: layerCounts,
      assemblyMs,
    };

    // Only cache context-free results (semantic results vary per conversation)
    if (!recentMessages) {
      cache = { header, timestamp: Date.now() };
    }

    return header;
  }

  function invalidate(): void {
    cache = null;
    kwCache = null;
  }

  function getWeights(): RelevanceWeights {
    return { ...weights };
  }

  function setWeight(signal: string, value: number): void {
    if (signal in weights) {
      (weights as unknown as Record<string, number>)[signal] = Math.max(0, Math.min(1, value));
      invalidate();
    }
  }

  return { assemble, invalidate, getWeights, setWeight };
}
