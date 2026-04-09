import type { GraphStore, Node, WorkingSetStore } from '@memrok/store';
import type {
  InjectorConfig,
  RelevanceWeights,
  WorkingSet,
  WorkingSetItem,
  ContextHeader,
  ContextHeaderDebugNode,
  Injector,
} from './types.js';

const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_MAX_NODE_CHARS = 150;
const DEFAULT_MAX_AGE = 90;
const DEFAULT_CACHE_MAX_AGE = 30000;
const DEFAULT_WORKING_SET_SNAPSHOT_LIMIT = 50;

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

const GENERIC_META_KEYWORDS = new Set([
  'memory', 'memories', 'context', 'selection', 'ranking', 'retrieval',
  'recall', 'judgment', 'curation', 'graph', 'graphs', 'topic', 'topics',
  'meta', 'system', 'baseline',
]);

const DOMAIN_KEYWORDS: Record<string, Set<string>> = {
  memrok: new Set(['memrok', 'injector', 'reflection', 'scribe', 'clawhub']),
  priomind: new Set(['priomind', 'tweet', 'tweets', 'linkedin', 'pricing', 'customer', 'landing']),
  zhaw: new Set(['zhaw', 'art', 'architecture', 'confluence', 'jira', 'evento']),
  fcl: new Set(['fcl', 'spielleiter', 'ifv', 'refsix', 'match', 'matches']),
  orbitals: new Set(['orbitals', 'episode', 'script', 'scene', 'character', 'pilot']),
  infra: new Set(['infra', 'infrastructure', 'gateway', 'cron', 'telegram', 'provider', 'openclaw']),
  health: new Set(['health', 'wellbeing', 'sleep', 'sick', 'energy']),
  learning: new Set(['learning', 'learn', 'study', 'reading', 'course']),
};

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

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[/.]+/g, '/');
}

function getKeySegments(key: string): string[] {
  return normalizeKey(key).split('/').filter(Boolean);
}

function getNodeFamily(node: Node): string {
  const segments = getKeySegments(node.key);
  if (segments.length <= 1) return segments[0] ?? node.key.toLowerCase();
  return segments.slice(0, Math.min(3, segments.length)).join('/');
}

function getNodeDomainSignature(node: Node): string | null {
  const segments = getKeySegments(node.key);
  if (segments.length < 2) return null;
  if (segments[0] === 'user' || segments[0] === 'agent' || segments[0] === 'collaboration' || segments[0] === 'collab') {
    return segments[1];
  }
  return segments[0];
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

function detectDomainFocus(queryKeywords: Set<string>): string | null {
  let bestDomain: string | null = null;
  let bestScore = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = countKeywordOverlap(queryKeywords, keywords);
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  return bestScore >= 2 ? bestDomain : null;
}

function classifyNodeDomain(node: Node): string | null {
  const signature = getNodeDomainSignature(node);
  const aliasMap: Record<string, string> = {
    memrok: 'memrok',
    priomind: 'priomind',
    linkedin: 'priomind',
    social: 'priomind',
    content: 'priomind',
    zhaw: 'zhaw',
    work: 'zhaw',
    arch: 'zhaw',
    fcl: 'fcl',
    orbitals: 'orbitals',
    creative: 'orbitals',
    infra: 'infra',
    memory: 'infra',
    health: 'health',
    learning: 'learning',
  };
  if (signature && aliasMap[signature]) return aliasMap[signature];

  const tokens = tokenize(`${node.key} ${node.value}`);
  let bestDomain: string | null = null;
  let bestScore = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = countKeywordOverlap(tokens, keywords);
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  return bestScore >= 2 ? bestDomain : null;
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

function computeGenericMetaScore(node: Node): number {
  const tokens = tokenize(`${node.key} ${node.category} ${node.value}`);
  const matches = countKeywordOverlap(tokens, GENERIC_META_KEYWORDS);
  return Math.min(1, matches / 4);
}

function computeOutOfContextRisk(params: {
  queryKeywords: Set<string>;
  semantic: number;
  queryCoverage: number;
  domainFocus: string | null;
  nodeDomain: string | null;
  genericMetaScore: number;
}): number {
  if (params.queryKeywords.size === 0) return 0;

  let risk = 0;
  if (params.semantic < 0.18 && params.queryCoverage < 0.12) {
    risk += 0.55;
  } else if (params.semantic < 0.28 && params.queryCoverage < 0.2) {
    risk += 0.3;
  }

  if (params.domainFocus && params.nodeDomain && params.nodeDomain !== params.domainFocus && params.queryCoverage < 0.18) {
    risk += 0.3;
  }

  if (params.genericMetaScore >= 0.5 && params.queryCoverage < 0.18) {
    risk += 0.2;
  }

  return Math.min(1, risk);
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

interface ScoredCandidate {
  node: Node;
  score: number;
  rawScore: number;
  semantic: number;
  queryCoverage: number;
  keyTokenCoverage: number;
  family: string;
  domain: string | null;
  domainMatch: boolean | null;
  outOfContextRisk: number;
  selectedBecause: string[];
  scoreAdjustments: {
    queryCoverageBoost: number;
    keyMatchBoost: number;
    domainBoost: number;
    broadBioPenalty: number;
    genericMetaPenalty: number;
    crossDomainPenalty: number;
    selectionSimilarityPenalty: number;
    selectionFamilyPenalty: number;
    selectionDomainPenalty: number;
  };
}

export function createInjector(
  store: GraphStore & WorkingSetStore,
  config?: InjectorConfig
): Injector {
  const tokenBudget = config?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const maxNodeChars = config?.maxNodeChars ?? DEFAULT_MAX_NODE_CHARS;
  const maxAge = config?.maxAge ?? DEFAULT_MAX_AGE;
  const cacheMaxAge = config?.cacheMaxAge ?? DEFAULT_CACHE_MAX_AGE;
  const workingSetSnapshotLimit =
    config?.workingSetSnapshotLimit ?? DEFAULT_WORKING_SET_SNAPSHOT_LIMIT;

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

  function selectWorkingSet(context?: { recentMessages?: string; sessionId?: string }): WorkingSet {
    const recentMessages = context?.recentMessages ?? '';
    const nodes = store.queryNodes({ active: true });

    // Build/refresh keyword cache (independent of query, invalidated with store)
    if (!kwCache || Date.now() - kwCache.timestamp >= cacheMaxAge) {
      kwCache = buildKeywordCache(nodes);
    }

    // Tokenize query; empty query falls back to 0.5 per-node inside computeSemanticScore
    const queryKeywords = recentMessages ? tokenize(recentMessages) : new Set<string>();
    const productDebugFocused = isProductDebugFocused(queryKeywords);
    const domainFocus = detectDomainFocus(queryKeywords);

    // Group by layer and score
    const layerNodes: Record<LayerName, ScoredCandidate[]> = {
      user: [],
      agent: [],
      collaboration: [],
    };

    for (const node of nodes) {
      const layer = node.layer as LayerName;
      if (!(layer in layerNodes)) continue;
      const semantic = computeSemanticScore(node.key, queryKeywords, kwCache);
      const queryCoverage = computeQueryCoverageScore(node.key, queryKeywords, kwCache);
      const baseScore = scoreNode(node, weights, maxAge, semantic);
      let score = baseScore;
      const nodeDomain = classifyNodeDomain(node);
      const genericMetaScore = computeGenericMetaScore(node);
      const keyTokenCoverage = queryKeywords.size > 0
        ? countKeywordOverlap(queryKeywords, tokenize(node.key))
        : 0;
      let queryCoverageBoost = 0;
      let keyMatchBoost = 0;
      let domainBoost = 0;
      let broadBioPenalty = 0;
      let genericMetaPenalty = 0;
      let crossDomainPenalty = 0;
      const selectedBecause: string[] = [];

      if (layer === 'user' && queryKeywords.size > 0) {
        queryCoverageBoost += 0.2 * queryCoverage;
        if (queryCoverage >= 0.5) {
          queryCoverageBoost += 0.08;
        }
        score += queryCoverageBoost;
      }

      if (queryKeywords.size > 0) {
        if (keyTokenCoverage >= 2) {
          keyMatchBoost += 0.1;
        } else if (keyTokenCoverage === 1 && queryCoverage >= 0.25) {
          keyMatchBoost += 0.04;
        }
        score += keyMatchBoost;
      }

      if (productDebugFocused) {
        const broadBioAdminScore = computeBroadBioAdminScore(node);
        if (broadBioAdminScore > 0) {
          const semanticMismatch = Math.max(0, 1 - semantic);
          broadBioPenalty = broadBioAdminScore * semanticMismatch * 0.18;
          score -= broadBioPenalty;
        }
      }

      if (domainFocus) {
        if (nodeDomain === domainFocus) {
          domainBoost += 0.16;
          domainBoost += 0.08 * queryCoverage;
          if (genericMetaScore > 0 && queryCoverage >= 0.2) {
            domainBoost += 0.04;
          }
          score += domainBoost;
        } else if (nodeDomain && queryCoverage < 0.18) {
          crossDomainPenalty += 0.18;
          if (semantic < 0.2) crossDomainPenalty += 0.1;
          score -= crossDomainPenalty;
        } else if (!nodeDomain && genericMetaScore > 0 && queryCoverage < 0.2) {
          genericMetaPenalty = 0.1 * genericMetaScore;
          score -= genericMetaPenalty;
        } else if (!nodeDomain && queryCoverage < 0.08) {
          genericMetaPenalty = 0.04;
          score -= genericMetaPenalty;
        }
      }

      if (semantic >= 0.35) selectedBecause.push('semantic match');
      if (queryCoverageBoost > 0.12) selectedBecause.push('query coverage');
      if (keyMatchBoost > 0) selectedBecause.push('key-family overlap');
      if (domainBoost > 0) selectedBecause.push('domain-local recall');
      if (baseScore >= 0.45 && selectedBecause.length === 0) selectedBecause.push('durable baseline relevance');

      layerNodes[layer].push({
        node,
        score,
        rawScore: score,
        semantic,
        queryCoverage,
        keyTokenCoverage,
        family: getNodeFamily(node),
        domain: nodeDomain,
        domainMatch: domainFocus ? nodeDomain === domainFocus : null,
        outOfContextRisk: computeOutOfContextRisk({
          queryKeywords,
          semantic,
          queryCoverage,
          domainFocus,
          nodeDomain,
          genericMetaScore,
        }),
        selectedBecause,
        scoreAdjustments: {
          queryCoverageBoost,
          keyMatchBoost,
          domainBoost,
          broadBioPenalty,
          genericMetaPenalty,
          crossDomainPenalty,
          selectionSimilarityPenalty: 0,
          selectionFamilyPenalty: 0,
          selectionDomainPenalty: 0,
        },
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

    const workingSetItems: WorkingSetItem[] = [];
    const selectedValues: string[] = [];
    const selectedFamilies = new Map<string, number>();
    const selectedDomains = new Map<string, number>();
    const categoryCounts = new Map<string, number>();
    const layerCounts: Record<LayerName, number> = {
      user: 0,
      agent: 0,
      collaboration: 0,
    };

    for (const layer of ['user', 'agent', 'collaboration'] as LayerName[]) {
      const budget = Math.floor(remainingBudget * layerWeights[layer]);
      const entries = layerNodes[layer];
      if (entries.length === 0) continue;

      const sectionHeader = `\n### ${LAYER_TITLES[layer]}\n`;
      let sectionTokens = estimateTokens(sectionHeader);

      const remaining = [...entries];
      while (remaining.length > 0) {
        let bestIndex = -1;
        let bestAdjustedScore = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const candidate = remaining[i];
          const categoryKey = `${candidate.node.layer}:${candidate.node.category}`;
          if ((categoryCounts.get(categoryKey) ?? 0) >= 2) continue;
          const family = candidate.family;
          if (queryKeywords.size > 0 && (selectedFamilies.get(family) ?? 0) >= 2) continue;
          const similarities = selectedValues.map((value) => similarityScore(candidate.node.value, value));
          const maxSimilarity = similarities.length === 0 ? 0 : Math.max(...similarities);
          const avgSimilarity =
            similarities.length === 0
              ? 0
              : similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
          const familyPenalty = (selectedFamilies.get(family) ?? 0) * 0.2;
          const domain = candidate.domain;
          const domainPenalty =
            domain && domainFocus && domain !== domainFocus
              ? (selectedDomains.get(domain) ?? 0) * 0.08
              : 0;
          const similarityPenalty = (maxSimilarity * 0.18) + (avgSimilarity * 0.08);
          const adjustedScore =
            candidate.score -
            similarityPenalty -
            familyPenalty -
            domainPenalty;
          if (adjustedScore > bestAdjustedScore) {
            bestAdjustedScore = adjustedScore;
            bestIndex = i;
          }
        }
        if (bestIndex === -1) break;
        const selected = remaining.splice(bestIndex, 1)[0];
        const { node, rawScore } = selected;
        if (isNearDuplicate(node.value, selectedValues)) continue;
        const latestMutation = store.getHistory(node.key).at(-1) ?? null;
        const categoryKey = `${node.layer}:${node.category}`;
        const line = `- ${truncateValue(node.value, maxNodeChars)}\n`;
        const lineTokens = estimateTokens(line);
        if (sectionTokens + lineTokens > budget) break;
        selectedValues.push(node.value);
        const family = selected.family;
        selectedFamilies.set(family, (selectedFamilies.get(family) ?? 0) + 1);
        const domain = selected.domain;
        if (domain) {
          selectedDomains.set(domain, (selectedDomains.get(domain) ?? 0) + 1);
        }
        categoryCounts.set(categoryKey, (categoryCounts.get(categoryKey) ?? 0) + 1);
        const similarities = selectedValues
          .slice(0, -1)
          .map((value) => similarityScore(node.value, value));
        const maxSimilarity = similarities.length === 0 ? 0 : Math.max(...similarities);
        const avgSimilarity =
          similarities.length === 0
            ? 0
            : similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
        const selectionSimilarityPenalty = (maxSimilarity * 0.18) + (avgSimilarity * 0.08);
        const selectionFamilyPenalty = Math.max(0, ((selectedFamilies.get(family) ?? 1) - 1) * 0.2);
        const selectionDomainPenalty =
          domain && domainFocus && domain !== domainFocus
            ? Math.max(0, ((selectedDomains.get(domain) ?? 1) - 1) * 0.08)
            : 0;
        workingSetItems.push({
          key: node.key,
          passId: node.last_pass_id ?? null,
          mutationId: latestMutation?.id ?? null,
          layer,
          category: node.category,
          value: node.value,
          score: bestAdjustedScore,
          rawScore,
          updatedAt: node.updated_at,
          referenceCount: node.reference_count,
          correctionCount: node.correction_count,
          semanticScore: selected.semantic,
          queryCoverage: selected.queryCoverage,
          keyTokenCoverage: selected.keyTokenCoverage,
          family,
          domain,
          domainMatch: selected.domainMatch,
          outOfContextRisk: selected.outOfContextRisk,
          selectedBecause: selected.selectedBecause,
          scoreAdjustments: {
            ...selected.scoreAdjustments,
            selectionSimilarityPenalty,
            selectionFamilyPenalty,
            selectionDomainPenalty,
          },
        });
        sectionTokens += lineTokens;
        layerCounts[layer]++;
      }
    }

    return {
      query: recentMessages,
      items: workingSetItems,
      layers: layerCounts,
    };
  }

  function renderWorkingSet(workingSet: WorkingSet): ContextHeader {
    const start = performance.now();
    const sections: string[] = [];
    const debugNodes: ContextHeaderDebugNode[] = [];

    for (const layer of ['user', 'agent', 'collaboration'] as LayerName[]) {
      const items = workingSet.items.filter((item) => item.layer === layer);
      if (items.length === 0) continue;
      const sectionHeader = `\n### ${LAYER_TITLES[layer]}\n`;
      const lines = items.map((item) => `- ${truncateValue(item.value, maxNodeChars)}\n`);
      sections.push(sectionHeader + lines.join(''));
      debugNodes.push(
        ...items.map((item) => ({
          key: item.key,
          layer: item.layer,
          category: item.category,
          value: item.value,
          score: item.score,
          rawScore: item.rawScore,
          updatedAt: item.updatedAt,
          referenceCount: item.referenceCount,
          correctionCount: item.correctionCount,
          semanticScore: item.semanticScore,
          queryCoverage: item.queryCoverage,
          keyTokenCoverage: item.keyTokenCoverage,
          family: item.family,
          domain: item.domain,
          domainMatch: item.domainMatch,
          outOfContextRisk: item.outOfContextRisk,
          selectedBecause: item.selectedBecause,
          scoreAdjustments: item.scoreAdjustments,
        }))
      );
    }

    const text =
      workingSet.items.length > 0
        ? '## Memory Context (Memrok)\n' + HEADER_PREAMBLE + sections.join('')
        : '';

    return {
      text,
      tokens: estimateTokens(text),
      nodesUsed: workingSet.items.length,
      layers: workingSet.layers,
      debugNodes,
      assemblyMs: performance.now() - start,
    };
  }

  function assemble(context?: { recentMessages?: string; sessionId?: string }): ContextHeader {
    const recentMessages = context?.recentMessages ?? '';

    // Header cache is only valid for context-free calls (no recentMessages)
    if (!recentMessages && cache && Date.now() - cache.timestamp < cacheMaxAge) {
      return { ...cache.header, cachedAt: cache.timestamp };
    }

    const workingSet = selectWorkingSet(context);
    const header = renderWorkingSet(workingSet);

    store.createWorkingSetSnapshot(
      {
        sessionId: context?.sessionId,
        query: workingSet.query || undefined,
        headerText: header.text,
        headerTokens: header.tokens,
        nodesUsed: header.nodesUsed,
        items: workingSet.items.map((item) => ({
          nodeKey: item.key,
          passId: item.passId,
          mutationId: item.mutationId,
          layer: item.layer,
          category: item.category,
          value: item.value,
          score: item.score,
          rawScore: item.rawScore,
          reason: item.selectedBecause.join(', '),
        })),
      },
      { maxSnapshots: workingSetSnapshotLimit },
    );

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

  return { selectWorkingSet, renderWorkingSet, assemble, invalidate, getWeights, setWeight };
}
