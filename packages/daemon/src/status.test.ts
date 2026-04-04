import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StatusTracker, getStatusFilePath } from './status.js';

describe('StatusTracker', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memrok-status-'));
    dbPath = join(dir, 'memrok.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a status file beside the db', () => {
    const tracker = new StatusTracker(dbPath);
    tracker.setNodeCount(12);
    tracker.recordTranscriptScribe('topic-540.jsonl');
    tracker.recordReflectiveScribeAttempt(256);
    tracker.recordReflectiveScribe();
    tracker.recordReflectiveScribeFailure('call-model', new Error('reflection boom'));
    tracker.recordError('transcript-scribe', new Error('boom'));

    const path = getStatusFilePath(dbPath);
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    assert.equal(parsed.nodeCount, 12);
    assert.equal(parsed.lastSourceProcessed, 'topic-540.jsonl');
    assert.equal(parsed.lastErrorStage, 'transcript-scribe');
    assert.equal(parsed.lastErrorMessage, 'boom');
    assert.equal(parsed.lastReflectiveScribeInputBytes, 256);
    assert.equal(parsed.lastReflectiveScribeErrorStage, 'call-model');
    assert.equal(parsed.lastReflectiveScribeErrorMessage, 'reflection boom');
    assert.ok(parsed.lastTranscriptScribeAt);
    assert.ok(parsed.lastReflectiveScribeAttemptAt);
    assert.ok(parsed.lastReflectiveScribeAt);
    assert.ok(parsed.lastReflectiveScribeFailureAt);
    assert.ok(parsed.updatedAt);
  });

  it('exposes a copy of current status', () => {
    const tracker = new StatusTracker(dbPath);
    tracker.setNodeCount(3);
    const status = tracker.getStatus();
    assert.equal(status.nodeCount, 3);

    status.nodeCount = 999;
    assert.equal(tracker.getStatus().nodeCount, 3);
  });
});
