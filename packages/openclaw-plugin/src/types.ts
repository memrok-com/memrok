/** Plugin configuration from openclaw.json entries. */
export interface MemrokPluginConfig {
  daemonUrl?: string;
  timeoutMs?: number;
  retryMs?: number;
  maxRetries?: number;
}

/** Resolved config with defaults applied. */
export interface ResolvedConfig {
  daemonUrl: string;
  timeoutMs: number;
  retryMs: number;
  maxRetries: number;
}

/** Shape returned by daemon POST /header. */
export interface ContextHeader {
  text: string;
  tokens: number;
  nodesUsed: number;
  layers: {
    user: number;
    agent: number;
    collaboration: number;
  };
  cachedAt?: number;
  assemblyMs: number;
}

/** Message type matching OpenClaw's message shape. */
export interface Message {
  role: string;
  content: string;
  [key: string]: unknown;
}

/** Params for assemble(). */
export interface AssembleParams {
  sessionId: string;
  messages: Message[];
  tokenBudget: number;
}

/** Result from assemble(). */
export interface AssembleResult {
  messages: Message[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}

/** Params for compact(). */
export interface CompactParams {
  sessionId: string;
  force?: boolean;
}

/** Params for ingest(). */
export interface IngestParams {
  sessionId: string;
  message: Message;
  isHeartbeat?: boolean;
}

/** Params for afterTurn(). */
export interface AfterTurnParams {
  sessionId: string;
}

/** The context engine interface as expected by OpenClaw. */
export interface ContextEngine {
  info: {
    id: string;
    name: string;
    ownsCompaction: boolean;
  };
  assemble(params: AssembleParams): Promise<AssembleResult>;
  compact(params: CompactParams): Promise<{ ok: boolean; compacted: boolean }>;
  ingest(params: IngestParams): Promise<{ ingested: boolean }>;
  afterTurn(params: AfterTurnParams): Promise<void>;
}

/** OpenClaw plugin API. */
export interface PluginApi {
  registerContextEngine(id: string, factory: () => ContextEngine): void;
}
