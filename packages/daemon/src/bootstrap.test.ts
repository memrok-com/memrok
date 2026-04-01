import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '@memrok/store';
import type { Store } from '@memrok/store';
import { bootstrap } from './bootstrap.js';
import type { ScribeConfig } from './types.js';

function makeScribeConfig(): ScribeConfig {
  return {
    provider: 'anthropic',
    model: 'test-model',
    apiKey: 'test-key',
  };
}

function mockFetchWithPass(passId: string, mutations: Array<Record<string, unknown>> = []) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({ pass_id: passId, mutations }),
      }],
    }),
  } as Response));
}

let callCount = 0;

function mockFetchWithMutations() {
  callCount = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    callCount++;
    return {
      ok: true,
      json: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            pass_id: `pass-${callCount}`,
            mutations: [
              { operation: 'add', layer: 'user', category: 'prefs', key: `key-${callCount}`, value: `value-${callCount}` },
            ],
          }),
        }],
      }),
    } as Response;
  });
}

describe('bootstrap', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memrok-bootstrap-test-'));
    store = createStore(join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('processes multiple files and applies passes', async () => {
    const memDir = join(tmpDir, 'memory');
    mkdirSync(memDir);
    writeFileSync(join(memDir, 'MEMORY.md'), '# Memory Index\n- [User role](user_role.md)');
    writeFileSync(join(memDir, 'user_role.md'), '---\nname: role\n---\nSenior engineer');
    writeFileSync(join(memDir, '2026-03-30.md'), '# Daily notes\nWorked on bootstrap feature');

    const fetchMock = mockFetchWithMutations();

    const result = await bootstrap({
      store,
      scribeConfig: makeScribeConfig(),
      memoryDir: memDir,
    });

    assert.equal(result.filesProcessed, 3);
    assert.equal(result.filesSkipped, 0);
    assert.equal(result.filesFailed, 0);
    assert.equal(result.totalMutations, 3);
    assert.equal(fetchMock.mock.calls.length, 3);

    // Verify nodes were created in the store
    const nodes = store.queryNodes();
    assert.equal(nodes.length, 3);
  });

  it('skips empty files', async () => {
    const memDir = join(tmpDir, 'memory');
    mkdirSync(memDir);
    writeFileSync(join(memDir, 'content.md'), 'Real content here');
    writeFileSync(join(memDir, 'empty.md'), '');
    writeFileSync(join(memDir, 'whitespace.md'), '   \n  \n  ');

    mockFetchWithMutations();

    const result = await bootstrap({
      store,
      scribeConfig: makeScribeConfig(),
      memoryDir: memDir,
    });

    assert.equal(result.filesProcessed, 1);
    assert.equal(result.filesSkipped, 2);

    const emptyResult = result.results.find(r => r.file.includes('empty.md'));
    assert.equal(emptyResult?.status, 'skipped');

    const wsResult = result.results.find(r => r.file.includes('whitespace.md'));
    assert.equal(wsResult?.status, 'skipped');
  });

  it('continues on individual file failure', async () => {
    const memDir = join(tmpDir, 'memory');
    mkdirSync(memDir);
    writeFileSync(join(memDir, 'a_good.md'), 'Good content');
    writeFileSync(join(memDir, 'b_bad.md'), 'Bad content');
    writeFileSync(join(memDir, 'c_good.md'), 'More good content');

    let fileCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fileCount++;
      if (fileCount === 2) {
        // Second file fails
        return { ok: false, status: 500, statusText: 'Internal Server Error' } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'text',
            text: JSON.stringify({
              pass_id: `pass-${fileCount}`,
              mutations: [
                { operation: 'add', layer: 'user', category: 'test', key: `k${fileCount}`, value: 'v' },
              ],
            }),
          }],
        }),
      } as Response;
    });

    const result = await bootstrap({
      store,
      scribeConfig: makeScribeConfig(),
      memoryDir: memDir,
    });

    assert.equal(result.filesProcessed, 2);
    assert.equal(result.filesFailed, 1);

    const failedResult = result.results.find(r => r.status === 'error');
    assert.ok(failedResult);
    assert.ok(failedResult.error);

    // Good files still had their mutations applied
    const nodes = store.queryNodes();
    assert.equal(nodes.length, 2);
  });

  it('source tagging is correct', async () => {
    const memDir = join(tmpDir, 'memory');
    mkdirSync(memDir);
    writeFileSync(join(memDir, 'MEMORY.md'), '# Index\n- stuff');

    mockFetchWithPass('pass-src', [
      { operation: 'add', layer: 'user', category: 'test', key: 'tagged', value: 'v' },
    ]);

    await bootstrap({
      store,
      scribeConfig: makeScribeConfig(),
      memoryDir: memDir,
    });

    // Verify the pass was recorded with correct source
    const passes = store.listPasses();
    assert.equal(passes.length, 1);
    assert.equal(passes[0].source, 'bootstrap:MEMORY.md');
  });

  it('accepts specific files via files option', async () => {
    const file1 = join(tmpDir, 'specific.md');
    const file2 = join(tmpDir, 'another.md');
    writeFileSync(file1, 'Specific file content');
    writeFileSync(file2, 'Another file content');

    mockFetchWithMutations();

    const result = await bootstrap({
      store,
      scribeConfig: makeScribeConfig(),
      files: [file1, file2],
    });

    assert.equal(result.filesProcessed, 2);
    assert.equal(result.totalMutations, 2);
  });

  it('deduplicates files from memoryDir and files', async () => {
    const memDir = join(tmpDir, 'memory');
    mkdirSync(memDir);
    const sharedFile = join(memDir, 'shared.md');
    writeFileSync(sharedFile, 'Shared content');

    mockFetchWithMutations();

    const result = await bootstrap({
      store,
      scribeConfig: makeScribeConfig(),
      memoryDir: memDir,
      files: [sharedFile],
    });

    // Should only process once
    assert.equal(result.filesProcessed, 1);
  });

  it('scans subdirectories recursively', async () => {
    const memDir = join(tmpDir, 'memory');
    const subDir = join(memDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(memDir, 'top.md'), 'Top level');
    writeFileSync(join(subDir, 'nested.md'), 'Nested file');

    mockFetchWithMutations();

    const result = await bootstrap({
      store,
      scribeConfig: makeScribeConfig(),
      memoryDir: memDir,
    });

    assert.equal(result.filesProcessed, 2);
  });
});
