import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createStore } from '@memrok/store';
import { createInjector } from '@memrok/injector';
import { ScribeInterface, REFLECTION_SYSTEM_PROMPT, serializeGraphForReflection, type ModelCaller } from '@memrok/scribe';
import { TranscriptWatcher, ConsolidationEngine } from '@memrok/daemon';
import type { Store } from '@memrok/store';
import type { Injector } from '@memrok/injector';
import type {
  AssembleParams,
  ContextEngine,
  MemrokPluginConfig,
  Message,
  PluginApi,
  PluginRegistration,
  ResolvedConfig,
  ResolvedReflectionConfig,
} from './types.js';

const DEFAULT_DB_PATH = '~/.memrok/memrok.db';
const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_DELTA_THRESHOLD = 20;
const DEFAULT_IDLE_MINUTES = 15;
const DEFAULT_TOKEN_BUDGET = 1000;
const DEFAULT_REFLECTION_ENABLED = true;
const DEFAULT_REFLECTION_DELTA_PASSES = 5;
const DEFAULT_REFLECTION_COOLDOWN_HOURS = 24;

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

function extractText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function estimateTokens(messages: Message[]): number {
  const text = messages.map((message) => extractText(message.content)).join('\n');
  return Math.ceil(text.length / 4);
}

function recentContextFromMessages(messages: Message[]): string {
  return messages
    .slice(-20)
    .map((message) => {
      const text = extractText(message.content);
      return text ? `${message.role}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function defaultWatchPaths(api: PluginApi): string[] {
  const agent = api.runtime?.agent;
  if (Array.isArray(agent?.sessionDirs) && agent.sessionDirs.length > 0) {
    return agent.sessionDirs.map(expandHome);
  }
  if (agent?.sessionsDir) {
    return [expandHome(agent.sessionsDir)];
  }
  return [join(homedir(), '.openclaw', 'agents')];
}

export function resolveConfig(
  raw: MemrokPluginConfig | Record<string, unknown> | undefined,
  api?: PluginApi,
): ResolvedConfig {
  const config = (raw ?? {}) as MemrokPluginConfig;
  const scribeProvider = config.scribeProvider ?? DEFAULT_PROVIDER;
  const scribeModel = config.scribeModel ?? DEFAULT_MODEL;
  const reflection: ResolvedReflectionConfig = {
    enabled: config.reflection?.enabled ?? DEFAULT_REFLECTION_ENABLED,
    deltaPasses: config.reflection?.deltaPasses ?? DEFAULT_REFLECTION_DELTA_PASSES,
    cooldownHours: config.reflection?.cooldownHours ?? DEFAULT_REFLECTION_COOLDOWN_HOURS,
    model: config.reflection?.model ?? scribeModel,
    provider: config.reflection?.provider ?? scribeProvider,
  };
  return {
    dbPath: expandHome(config.dbPath ?? DEFAULT_DB_PATH),
    scribeProvider,
    scribeModel,
    watchPaths: (config.watchPaths?.length ? config.watchPaths : defaultWatchPaths(api as PluginApi)).map(expandHome),
    deltaThreshold: config.deltaThreshold ?? DEFAULT_DELTA_THRESHOLD,
    idleMinutes: config.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    tokenBudget: config.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    reflection,
  };
}

function collectText(payloads: Array<{ isError?: boolean; text?: string }>): string {
  return (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === 'string')
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
}

export function createModelCaller(api: PluginApi, config: ResolvedConfig, inputLabel?: string): ModelCaller {
  return async (systemPrompt: string, userMessage: string): Promise<string> => {
    const runAgent = api.runtime?.agent?.runEmbeddedPiAgent;
    if (typeof runAgent !== 'function') {
      throw new Error('api.runtime.agent.runEmbeddedPiAgent not available');
    }

    const tmpDir = join(homedir(), '.memrok', 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const sessionId = `memrok-scribe-${Date.now()}`;
    const sessionFile = join(tmpDir, `${sessionId}.jsonl`);

    // Combine system prompt and user message into a single prompt,
    // matching the pattern used by OpenClaw's llm-task plugin
    const label = inputLabel ?? 'TRANSCRIPT';
    const fullPrompt = `${systemPrompt}\n\n${label}:\n${userMessage}\n`;

    const result = await runAgent({
      sessionId,
      sessionFile,
      workspaceDir: api.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config) ?? process.cwd(),
      config: api.config,
      prompt: fullPrompt,
      timeoutMs: 60_000,
      runId: `memrok-scribe-${Date.now()}`,
      provider: config.scribeProvider,
      model: config.scribeModel,
      disableTools: true,
    });

    // Clean up session file
    try { const { unlink } = await import('node:fs/promises'); await unlink(sessionFile); } catch {}

    const text = collectText(result.payloads ?? []);
    if (!text) {
      throw new Error('Scribe model returned empty output');
    }
    return text;
  };
}

async function delegateCompaction(params: AssembleParams | unknown): Promise<unknown> {
  try {
    const sdk = await import('openclaw/plugin-sdk/core');
    if (typeof sdk.delegateCompactionToRuntime === 'function') {
      return sdk.delegateCompactionToRuntime(params as never);
    }
  } catch {
    // noop in dev/test
  }
  return { ok: true, compacted: false, delegated: false };
}

export interface PluginRuntimeState {
  store: Store;
  injector: Injector;
  watcher: TranscriptWatcher;
  consolidation: ConsolidationEngine;
}

export function createContextEngine(runtime: PluginRuntimeState): ContextEngine {
  return {
    info: {
      id: 'memrok',
      name: 'Memrok Memory Layer',
      ownsCompaction: false,
    },
    async assemble(params) {
      const header = runtime.injector.assemble({
        recentMessages: recentContextFromMessages(params.messages),
      });
      return {
        messages: params.messages,
        estimatedTokens: estimateTokens(params.messages),
        systemPromptAddition: header.text,
      };
    },
    async compact(params) {
      return delegateCompaction(params);
    },
    async ingest() {
      return { ingested: true };
    },
    async afterTurn() {
      runtime.consolidation.recordMessages(1);
    },
  };
}

/** Pure function: should a reflection pass run given current state? */
export function shouldRunReflection(
  passesSinceReflection: number,
  lastReflectionTime: number,
  config: ResolvedConfig['reflection'],
  now = Date.now(),
): boolean {
  if (!config.enabled) return false;
  const cooldownMs = config.cooldownHours * 60 * 60 * 1000;
  return (
    passesSinceReflection >= config.deltaPasses &&
    now - lastReflectionTime >= cooldownMs
  );
}

export function createPluginRegistration(api: PluginApi): PluginRuntimeState {
  const config = resolveConfig(api.pluginConfig, api);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = createStore(config.dbPath);
  const injector = createInjector(store, { tokenBudget: config.tokenBudget });
  const scribe = new ScribeInterface(createModelCaller(api, config));

  // Reflection scribe uses its own model/provider (may differ from transcript scribe)
  const reflectionConfig = {
    ...config,
    scribeProvider: config.reflection.provider,
    scribeModel: config.reflection.model,
  };
  const reflectionScribe = new ScribeInterface(
    createModelCaller(api, reflectionConfig, 'GRAPH_STATE'),
    { systemPrompt: REFLECTION_SYSTEM_PROMPT },
  );

  const watcher = new TranscriptWatcher({ paths: config.watchPaths });
  const consolidation = new ConsolidationEngine({
    deltaThreshold: config.deltaThreshold,
    idleMinutes: config.idleMinutes,
  });
  const pendingTranscriptChunks: string[] = [];

  // Reflection state
  let passesSinceReflection = 0;
  let lastReflectionTime = 0;

  const checkAndRunReflection = async (): Promise<void> => {
    if (!shouldRunReflection(passesSinceReflection, lastReflectionTime, config.reflection)) return;
    try {
      const graphState = serializeGraphForReflection(store);
      const pass = await reflectionScribe.callModel(graphState);
      store.applyPass(pass);
      injector.invalidate();
      passesSinceReflection = 0;
      lastReflectionTime = Date.now();
    } catch (err) {
      console.warn(`[memrok] Reflection pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runScribePass = async () => {
    if (pendingTranscriptChunks.length === 0) return;
    const transcript = pendingTranscriptChunks.join('\n');
    try {
      const pass = await scribe.callModel(transcript);
      store.applyPass(pass);
      pendingTranscriptChunks.length = 0;
      injector.invalidate();
      passesSinceReflection++;
      await checkAndRunReflection();
    } catch (err) {
      console.warn(`[memrok] Scribe pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  watcher.on('data', (_filePath: string, content: string) => {
    pendingTranscriptChunks.push(content);
    const lines = content.split('\n').filter((line) => line.trim()).length;
    consolidation.recordMessages(lines);
  });

  consolidation.setTriggerCallback(runScribePass);

  const runtime = { store, injector, watcher, consolidation };

  api.registerContextEngine('memrok', () => createContextEngine(runtime));
  api.registerService({
    id: 'memrok-watcher',
    async start() {
      watcher.start();
      consolidation.startLoop();
    },
    async stop() {
      consolidation.stopLoop();
      watcher.stop();
      store.close();
    },
  });

  return runtime;
}

const pluginSpec: PluginRegistration = {
  id: 'memrok',
  name: 'Memrok Memory Layer',
  description: 'Persistent memory layer with knowledge graphs',
  kind: 'context-engine',
  register(api) {
    try {
      createPluginRegistration(api);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      api.logger.warn(`[memrok] Plugin registration failed: ${msg}`);
      throw err;
    }
  },
};

export default pluginSpec;
