import type { ContextHeader } from '@memrok/injector';

export interface ReflectionConfig {
  /** Enable reflective scribe passes. Default: true */
  enabled?: boolean;
  /** Number of transcript scribe passes since last reflection before reflecting. Default: 5 */
  deltaPasses?: number;
  /** Minimum hours between reflections. Default: 24 */
  cooldownHours?: number;
  /** Model override for reflection. If omitted, inherits explicit scribeModel when set. */
  model?: string;
  /** Provider override for reflection. If omitted, inherits explicit scribeProvider when set. */
  provider?: string;
}

export interface BootstrapConfig {
  /** Enable seeding the graph from existing memory files on first start. Default: true */
  enabled?: boolean;
  /** Directory to scan for .md files. Default: auto-detect from workspace + '/memory/' */
  memoryDir?: string;
  /** Path to MEMORY.md index file. Default: auto-detect from workspace + '/MEMORY.md' */
  memoryIndex?: string;
  /** Skip files older than this many days. Default: 90 */
  maxAgeDays?: number;
  /** Delay in ms between processing files to avoid rate limits. Default: 10000 */
  delayMs?: number;
}

export interface MemrokPluginConfig {
  dbPath?: string;
  scribeProvider?: string;
  scribeModel?: string;
  watchPaths?: string[];
  deltaThreshold?: number;
  idleMinutes?: number;
  tokenBudget?: number;
  reflection?: ReflectionConfig;
  bootstrap?: BootstrapConfig;
}

export interface ResolvedReflectionConfig {
  enabled: boolean;
  deltaPasses: number;
  cooldownHours: number;
  model?: string;
  provider?: string;
}

export interface ResolvedBootstrapConfig {
  enabled: boolean;
  memoryDir?: string;
  memoryIndex?: string;
  maxAgeDays: number;
  delayMs: number;
}

export interface ResolvedConfig {
  dbPath: string;
  scribeProvider?: string;
  scribeModel?: string;
  watchPaths: string[];
  deltaThreshold: number;
  idleMinutes: number;
  tokenBudget: number;
  reflection: ResolvedReflectionConfig;
  bootstrap: ResolvedBootstrapConfig;
}

export interface Message {
  role: string;
  content?: string | Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
}

export interface AssembleParams {
  sessionId?: string;
  messages: Message[];
  tokenBudget?: number;
}

export interface AssembleResult {
  messages: Message[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}

export interface CompactParams {
  sessionId?: string;
  force?: boolean;
}

export interface IngestParams {
  sessionId?: string;
  message?: Message;
  isHeartbeat?: boolean;
}

export interface AfterTurnParams {
  sessionId?: string;
}

export interface ContextEngine {
  info: {
    id: string;
    name: string;
    ownsCompaction: boolean;
  };
  assemble(params: AssembleParams): Promise<AssembleResult>;
  compact(params: CompactParams): Promise<unknown>;
  ingest(params: IngestParams): Promise<{ ingested: boolean }>;
  afterTurn(params: AfterTurnParams): Promise<void>;
}

export interface PluginLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn(message: string): void;
  error?(message: string): void;
}

export interface ModelAuthApi {
  getApiKeyForModel?(params: { model: string; cfg?: unknown }): Promise<unknown>;
  resolveApiKeyForProvider?(params: { provider: string; cfg?: unknown }): Promise<unknown>;
}

export interface PluginRuntime {
  modelAuth?: ModelAuthApi;
  state?: {
    resolveStateDir?: () => string;
  };
  agent?: {
    sessionsDir?: string;
    sessionDirs?: string[];
    runEmbeddedPiAgent?: (params: {
      sessionId: string;
      sessionFile: string;
      workspaceDir: string;
      config: unknown;
      prompt: string;
      timeoutMs: number;
      runId: string;
      provider?: string;
      model?: string;
      disableTools?: boolean;
      [key: string]: unknown;
    }) => Promise<{ payloads?: Array<{ isError?: boolean; text?: string }> }>;
    resolveAgentWorkspaceDir?: (config: unknown) => string;
  };
}

export interface PluginServiceContext {
  stateDir: string;
}

export interface PluginService {
  id: string;
  start(ctx: PluginServiceContext): Promise<void>;
  stop(): Promise<void>;
}

export interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  config?: unknown;
  runtime?: PluginRuntime;
  logger: PluginLogger;
  registrationMode?: 'full' | 'setup-only' | 'setup-runtime';
  registerContextEngine(id: string, factory: () => ContextEngine): void;
  registerService(service: PluginService): void;
}

export interface PluginRegistration {
  id: string;
  name: string;
  description: string;
  kind?: string;
  register(api: PluginApi): void;
}

export type { ContextHeader };
