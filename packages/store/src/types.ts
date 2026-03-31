export interface MutationSignals {
  emotional_weight?: number;
  explicit?: boolean;
  correction?: boolean;
}

export interface MutationInput {
  operation: 'add' | 'update' | 'expire';
  layer: 'user' | 'agent' | 'collaboration';
  category: string;
  key: string;
  value: string;
  evidence?: string;
  signals?: MutationSignals;
}

export interface ScribePass {
  pass_id: string;
  source?: string;
  model?: string;
  mutations: MutationInput[];
  meta?: {
    turns_processed?: number;
    observations?: string;
    duration_ms?: number;
  };
}

export interface Mutation {
  id: number;
  pass_id: string;
  timestamp: string;
  operation: 'add' | 'update' | 'expire';
  layer: string;
  category: string;
  key: string;
  value: string;
  evidence: string | null;
  source: string | null;
  emotional_weight: number;
  explicit: boolean;
  correction: boolean;
}

export interface Node {
  key: string;
  layer: string;
  category: string;
  value: string;
  evidence: string | null;
  created_at: string;
  updated_at: string;
  expired_at: string | null;
  version: number;
  emotional_weight: number;
  reference_count: number;
  correction_count: number;
  last_referenced: string | null;
  first_pass_id: string;
  last_pass_id: string;
}

export interface Pass {
  pass_id: string;
  timestamp: string;
  source: string | null;
  model: string | null;
  turns_processed: number | null;
  mutations_count: number | null;
  observations: string | null;
  duration_ms: number | null;
}

export interface NodeFilter {
  layer?: string;
  category?: string;
  active?: boolean;
  keyPrefix?: string;
}

export interface ApplyResult {
  pass_id: string;
  mutations_applied: number;
  nodes_created: number;
  nodes_updated: number;
  nodes_expired: number;
}

export interface Store {
  applyPass(pass: ScribePass): ApplyResult;
  queryNodes(filter?: NodeFilter): Node[];
  getNode(key: string): Node | null;
  getHistory(key: string): Mutation[];
  listPasses(): Pass[];
  rebuild(): void;
  close(): void;
}
