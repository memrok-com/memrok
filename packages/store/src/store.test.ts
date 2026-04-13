import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createStore } from './store.js';
import type { Store, ScribePass } from './types.js';

function makePass(overrides?: Partial<ScribePass>): ScribePass {
  return {
    pass_id: 'test-pass-001',
    source: 'transcript-abc.jsonl',
    mutations: [
      {
        operation: 'add',
        layer: 'user',
        category: 'preference',
        key: 'user.content.voice',
        value: 'Prefers blunt, punchy tone over polished/elegant.',
        evidence: '"I\'d go with blunt. Dial it up a notch."',
        signals: { emotional_weight: 0.7, explicit: true, correction: true },
      },
    ],
    meta: { turns_processed: 20, observations: 'Notable corrections on content tone.' },
    ...overrides,
  };
}

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('schema creation', () => {
    it('should create all tables', () => {
      // If createStore succeeded, schema is in place.
      // Verify by querying nodes (empty) and passes (empty).
      assert.deepEqual(store.queryNodes(), []);
      assert.deepEqual(store.listPasses(), []);
    });
  });

  describe('applyPass', () => {
    it('should apply a pass and create nodes', () => {
      const result = store.applyPass(makePass());

      assert.equal(result.pass_id, 'test-pass-001');
      assert.equal(result.mutations_applied, 1);
      assert.equal(result.nodes_created, 1);
      assert.equal(result.nodes_updated, 0);
      assert.equal(result.nodes_expired, 0);

      const node = store.getNode('user.content.voice');
      assert.ok(node);
      assert.equal(node.layer, 'user');
      assert.equal(node.category, 'preference');
      assert.equal(node.value, 'Prefers blunt, punchy tone over polished/elegant.');
      assert.equal(node.version, 1);
      assert.equal(node.emotional_weight, 0.7);
      assert.equal(node.correction_count, 1);
      assert.equal(node.expired_at, null);
    });

    it('should record pass metadata', () => {
      store.applyPass(makePass());
      const passes = store.listPasses();
      assert.equal(passes.length, 1);
      assert.equal(passes[0].pass_id, 'test-pass-001');
      assert.equal(passes[0].source, 'transcript-abc.jsonl');
      assert.equal(passes[0].derived_artifact_id, null);
      assert.equal(passes[0].turns_processed, 20);
      assert.equal(passes[0].mutations_count, 1);
    });
  });

  describe('archive observations and derived artifacts', () => {
    it('persists raw archive observations separately from graph state', () => {
      const observation = store.createArchiveObservation({
        kind: 'transcript',
        source: 'session.jsonl',
        sessionId: 'session-1',
        content: 'user: fix the injector boundary',
        metadata: { offset: 128 },
      });

      assert.equal(observation.kind, 'transcript');
      assert.equal(observation.session_id, 'session-1');
      assert.deepEqual(observation.metadata, { offset: 128 });
      assert.equal(store.queryNodes().length, 0);

      const observations = store.listArchiveObservations();
      assert.equal(observations.length, 1);
      assert.equal(observations[0].id, observation.id);
    });

    it('persists derived artifacts linked back to observations', () => {
      const observation = store.createArchiveObservation({
        kind: 'bootstrap-file',
        source: 'MEMORY.md',
        content: '# Existing memory',
      });

      const artifact = store.createDerivedArtifact({
        kind: 'scribe-pass-output',
        observationId: observation.id,
        content: JSON.stringify(makePass()),
        metadata: { model: 'test-model' },
      });

      assert.equal(artifact.observation_id, observation.id);
      assert.deepEqual(artifact.metadata, { model: 'test-model' });
      assert.equal(store.listDerivedArtifacts().length, 1);
    });
  });

  describe('update operation', () => {
    it('should update an existing node', () => {
      store.applyPass(makePass());

      const updatePass: ScribePass = {
        pass_id: 'test-pass-002',
        source: 'transcript-def.jsonl',
        mutations: [
          {
            operation: 'update',
            layer: 'user',
            category: 'preference',
            key: 'user.content.voice',
            value: 'Strongly prefers blunt, direct language. No hedging.',
            evidence: '"Just say it straight."',
            signals: { emotional_weight: 0.9, explicit: true, correction: false },
          },
        ],
      };

      const result = store.applyPass(updatePass);
      assert.equal(result.nodes_updated, 1);
      assert.equal(result.nodes_created, 0);

      const node = store.getNode('user.content.voice');
      assert.ok(node);
      assert.equal(node.value, 'Strongly prefers blunt, direct language. No hedging.');
      assert.equal(node.version, 2);
      assert.equal(node.reference_count, 2);
      assert.equal(node.emotional_weight, 0.9);
      assert.equal(node.first_pass_id, 'test-pass-001');
      assert.equal(node.last_pass_id, 'test-pass-002');
    });
  });

  describe('expire operation', () => {
    it('should expire an existing node', () => {
      store.applyPass(makePass());

      const expirePass: ScribePass = {
        pass_id: 'test-pass-003',
        mutations: [
          {
            operation: 'expire',
            layer: 'user',
            category: 'preference',
            key: 'user.content.voice',
            value: 'No longer relevant.',
          },
        ],
      };

      const result = store.applyPass(expirePass);
      assert.equal(result.nodes_expired, 1);

      const node = store.getNode('user.content.voice');
      assert.ok(node);
      assert.ok(node.expired_at);
      assert.equal(node.version, 2);
    });

    it('should be a noop for non-existent keys', () => {
      const expirePass: ScribePass = {
        pass_id: 'test-pass-003',
        mutations: [
          {
            operation: 'expire',
            layer: 'user',
            category: 'preference',
            key: 'nonexistent.key',
            value: 'No longer relevant.',
          },
        ],
      };

      const result = store.applyPass(expirePass);
      assert.equal(result.nodes_expired, 0);
    });
  });

  describe('getHistory', () => {
    it('should return all mutations for a key in order', () => {
      store.applyPass(makePass());
      store.applyPass({
        pass_id: 'test-pass-002',
        mutations: [
          {
            operation: 'update',
            layer: 'user',
            category: 'preference',
            key: 'user.content.voice',
            value: 'Updated value.',
            signals: { emotional_weight: 0.5 },
          },
        ],
      });

      const history = store.getHistory('user.content.voice');
      assert.equal(history.length, 2);
      assert.equal(history[0].operation, 'add');
      assert.equal(history[0].pass_id, 'test-pass-001');
      assert.equal(history[1].operation, 'update');
      assert.equal(history[1].pass_id, 'test-pass-002');
    });
  });

  describe('queryNodes filtering', () => {
    beforeEach(() => {
      store.applyPass({
        pass_id: 'filter-pass',
        mutations: [
          { operation: 'add', layer: 'user', category: 'preference', key: 'user.pref.a', value: 'A' },
          { operation: 'add', layer: 'user', category: 'fact', key: 'user.fact.b', value: 'B' },
          { operation: 'add', layer: 'agent', category: 'pattern', key: 'agent.pattern.c', value: 'C' },
          { operation: 'add', layer: 'collaboration', category: 'preference', key: 'collab.pref.d', value: 'D' },
        ],
      });
    });

    it('should filter by layer', () => {
      const nodes = store.queryNodes({ layer: 'user' });
      assert.equal(nodes.length, 2);
      assert.ok(nodes.every(n => n.layer === 'user'));
    });

    it('should filter by category', () => {
      const nodes = store.queryNodes({ category: 'preference' });
      assert.equal(nodes.length, 2);
      assert.ok(nodes.every(n => n.category === 'preference'));
    });

    it('should filter by key prefix', () => {
      const nodes = store.queryNodes({ keyPrefix: 'user.pref' });
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].key, 'user.pref.a');
    });

    it('should filter expired nodes', () => {
      // Expire one node
      store.applyPass({
        pass_id: 'expire-pass',
        mutations: [
          { operation: 'expire', layer: 'user', category: 'preference', key: 'user.pref.a', value: 'expired' },
        ],
      });

      // Active (default)
      const active = store.queryNodes();
      assert.equal(active.length, 3);
      assert.ok(active.every(n => n.expired_at === null));

      // Expired only
      const expired = store.queryNodes({ active: false });
      assert.equal(expired.length, 1);
      assert.equal(expired[0].key, 'user.pref.a');
    });
  });

  describe('rebuild', () => {
    it('should rebuild nodes from mutation log', () => {
      store.applyPass(makePass());
      store.applyPass({
        pass_id: 'test-pass-002',
        mutations: [
          {
            operation: 'update',
            layer: 'user',
            category: 'preference',
            key: 'user.content.voice',
            value: 'Updated after rebuild test.',
            signals: { emotional_weight: 0.8, correction: true },
          },
          {
            operation: 'add',
            layer: 'agent',
            category: 'pattern',
            key: 'agent.style.concise',
            value: 'User prefers concise responses.',
          },
        ],
      });

      // Capture state before rebuild
      const beforeNodes = store.queryNodes();
      const beforeVoice = store.getNode('user.content.voice');

      // Rebuild
      store.rebuild();

      // Verify state matches
      const afterNodes = store.queryNodes();
      assert.equal(afterNodes.length, beforeNodes.length);

      const afterVoice = store.getNode('user.content.voice');
      assert.ok(afterVoice);
      assert.equal(afterVoice.value, beforeVoice!.value);
      assert.equal(afterVoice.version, beforeVoice!.version);
      assert.equal(afterVoice.correction_count, beforeVoice!.correction_count);

      const concise = store.getNode('agent.style.concise');
      assert.ok(concise);
      assert.equal(concise.value, 'User prefers concise responses.');
    });

    it('should handle expire during rebuild', () => {
      store.applyPass(makePass());
      store.applyPass({
        pass_id: 'test-pass-expire',
        mutations: [
          { operation: 'expire', layer: 'user', category: 'preference', key: 'user.content.voice', value: 'expired' },
        ],
      });

      store.rebuild();

      const node = store.getNode('user.content.voice');
      assert.ok(node);
      assert.ok(node.expired_at);
    });
  });

  describe('node hygiene', () => {
    beforeEach(() => {
      store.applyPass({
        pass_id: 'hygiene-pass',
        mutations: [
          {
            operation: 'add',
            layer: 'user',
            category: 'preference',
            key: 'user/bio/profile',
            value: 'Broad biography and admin preference summary.',
          },
        ],
      });
    });

    it('stores reversible hygiene state alongside nodes', () => {
      const record = store.upsertNodeHygiene({
        nodeKey: 'user/bio/profile',
        state: 'suppressed',
        action: 'exclude',
        score: 0.91,
        rationale: 'Old broad node with weak anchors in focused contexts.',
        reasonCodes: ['old-node', 'broad-bio-admin', 'weak-anchor'],
        details: { ageDays: 140, domain: null },
        source: 'test:hygiene',
      });

      assert.equal(record.node_key, 'user/bio/profile');
      assert.equal(record.action, 'exclude');
      assert.deepEqual(record.reason_codes, ['old-node', 'broad-bio-admin', 'weak-anchor']);

      const node = store.getNode('user/bio/profile');
      assert.equal(node?.hygiene?.state, 'suppressed');
      assert.equal(node?.hygiene?.score, 0.91);

      const active = store.listNodeHygiene();
      assert.equal(active.length, 1);
      assert.equal(active[0].node_key, 'user/bio/profile');

      const events = store.listNodeHygieneEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, 'set');
      assert.equal(events[0].node_key, 'user/bio/profile');
    });

    it('clears hygiene state while preserving an audit trail', () => {
      store.upsertNodeHygiene({
        nodeKey: 'user/bio/profile',
        state: 'deprioritized',
        action: 'deprioritize',
        score: 0.72,
        rationale: 'Broad but not fully suppressible.',
        reasonCodes: ['generic-meta'],
        source: 'test:hygiene',
      });

      const cleared = store.clearNodeHygiene(
        'user/bio/profile',
        'test:hygiene:clear',
        'Manual review restored this node.',
      );

      assert.equal(cleared, true);
      assert.equal(store.getNode('user/bio/profile')?.hygiene, null);
      assert.equal(store.listNodeHygiene().length, 0);

      const events = store.listNodeHygieneEvents();
      assert.equal(events.length, 2);
      assert.equal(events[0].event_type, 'clear');
      assert.equal(events[0].source, 'test:hygiene:clear');
      assert.equal(events[1].event_type, 'set');
    });
  });

  describe('working set traces and provenance', () => {
    it('records retention-bounded working set traces', () => {
      const first = store.createWorkingSetSnapshot(
        {
          headerText: 'header one',
          headerTokens: 3,
          nodesUsed: 1,
          items: [],
        },
        { maxSnapshots: 2 },
      );

      const second = store.createWorkingSetSnapshot(
        {
          headerText: 'header two',
          headerTokens: 3,
          nodesUsed: 1,
          items: [],
        },
        { maxSnapshots: 2 },
      );

      const third = store.createWorkingSetSnapshot(
        {
          headerText: 'header three',
          headerTokens: 3,
          nodesUsed: 1,
          items: [],
        },
        { maxSnapshots: 2 },
      );

      const snapshots = store.listWorkingSetSnapshots();
      assert.equal(snapshots.length, 2);
      assert.deepEqual(
        snapshots.map((snapshot) => snapshot.id),
        [third.id, second.id],
      );
      assert.equal(store.getWorkingSetSnapshot(first.id), null);
    });

    it('traverses provenance from working set trace to archive observation', () => {
      const observation = store.createArchiveObservation({
        kind: 'transcript',
        source: 'session.jsonl',
        sessionId: 'session-42',
        content: 'user: keep archive and graph separate',
      });
      const artifact = store.createDerivedArtifact({
        kind: 'scribe-pass-output',
        observationId: observation.id,
        content: JSON.stringify(makePass()),
      });
      store.applyPass({
        ...makePass({
          pass_id: 'prov-pass',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/archive-layer',
              value: 'Wants explicit archive layer boundaries.',
            },
          ],
        }),
        derived_artifact_id: artifact.id,
      });
      const latestMutationId = store.getHistory('user/archive-layer').at(-1)?.id ?? null;

      const trace = store.createWorkingSetSnapshot({
        sessionId: 'session-42',
        query: 'archive layer boundaries',
        headerText: 'header',
        headerTokens: 10,
        nodesUsed: 1,
        items: [
          {
            nodeKey: 'user/archive-layer',
            passId: 'prov-pass',
            mutationId: latestMutationId,
            layer: 'user',
            category: 'preference',
            value: 'Wants explicit archive layer boundaries.',
            score: 0.9,
            rawScore: 0.85,
            reason: 'topic match',
          },
        ],
      });

      const provenance = store.getProvenanceForWorkingSetSnapshot(trace.id);
      assert.equal(provenance.length, 1);
      assert.equal(store.getWorkingSetSnapshot(trace.id)?.items[0].mutation_id, latestMutationId);
      assert.equal(latestMutationId, 1);
      assert.equal(provenance[0].pass?.pass_id, 'prov-pass');
      assert.equal(provenance[0].artifact?.id, artifact.id);
      assert.equal(provenance[0].observation?.id, observation.id);
    });

    it('keeps working set mutation provenance aligned with node lineage', () => {
      store.applyPass(makePass({
        pass_id: 'prov-pass-1',
        mutations: [
          {
            operation: 'add',
            layer: 'user',
            category: 'preference',
            key: 'user/prov-lineage',
            value: 'Initial value.',
          },
        ],
      }));
      store.applyPass(makePass({
        pass_id: 'prov-pass-2',
        mutations: [
          {
            operation: 'update',
            layer: 'user',
            category: 'preference',
            key: 'user/prov-lineage',
            value: 'Curated latest value.',
          },
        ],
      }));

      const latestMutation = store.getHistory('user/prov-lineage').at(-1);
      assert.ok(latestMutation);

      const trace = store.createWorkingSetSnapshot({
        headerText: 'header',
        headerTokens: 3,
        nodesUsed: 1,
        items: [
          {
            nodeKey: 'user/prov-lineage',
            passId: 'prov-pass-2',
            mutationId: latestMutation.id,
            layer: 'user',
            category: 'preference',
            value: 'Curated latest value.',
            score: 0.8,
            rawScore: 0.75,
          },
        ],
      });

      const snapshot = store.getWorkingSetSnapshot(trace.id);
      assert.equal(snapshot?.items[0].mutation_id, latestMutation.id);
      assert.equal(snapshot?.items[0].pass_id, latestMutation.pass_id);
      assert.equal(store.getHistory(snapshot!.items[0].node_key).at(-1)?.id, snapshot?.items[0].mutation_id);
    });
  });
});
