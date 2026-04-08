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

async function waitForNextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('serializeGraphForReflection', () => {
  it('returns empty-graph message when store has no nodes', () => {
    const { store, dir } = makeTmpStore();
    try {
      const out = serializeGraphForReflection(store);
      assert.match(out, /Scope: 0 of 0 scoped nodes/);
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

  it('includes recent pass summaries and stale candidate hints', () => {
    const { store, dir } = makeTmpStore();
    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'user',
            category: 'fact',
            key: 'user.memrok.status',
            value: 'Memrok is live with 33 graph nodes as of 2026-04-01.',
          },
        ],
      });
      store.applyPass({
        pass_id: 'p2',
        mutations: [
          {
            operation: 'add',
            layer: 'collaboration',
            category: 'process',
            key: 'collab.process.loop',
            value: 'Inspect, patch, rebuild, compare.',
          },
        ],
      });

      const out = serializeGraphForReflection(store);
      assert.match(out, /## RECENT PASSES/);
      assert.match(out, /mutations=1/);
      assert.match(out, /## CURATION PRIORITY: STALE OR SUPERSEDED NODES/);
      assert.match(out, /user\.memrok\.status/);
      assert.match(out, /expiry_pressure=/);
      assert.match(out, /snapshot\/status wording/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces fresher same-family state as supersession pressure', async () => {
    const { store, dir } = makeTmpStore();
    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'agent',
            category: 'dynamic',
            key: 'agent.memrok.status',
            value: 'Memrok status: healthy as of 2026-03-01.',
          },
        ],
      });
      await waitForNextTick();
      store.applyPass({
        pass_id: 'p2',
        mutations: [
          {
            operation: 'add',
            layer: 'agent',
            category: 'dynamic',
            key: 'agent.memrok.state.current',
            value: 'Current state: degraded while rebuilding the injector.',
          },
        ],
      });

      const out = serializeGraphForReflection(store);
      assert.match(out, /agent\.memrok\.status/);
      assert.match(out, /fresher same-family state exists \(agent\.memrok\.state\.current\)/);
      assert.match(out, /newer_state: agent\.memrok\.state\.current/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks same-key snapshot churn as strong supersession pressure', () => {
    const { store, dir } = makeTmpStore();
    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'user',
            category: 'fact',
            key: 'user.memrok.node_count',
            value: 'Graph node count is 33 as of 2026-03-01.',
          },
        ],
      });
      store.applyPass({
        pass_id: 'p2',
        mutations: [
          {
            operation: 'update',
            layer: 'user',
            category: 'fact',
            key: 'user.memrok.node_count',
            value: 'Graph node count is 41 as of 2026-03-18.',
          },
        ],
      });

      const out = serializeGraphForReflection(store);
      assert.match(out, /user\.memrok\.node_count/);
      assert.match(out, /same key has been rewritten with different state/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat durable policy decisions as stale operational state', () => {
    const { store, dir } = makeTmpStore();
    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'collaboration',
            category: 'decision',
            key: 'collab.policy.review_flow',
            value: 'Default to inspect, patch, rebuild, compare before proposing broader refactors.',
          },
        ],
      });

      const out = serializeGraphForReflection(store);
      const policyBlock = out.match(/\[collab\.policy\.review_flow\][\s\S]*?(?=\n\[|\n## |\s*$)/)?.[0] ?? '';
      assert.ok(policyBlock.includes('stats:'), 'durable decision is serialized');
      assert.doesNotMatch(policyBlock, /expiry_pressure=/);
      assert.doesNotMatch(out, /## CURATION PRIORITY: STALE OR SUPERSEDED NODES[\s\S]*collab\.policy\.review_flow/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still treats transient operational decisions as stale candidates', () => {
    const { store, dir } = makeTmpStore();
    try {
      store.applyPass({
        pass_id: 'p1',
        mutations: [
          {
            operation: 'add',
            layer: 'agent',
            category: 'decision',
            key: 'agent.ops.rollout_mode',
            value: 'Current decision: keep the service in degraded mode during this release.',
          },
        ],
      });

      const out = serializeGraphForReflection(store);
      assert.match(out, /agent\.ops\.rollout_mode/);
      assert.match(out, /operational-state wording/);
      assert.match(out, /expiry_pressure=/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps the serialized payload and keeps higher-priority nodes', () => {
    const { store, dir } = makeTmpStore();
    try {
      for (let i = 0; i < 4; i++) {
        store.applyPass({
          pass_id: `p${i + 1}`,
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'fact',
              key: `user.fact.${i}`,
              value: `fact ${i}`,
              signals: i === 3 ? { correction: true } : undefined,
            },
          ],
        });
      }

      store.applyPass({
        pass_id: 'p5',
        mutations: [
          {
            operation: 'update',
            layer: 'user',
            category: 'fact',
            key: 'user.fact.2',
            value: 'fact 2',
          },
        ],
      });

      const out = serializeGraphForReflection(store, { maxNodes: 2, recentDays: 30, minReferenceCount: 999, minCorrectionCount: 1 });
      assert.match(out, /Scope: 2 of 4 scoped nodes/);
      assert.match(out, /Truncated 2 lower-priority nodes/);
      assert.match(out, /user\.fact\.3/);
      assert.match(out, /user\.fact\.2/);
      assert.doesNotMatch(out, /user\.fact\.0/);
      assert.doesNotMatch(out, /user\.fact\.1/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
