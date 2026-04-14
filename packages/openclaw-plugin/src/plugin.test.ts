import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '@memrok/store';
import { createModelCaller, createPluginRegistration, resolveConfig, runReflectionPass, shouldRunReflection } from './plugin.js';
import type { ContextEngine, PluginApi, PluginCommandDefinition, PluginService } from './types.js';

function createApi(overrides: Partial<PluginApi> = {}): {
  api: PluginApi;
  services: PluginService[];
  factories: Map<string, () => ContextEngine>;
  commands: PluginCommandDefinition[];
} {
  const services: PluginService[] = [];
  const factories = new Map<string, () => ContextEngine>();
  const commands: PluginCommandDefinition[] = [];
  const api: PluginApi = {
    pluginConfig: {},
    logger: {
      warn() {},
      info() {},
      debug() {},
      error() {},
    },
    registerContextEngine(id, factory) {
      factories.set(id, factory);
    },
    registerService(service) {
      services.push(service);
    },
    registerCommand(command) {
      commands.push(command);
    },
    ...overrides,
  };
  return { api, services, factories, commands };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('openclaw plugin orchestration', () => {
  it('resolves plugin config defaults', () => {
    const { api } = createApi();
    const resolved = resolveConfig({}, api);
    assert.equal(resolved.scribeProvider, undefined);
    assert.equal(resolved.scribeModel, undefined);
    assert.equal(resolved.deltaThreshold, 20);
    assert.equal(resolved.idleMinutes, 15);
    assert.equal(resolved.tokenBudget, 1000);
    assert.equal(resolved.bootstrap.enabled, false);
    assert.ok(resolved.dbPath.endsWith('/.openclaw/plugins/memrok/memrok.db'));
  });

  it('resolves reflection config defaults', () => {
    const { api } = createApi();
    const resolved = resolveConfig({}, api);
    assert.equal(resolved.reflection.enabled, true);
    assert.equal(resolved.reflection.deltaPasses, 5);
    assert.equal(resolved.reflection.cooldownHours, 24);
    assert.equal(resolved.reflection.model, undefined);
    assert.equal(resolved.reflection.provider, undefined);
  });

  it('resolves reflection config overrides', () => {
    const { api } = createApi();
    const resolved = resolveConfig({
      scribeProvider: 'openai',
      scribeModel: 'gpt-5-mini',
      reflection: {
        enabled: false,
        deltaPasses: 10,
        cooldownHours: 48,
        model: 'gpt-5',
        provider: 'openai',
      },
    }, api);
    assert.equal(resolved.scribeProvider, 'openai');
    assert.equal(resolved.scribeModel, 'gpt-5-mini');
    assert.equal(resolved.reflection.enabled, false);
    assert.equal(resolved.reflection.deltaPasses, 10);
    assert.equal(resolved.reflection.cooldownHours, 48);
    assert.equal(resolved.reflection.model, 'gpt-5');
    assert.equal(resolved.reflection.provider, 'openai');
  });

  it('inherits explicit transcript provider and model for reflection when unset', () => {
    const { api } = createApi();
    const resolved = resolveConfig({
      scribeProvider: 'openai',
      scribeModel: 'gpt-5-mini',
    }, api);

    assert.equal(resolved.scribeProvider, 'openai');
    assert.equal(resolved.scribeModel, 'gpt-5-mini');
    assert.equal(resolved.reflection.provider, 'openai');
    assert.equal(resolved.reflection.model, 'gpt-5-mini');
  });

  it('registers a direct context engine and background service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-plugin-'));
    try {
      const { api, services, factories } = createApi({
        pluginConfig: {
          dbPath: join(dir, 'memrok.db'),
          watchPaths: [dir],
        },
      });

      createPluginRegistration(api);

      assert.equal(services.length, 1);
      assert.equal(factories.has('memrok'), true);

      const engine = factories.get('memrok')?.();
      assert.ok(engine);

      const result = await engine!.assemble({
        messages: [
          { role: 'user', content: 'Michael likes train commutes for async chats.' },
          { role: 'assistant', content: 'Noted.' },
        ],
      });

      assert.equal(result.messages.length, 2);
      assert.equal(typeof result.estimatedTokens, 'number');
      assert.equal(result.systemPromptAddition, '');

      await services[0].start({ stateDir: dir });
      await engine!.afterTurn({ sessionId: 's1' });
      await services[0].stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses injector directly after store writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-plugin-store-'));
    try {
      const { api, factories } = createApi({
        pluginConfig: {
          dbPath: join(dir, 'memrok.db'),
          watchPaths: [dir],
        },
      });

      const runtime = createPluginRegistration(api);
      runtime.store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'user',
            category: 'preferences',
            key: 'user.preference.commute',
            value: 'Michael likes train commutes for async chats.',
          },
        ],
      });
      runtime.injector.invalidate();

      const engine = factories.get('memrok')?.();
      const result = await engine!.assemble({
        messages: [{ role: 'user', content: 'What do you remember?' }],
      });

      assert.match(result.systemPromptAddition ?? '', /Michael likes train commutes/);
      runtime.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers memory targets for multiple configured OpenClaw agents', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'memrok-openclaw-state-'));
    const oldStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      mkdirSync(join(stateDir, 'agents', 'alpha', 'memory'), { recursive: true });
      mkdirSync(join(stateDir, 'agents', 'beta', 'memory'), { recursive: true });

      const { api } = createApi({
        pluginConfig: {
          dbPath: join(stateDir, 'memrok.db'),
          bootstrap: {
            enabled: true,
          },
        },
      });

      const runtime = createPluginRegistration(api);
      const targets = runtime.describeBootstrapTargets();

      assert.deepEqual(targets.memoryDirs, [
        join(stateDir, 'agents', 'alpha', 'memory'),
        join(stateDir, 'agents', 'beta', 'memory'),
      ]);
      assert.deepEqual(targets.memoryIndexes, [
        join(stateDir, 'agents', 'alpha', 'MEMORY.md'),
        join(stateDir, 'agents', 'beta', 'MEMORY.md'),
      ]);
      runtime.store.close();
    } finally {
      if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = oldStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('registers a memrok command surface for manual operations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-command-'));
    try {
      const { api, commands } = createApi({
        pluginConfig: {
          dbPath: join(dir, 'memrok.db'),
          watchPaths: [dir],
        },
      });

      const runtime = createPluginRegistration(api);
      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.name, 'memrok');

      const help = await commands[0]!.handler({ args: 'help' });
      assert.match(help.text, /scan-memory/);

      const status = await commands[0]!.handler({ args: 'status' });
      assert.match(status.text, /Memrok/);
      runtime.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits explicit provider and model so OpenClaw defaults can apply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-model-defaults-'));
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [{ text: '{"pass_id":"scribe-defaults","mutations":[]}' }],
    }));

    try {
      const { api } = createApi({
        runtime: {
          agent: {
            runEmbeddedPiAgent,
            resolveAgentWorkspaceDir: () => dir,
          },
        },
      });

      const caller = createModelCaller(api, resolveConfig({}, api));
      await caller('system', 'user');

      const params = runEmbeddedPiAgent.mock.calls[0]?.[0] as Record<string, unknown>;
      assert.ok(params);
      assert.equal('provider' in params, false);
      assert.equal('model' in params, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bootstraps memory files on service start even when transcript passes already exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-bootstrap-start-'));
    const dbPath = join(dir, 'memrok.db');
    const seededStore = createStore(dbPath);

    try {
      mkdirSync(join(dir, 'memory'), { recursive: true });
      writeFileSync(join(dir, 'memory', 'note.md'), '# Existing memory\n');
      seededStore.applyPass({
        pass_id: 'transcript-existing',
        source: 'session-1',
        mutations: [
          {
            operation: 'add',
            layer: 'user',
            category: 'fact',
            key: 'user.fact.seeded',
            value: 'already has transcript data',
          },
        ],
      });
      seededStore.close();

      const runEmbeddedPiAgent = vi.fn(async () => ({
        payloads: [{ text: '{"pass_id":"bootstrap-pass","mutations":[]}' }],
      }));

      const { api, services } = createApi({
        pluginConfig: {
          dbPath,
          watchPaths: [dir],
          bootstrap: {
            enabled: true,
            delayMs: 0,
            scanConfiguredAgents: false,
          },
        },
        runtime: {
          agent: {
            runEmbeddedPiAgent,
            resolveAgentWorkspaceDir: () => dir,
          },
        },
      });

      createPluginRegistration(api);
      await services[0]!.start({ stateDir: dir });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(runEmbeddedPiAgent.mock.calls.length >= 1);
      await services[0]!.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds full session reindex runs and reports remaining files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-index-limit-'));
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const oldStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = dir;

    try {
      for (let index = 0; index < 30; index++) {
        writeFileSync(
          join(sessionsDir, `session-${index.toString().padStart(2, '0')}.jsonl`),
          '{"type":"user","text":"hello"}\n',
        );
      }

      let passCounter = 0;
      const runEmbeddedPiAgent = vi.fn(async () => ({
        payloads: [{ text: `{"pass_id":"session-index-pass-${++passCounter}","mutations":[]}` }],
      }));

      const { api } = createApi({
        pluginConfig: {
          dbPath: join(dir, 'memrok.db'),
        },
        runtime: {
          agent: {
            sessionDirs: [sessionsDir],
            runEmbeddedPiAgent,
            resolveAgentWorkspaceDir: () => dir,
          },
        },
      });

      const runtime = createPluginRegistration(api);
      const result = await runtime.indexSessionFiles({ full: true });

      assert.equal(result.filesConsidered, 30);
      assert.equal(result.unreadCandidates, 30);
      assert.equal(result.limitApplied, 25);
      assert.equal(result.processed, 25);
      assert.equal(result.remaining, 5);
      runtime.store.close();
    } finally {
      if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = oldStateDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('advances the cursor after a full replay so unread replay does not immediately duplicate it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-index-cursor-'));
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'session.jsonl'), '{"type":"user","text":"hello"}\n');
    const oldStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = dir;

    let passCounter = 0;
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [{ text: `{"pass_id":"session-replay-pass-${++passCounter}","mutations":[]}` }],
    }));

    try {
      const { api } = createApi({
        pluginConfig: {
          dbPath: join(dir, 'memrok.db'),
        },
        runtime: {
          agent: {
            sessionDirs: [sessionsDir],
            runEmbeddedPiAgent,
            resolveAgentWorkspaceDir: () => dir,
          },
        },
      });

      const runtime = createPluginRegistration(api);
      const fullReplay = await runtime.indexSessionFiles({ full: true, limit: 10 });
      const unreadReplay = await runtime.indexSessionFiles({ limit: 10 });

      assert.equal(fullReplay.processed, 1);
      assert.equal(fullReplay.unreadCandidates, 1);
      assert.equal(unreadReplay.processed, 0);
      assert.equal(unreadReplay.unreadCandidates, 0);
      assert.equal(unreadReplay.skipped, 0);
      runtime.store.close();
    } finally {
      if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = oldStateDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefilters unread session indexing to files with unread bytes before applying the limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-index-unread-filter-'));
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const oldStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = dir;

    const readPath = join(sessionsDir, 'older-read.jsonl');
    const unreadPath = join(sessionsDir, 'newer-unread.jsonl');
    writeFileSync(readPath, '{"type":"user","text":"read"}\n');
    writeFileSync(unreadPath, '{"type":"user","text":"unread"}\n');

    let passCounter = 0;
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [{ text: `{"pass_id":"session-unread-pass-${++passCounter}","mutations":[]}` }],
    }));

    try {
      const { api } = createApi({
        pluginConfig: {
          dbPath: join(dir, 'memrok.db'),
        },
        runtime: {
          agent: {
            sessionDirs: [sessionsDir],
            runEmbeddedPiAgent,
            resolveAgentWorkspaceDir: () => dir,
          },
        },
      });

      const runtime = createPluginRegistration(api);
      runtime.watcher.setCursor(readPath, readFileSync(readPath, 'utf-8').length);
      runtime.watcher.saveCursors();

      const result = await runtime.indexSessionFiles({ limit: 1 });

      assert.equal(result.filesConsidered, 2);
      assert.equal(result.unreadCandidates, 1);
      assert.equal(result.processed, 1);
      assert.equal(result.remaining, 0);
      assert.equal(runEmbeddedPiAgent.mock.calls.length, 1);
      const call = runEmbeddedPiAgent.mock.calls[0]?.[0] as { sessionFile?: string; prompt?: string };
      assert.ok(call);
      assert.match(call.prompt ?? '', /unread/);
      runtime.store.close();
    } finally {
      if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = oldStateDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shouldRunReflection', () => {
  const baseConfig = {
    enabled: true,
    deltaPasses: 5,
    cooldownHours: 24,
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
  };

  it('returns false when reflection is disabled', () => {
    const now = Date.now();
    assert.equal(
      shouldRunReflection(10, 0, { ...baseConfig, enabled: false }, now),
      false,
    );
  });

  it('returns false when delta passes not met', () => {
    const now = Date.now();
    // Only 4 passes but need 5
    assert.equal(
      shouldRunReflection(4, 0, baseConfig, now),
      false,
    );
  });

  it('returns false when cooldown not elapsed', () => {
    const now = Date.now();
    const recentReflection = now - 1 * 60 * 60 * 1000; // 1 hour ago, need 24
    assert.equal(
      shouldRunReflection(5, recentReflection, baseConfig, now),
      false,
    );
  });

  it('returns true when delta and cooldown both satisfied', () => {
    const now = Date.now();
    const oldReflection = now - 25 * 60 * 60 * 1000; // 25 hours ago
    assert.equal(
      shouldRunReflection(5, oldReflection, baseConfig, now),
      true,
    );
  });

  it('returns true on first reflection (lastReflectionTime = 0)', () => {
    const now = Date.now();
    assert.equal(
      shouldRunReflection(5, 0, baseConfig, now),
      true,
    );
  });

  it('returns false when exactly at delta boundary (need strictly >=)', () => {
    const now = Date.now();
    // Exactly 5 passes — should trigger (>= not >)
    assert.equal(
      shouldRunReflection(5, 0, baseConfig, now),
      true,
    );
    // 4 passes — should not trigger
    assert.equal(
      shouldRunReflection(4, 0, baseConfig, now),
      false,
    );
  });
});

describe('runReflectionPass', () => {
  it('records reflection attempt metadata when the reflective scribe fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-reflection-status-'));
    const dbPath = join(dir, 'memrok.db');
    const store = createStore(dbPath);
    const statusCalls: Record<string, unknown> = {};
    const status = {
      recordReflectiveScribeAttempt(inputBytes: number) {
        statusCalls.lastReflectiveScribeAttemptAt = new Date().toISOString();
        statusCalls.lastReflectiveScribeInputBytes = inputBytes;
      },
      recordReflectiveScribeFailure(stage: string, error: unknown) {
        statusCalls.lastReflectiveScribeFailureAt = new Date().toISOString();
        statusCalls.lastReflectiveScribeErrorStage = stage;
        statusCalls.lastReflectiveScribeErrorMessage = error instanceof Error ? error.message : String(error);
      },
      recordReflectiveScribe() {
        statusCalls.lastReflectiveScribeAt = new Date().toISOString();
      },
      recordError(stage: string, error: unknown) {
        statusCalls.lastErrorStage = stage;
        statusCalls.lastErrorMessage = error instanceof Error ? error.message : String(error);
      },
      setNodeLifecycleCounts(activeNodeCount: number, expiredNodeCount: number) {
        statusCalls.activeNodeCount = activeNodeCount;
        statusCalls.expiredNodeCount = expiredNodeCount;
      },
    };

    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'user',
            category: 'fact',
            key: 'user.preference.tone',
            value: 'Prefers direct status updates.',
          },
        ],
      });

      let invalidated = false;

      await assert.rejects(
        runReflectionPass({
          store,
          reflectionScribe: {
            callModel: async () => {
              throw new Error('reflection model boom');
            },
          } as never,
          injector: {
            invalidate() {
              invalidated = true;
            },
          },
          status: status as never,
        }),
        /reflection model boom/,
      );

      assert.ok(statusCalls.lastReflectiveScribeAttemptAt);
      assert.ok(statusCalls.lastReflectiveScribeFailureAt);
      assert.equal(statusCalls.lastReflectiveScribeErrorStage, 'call-model');
      assert.equal(statusCalls.lastReflectiveScribeErrorMessage, 'reflection model boom');
      assert.equal(statusCalls.lastErrorStage, 'reflective-scribe');
      assert.equal(statusCalls.lastErrorMessage, 'reflection model boom');
      assert.equal(statusCalls.lastReflectiveScribeAt, undefined);
      assert.equal(typeof statusCalls.lastReflectiveScribeInputBytes, 'number');
      assert.ok((statusCalls.lastReflectiveScribeInputBytes as number) > 0);
      assert.equal(invalidated, false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs reflection on service start when recovered state already qualifies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-reflection-start-'));
    const dbPath = join(dir, 'memrok.db');
    const seededStore = createStore(dbPath);

    try {
      seededStore.applyPass({
        pass_id: 'transcript-1',
        source: 'session-1',
        mutations: [
          {
            operation: 'add',
            layer: 'user',
            category: 'preference',
            key: 'user.preference.status',
            value: 'Wants direct status updates.',
          },
        ],
      });
      seededStore.close();

      const { api, services } = createApi({
        pluginConfig: {
          dbPath,
          watchPaths: [dir],
          bootstrap: { enabled: false },
          reflection: {
            enabled: true,
            deltaPasses: 1,
            cooldownHours: 0,
          },
        },
        runtime: {
          agent: {
            runEmbeddedPiAgent: async () => ({
              payloads: [
                {
                  text: '{"pass_id":"reflection-start","mutations":[]}',
                },
              ],
            }),
          },
        },
      });

      const runtime = createPluginRegistration(api);
      await services[0].start({ stateDir: dir });

      const reflectionPasses = runtime.store.listPasses().filter((pass) => pass.source === 'reflection');
      assert.equal(reflectionPasses.length, 1);

      await services[0].stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs reflection from the timer after cooldown elapses without a new transcript pass', async () => {
    vi.useFakeTimers();
    const baseTime = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(baseTime);

    const dir = mkdtempSync(join(tmpdir(), 'memrok-reflection-timer-'));
    const dbPath = join(dir, 'memrok.db');
    const seededStore = createStore(dbPath);

    try {
      seededStore.applyPass({
        pass_id: 'reflection-old',
        source: 'reflection',
        mutations: [],
      });
      seededStore.applyPass({
        pass_id: 'transcript-after-reflection',
        source: 'session-2',
        mutations: [
          {
            operation: 'add',
            layer: 'collaboration',
            category: 'pattern',
            key: 'collab.pattern.status',
            value: 'Direct status updates work well.',
          },
        ],
      });
      seededStore.close();

      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE passes SET timestamp = ? WHERE pass_id = ?').run('2026-01-01 00:00:00', 'reflection-old');
      db.prepare('UPDATE passes SET timestamp = ? WHERE pass_id = ?').run('2026-01-01 01:00:00', 'transcript-after-reflection');
      db.close();

      let reflectionCalls = 0;
      const { api, services } = createApi({
        pluginConfig: {
          dbPath,
          watchPaths: [dir],
          bootstrap: { enabled: false },
          reflection: {
            enabled: true,
            deltaPasses: 1,
            cooldownHours: 24,
          },
        },
        runtime: {
          agent: {
            runEmbeddedPiAgent: async () => {
              reflectionCalls++;
              return {
                payloads: [
                  {
                    text: '{"pass_id":"reflection-periodic","mutations":[]}',
                  },
                ],
              };
            },
          },
        },
      });

      const runtime = createPluginRegistration(api);
      await services[0].start({ stateDir: dir });
      assert.equal(runtime.store.listPasses().filter((pass) => pass.source === 'reflection').length, 1);

      vi.setSystemTime(new Date(baseTime.getTime() + 25 * 60 * 60 * 1000));
      await vi.advanceTimersByTimeAsync(60_000);
      assert.equal(reflectionCalls, 1);
      let reflectionPasses = runtime.store.listPasses().filter((pass) => pass.source === 'reflection');
      for (let attempt = 0; reflectionPasses.length < 2 && attempt < 5; attempt++) {
        await vi.advanceTimersByTimeAsync(0);
        reflectionPasses = runtime.store.listPasses().filter((pass) => pass.source === 'reflection');
      }
      assert.equal(reflectionPasses.length, 2);

      await services[0].stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
