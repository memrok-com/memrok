import type { Store, Node } from '@memrok/store';
import type {
  InjectorConfig,
  RelevanceWeights,
  ContextHeader,
  Injector,
} from './types.js';

const DEFAULT_TOKEN_BUDGET = 1000;
const DEFAULT_MAX_AGE = 90;
const DEFAULT_CACHE_MAX_AGE = 30000;

const DEFAULT_LAYER_WEIGHTS = { user: 0.5, agent: 0.25, collaboration: 0.25 };
const DEFAULT_RELEVANCE_WEIGHTS: RelevanceWeights = {
  recency: 0.3,
  frequency: 0.15,
  emotional: 0.2,
  correction: 0.15,
  semantic: 0.2,
};

const LAYER_TITLES: Record<string, string> = {
  user: 'About the user',
  agent: 'About this agent',
  collaboration: 'About our collaboration',
};

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
  maxAge: number
): number {
  return (
    weights.recency * recencyScore(node.updated_at, maxAge) +
    weights.frequency * normalize(node.reference_count) +
    weights.emotional * node.emotional_weight +
    weights.correction * normalize(node.correction_count) +
    weights.semantic * 0.5
  );
}

type LayerName = 'user' | 'agent' | 'collaboration';

export function createInjector(
  store: Store,
  config?: InjectorConfig
): Injector {
  const tokenBudget = config?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
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

  function assemble(context?: { recentMessages?: string }): ContextHeader {
    // Check cache
    if (cache && Date.now() - cache.timestamp < cacheMaxAge) {
      return { ...cache.header, cachedAt: cache.timestamp };
    }

    const start = performance.now();
    const nodes = store.queryNodes({ active: true });

    // Group by layer and score
    const layerNodes: Record<LayerName, { node: Node; score: number }[]> = {
      user: [],
      agent: [],
      collaboration: [],
    };

    for (const node of nodes) {
      const layer = node.layer as LayerName;
      if (!(layer in layerNodes)) continue;
      layerNodes[layer].push({
        node,
        score: scoreNode(node, weights, maxAge),
      });
    }

    // Sort each layer by score descending
    for (const layer of Object.keys(layerNodes) as LayerName[]) {
      layerNodes[layer].sort((a, b) => b.score - a.score);
    }

    // Allocate token budget proportionally
    const headerPrefix = '## Memory Context (Memrok)\n';
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
        const line = `- ${node.value}\n`;
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

    cache = { header, timestamp: Date.now() };
    return header;
  }

  function invalidate(): void {
    cache = null;
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
