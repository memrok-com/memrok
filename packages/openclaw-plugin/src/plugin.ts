import { homedir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { createStore } from '@memrok/store';
import { createInjector } from '@memrok/injector';
import { ScribeInterface, REFLECTION_SYSTEM_PROMPT, serializeGraphForReflection, type ModelCaller } from '@memrok/scribe';
import { TranscriptWatcher, ConsolidationEngine, StatusTracker } from '@memrok/daemon';
import type { ArchiveStore, ArtifactStore, GraphStore, Store } from '@memrok/store';
import type { Injector } from '@memrok/injector';
import type {
  AssembleParams,
  ContextEngine,
  MemrokPluginConfig,
  Message,
  PluginApi,
  PluginRegistration,
  ResolvedBootstrapConfig,
  ResolvedConfig,
  ResolvedReflectionConfig,
} from './types.js';

const DEFAULT_DB_PATH = '~/.memrok/memrok.db';
const DEFAULT_DELTA_THRESHOLD = 20;
const DEFAULT_IDLE_MINUTES = 15;
const DEFAULT_TOKEN_BUDGET = 1000;
const DEFAULT_REFLECTION_ENABLED = true;
const DEFAULT_REFLECTION_DELTA_PASSES = 5;
const DEFAULT_REFLECTION_COOLDOWN_HOURS = 24;
const DEFAULT_REFLECTION_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_BOOTSTRAP_ENABLED = false;
const DEFAULT_BOOTSTRAP_MAX_AGE_DAYS = 90;
const DEFAULT_BOOTSTRAP_DELAY_MS = 10_000;
const DEFAULT_EVAL_EVENTS_ENABLED = false;
const DEFAULT_EVAL_EVENTS_INCLUDE_HEADER = true;
const DEFAULT_EVAL_EVENTS_QUERY_CHARS = 1000;
const DEFAULT_EVAL_EVENTS_HEADER_CHARS = 4000;
const DEFAULT_EVAL_EVENTS_NODE_VALUE_CHARS = 220;
const DEFAULT_EVAL_EVENTS_MAX_EVENTS = 500;

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

/** Remove stale memrok-scribe-*.jsonl files from ~/.memrok/tmp/ on startup. */
function cleanupStaleTmpFiles(): void {
  const tmpDir = join(homedir(), '.memrok', 'tmp');
  try {
    const entries = readdirSync(tmpDir);
    let cleaned = 0;
    for (const entry of entries) {
      if (entry.startsWith('memrok-scribe-') && entry.endsWith('.jsonl')) {
        try {
          unlinkSync(join(tmpDir, entry));
          cleaned++;
        } catch {}
      }
    }
    if (cleaned > 0) {
      console.log(`[memrok] Cleaned up ${cleaned} orphaned scribe temp file(s)`);
    }
  } catch {
    // tmp dir may not exist yet — that's fine
  }
}

export function resolveConfig(
  raw: MemrokPluginConfig | Record<string, unknown> | undefined,
  api?: PluginApi,
): ResolvedConfig {
  const config = (raw ?? {}) as MemrokPluginConfig;
  const scribeProvider = config.scribeProvider;
  const scribeModel = config.scribeModel;
  const reflection: ResolvedReflectionConfig = {
    enabled: config.reflection?.enabled ?? DEFAULT_REFLECTION_ENABLED,
    deltaPasses: config.reflection?.deltaPasses ?? DEFAULT_REFLECTION_DELTA_PASSES,
    cooldownHours: config.reflection?.cooldownHours ?? DEFAULT_REFLECTION_COOLDOWN_HOURS,
    model: config.reflection?.model ?? scribeModel,
    provider: config.reflection?.provider ?? scribeProvider,
  };
  const bootstrap: ResolvedBootstrapConfig = {
    enabled: config.bootstrap?.enabled ?? DEFAULT_BOOTSTRAP_ENABLED,
    memoryDir: config.bootstrap?.memoryDir,
    memoryIndex: config.bootstrap?.memoryIndex,
    maxAgeDays: config.bootstrap?.maxAgeDays ?? DEFAULT_BOOTSTRAP_MAX_AGE_DAYS,
    delayMs: config.bootstrap?.delayMs ?? DEFAULT_BOOTSTRAP_DELAY_MS,
  };
  const evalEvents = {
    enabled: config.evalEvents?.enabled ?? DEFAULT_EVAL_EVENTS_ENABLED,
    includeHeaderText: config.evalEvents?.includeHeaderText ?? DEFAULT_EVAL_EVENTS_INCLUDE_HEADER,
    maxQueryChars: config.evalEvents?.maxQueryChars ?? DEFAULT_EVAL_EVENTS_QUERY_CHARS,
    maxHeaderChars: config.evalEvents?.maxHeaderChars ?? DEFAULT_EVAL_EVENTS_HEADER_CHARS,
    maxNodeValueChars: config.evalEvents?.maxNodeValueChars ?? DEFAULT_EVAL_EVENTS_NODE_VALUE_CHARS,
    maxEvents: config.evalEvents?.maxEvents ?? DEFAULT_EVAL_EVENTS_MAX_EVENTS,
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
    bootstrap,
    evalEvents,
  };
}

function collectText(payloads: Array<{ isError?: boolean; text?: string }>): string {
  return (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === 'string')
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
}

function persistObservationDrivenPass(params: {
  store: ArchiveStore & ArtifactStore & GraphStore;
  observation: {
    kind: string;
    source: string;
    sessionId?: string;
    content: string;
    metadata?: Record<string, unknown>;
  };
  artifact: {
    kind: string;
    content: string;
    metadata?: Record<string, unknown>;
  };
  pass: ReturnType<ScribeInterface['parseResponse']>;
  source: string;
}) {
  const observation = params.store.createArchiveObservation(params.observation);
  const artifact = params.store.createDerivedArtifact({
    kind: params.artifact.kind,
    observationId: observation.id,
    content: params.artifact.content,
    metadata: params.artifact.metadata,
  });
  params.pass.source = params.source;
  params.pass.derived_artifact_id = artifact.id;
  return params.store.applyPass(params.pass);
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

    let result;
    try {
      result = await runAgent({
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
    } finally {
      // Always clean up session file, even on error/timeout
      try { const { unlink } = await import('node:fs/promises'); await unlink(sessionFile); } catch {}
    }

    const text = collectText(result.payloads ?? []);
    if (!text) {
      throw new Error('Scribe model returned empty output');
    }
    return text;
  };
}

async function delegateCompaction(params: AssembleParams | unknown): Promise<unknown> {
  try {
    // @ts-expect-error — SDK import only available inside OpenClaw runtime
    const sdk = await import('openclaw/plugin-sdk/core');
    if (typeof sdk.delegateCompactionToRuntime === 'function') {
      return sdk.delegateCompactionToRuntime(params as never);
    }
  } catch {
    // noop in dev/test
  }
  return { ok: true, compacted: false, delegated: false };
}

function scanMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results.sort();
}

export async function runBootstrap(
  store: ArchiveStore & ArtifactStore & GraphStore,
  scribe: ScribeInterface,
  bootstrapConfig: ResolvedBootstrapConfig,
  workspaceDir: string,
): Promise<void> {
  const memoryDir = bootstrapConfig.memoryDir
    ? expandHome(bootstrapConfig.memoryDir)
    : join(workspaceDir, 'memory');
  const memoryIndex = bootstrapConfig.memoryIndex
    ? expandHome(bootstrapConfig.memoryIndex)
    : join(workspaceDir, 'MEMORY.md');

  // Collect candidate files
  const filePaths: string[] = [];
  if (existsSync(memoryDir)) {
    filePaths.push(...scanMarkdownFiles(memoryDir));
  }
  if (existsSync(memoryIndex) && !filePaths.includes(memoryIndex)) {
    filePaths.push(memoryIndex);
  }

  if (filePaths.length === 0) {
    console.log('[memrok:bootstrap] No memory files found, skipping');
    return;
  }

  // Build set of already-bootstrapped filenames from pass sources
  const existingPasses = store.listPasses();
  const bootstrappedFiles = new Set<string>(
    existingPasses
      .filter((p) => p.source?.startsWith('bootstrap:'))
      .map((p) => p.source!.slice('bootstrap:'.length)),
  );

  const maxAgeMs = bootstrapConfig.maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  console.log(`[memrok:bootstrap] Found ${filePaths.length} file(s) to consider`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const filePath of filePaths) {
    const fileKey = relative(workspaceDir, filePath);

    // Skip already bootstrapped
    if (bootstrappedFiles.has(fileKey)) {
      console.log(`[memrok:bootstrap] Skipping ${fileKey} (already bootstrapped)`);
      skipped++;
      continue;
    }

    // Skip files older than maxAgeDays
    try {
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        console.log(`[memrok:bootstrap] Skipping ${fileKey} (older than ${bootstrapConfig.maxAgeDays} days)`);
        skipped++;
        continue;
      }
    } catch {
      // If we can't stat, skip
      skipped++;
      continue;
    }

    // Read content
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.warn(`[memrok:bootstrap] Failed to read ${fileKey}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      continue;
    }

    if (!content.trim()) {
      skipped++;
      continue;
    }

    // Run through scribe
    try {
      const pass = await scribe.callModel(content);
      const result = persistObservationDrivenPass({
        store,
        observation: {
          kind: 'bootstrap-file',
          source: fileKey,
          content,
          metadata: { filePath },
        },
        artifact: {
          kind: 'scribe-pass-output',
          content: JSON.stringify(pass),
          metadata: { stage: 'bootstrap' },
        },
        pass,
        source: `bootstrap:${fileKey}`,
      });
      console.log(
        `[memrok:bootstrap] ${fileKey}: ${pass.mutations.length} mutations (${result.nodes_created} created, ${result.nodes_updated} updated)`,
      );
      processed++;
    } catch (err) {
      console.warn(`[memrok:bootstrap] Failed to process ${fileKey}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      continue;
    }

    // Rate limit between files (skip delay after last file)
    if (bootstrapConfig.delayMs > 0 && filePath !== filePaths[filePaths.length - 1]) {
      await new Promise((resolve) => setTimeout(resolve, bootstrapConfig.delayMs));
    }
  }

  console.log(`[memrok:bootstrap] Done: ${processed} processed, ${skipped} skipped, ${failed} failed`);
}

export interface PluginRuntimeState {
  store: GraphStore;
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
        sessionId: params.sessionId,
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

type ReflectionStage = 'serialize-graph' | 'call-model' | 'apply-pass';

export async function runReflectionPass(params: {
  store: ArchiveStore & ArtifactStore & GraphStore;
  reflectionScribe: ScribeInterface;
  injector: Pick<Injector, 'invalidate'>;
  status: StatusTracker;
}): Promise<void> {
  let stage: ReflectionStage = 'serialize-graph';
  let graphState = '';

  try {
    graphState = serializeGraphForReflection(params.store);
    const observation = params.store.createArchiveObservation({
      kind: 'reflection-input',
      source: 'reflection',
      content: graphState,
    });
    params.status.recordReflectiveScribeAttempt(Buffer.byteLength(graphState, 'utf8'));

    stage = 'call-model';
    const pass = await params.reflectionScribe.callModel(graphState);
    pass.source = 'reflection';
    const artifact = params.store.createDerivedArtifact({
      kind: 'reflection-output',
      observationId: observation.id,
      content: JSON.stringify(pass),
    });
    pass.derived_artifact_id = artifact.id;

    stage = 'apply-pass';
    params.store.applyPass(pass);
    params.injector.invalidate();
    params.status.recordReflectiveScribe();
    params.status.setNodeLifecycleCounts(
      params.store.queryNodes({ active: true }).length,
      params.store.queryNodes({ active: false }).length,
    );
  } catch (err) {
    params.status.recordReflectiveScribeFailure(stage, err);
    params.status.recordError('reflective-scribe', err);
    throw err;
  }
}

export function createPluginRegistration(api: PluginApi): PluginRuntimeState {
  const config = resolveConfig(api.pluginConfig, api);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = createStore(config.dbPath);
  const status = new StatusTracker(config.dbPath);
  status.setNodeLifecycleCounts(
    store.queryNodes({ active: true }).length,
    store.queryNodes({ active: false }).length,
  );
  const baseInjector = createInjector(store, {
    tokenBudget: config.tokenBudget,
    injectionEvalEvents: {
      enabled: config.evalEvents.enabled,
      eventKind: 'runtime',
      includeHeaderText: config.evalEvents.includeHeaderText,
      maxQueryChars: config.evalEvents.maxQueryChars,
      maxHeaderChars: config.evalEvents.maxHeaderChars,
      maxNodeValueChars: config.evalEvents.maxNodeValueChars,
      retention: { maxEvents: config.evalEvents.maxEvents },
      metadata: { source: 'openclaw-plugin' },
    },
  });
  const injector = {
    ...baseInjector,
    assemble(context: { recentMessages?: string }) {
      status.recordInjection();
      return baseInjector.assemble(context);
    },
  };
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
  let lastSourceProcessed: string | null = null;
  let reflectionCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Reflection state — recover from DB so restarts don't reset the counters
  const allPasses = store.listPasses();
  const lastReflectionPass = [...allPasses].reverse().find((p) => p.source === 'reflection');
  let passesSinceReflection = lastReflectionPass
    ? allPasses.filter((p) => p.source !== 'reflection' && !p.source?.startsWith('bootstrap:') && p.timestamp > lastReflectionPass.timestamp).length
    : allPasses.filter((p) => !p.source?.startsWith('bootstrap:')).length;
  let lastReflectionTime = lastReflectionPass ? new Date(lastReflectionPass.timestamp).getTime() : 0;
  console.log(`[memrok] Reflection state recovered: ${passesSinceReflection} passes since last reflection, lastReflectionTime=${lastReflectionTime ? new Date(lastReflectionTime).toISOString() : 'never'}`);
  let reflectionRunInFlight: Promise<void> | null = null;

  const checkAndRunReflection = async (): Promise<void> => {
    if (reflectionRunInFlight) {
      return reflectionRunInFlight;
    }
    if (!shouldRunReflection(passesSinceReflection, lastReflectionTime, config.reflection)) return;
    reflectionRunInFlight = (async () => {
      try {
        await runReflectionPass({ store, reflectionScribe, injector, status });
        passesSinceReflection = 0;
        lastReflectionTime = Date.now();
      } catch (err) {
        console.warn(`[memrok] Reflection pass failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        reflectionRunInFlight = null;
      }
    })();
    return reflectionRunInFlight;
  };

  const runScribePass = async () => {
    if (pendingTranscriptChunks.length === 0) return;
    const transcript = pendingTranscriptChunks.join('\n');
    try {
      const pass = await scribe.callModel(transcript);
      persistObservationDrivenPass({
        store,
        observation: {
          kind: 'transcript',
          source: lastSourceProcessed ?? 'transcript',
          content: transcript,
          metadata: { chunkCount: pendingTranscriptChunks.length },
        },
        artifact: {
          kind: 'scribe-pass-output',
          content: JSON.stringify(pass),
          metadata: { stage: 'transcript-scribe' },
        },
        pass,
        source: lastSourceProcessed ?? 'transcript',
      });
      pendingTranscriptChunks.length = 0;
      injector.invalidate();
      passesSinceReflection++;
      status.recordTranscriptScribe(lastSourceProcessed);
      status.setNodeLifecycleCounts(
        store.queryNodes({ active: true }).length,
        store.queryNodes({ active: false }).length,
      );
      await checkAndRunReflection();
    } catch (err) {
      status.recordError('transcript-scribe', err);
      console.warn(`[memrok] Scribe pass failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };

  watcher.on('data', (filePath: string, content: string) => {
    lastSourceProcessed = filePath;
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
      // Clean up orphaned scribe temp files from previous runs
      cleanupStaleTmpFiles();

      watcher.start();
      consolidation.startLoop();
      reflectionCheckTimer = setInterval(async () => {
        await checkAndRunReflection();
      }, DEFAULT_REFLECTION_CHECK_INTERVAL_MS);
      await checkAndRunReflection();

      // Auto-bootstrap: seed the graph from existing memory files if no
      // non-bootstrap passes have been recorded yet (i.e. fresh graph).
      if (config.bootstrap.enabled) {
        const passes = store.listPasses();
        const hasNonBootstrapPasses = passes.some((p) => p.source && !p.source.startsWith('bootstrap:'));
        if (!hasNonBootstrapPasses) {
          const workspaceDir =
            api.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config) ?? process.cwd();
          runBootstrap(store, scribe, config.bootstrap, workspaceDir).then(() => {
            status.setNodeLifecycleCounts(
              store.queryNodes({ active: true }).length,
              store.queryNodes({ active: false }).length,
            );
          }).catch((err) => {
            status.recordError('bootstrap', err);
            console.warn(
              `[memrok] Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      }
    },
    async stop() {
      consolidation.stopLoop();
      if (reflectionCheckTimer) {
        clearInterval(reflectionCheckTimer);
        reflectionCheckTimer = null;
      }
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
