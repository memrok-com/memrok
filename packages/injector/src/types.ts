export interface InjectorConfig {
  tokenBudget?: number;
  maxNodeChars?: number;
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
  updatedAt: string;
  referenceCount: number;
  correctionCount: number;
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

export interface Injector {
  assemble(context?: { recentMessages?: string }): ContextHeader;
  invalidate(): void;
  getWeights(): RelevanceWeights;
  setWeight(signal: string, value: number): void;
}
