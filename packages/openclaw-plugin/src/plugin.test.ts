import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '@memrok/store';
import { createPluginRegistration, resolveConfig, runReflectionPass, shouldRunReflection } from './plugin.js';
import type { ContextEngine, PluginApi, PluginService } from './types.js';

function createApi(overrides: Partial<PluginApi> = {}): {
  api: PluginApi;
  services: PluginService[];
  factories: Map<string, () => ContextEngine>;
} {
  const services: PluginService[] = [];
  const factories = new Map<string, () => ContextEngine>();
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
    ...overrides,
  };
  return { api, services, factories };
}

describe('openclaw plugin orchestration', () => {
  it('resolves plugin config defaults', () => {
    const { api } = createApi();
    const resolved = resolveConfig({}, api);
    assert.equal(resolved.scribeProvider, 'anthropic');
    assert.equal(resolved.scribeModel, 'claude-sonnet-4-6');
    assert.equal(resolved.deltaThreshold, 20);
    assert.equal(resolved.idleMinutes, 15);
    assert.equal(resolved.tokenBudget, 1000);
    assert.ok(resolved.dbPath.endsWith('/.memrok/memrok.db'));
  });

  it('resolves reflection config defaults', () => {
    const { api } = createApi();
    const resolved = resolveConfig({}, api);
    assert.equal(resolved.reflection.enabled, true);
    assert.equal(resolved.reflection.deltaPasses, 5);
    assert.equal(resolved.reflection.cooldownHours, 24);
    // Inherits scribe model/provider when not specified
    assert.equal(resolved.reflection.model, resolved.scribeModel);
    assert.equal(resolved.reflection.provider, resolved.scribeProvider);
  });

  it('resolves reflection config overrides', () => {
    const { api } = createApi();
    const resolved = resolveConfig({
      reflection: {
        enabled: false,
        deltaPasses: 10,
        cooldownHours: 48,
        model: 'claude-opus-4-6',
        provider: 'anthropic',
      },
    }, api);
    assert.equal(resolved.reflection.enabled, false);
    assert.equal(resolved.reflection.deltaPasses, 10);
    assert.equal(resolved.reflection.cooldownHours, 48);
    assert.equal(resolved.reflection.model, 'claude-opus-4-6');
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
      setNodeCount(nodeCount: number) {
        statusCalls.nodeCount = nodeCount;
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
});
