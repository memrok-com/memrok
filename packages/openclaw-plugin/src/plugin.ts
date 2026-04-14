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
const DEFAULT_BOOTSTRAP_SCAN_CONFIGURED_AGENTS = true;
const DEFAULT_INDEX_SESSION_LIMIT = 100;
const DEFAULT_FULL_REINDEX_LIMIT = 25;

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

function resolveOpenclawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  return explicit ? expandHome(explicit) : join(homedir(), '.openclaw');
}

function resolveMemrokDataDir(api?: PluginApi): string {
  const runtimeAgent = toRecord(api?.runtime?.agent);
  const explicitStateDir = typeof runtimeAgent?.stateDir === 'string' ? runtimeAgent.stateDir : undefined;
  const stateDir = explicitStateDir?.trim()
    ? expandHome(explicitStateDir)
    : resolveOpenclawStateDir();
  return join(stateDir, 'plugins', 'memrok');
}

function resolveMemrokTmpDir(api?: PluginApi): string {
  return join(resolveMemrokDataDir(api), 'tmp');
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => typeof entry === 'string' ? entry.trim() : '')
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function resolvePluginConfig(
  raw: MemrokPluginConfig | Record<string, unknown> | undefined,
  api?: PluginApi,
): MemrokPluginConfig {
  if (raw && Object.keys(raw).length > 0) {
    return raw as MemrokPluginConfig;
  }

  const rootConfig = toRecord(api?.config);
  const plugins = toRecord(rootConfig?.plugins);
  const entries = toRecord(plugins?.entries);
  const pluginEntry = toRecord(entries?.memrok);
  return (toRecord(pluginEntry?.config) ?? {}) as MemrokPluginConfig;
}

function normalizeFileKey(filePath: string): string {
  return resolve(filePath);
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
  const discoveredSessionDirs = discoverSessionDirs(api);
  if (discoveredSessionDirs.length > 0) {
    return discoveredSessionDirs;
  }

  const agent = api.runtime?.agent;
  if (Array.isArray(agent?.sessionDirs) && agent.sessionDirs.length > 0) {
    return agent.sessionDirs.map(expandHome);
  }
  if (agent?.sessionsDir) {
    return [expandHome(agent.sessionsDir)];
  }
  return [join(resolveOpenclawStateDir(), 'agents')];
}

function discoverSessionDirs(api: PluginApi): string[] {
  const sessionDirs = new Set<string>();
  const addSessionDir = (candidate: string | undefined) => {
    const trimmed = candidate?.trim();
    if (!trimmed) return;
    sessionDirs.add(expandHome(trimmed));
  };

  const runtimeAgent = api.runtime?.agent;
  for (const sessionDir of runtimeAgent?.sessionDirs ?? []) {
    addSessionDir(sessionDir);
  }
  addSessionDir(runtimeAgent?.sessionsDir);

  const agentsDir = join(resolveOpenclawStateDir(), 'agents');
  try {
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(agentsDir, entry.name, 'sessions');
      if (existsSync(candidate)) {
        sessionDirs.add(candidate);
      }
    }
  } catch {
    // Fall back to runtime-provided session directories if the state dir layout
    // is unavailable in this environment.
  }

  return [...sessionDirs].sort();
}

function resolveSessionReplayPaths(api: PluginApi, configuredWatchPaths: string[]): string[] {
  const discoveredSessionDirs = discoverSessionDirs(api);
  if (discoveredSessionDirs.length > 0) {
    return discoveredSessionDirs;
  }

  const broadFallback = join(resolveOpenclawStateDir(), 'agents');
  return configuredWatchPaths
    .map(expandHome)
    .filter((watchPath) => watchPath !== broadFallback);
}

function discoverAgentRoots(api: PluginApi, workspaceDir: string): string[] {
  const roots = new Set<string>();
  const fallbacks = new Set<string>();

  const addRoot = (candidate: string | undefined) => {
    const trimmed = candidate?.trim();
    if (!trimmed) return;
    roots.add(expandHome(trimmed));
  };

  const addFallbackRoot = (candidate: string | undefined) => {
    const trimmed = candidate?.trim();
    if (!trimmed) return;
    fallbacks.add(expandHome(trimmed));
  };

  const addSessionPath = (candidate: string | undefined) => {
    const trimmed = candidate?.trim();
    if (!trimmed) return;
    const resolved = expandHome(trimmed);
    if (basename(resolved) === 'sessions') {
      roots.add(dirname(resolved));
      return;
    }
    roots.add(resolved);
  };

  const runtimeAgent = api.runtime?.agent;
  for (const sessionDir of runtimeAgent?.sessionDirs ?? []) {
    addSessionPath(sessionDir);
  }
  addSessionPath(runtimeAgent?.sessionsDir);
  addFallbackRoot(runtimeAgent?.resolveAgentWorkspaceDir?.(api.config));
  addFallbackRoot(workspaceDir);

  const agentsDir = join(resolveOpenclawStateDir(), 'agents');
  try {
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        roots.add(join(agentsDir, entry.name));
      }
    }
  } catch {
    // No global agent registry available — fall back to runtime-discovered roots.
  }

  if (roots.size === 0) {
    for (const fallback of fallbacks) {
      roots.add(fallback);
    }
  }

  return [...roots].sort();
}

/** Remove stale memrok-scribe-*.jsonl files from the plugin temp directory on startup. */
function cleanupStaleTmpFiles(api?: PluginApi): void {
  const tmpDir = resolveMemrokTmpDir(api);
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
  const config = resolvePluginConfig(raw, api);
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
    memoryDirs: [
      ...toStringArray(config.bootstrap?.memoryDirs),
      ...toStringArray(config.bootstrap?.memoryDir),
    ],
    memoryIndex: config.bootstrap?.memoryIndex,
    memoryIndexes: [
      ...toStringArray(config.bootstrap?.memoryIndexes),
      ...toStringArray(config.bootstrap?.memoryIndex),
    ],
    scanConfiguredAgents: config.bootstrap?.scanConfiguredAgents ?? DEFAULT_BOOTSTRAP_SCAN_CONFIGURED_AGENTS,
    maxAgeDays: config.bootstrap?.maxAgeDays ?? DEFAULT_BOOTSTRAP_MAX_AGE_DAYS,
    delayMs: config.bootstrap?.delayMs ?? DEFAULT_BOOTSTRAP_DELAY_MS,
  };
  return {
    dbPath: expandHome(config.dbPath ?? join(resolveMemrokDataDir(api), 'memrok.db')),
    scribeProvider,
    scribeModel,
    watchPaths: (config.watchPaths?.length ? config.watchPaths : defaultWatchPaths(api as PluginApi)).map(expandHome),
    deltaThreshold: config.deltaThreshold ?? DEFAULT_DELTA_THRESHOLD,
    idleMinutes: config.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    tokenBudget: config.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    reflection,
    bootstrap,
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

    const tmpDir = resolveMemrokTmpDir(api);
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
        ...(config.scribeProvider ? { provider: config.scribeProvider } : {}),
        ...(config.scribeModel ? { model: config.scribeModel } : {}),
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

function scanJsonlFiles(dir: string): string[] {
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
      } else if (entry.isFile() && extname(entry.name) === '.jsonl') {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results.sort();
}

function resolveBootstrapTargets(
  bootstrapConfig: ResolvedBootstrapConfig,
  api: PluginApi,
  workspaceDir: string,
): { memoryDirs: string[]; memoryIndexes: string[] } {
  const memoryDirs = new Set<string>();
  const memoryIndexes = new Set<string>();

  for (const candidate of bootstrapConfig.memoryDirs) {
    memoryDirs.add(expandHome(candidate));
  }
  for (const candidate of bootstrapConfig.memoryIndexes) {
    memoryIndexes.add(expandHome(candidate));
  }

  if (bootstrapConfig.scanConfiguredAgents) {
    for (const agentRoot of discoverAgentRoots(api, workspaceDir)) {
      memoryDirs.add(join(agentRoot, 'memory'));
      memoryIndexes.add(join(agentRoot, 'MEMORY.md'));
    }
  }

  if (memoryDirs.size === 0 && memoryIndexes.size === 0) {
    memoryDirs.add(bootstrapConfig.memoryDir
      ? expandHome(bootstrapConfig.memoryDir)
      : join(workspaceDir, 'memory'));
    memoryIndexes.add(bootstrapConfig.memoryIndex
      ? expandHome(bootstrapConfig.memoryIndex)
      : join(workspaceDir, 'MEMORY.md'));
  }

  return {
    memoryDirs: [...memoryDirs].sort(),
    memoryIndexes: [...memoryIndexes].sort(),
  };
}

function formatTimestamp(value: string | null | undefined): string {
  return value ? new Date(value).toISOString() : 'never';
}

type MemrokCommand =
  | { kind: 'status' }
  | { kind: 'scan-memory'; force: boolean }
  | { kind: 'flush-sessions' }
  | { kind: 'index-sessions'; full: boolean; limit?: number }
  | { kind: 'help'; error?: string };

function parseCommandArgs(rawArgs: string | undefined): MemrokCommand {
  const tokens = (rawArgs ?? '')
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0 || tokens[0] === 'status') {
    return tokens.length <= 1
      ? { kind: 'status' }
      : { kind: 'help', error: '`/memrok status` does not accept extra arguments.' };
  }

  if (tokens[0] === 'scan-memory' || tokens[0] === 'bootstrap') {
    const force = tokens.slice(1).includes('force');
    const unexpected = tokens.slice(1).filter((token) => token !== 'force');
    return unexpected.length === 0
      ? { kind: 'scan-memory', force }
      : { kind: 'help', error: '`/memrok scan-memory` accepts only the optional `force` flag.' };
  }

  if (tokens[0] === 'flush-sessions' || tokens[0] === 'trigger') {
    return tokens.length === 1
      ? { kind: 'flush-sessions' }
      : { kind: 'help', error: '`/memrok flush-sessions` does not accept extra arguments.' };
  }

  if (tokens[0] === 'index-sessions' || tokens[0] === 'reindex-sessions') {
    let full = false;
    let limit: number | undefined;
    const unexpected: string[] = [];

    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === 'full') {
        full = true;
        continue;
      }
      if (token === 'limit' && i + 1 < tokens.length) {
        const value = Number.parseInt(tokens[i + 1]!, 10);
        if (Number.isFinite(value) && value > 0) {
          limit = value;
          i++;
          continue;
        }
      }
      if (token.startsWith('limit=')) {
        const value = Number.parseInt(token.slice('limit='.length), 10);
        if (Number.isFinite(value) && value > 0) {
          limit = value;
          continue;
        }
      }
      unexpected.push(token);
    }

    return unexpected.length === 0
      ? { kind: 'index-sessions', full, limit }
      : { kind: 'help', error: '`/memrok index-sessions` accepts optional `full` and `limit=<n>` flags.' };
  }

  if (tokens[0] === 'help') {
    return { kind: 'help' };
  }

  return {
    kind: 'help',
    error: `Unknown subcommand \`${tokens[0]}\`. Supported: status, scan-memory, flush-sessions, index-sessions, help.`,
  };
}

function buildHelpText(error?: string): string {
  const lines = [
    '**Memrok**',
    'Commands:',
    '- `/memrok status` show recent Memrok activity and discovered targets',
    '- `/memrok scan-memory [force]` scan configured `MEMORY.md` and `memory/` files now',
    '- `/memrok flush-sessions` run transcript scribing immediately for pending session changes',
    '- `/memrok index-sessions [full] [limit=<n>]` index session JSONL files now; `full` replays complete files',
    '- `/memrok help` show this help',
  ];
  return error ? [`Error: ${error}`, '', ...lines].join('\n') : lines.join('\n');
}

export async function runBootstrap(
  store: ArchiveStore & ArtifactStore & GraphStore,
  scribe: ScribeInterface,
  bootstrapConfig: ResolvedBootstrapConfig,
  api: PluginApi,
  workspaceDir: string,
  options?: { force?: boolean },
): Promise<{ filesConsidered: number; processed: number; skipped: number; failed: number }> {
  const targets = resolveBootstrapTargets(bootstrapConfig, api, workspaceDir);
  const force = options?.force ?? false;

  const filePaths: string[] = [];
  for (const memoryDir of targets.memoryDirs) {
    if (existsSync(memoryDir)) {
      filePaths.push(...scanMarkdownFiles(memoryDir));
    }
  }
  for (const memoryIndex of targets.memoryIndexes) {
    if (existsSync(memoryIndex) && !filePaths.includes(memoryIndex)) {
      filePaths.push(memoryIndex);
    }
  }

  if (filePaths.length === 0) {
    console.log('[memrok:bootstrap] No memory files found, skipping');
    return { filesConsidered: 0, processed: 0, skipped: 0, failed: 0 };
  }

  // Build set of already-bootstrapped filenames from pass sources.
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
    const fileKey = normalizeFileKey(filePath);
    const legacyFileKey = relative(workspaceDir, filePath);

    if (!force && (bootstrappedFiles.has(fileKey) || bootstrappedFiles.has(legacyFileKey))) {
      console.log(`[memrok:bootstrap] Skipping ${fileKey} (already bootstrapped)`);
      skipped++;
      continue;
    }

    try {
      const stat = statSync(filePath);
      if (!force && now - stat.mtimeMs > maxAgeMs) {
        console.log(`[memrok:bootstrap] Skipping ${fileKey} (older than ${bootstrapConfig.maxAgeDays} days)`);
        skipped++;
        continue;
      }
    } catch {
      skipped++;
      continue;
    }

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

    if (bootstrapConfig.delayMs > 0 && filePath !== filePaths[filePaths.length - 1]) {
      await new Promise((resolve) => setTimeout(resolve, bootstrapConfig.delayMs));
    }
  }

  console.log(`[memrok:bootstrap] Done: ${processed} processed, ${skipped} skipped, ${failed} failed`);
  return { filesConsidered: filePaths.length, processed, skipped, failed };
}

export interface PluginRuntimeState {
  store: GraphStore;
  injector: Injector;
  watcher: TranscriptWatcher;
  consolidation: ConsolidationEngine;
  status: StatusTracker;
  config: ResolvedConfig;
  scanMemory(force?: boolean): Promise<{ filesConsidered: number; processed: number; skipped: number; failed: number }>;
  flushPendingSessions(): Promise<number>;
  indexSessionFiles(options?: { full?: boolean; limit?: number }): Promise<{
    filesConsidered: number;
    unreadCandidates: number;
    processed: number;
    skipped: number;
    failed: number;
    remaining: number;
    limitApplied: number;
  }>;
  describeBootstrapTargets(): { memoryDirs: string[]; memoryIndexes: string[] };
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
  cleanupStaleTmpFiles(api);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = createStore(config.dbPath);
  const status = new StatusTracker(config.dbPath);
  status.setNodeLifecycleCounts(
    store.queryNodes({ active: true }).length,
    store.queryNodes({ active: false }).length,
  );
  const baseInjector = createInjector(store, { tokenBudget: config.tokenBudget });
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

  const watcher = new TranscriptWatcher(
    { paths: config.watchPaths },
    join(dirname(config.dbPath), '.memrok-cursors.json'),
  );
  const consolidation = new ConsolidationEngine({
    deltaThreshold: config.deltaThreshold,
    idleMinutes: config.idleMinutes,
  });
  const pendingTranscriptChunks: Array<{ source: string; content: string }> = [];
  let reflectionCheckTimer: ReturnType<typeof setInterval> | null = null;
  let sessionIndexRunInFlight: Promise<{
    filesConsidered: number;
    unreadCandidates: number;
    processed: number;
    skipped: number;
    failed: number;
    remaining: number;
    limitApplied: number;
  }> | null = null;
  const resolveWorkspaceDir = () =>
    api.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config) ?? process.cwd();

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
    // TODO: Investigate why the periodic reflection timer path does not reliably
    // trigger in the fake-timer test case (`runs reflection from the timer after
    // cooldown elapses without a new transcript pass`). Install/load behavior is
    // correct, but the timer-driven test still fails intermittently.
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

  const runTranscriptScribeForSource = async (
    source: string,
    transcript: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      const pass = await scribe.callModel(transcript);
      persistObservationDrivenPass({
        store,
        observation: {
          kind: 'transcript',
          source,
          content: transcript,
          metadata,
        },
        artifact: {
          kind: 'scribe-pass-output',
          content: JSON.stringify(pass),
          metadata: { stage: 'transcript-scribe' },
        },
        pass,
        source,
      });
      injector.invalidate();
      passesSinceReflection++;
      status.recordTranscriptScribe(source);
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

  const runScribePass = async (): Promise<number> => {
    if (pendingTranscriptChunks.length === 0) return 0;
    const drainedChunks = pendingTranscriptChunks.splice(0, pendingTranscriptChunks.length);
    const transcript = drainedChunks.map((chunk) => chunk.content).join('\n');
    const source = drainedChunks[drainedChunks.length - 1]?.source ?? 'transcript';
    const chunkCount = drainedChunks.length;

    try {
      await runTranscriptScribeForSource(source, transcript, { chunkCount });
    } catch (err) {
      pendingTranscriptChunks.unshift(...drainedChunks);
      throw err;
    }

    return 1;
  };

  const indexSessionFiles = async (
    options?: { full?: boolean; limit?: number },
  ): Promise<{
    filesConsidered: number;
    unreadCandidates: number;
    processed: number;
    skipped: number;
    failed: number;
    remaining: number;
    limitApplied: number;
  }> => {
    if (sessionIndexRunInFlight) {
      return sessionIndexRunInFlight;
    }

    sessionIndexRunInFlight = (async () => {
      const full = options?.full ?? false;
      const requestedLimit = options?.limit;
      const limitApplied = Math.max(
        1,
        requestedLimit ?? (full ? DEFAULT_FULL_REINDEX_LIMIT : DEFAULT_INDEX_SESSION_LIMIT),
      );
      const filePaths = new Set<string>();
      const replayPaths = resolveSessionReplayPaths(api, config.watchPaths);

      for (const watchPath of replayPaths) {
        const resolvedWatchPath = expandHome(watchPath);
        if (!existsSync(resolvedWatchPath)) continue;
        if (extname(resolvedWatchPath) === '.jsonl') {
          filePaths.add(resolvedWatchPath);
        } else {
          for (const filePath of scanJsonlFiles(resolvedWatchPath)) {
            filePaths.add(filePath);
          }
        }
      }

      const orderedPaths = [...filePaths].sort();
      const cursorSnapshot = watcher.getCursors();
      const pathStates = orderedPaths.map((filePath) => {
        const size = watcher.getFileSize(filePath);
        const cursor = cursorSnapshot[filePath] ?? 0;
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(filePath).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return {
          filePath,
          cursor,
          size,
          mtimeMs,
          hasUnread: size !== null && size > cursor,
        };
      });
      const unreadPaths = pathStates
        .filter((state) => state.hasUnread)
        .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
      const selectedStates = (full ? pathStates : unreadPaths).slice(0, limitApplied);
      let processed = 0;
      let skipped = 0;
      let failed = 0;

      console.log(
        `[memrok] Session indexing started: selected=${selectedStates.length} total=${orderedPaths.length} unread=${unreadPaths.length} mode=${full ? 'full' : 'unread'} limit=${limitApplied}`,
      );

      for (const [index, state] of selectedStates.entries()) {
        const filePath = state.filePath;
        const previousCursor = full ? 0 : state.cursor;
        let result: { content: string | null; nextOffset: number } | null;
        try {
          result = watcher.readContentFromOffset(filePath, previousCursor);
        } catch (err) {
          failed++;
          status.recordError('session-index', err);
          continue;
        }

        if (!result) {
          skipped++;
          continue;
        }

        console.log(`[memrok] Session indexing ${index + 1}/${selectedStates.length}: ${filePath}`);

        if (!result.content?.trim()) {
          watcher.setCursor(filePath, result.nextOffset);
          skipped++;
          continue;
        }

        try {
          await runTranscriptScribeForSource(filePath, result.content, {
            stage: full ? 'manual-session-reindex' : 'manual-session-index',
            replay: full,
            fileIndex: index + 1,
            fileCount: selectedStates.length,
          });
          watcher.setCursor(filePath, result.nextOffset);
          processed++;
        } catch (err) {
          watcher.setCursor(filePath, previousCursor);
          status.recordError('session-index', err);
          failed++;
        }
      }

      watcher.saveCursors();

      return {
        filesConsidered: orderedPaths.length,
        unreadCandidates: unreadPaths.length,
        processed,
        skipped,
        failed,
        remaining: Math.max((full ? orderedPaths.length : unreadPaths.length) - selectedStates.length, 0),
        limitApplied,
      };
    })();

    try {
      return await sessionIndexRunInFlight;
    } finally {
      sessionIndexRunInFlight = null;
    }
  };

  const scanMemory = async (force = false) => {
    const result = await runBootstrap(store, scribe, config.bootstrap, api, resolveWorkspaceDir(), { force });
    status.setNodeLifecycleCounts(
      store.queryNodes({ active: true }).length,
      store.queryNodes({ active: false }).length,
    );
    return result;
  };

  const flushPendingSessions = async (): Promise<number> => {
    const processed = await runScribePass();
    if (processed > 0) {
      consolidation.recordPassComplete();
    }
    return processed;
  };

  watcher.on('data', (filePath: string, content: string) => {
    pendingTranscriptChunks.push({ source: filePath, content });
    const lines = content.split('\n').filter((line) => line.trim()).length;
    consolidation.recordMessages(lines);
  });

  consolidation.setTriggerCallback(async () => {
    await runScribePass();
  });

  const runtime: PluginRuntimeState = {
    store,
    injector,
    watcher,
    consolidation,
    status,
    config,
    scanMemory,
    flushPendingSessions,
    indexSessionFiles,
    describeBootstrapTargets: () => resolveBootstrapTargets(config.bootstrap, api, resolveWorkspaceDir()),
  };

  api.registerContextEngine('memrok', () => createContextEngine(runtime));
  api.registerCommand?.({
    name: 'memrok',
    nativeNames: {
      default: 'memrok',
    },
    nativeProgressMessages: {
      telegram: 'Memrok is working...',
    },
    description: 'Show Memrok status and manually trigger memory/session indexing.',
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseCommandArgs(ctx.args);
      switch (parsed.kind) {
        case 'status': {
          const activity = status.getStatus();
          const targets = runtime.describeBootstrapTargets();
          return {
            text: [
              '**Memrok**',
              `db: \`${config.dbPath}\``,
              `watch paths: ${config.watchPaths.length}`,
              `memory dirs: ${targets.memoryDirs.length}`,
              `memory indexes: ${targets.memoryIndexes.length}`,
              `active nodes: ${activity.activeNodeCount}`,
              `expired nodes: ${activity.expiredNodeCount}`,
              `last transcript scribe: ${formatTimestamp(activity.lastTranscriptScribeAt)}`,
              `last reflection: ${formatTimestamp(activity.lastReflectiveScribeAt)}`,
              `last source: ${activity.lastSourceProcessed ?? 'none'}`,
            ].join('\n'),
          };
        }
        case 'scan-memory': {
          const result = await runtime.scanMemory(parsed.force);
          return {
            text: `Memrok memory scan complete. considered=${result.filesConsidered} processed=${result.processed} skipped=${result.skipped} failed=${result.failed}${parsed.force ? ' force=true' : ''}`,
          };
        }
        case 'flush-sessions': {
          const processed = await runtime.flushPendingSessions();
          return {
            text: processed > 0
              ? `Memrok flushed pending session indexing. processed=${processed}`
              : 'Memrok has no pending session transcript chunks to flush.',
          };
        }
        case 'index-sessions': {
          const result = await runtime.indexSessionFiles({ full: parsed.full, limit: parsed.limit });
          return {
            text: `Memrok session indexing complete. considered=${result.filesConsidered} unread=${result.unreadCandidates} processed=${result.processed} skipped=${result.skipped} failed=${result.failed} remaining=${result.remaining} limit=${result.limitApplied}${parsed.full ? ' mode=full' : ' mode=unread'}`,
          };
        }
        case 'help':
          return { text: buildHelpText(parsed.error) };
      }
    },
  });
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

      if (config.bootstrap.enabled) {
        scanMemory(false).catch((err) => {
          status.recordError('bootstrap', err);
          console.warn(
            `[memrok] Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
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
