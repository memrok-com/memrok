export interface InjectorConfig {
  tokenBudget?: number;
  maxNodeChars?: number;
  workingSetSnapshotLimit?: number;
  layerWeights?: {
    user?: number;
    agent?: number;
    collaboration?: number;
  };
  relevanceWeights?: {
    recency?: number;
    frequency?: number;
    emotional?: number;
    correction?: number;
    semantic?: number;
  };
  maxAge?: number;
  cacheMaxAge?: number;
}

export interface RelevanceWeights {
  recency: number;
  frequency: number;
  emotional: number;
  correction: number;
  semantic: number;
}

export interface ContextHeaderDebugNode {
  key: string;
  layer: 'user' | 'agent' | 'collaboration';
  category: string;
  value: string;
  score: number;
  rawScore: number;
  updatedAt: string;
  referenceCount: number;
  correctionCount: number;
  semanticScore: number;
  queryCoverage: number;
  keyTokenCoverage: number;
  family: string;
  domain: string | null;
  domainMatch: boolean | null;
  outOfContextRisk: number;
  selectedBecause: string[];
  anchorIds: string[];
  matchedAnchorIds: string[];
  scoreAdjustments: {
    queryCoverageBoost: number;
    keyMatchBoost: number;
    domainBoost: number;
    anchorBoost: number;
    anchorMismatchPenalty: number;
    broadBioPenalty: number;
    genericMetaPenalty: number;
    crossDomainPenalty: number;
    selectionSimilarityPenalty: number;
    selectionFamilyPenalty: number;
    selectionDomainPenalty: number;
  };
}

export interface WorkingSetItem {
  key: string;
  passId: string | null;
  mutationId: number | null;
  layer: 'user' | 'agent' | 'collaboration';
  category: string;
  value: string;
  score: number;
  rawScore: number;
  updatedAt: string;
  referenceCount: number;
  correctionCount: number;
  semanticScore: number;
  queryCoverage: number;
  keyTokenCoverage: number;
  family: string;
  domain: string | null;
  domainMatch: boolean | null;
  outOfContextRisk: number;
  selectedBecause: string[];
  anchorIds: string[];
  matchedAnchorIds: string[];
  scoreAdjustments: ContextHeaderDebugNode['scoreAdjustments'];
}

export interface WorkingSet {
  query: string;
  items: WorkingSetItem[];
  layers: {
    user: number;
    agent: number;
    collaboration: number;
  };
}

export interface ContextHeader {
  text: string;
  tokens: number;
  nodesUsed: number;
  layers: {
    user: number;
    agent: number;
    collaboration: number;
  };
  debugNodes?: ContextHeaderDebugNode[];
  cachedAt?: number;
  assemblyMs: number;
}

export interface AssembleContext {
  recentMessages?: string;
  sessionId?: string;
  noPersist?: boolean;
}

export interface Injector {
  selectWorkingSet(context?: AssembleContext): WorkingSet;
  renderWorkingSet(workingSet: WorkingSet): ContextHeader;
  assemble(context?: AssembleContext): ContextHeader;
  invalidate(): void;
  getWeights(): RelevanceWeights;
  setWeight(signal: string, value: number): void;
}
