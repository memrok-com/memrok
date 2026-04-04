import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScribeInterface } from './index.js';

describe('ScribeInterface', () => {
  it('passes system prompt and transcript to ModelCaller', async () => {
    let seenSystemPrompt = '';
    let seenTranscript = '';

    const scribe = new ScribeInterface(async (systemPrompt, userMessage) => {
      seenSystemPrompt = systemPrompt;
      seenTranscript = userMessage;
      return '{"pass_id":"p1","mutations":[]}';
    });

    const pass = await scribe.callModel('test transcript');
    assert.equal(pass.pass_id, 'p1');
    assert.ok(seenSystemPrompt.length > 100);
    assert.equal(seenTranscript, 'test transcript');
  });

  it('loads custom system prompt from file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memrok-scribe-'));
    try {
      const promptPath = join(dir, 'prompt.txt');
      writeFileSync(promptPath, 'custom prompt');

      let seenSystemPrompt = '';
      const scribe = new ScribeInterface(async (systemPrompt) => {
        seenSystemPrompt = systemPrompt;
        return '{"pass_id":"p2","mutations":[]}';
      }, { systemPromptPath: promptPath });

      await scribe.callModel('hello');
      assert.equal(seenSystemPrompt, 'custom prompt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses fenced JSON', () => {
    const scribe = new ScribeInterface(async () => '{"pass_id":"ignored","mutations":[]}');
    const pass = scribe.parseResponse('```json\n{"pass_id":"p3","mutations":[]}\n```');
    assert.equal(pass.pass_id, 'p3');
  });

  it('rejects missing pass_id or mutations', () => {
    const scribe = new ScribeInterface(async () => '{"pass_id":"ignored","mutations":[]}');
    assert.throws(() => scribe.parseResponse('{"mutations":[]}'), /missing pass_id or mutations/);
  });

  it('drops mutations with missing required fields like category', () => {
    const scribe = new ScribeInterface(async () => '{"pass_id":"ignored","mutations":[]}');
    const pass = scribe.parseResponse('{"pass_id":"p4","mutations":[{"operation":"add","layer":"user","key":"user.test","value":"hello"}]}');
    assert.equal(pass.pass_id, 'p4');
    assert.equal(pass.mutations.length, 0);
  });
});
