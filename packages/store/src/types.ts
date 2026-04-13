export interface MutationSignals {
  emotional_weight?: number;
  explicit?: boolean;
  correction?: boolean;
}

export interface ArchiveObservation {
  id: number;
  kind: string;
  source: string;
  session_id: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface CreateArchiveObservationInput {
  kind: string;
  source: string;
  sessionId?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface DerivedArtifact {
  id: number;
  kind: string;
  observation_id: number | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface CreateDerivedArtifactInput {
  kind: string;
  observationId?: number;
  content: string;
  metadata?: Record<string, unknown>;
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
  derived_artifact_id?: number;
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
  hygiene: NodeHygieneRecord | null;
}

export interface Pass {
  pass_id: string;
  timestamp: string;
  source: string | null;
  model: string | null;
  derived_artifact_id: number | null;
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

export type NodeHygieneState = 'suppressed' | 'deprioritized';
export type NodeHygieneAction = 'exclude' | 'deprioritize';

export interface NodeHygieneRecord {
  node_key: string;
  state: NodeHygieneState;
  action: NodeHygieneAction;
  score: number;
  rationale: string;
  reason_codes: string[];
  details: Record<string, unknown> | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface NodeHygieneEvent {
  id: number;
  node_key: string;
  event_type: 'set' | 'clear';
  state: NodeHygieneState | null;
  action: NodeHygieneAction | null;
  score: number | null;
  rationale: string | null;
  reason_codes: string[];
  details: Record<string, unknown> | null;
  source: string;
  created_at: string;
}

export interface UpsertNodeHygieneInput {
  nodeKey: string;
  state: NodeHygieneState;
  action: NodeHygieneAction;
  score: number;
  rationale: string;
  reasonCodes: string[];
  details?: Record<string, unknown>;
  source: string;
}

export interface ApplyResult {
  pass_id: string;
  mutations_applied: number;
  nodes_created: number;
  nodes_updated: number;
  nodes_expired: number;
}

export interface WorkingSetSnapshot {
  id: number;
  session_id: string | null;
  query: string | null;
  header_text: string;
  header_tokens: number;
  nodes_used: number;
  created_at: string;
}

export interface WorkingSetSnapshotItem {
  id: number;
  snapshot_id: number;
  node_key: string;
  pass_id: string | null;
  mutation_id: number | null;
  layer: 'user' | 'agent' | 'collaboration';
  category: string;
  value: string;
  score: number;
  raw_score: number;
  reason: string | null;
}

export interface CreateWorkingSetSnapshotInput {
  sessionId?: string;
  query?: string;
  headerText: string;
  headerTokens: number;
  nodesUsed: number;
  items: Array<{
    nodeKey: string;
    passId?: string | null;
    mutationId?: number | null;
    layer: 'user' | 'agent' | 'collaboration';
    category: string;
    value: string;
    score: number;
    rawScore: number;
    reason?: string;
  }>;
}

export interface WorkingSetRetentionPolicy {
  maxSnapshots: number;
}

export interface ProvenanceLink {
  observation: ArchiveObservation | null;
  artifact: DerivedArtifact | null;
  pass: Pass | null;
}

export interface WorkingSetSnapshotTrace extends WorkingSetSnapshot {
  items: WorkingSetSnapshotItem[];
}

export interface ArchiveStore {
  createArchiveObservation(input: CreateArchiveObservationInput): ArchiveObservation;
  listArchiveObservations(limit?: number): ArchiveObservation[];
  getArchiveObservation(id: number): ArchiveObservation | null;
}

export interface ArtifactStore {
  createDerivedArtifact(input: CreateDerivedArtifactInput): DerivedArtifact;
  listDerivedArtifacts(limit?: number): DerivedArtifact[];
  getDerivedArtifact(id: number): DerivedArtifact | null;
}

export interface GraphStore {
  applyPass(pass: ScribePass): ApplyResult;
  queryNodes(filter?: NodeFilter): Node[];
  getNode(key: string): Node | null;
  getHistory(key: string): Mutation[];
  getNodeHygiene(key: string): NodeHygieneRecord | null;
  listNodeHygiene(): NodeHygieneRecord[];
  listNodeHygieneEvents(limit?: number): NodeHygieneEvent[];
  upsertNodeHygiene(input: UpsertNodeHygieneInput): NodeHygieneRecord;
  clearNodeHygiene(key: string, source: string, rationale?: string): boolean;
  listPasses(): Pass[];
  getProvenanceForPass(passId: string): ProvenanceLink;
  rebuild(): void;
}

export interface WorkingSetStore {
  createWorkingSetSnapshot(
    input: CreateWorkingSetSnapshotInput,
    retention?: WorkingSetRetentionPolicy,
  ): WorkingSetSnapshotTrace;
  listWorkingSetSnapshots(limit?: number): WorkingSetSnapshot[];
  getWorkingSetSnapshot(id: number): WorkingSetSnapshotTrace | null;
  getProvenanceForWorkingSetSnapshot(snapshotId: number): ProvenanceLink[];
}

export interface Store extends ArchiveStore, ArtifactStore, GraphStore, WorkingSetStore {
  close(): void;
}
