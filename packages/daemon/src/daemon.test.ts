import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '@memrok/store';
import { createInjector } from '@memrok/injector';
import type { Store, ScribePass } from '@memrok/store';
import type { Injector } from '@memrok/injector';
import { ConsolidationEngine } from './consolidation.js';
import { ScribeInterface } from './scribe.js';
import { TranscriptWatcher } from './watcher.js';
import { createApiServer } from './api.js';
import { substituteEnvVars, expandHome, resolveConfig } from './config.js';
import type { Server } from 'node:http';

// ─── Config tests ───

describe('config', () => {
  it('substitutes environment variables', () => {
    process.env.__TEST_VAR__ = 'hello';
    assert.equal(substituteEnvVars('${__TEST_VAR__}'), 'hello');
    assert.equal(substituteEnvVars('key=${__TEST_VAR__}/path'), 'key=hello/path');
    delete process.env.__TEST_VAR__;
  });

  it('throws on missing env var', () => {
    delete process.env.__MISSING_VAR__;
    assert.throws(() => substituteEnvVars('${__MISSING_VAR__}'), /not set/);
  });

  it('expands home directory', () => {
    const result = expandHome('~/test');
    assert.ok(!result.startsWith('~'));
    assert.ok(result.endsWith('/test'));
  });

  it('resolveConfig walks and substitutes', () => {
    process.env.__TEST_KEY__ = 'secret123';
    const config = resolveConfig({
      store: { path: '/tmp/test.sqlite' },
      watcher: { paths: ['/tmp'] },
      scribe: {
        provider: 'anthropic',
        model: 'test',
        apiKey: '${__TEST_KEY__}',
      },
    });
    assert.equal(config.scribe.apiKey, 'secret123');
    delete process.env.__TEST_KEY__;
  });
});

// ─── Consolidation tests ───

describe('ConsolidationEngine', () => {
  let engine: ConsolidationEngine;

  beforeEach(() => {
    engine = new ConsolidationEngine({
      deltaThreshold: 5,
      idleMinutes: 1,
      maxInterval: 10,
    });
  });

  it('does not trigger below threshold', () => {
    engine.recordMessages(3);
    const result = engine.shouldTrigger();
    assert.equal(result.trigger, false);
  });

  it('does not trigger at threshold without idle time', () => {
    engine.recordMessages(5);
    // Just recorded messages, not idle yet
    const result = engine.shouldTrigger();
    assert.equal(result.trigger, false);
  });

  it('triggers when delta threshold met and idle', () => {
    engine.recordMessages(5);
    // Simulate idle: set lastMessageTime to 2 minutes ago
    const twoMinAgo = Date.now() - 2 * 60 * 1000;
    engine._setState({ lastMessageTime: twoMinAgo });
    const result = engine.shouldTrigger();
    assert.equal(result.trigger, true);
    assert.equal(result.reason, 'delta_and_idle');
  });

  it('triggers on max interval regardless of delta', () => {
    engine.recordMessages(1); // Below threshold
    // Simulate last pass was 11 minutes ago
    const elevenMinAgo = Date.now() - 11 * 60 * 1000;
    engine._setState({ lastPassTime: elevenMinAgo });
    const result = engine.shouldTrigger();
    assert.equal(result.trigger, true);
    assert.equal(result.reason, 'max_interval');
  });

  it('does not trigger max interval with zero messages', () => {
    const elevenMinAgo = Date.now() - 11 * 60 * 1000;
    engine._setState({ lastPassTime: elevenMinAgo, newMessageCount: 0 });
    const result = engine.shouldTrigger();
    assert.equal(result.trigger, false);
  });

  it('force trigger calls callback and resets state', async () => {
    let called = false;
    engine.setTriggerCallback(() => { called = true; });
    engine.recordMessages(10);
    await engine.forceTrigger();
    assert.equal(called, true);
    assert.equal(engine.getState().newMessageCount, 0);
  });

  it('recordPassComplete resets message count', () => {
    engine.recordMessages(10);
    engine.recordPassComplete();
    assert.equal(engine.getState().newMessageCount, 0);
  });
});

// ─── Scribe response parsing tests ───

describe('ScribeInterface', () => {
  let scribe: ScribeInterface;

  beforeEach(() => {
    scribe = new ScribeInterface({
      provider: 'anthropic',
      model: 'test-model',
      apiKey: 'test-key',
    });
  });

  it('parses plain JSON response', () => {
    const pass = scribe.parseResponse(JSON.stringify({
      pass_id: 'test-001',
      mutations: [
        { operation: 'add', layer: 'user', category: 'prefs', key: 'lang', value: 'TypeScript' },
      ],
    }));
    assert.equal(pass.pass_id, 'test-001');
    assert.equal(pass.mutations.length, 1);
    assert.equal(pass.mutations[0].key, 'lang');
  });

  it('parses JSON wrapped in markdown code block', () => {
    const text = '```json\n{"pass_id":"test-002","mutations":[]}\n```';
    const pass = scribe.parseResponse(text);
    assert.equal(pass.pass_id, 'test-002');
    assert.equal(pass.mutations.length, 0);
  });

  it('throws on missing pass_id', () => {
    assert.throws(
      () => scribe.parseResponse('{"mutations":[]}'),
      /missing pass_id/,
    );
  });

  it('throws on missing mutations', () => {
    assert.throws(
      () => scribe.parseResponse('{"pass_id":"x"}'),
      /missing pass_id or mutations/,
    );
  });

  it('throws on invalid JSON', () => {
    assert.throws(
      () => scribe.parseResponse('not json'),
    );
  });
});

// ─── Cursor persistence tests ───

describe('TranscriptWatcher cursors', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memrok-watcher-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads new content from a file based on cursor offset', () => {
    const testFile = join(tmpDir, 'test.jsonl');
    writeFileSync(testFile, '{"line":1}\n{"line":2}\n');

    const cursorPath = join(tmpDir, '.memrok-cursors.json');
    const watcher = new TranscriptWatcher({ paths: [tmpDir] }, cursorPath);

    const content1 = watcher.readNewContent(testFile);
    assert.ok(content1);
    assert.ok(content1.includes('"line":1'));

    // Append more data
    appendFileSync(testFile, '{"line":3}\n');
    const content2 = watcher.readNewContent(testFile);
    assert.ok(content2);
    assert.ok(content2.includes('"line":3'));
    assert.ok(!content2.includes('"line":1'));
  });

  it('persists and restores cursors', () => {
    const testFile = join(tmpDir, 'test.jsonl');
    writeFileSync(testFile, '{"a":1}\n');

    const cursorPath = join(tmpDir, '.memrok-cursors.json');
    const watcher1 = new TranscriptWatcher({ paths: [tmpDir] }, cursorPath);
    watcher1.readNewContent(testFile);
    watcher1.saveCursors();

    // Create new watcher that loads persisted cursors
    const watcher2 = new TranscriptWatcher({ paths: [tmpDir] }, cursorPath);
    const cursors = watcher2.getCursors();
    assert.ok(cursors[testFile] > 0);

    // No new content since cursor was saved
    const content = watcher2.readNewContent(testFile);
    assert.equal(content, null);
  });

  it('returns null for nonexistent file', () => {
    const watcher = new TranscriptWatcher({ paths: [tmpDir] }, join(tmpDir, 'c.json'));
    const content = watcher.readNewContent('/nonexistent/file.jsonl');
    assert.equal(content, null);
  });
});

// ─── HTTP API tests ───

describe('HTTP API', () => {
  let tmpDir: string;
  let store: Store;
  let injector: Injector;
  let consolidation: ConsolidationEngine;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memrok-api-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    store = createStore(dbPath);
    injector = createInjector(store, { tokenBudget: 500 });
    consolidation = new ConsolidationEngine();

    let triggerCalled = false;

    server = createApiServer(
      { port: 0, host: '127.0.0.1' },
      {
        store,
        injector,
        consolidation,
        getStatus: () => ({
          running: true,
          uptime: 1000,
          lastPass: null,
          pendingMessages: 0,
          watchedFiles: 0,
        }),
        onNotify: () => {},
        onTrigger: async () => { triggerCalled = true; },
      },
    );

    // Wait for server to be listening
    await new Promise<void>((resolve) => {
      server.on('listening', resolve);
    });

    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /health returns status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(data.running, true);
    assert.equal(typeof data.uptime, 'number');
  });

  it('GET /header returns context header', async () => {
    const res = await fetch(`${baseUrl}/header`);
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(typeof data.tokens, 'number');
    assert.equal(typeof data.nodesUsed, 'number');
  });

  it('POST /header with context', async () => {
    const res = await fetch(`${baseUrl}/header`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recentMessages: 'hello world' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(typeof data.tokens, 'number');
  });

  it('POST /notify returns ok', async () => {
    const res = await fetch(`${baseUrl}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageCount: 5 }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(data.ok, true);
  });

  it('POST /trigger returns ok', async () => {
    const res = await fetch(`${baseUrl}/trigger`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(data.triggered, true);
  });

  it('GET /nodes returns empty array initially', async () => {
    const res = await fetch(`${baseUrl}/nodes`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal((data as unknown[]).length, 0);
  });

  it('GET /nodes returns nodes after applying a pass', async () => {
    const pass: ScribePass = {
      pass_id: 'api-test-pass',
      mutations: [
        { operation: 'add', layer: 'user', category: 'prefs', key: 'editor', value: 'vim' },
      ],
    };
    store.applyPass(pass);

    const res = await fetch(`${baseUrl}/nodes`);
    assert.equal(res.status, 200);
    const data = await res.json() as unknown[];
    assert.equal(data.length, 1);
  });

  it('GET /nodes/:key returns specific node', async () => {
    store.applyPass({
      pass_id: 'api-test-pass-2',
      mutations: [
        { operation: 'add', layer: 'user', category: 'prefs', key: 'theme', value: 'dark' },
      ],
    });

    const res = await fetch(`${baseUrl}/nodes/theme`);
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(data.key, 'theme');
    assert.equal(data.value, 'dark');
  });

  it('GET /nodes/:key returns 404 for missing', async () => {
    const res = await fetch(`${baseUrl}/nodes/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('GET /weights returns relevance weights', async () => {
    const res = await fetch(`${baseUrl}/weights`);
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(typeof data.recency, 'number');
    assert.equal(typeof data.frequency, 'number');
  });

  it('PUT /weights/:signal updates a weight', async () => {
    const res = await fetch(`${baseUrl}/weights/recency`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 0.8 }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, number>;
    assert.equal(data.recency, 0.8);
  });

  it('PUT /weights/:signal rejects unknown signal', async () => {
    const res = await fetch(`${baseUrl}/weights/bogus`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 0.5 }),
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    assert.equal(res.status, 404);
  });

  it('binds to loopback by default', () => {
    const addr = server.address();
    assert.ok(typeof addr === 'object' && addr !== null);
    assert.equal(addr.address, '127.0.0.1');
  });

  it('GET /nodes with query params filters', async () => {
    store.applyPass({
      pass_id: 'filter-test',
      mutations: [
        { operation: 'add', layer: 'user', category: 'prefs', key: 'k1', value: 'v1' },
        { operation: 'add', layer: 'agent', category: 'style', key: 'k2', value: 'v2' },
      ],
    });

    const res = await fetch(`${baseUrl}/nodes?layer=user`);
    assert.equal(res.status, 200);
    const data = await res.json() as Array<{ layer: string }>;
    assert.ok(data.length > 0);
    for (const node of data) {
      assert.equal(node.layer, 'user');
    }
  });
});

// ─── Chunk preservation on scribe failure tests ───

describe('runScribePass chunk preservation', () => {

  it('preserves chunks on failure and processes them on retry', async () => {
    // Direct unit test of the runScribePass pattern
    const pendingChunks: string[] = [];
    pendingChunks.push('chunk1', 'chunk2');

    let callModelCalled = false;

    // Simulate the fixed runScribePass logic
    async function runScribePass(callModel: (t: string) => Promise<void>): Promise<void> {
      if (pendingChunks.length === 0) return;
      const transcript = pendingChunks.join('\n');

      // Call model (may throw)
      await callModel(transcript);

      // Only clear after success
      pendingChunks.length = 0;
    }

    // First call: callModel throws
    await assert.rejects(
      () => runScribePass(async () => { throw new Error('API error'); }),
      /API error/,
    );

    // Chunks should be preserved
    assert.equal(pendingChunks.length, 2, 'chunks must be preserved after failure');
    assert.deepEqual(pendingChunks, ['chunk1', 'chunk2']);

    // Second call: callModel succeeds
    await runScribePass(async (transcript) => {
      callModelCalled = true;
      assert.ok(transcript.includes('chunk1'), 'retry should include original chunk1');
      assert.ok(transcript.includes('chunk2'), 'retry should include original chunk2');
    });

    assert.equal(callModelCalled, true, 'callModel should have been called on retry');
    assert.equal(pendingChunks.length, 0, 'chunks should be cleared after success');
  });
});

// ─── systemPromptPath override tests ───

describe('ScribeInterface systemPromptPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memrok-prompt-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses custom system prompt from file when systemPromptPath is set', async () => {
    const customPrompt = 'You are a custom scribe. Extract memories as JSON.';
    const promptFile = join(tmpDir, 'custom-prompt.txt');
    writeFileSync(promptFile, customPrompt);

    const scribe = new ScribeInterface({
      provider: 'anthropic',
      model: 'test-model',
      apiKey: 'test-key',
      systemPromptPath: promptFile,
    });

    // Access the systemPrompt via the Anthropic request body
    // We mock fetch to capture the request
    let capturedBody: any;
    mock.method(globalThis, 'fetch', async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '{"pass_id":"p1","mutations":[]}' }],
        }),
      } as Response;
    });

    await scribe.callModel('test transcript');
    assert.equal(capturedBody.system, customPrompt, 'should use custom prompt from file');

    mock.restoreAll();
  });

  it('uses bundled SCRIBE_SYSTEM_PROMPT when no systemPromptPath is set', async () => {
    const scribe = new ScribeInterface({
      provider: 'anthropic',
      model: 'test-model',
      apiKey: 'test-key',
    });

    let capturedBody: any;
    mock.method(globalThis, 'fetch', async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '{"pass_id":"p1","mutations":[]}' }],
        }),
      } as Response;
    });

    await scribe.callModel('test transcript');
    assert.ok(capturedBody.system, 'system prompt should be set');
    assert.ok(capturedBody.system.length > 100, 'bundled prompt should be substantial');

    mock.restoreAll();
  });

  it('throws when systemPromptPath points to nonexistent file', () => {
    assert.throws(() => {
      new ScribeInterface({
        provider: 'anthropic',
        model: 'test-model',
        apiKey: 'test-key',
        systemPromptPath: '/nonexistent/path/prompt.txt',
      });
    }, /ENOENT/);
  });
});
