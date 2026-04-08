import type { Store, Node } from '@memrok/store';
import type {
  InjectorConfig,
  RelevanceWeights,
  ContextHeader,
  ContextHeaderDebugNode,
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

const PRODUCT_DEBUG_KEYWORDS = new Set([
  'product', 'feature', 'features', 'bug', 'bugs', 'debug', 'debugging',
  'issue', 'issues', 'error', 'errors', 'failure', 'failures', 'failing',
  'fix', 'fixes', 'regression', 'regressions', 'test', 'tests', 'build',
  'builds', 'deploy', 'release', 'code', 'coding', 'injector', 'ranking',
  'selection', 'topic', 'topics', 'context', 'qa', 'broken',
]);

const BROAD_BIO_ADMIN_KEYWORDS = new Set([
  'admin', 'administrative', 'biography', 'bio', 'background', 'profile',
  'profiles', 'identity', 'personal', 'personally', 'about', 'role', 'roles',
  'title', 'titles', 'preference', 'preferences', 'style', 'tone', 'routine',
  'routines', 'schedule', 'schedules', 'timezone', 'location', 'demographic',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  );
}

function similarityScore(a: string, b: string): number {
  const aSet = tokenize(a);
  const bSet = tokenize(b);
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection++;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function isNearDuplicate(candidate: string, selected: string[]): boolean {
  return selected.some((existing) => similarityScore(candidate, existing) >= 0.75);
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

function computeQueryCoverageScore(
  nodeKey: string,
  queryKeywords: Set<string>,
  kwCache: KeywordCache,
): number {
  if (queryKeywords.size === 0) return 0;

  const nkw = kwCache.nodeKeywords.get(nodeKey);
  if (!nkw || nkw.size === 0) return 0;

  let numerator = 0;
  let denominator = 0;

  for (const kw of queryKeywords) {
    const weight = kwCache.idf.get(kw) ?? 0;
    denominator += weight;
    if (nkw.has(kw)) {
      numerator += weight;
    }
  }

  if (denominator === 0) return 0;
  return numerator / denominator;
}

function countKeywordOverlap(tokens: Set<string>, keywords: Set<string>): number {
  let matches = 0;
  for (const token of tokens) {
    if (keywords.has(token)) matches++;
  }
  return matches;
}

function isProductDebugFocused(queryKeywords: Set<string>): boolean {
  return countKeywordOverlap(queryKeywords, PRODUCT_DEBUG_KEYWORDS) >= 2;
}

function computeBroadBioAdminScore(node: Node): number {
  const tokens = tokenize(`${node.key} ${node.category} ${node.value}`);
  const matches = countKeywordOverlap(tokens, BROAD_BIO_ADMIN_KEYWORDS);

  let score = Math.min(1, matches / 4);
  if (node.category === 'preference' || node.category === 'pref') {
    score = Math.max(score, 0.45);
  }
  if (node.key.includes('/bio') || node.key.includes('/profile') || node.key.includes('/admin')) {
    score = Math.max(score, 0.7);
  }

  return score;
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
    const productDebugFocused = isProductDebugFocused(queryKeywords);

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
      const queryCoverage = computeQueryCoverageScore(node.key, queryKeywords, kwCache);
      let score = scoreNode(node, weights, maxAge, semantic);

      if (layer === 'user' && queryKeywords.size > 0) {
        score += 0.2 * queryCoverage;
        if (queryCoverage >= 0.5) {
          score += 0.08;
        }
      }

      if (productDebugFocused) {
        const broadBioAdminScore = computeBroadBioAdminScore(node);
        if (broadBioAdminScore > 0) {
          const semanticMismatch = Math.max(0, 1 - semantic);
          score -= broadBioAdminScore * semanticMismatch * 0.18;
        }
      }

      layerNodes[layer].push({ node, score });
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
    const debugNodes: ContextHeaderDebugNode[] = [];
    const selectedValues: string[] = [];
    const categoryCounts = new Map<string, number>();
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

      const remaining = [...entries];
      while (remaining.length > 0) {
        let bestIndex = -1;
        let bestAdjustedScore = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const candidate = remaining[i];
          const categoryKey = `${candidate.node.layer}:${candidate.node.category}`;
          if ((categoryCounts.get(categoryKey) ?? 0) >= 2) continue;
          const similarities = selectedValues.map((value) => similarityScore(candidate.node.value, value));
          const maxSimilarity = similarities.length === 0 ? 0 : Math.max(...similarities);
          const avgSimilarity =
            similarities.length === 0
              ? 0
              : similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
          const adjustedScore = candidate.score - (maxSimilarity * 0.18) - (avgSimilarity * 0.08);
          if (adjustedScore > bestAdjustedScore) {
            bestAdjustedScore = adjustedScore;
            bestIndex = i;
          }
        }
        if (bestIndex === -1) break;
        const { node, score } = remaining.splice(bestIndex, 1)[0];
        if (isNearDuplicate(node.value, selectedValues)) continue;
        const categoryKey = `${node.layer}:${node.category}`;
        const line = `- ${truncateValue(node.value, maxNodeChars)}\n`;
        const lineTokens = estimateTokens(line);
        if (sectionTokens + lineTokens > budget) break;
        lines.push(line);
        selectedValues.push(node.value);
        categoryCounts.set(categoryKey, (categoryCounts.get(categoryKey) ?? 0) + 1);
        debugNodes.push({
          key: node.key,
          layer,
          category: node.category,
          value: node.value,
          score: bestAdjustedScore,
          updatedAt: node.updated_at,
          referenceCount: node.reference_count,
          correctionCount: node.correction_count,
        });
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
      debugNodes,
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
