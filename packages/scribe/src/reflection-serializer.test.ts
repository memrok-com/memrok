import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '@memrok/store';
import { serializeGraphForReflection } from './reflection-serializer.js';

function makeTmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'memrok-reflect-'));
  const store = createStore(join(dir, 'test.db'));
  return { store, dir };
}

describe('serializeGraphForReflection', () => {
  it('returns empty-graph message when store has no nodes', () => {
    const { store, dir } = makeTmpStore();
    try {
      const out = serializeGraphForReflection(store);
      assert.match(out, /0 nodes/);
      assert.match(out, /No nodes match/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes nodes updated recently', () => {
    const { store, dir } = makeTmpStore();
    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'user',
            category: 'preference',
            key: 'user.voice.tone',
            value: 'Prefers blunt, direct tone.',
          },
        ],
      });

      const out = serializeGraphForReflection(store, { recentDays: 30 });
      assert.match(out, /user\.voice\.tone/);
      assert.match(out, /Prefers blunt/);
      assert.match(out, /USER/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes expired nodes', () => {
    const { store, dir } = makeTmpStore();
    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'agent',
            category: 'failure_mode',
            key: 'agent.failure.old_habit',
            value: 'Used to do X.',
          },
        ],
      });
      store.applyPass({
        pass_id: 'p2',
        mutations: [
          {
            operation: 'expire',
            layer: 'agent',
            category: 'failure_mode',
            key: 'agent.failure.old_habit',
            value: 'No longer relevant.',
          },
        ],
      });

      const out = serializeGraphForReflection(store);
      assert.doesNotMatch(out, /agent\.failure\.old_habit/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes high-reference nodes regardless of age', () => {
    const { store, dir } = makeTmpStore();
    try {
      // Add node and reference it multiple times to raise reference_count
      store.applyPass({
        pass_id: 'p1',
        mutations: [{ operation: 'add', layer: 'collaboration', category: 'trust', key: 'collab.trust.infra', value: 'High trust for infra work.' }],
      });
      store.applyPass({
        pass_id: 'p2',
        mutations: [{ operation: 'update', layer: 'collaboration', category: 'trust', key: 'collab.trust.infra', value: 'High trust for infra work.' }],
      });
      store.applyPass({
        pass_id: 'p3',
        mutations: [{ operation: 'update', layer: 'collaboration', category: 'trust', key: 'collab.trust.infra', value: 'High trust for infra work.' }],
      });

      // Use strict cutoff so the recency filter alone wouldn't include it,
      // but minReferenceCount=3 should still pull it in
      const out = serializeGraphForReflection(store, { recentDays: 0, minReferenceCount: 3, minCorrectionCount: 999 });
      assert.match(out, /collab\.trust\.infra/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('organizes output by layer', () => {
    const { store, dir } = makeTmpStore();
    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          { operation: 'add', layer: 'user', category: 'fact', key: 'user.location', value: 'Lives in Switzerland.' },
          { operation: 'add', layer: 'agent', category: 'skill', key: 'agent.skill.pipeline', value: 'Good at pipeline design.' },
          { operation: 'add', layer: 'collaboration', category: 'dynamic', key: 'collab.dynamic.tone', value: 'User overrides on tone.' },
        ],
      });

      const out = serializeGraphForReflection(store);
      const userIdx = out.indexOf('## USER');
      const agentIdx = out.indexOf('## AGENT');
      const collabIdx = out.indexOf('## COLLABORATION');

      assert.ok(userIdx >= 0, 'USER section present');
      assert.ok(agentIdx >= 0, 'AGENT section present');
      assert.ok(collabIdx >= 0, 'COLLABORATION section present');
      // USER before AGENT before COLLABORATION
      assert.ok(userIdx < agentIdx && agentIdx < collabIdx);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes correction_count in stats line', () => {
    const { store, dir } = makeTmpStore();
    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'agent',
            category: 'failure_mode',
            key: 'agent.failure.opener',
            value: 'Biography-first openers.',
            signals: { correction: true, emotional_weight: 0.8, explicit: true },
          },
        ],
      });

      const out = serializeGraphForReflection(store, { minCorrectionCount: 1 });
      assert.match(out, /corrections=1/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
