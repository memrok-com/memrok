import type { ContextHeader } from '@memrok/injector';

export interface ReflectionConfig {
  /** Enable reflective scribe passes. Default: true */
  enabled?: boolean;
  /** Number of transcript scribe passes since last reflection before reflecting. Default: 5 */
  deltaPasses?: number;
  /** Minimum hours between reflections. Default: 24 */
  cooldownHours?: number;
  /** Model for reflection (defaults to scribeModel). Reflection benefits from a capable model. */
  model?: string;
  /** Provider for reflection model (defaults to scribeProvider). */
  provider?: string;
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
}

export interface ResolvedReflectionConfig {
  enabled: boolean;
  deltaPasses: number;
  cooldownHours: number;
  model: string;
  provider: string;
}

export interface ResolvedConfig {
  dbPath: string;
  scribeProvider: string;
  scribeModel: string;
  watchPaths: string[];
  deltaThreshold: number;
  idleMinutes: number;
  tokenBudget: number;
  reflection: ResolvedReflectionConfig;
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
