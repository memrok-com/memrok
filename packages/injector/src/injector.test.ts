import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createStore, type Store, type ScribePass } from '@memrok/store';
import { createInjector } from './injector.js';

function makePass(overrides?: Partial<ScribePass>): ScribePass {
  return {
    pass_id: `pass-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'test',
    mutations: [],
    ...overrides,
  };
}

let store: Store;

beforeEach(() => {
  store = createStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('injector', () => {
  describe('empty store', () => {
    it('returns empty header for empty store', () => {
      const injector = createInjector(store);
      const header = injector.assemble();
      assert.equal(header.text, '');
      assert.equal(header.tokens, 0);
      assert.equal(header.nodesUsed, 0);
      assert.deepEqual(header.debugNodes, []);
      assert.equal(header.layers.user, 0);
      assert.equal(header.layers.agent, 0);
      assert.equal(header.layers.collaboration, 0);
      assert.equal(header.cachedAt, undefined);
      assert.ok(header.assemblyMs >= 0);
    });

    it('returns an explicit empty working set for empty store', () => {
      const injector = createInjector(store);
      const workingSet = injector.selectWorkingSet();
      assert.equal(workingSet.items.length, 0);
      assert.equal(workingSet.layers.user, 0);
      assert.equal(workingSet.layers.agent, 0);
      assert.equal(workingSet.layers.collaboration, 0);
    });
  });

  describe('assembly from populated store', () => {
    it('assembles header with nodes from all layers', () => {
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/pref/tone',
              value: 'Prefers blunt, punchy tone',
            },
            {
              operation: 'add',
              layer: 'agent',
              category: 'tendency',
              key: 'agent/tendency/opener',
              value: 'Tends to open from biography',
            },
            {
              operation: 'add',
              layer: 'collaboration',
              category: 'dynamic',
              key: 'collab/dynamic/steering',
              value: 'User steers via conceptual framing',
            },
          ],
        })
      );

      const injector = createInjector(store);
      const header = injector.assemble();

      assert.ok(header.text.includes('## Memory Context (Memrok)'));
      assert.ok(header.text.includes('### About the user'));
      assert.ok(header.text.includes('### About this agent'));
      assert.ok(header.text.includes('### About our collaboration'));
      assert.ok(header.text.includes('Prefers blunt, punchy tone'));
      assert.ok(header.text.includes('Tends to open from biography'));
      assert.ok(header.text.includes('User steers via conceptual framing'));
      assert.equal(header.debugNodes?.length, 3);
      assert.equal(header.debugNodes?.[0]?.layer, 'user');
      assert.equal(header.nodesUsed, 3);
      assert.equal(header.layers.user, 1);
      assert.equal(header.layers.agent, 1);
      assert.equal(header.layers.collaboration, 1);
      assert.ok(header.tokens > 0);
    });

    it('renders headers only from typed working sets', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-ws',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/pref/debug',
              value: 'Keep working set explicit.',
            },
          ],
        })
      );

      const injector = createInjector(store);
      const workingSet = injector.selectWorkingSet({
        recentMessages: 'working set debugging',
        sessionId: 'session-1',
      });
      const header = injector.renderWorkingSet(workingSet);

      assert.equal(workingSet.items.length, 1);
      assert.equal(workingSet.items[0].key, 'user/pref/debug');
      assert.ok(header.text.includes('Keep working set explicit.'));
    });

    it('suppresses near-duplicate node values across the header', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-dup',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'belief',
              key: 'user/memrok-1',
              value: 'Build Memrok because it is useful to us and open-source it for others.',
            },
            {
              operation: 'add',
              layer: 'agent',
              category: 'belief',
              key: 'agent/memrok-2',
              value: 'Build Memrok because it is useful to us and open source it for others.',
            },
          ],
        })
      );

      const injector = createInjector(store);
      const header = injector.assemble({ recentMessages: 'We are evaluating Memrok itself.' });

      assert.equal(header.debugNodes?.length, 1);
      assert.equal(header.nodesUsed, 1);
    });

    it('caps repeated categories within a layer', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-cap',
          mutations: [
            { operation: 'add', layer: 'user', category: 'belief', key: 'u1', value: 'Belief one about Memrok.' },
            { operation: 'add', layer: 'user', category: 'belief', key: 'u2', value: 'Belief two about Memrok.' },
            { operation: 'add', layer: 'user', category: 'belief', key: 'u3', value: 'Belief three about Memrok.' },
          ],
        })
      );

      const injector = createInjector(store);
      const header = injector.assemble({ recentMessages: 'We are evaluating Memrok itself.' });

      assert.equal((header.debugNodes ?? []).filter((n) => n.layer === 'user' && n.category === 'belief').length, 2);
    });
  });

  describe('relevance scoring', () => {
    it('ranks nodes with higher emotional weight higher', () => {
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/low-emotion',
              value: 'Low emotion item',
              signals: { emotional_weight: 0.1 },
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/high-emotion',
              value: 'High emotion item',
              signals: { emotional_weight: 0.9 },
            },
          ],
        })
      );

      const injector = createInjector(store);
      const header = injector.assemble();
      const highIdx = header.text.indexOf('High emotion item');
      const lowIdx = header.text.indexOf('Low emotion item');
      assert.ok(highIdx < lowIdx, 'Higher emotional weight should appear first');
    });

    it('ranks nodes with higher correction count higher', () => {
      // Create two nodes, then update one with corrections
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/no-corrections',
              value: 'No corrections item',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/many-corrections',
              value: 'Many corrections item',
              signals: { correction: true },
            },
          ],
        })
      );
      // Apply more corrections to boost correction_count
      for (let i = 0; i < 5; i++) {
        store.applyPass(
          makePass({
            pass_id: `corr-${i}`,
            mutations: [
              {
                operation: 'update',
                layer: 'user',
                category: 'pref',
                key: 'user/many-corrections',
                value: 'Many corrections item',
                signals: { correction: true },
              },
            ],
          })
        );
      }

      const injector = createInjector(store);
      const header = injector.assemble();
      const manyIdx = header.text.indexOf('Many corrections item');
      const noIdx = header.text.indexOf('No corrections item');
      assert.ok(
        manyIdx < noIdx,
        'Higher correction count should appear first'
      );
    });

    it('ranks nodes with higher reference count higher', () => {
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/low-refs',
              value: 'Low refs item',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/high-refs',
              value: 'High refs item',
            },
          ],
        })
      );
      // Update high-refs many times to boost reference_count
      for (let i = 0; i < 9; i++) {
        store.applyPass(
          makePass({
            pass_id: `ref-${i}`,
            mutations: [
              {
                operation: 'update',
                layer: 'user',
                category: 'pref',
                key: 'user/high-refs',
                value: 'High refs item',
              },
            ],
          })
        );
      }

      const injector = createInjector(store);
      const header = injector.assemble();
      const highIdx = header.text.indexOf('High refs item');
      const lowIdx = header.text.indexOf('Low refs item');
      assert.ok(highIdx < lowIdx, 'Higher frequency should appear first');
    });

    it('prefers topic-relevant user nodes over broad biography-admin user nodes in product debugging contexts', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-topic-affinity',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/profile/admin-style',
              value: 'Prefers concise admin updates and has a broad biography across many projects.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'project',
              key: 'user/memrok/injector-ranking',
              value: 'Works on Memrok injector ranking and debugging topic selection regressions.',
            },
          ],
        })
      );

      const injector = createInjector(store);
      const header = injector.assemble({
        recentMessages: 'Memrok injector bug: debug topic 540 ranking and fix selection regressions in product context.',
      });

      const topicalIdx = header.text.indexOf(
        'Works on Memrok injector ranking and debugging topic selection regressions.'
      );
      const broadIdx = header.text.indexOf(
        'Prefers concise admin updates and has a broad biography across many projects.'
      );

      assert.ok(topicalIdx !== -1, 'Topical user node should be included');
      assert.ok(broadIdx !== -1, 'Broad user node should still be included');
      assert.ok(topicalIdx < broadIdx, 'Topical user node should rank ahead of broad biography/admin node');

      const topicalNode = (header.debugNodes ?? []).find((node) => node.key === 'user/memrok/injector-ranking');
      assert.ok(topicalNode, 'Topical node should expose debug attribution');
      assert.ok((topicalNode?.semanticScore ?? 0) > 0);
      assert.ok((topicalNode?.queryCoverage ?? 0) > 0);
      assert.equal(topicalNode?.domain, 'memrok');
      assert.equal(topicalNode?.domainMatch, true);
      assert.ok((topicalNode?.selectedBecause ?? []).length > 0);
    });

    it('softly downweights broad biography-admin nodes without excluding them in focused product contexts', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-soft-downweight',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/bio/profile',
              value: 'Personal background: prefers biography-first framing and administrative summaries.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'project',
              key: 'user/memrok/debugging',
              value: 'Currently debugging Memrok product issues in injector ranking for topic 540.',
            },
            {
              operation: 'add',
              layer: 'agent',
              category: 'skill',
              key: 'agent/testing',
              value: 'Can trace ranking regressions with focused tests.',
            },
          ],
        })
      );

      const injector = createInjector(store, {
        tokenBudget: 220,
        layerWeights: { user: 0.75, agent: 0.15, collaboration: 0.1 },
      });
      const header = injector.assemble({
        recentMessages: 'Debug Memrok topic 540 ranking bug in the injector and fix product selection behavior.',
      });

      const broadNode = (header.debugNodes ?? []).find((node) => node.key === 'user/bio/profile');
      const topicalNode = (header.debugNodes ?? []).find((node) => node.key === 'user/memrok/debugging');

      assert.ok(topicalNode, 'Topical user node should be selected');
      assert.ok(broadNode, 'Broad biography/admin node should still be selected under a soft downweight');
      assert.ok(
        (topicalNode?.score ?? 0) > (broadNode?.score ?? 0),
        'Topical user node should outscore the broad biography/admin node'
      );
    });

    it('suppresses memrok and infra user nodes in a Priomind-focused context', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-domain-focus',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'decision',
              key: 'user.priomind.positioning',
              value: 'PrioMind should lead with structured decisions and team trust on the landing page.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'belief',
              key: 'user.memrok.curation',
              value: 'Memrok should provide a sharper curation and judgment layer than baseline memory.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'decision',
              key: 'user.infra.tandem_setup',
              value: 'Created Telegram forum group Tandem to structure conversations by topic.',
            },
          ],
        })
      );

      const injector = createInjector(store);
      const header = injector.assemble({
        recentMessages: 'PrioMind landing page messaging, pricing, and tweet pipeline positioning for product growth.',
      });

      const priomindNode = (header.debugNodes ?? []).find((node) => node.key === 'user.priomind.positioning');
      const memrokNode = (header.debugNodes ?? []).find((node) => node.key === 'user.memrok.curation');
      const infraNode = (header.debugNodes ?? []).find((node) => node.key === 'user.infra.tandem_setup');

      assert.ok(priomindNode, 'Priomind node should be selected');
      assert.ok(memrokNode, 'Memrok node may still survive under soft suppression');
      assert.ok(infraNode, 'Infra node may still survive under soft suppression');
      assert.ok((priomindNode?.score ?? 0) > (memrokNode?.score ?? 0), 'Priomind node should outrank Memrok node');
      assert.ok((priomindNode?.score ?? 0) > (infraNode?.score ?? 0), 'Priomind node should outrank infra node');
    });

    it('boosts local-domain user nodes in a health-focused context', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-health-domain',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user.health.privacy',
              value: 'Health and wellbeing conversations should feel private, practical, and non-judgy.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'decision',
              key: 'user.priomind.gtm_shift',
              value: 'Shifted PrioMind GTM from cautious outreach to going public.',
            },
          ],
        })
      );

      const injector = createInjector(store);
      const header = injector.assemble({
        recentMessages: 'Health and wellbeing topic: private, practical discussion about comfort and experiments.',
      });

      const healthNode = (header.debugNodes ?? []).find((node) => node.key === 'user.health.privacy');
      const priomindNode = (header.debugNodes ?? []).find((node) => node.key === 'user.priomind.gtm_shift');

      assert.ok(healthNode, 'Health node should be selected');
      assert.ok(priomindNode, 'Cross-domain node may still survive under soft suppression');
      assert.ok((healthNode?.score ?? 0) > (priomindNode?.score ?? 0), 'Health node should outrank weakly related Priomind node');
    });

    it('applies domain-local recall across agent and collaboration layers, not just user nodes', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-cross-layer-domain',
          mutations: [
            {
              operation: 'add',
              layer: 'agent',
              category: 'skill',
              key: 'agent/priomind/landing/messaging',
              value: 'Can sharpen PrioMind landing page messaging around trust, pricing, and team decisions.',
            },
            {
              operation: 'add',
              layer: 'collaboration',
              category: 'dynamic',
              key: 'collaboration/priomind/review-loop',
              value: 'PrioMind work benefits from comparing positioning options and cutting weak slogans fast.',
            },
            {
              operation: 'add',
              layer: 'agent',
              category: 'belief',
              key: 'agent/memrok/judgment',
              value: 'Memrok should provide a sharper curation and judgment layer than baseline memory systems.',
            },
          ],
        })
      );

      const injector = createInjector(store, {
        tokenBudget: 260,
        layerWeights: { user: 0.2, agent: 0.45, collaboration: 0.35 },
      });
      const header = injector.assemble({
        recentMessages: 'PrioMind landing page messaging, pricing, and trust positioning for team decision workflows.',
      });

      const priomindAgentNode = (header.debugNodes ?? []).find((node) => node.key === 'agent/priomind/landing/messaging');
      const priomindCollabNode = (header.debugNodes ?? []).find((node) => node.key === 'collaboration/priomind/review-loop');
      const memrokAgentNode = (header.debugNodes ?? []).find((node) => node.key === 'agent/memrok/judgment');

      assert.ok(priomindAgentNode, 'Priomind agent node should be selected');
      assert.ok(priomindCollabNode, 'Priomind collaboration node should be selected');
      assert.ok(memrokAgentNode, 'Cross-domain agent node may still survive under soft suppression');
      assert.ok((priomindAgentNode?.score ?? 0) > (memrokAgentNode?.score ?? 0), 'Priomind agent node should outrank cross-domain agent node');
      assert.ok((priomindCollabNode?.score ?? 0) > (memrokAgentNode?.score ?? 0), 'Priomind collaboration node should outrank cross-domain agent node');
    });

    it('prefers topic-relevant family diversity over selecting one graph family repeatedly', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-family-diversity',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'decision',
              key: 'user/priomind/landing/headline',
              value: 'PrioMind landing headline should emphasize structured decisions for teams.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'belief',
              key: 'user/priomind/landing/proof',
              value: 'PrioMind landing proof should reinforce structured decisions with team trust signals.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'process',
              key: 'user/priomind/landing/cta',
              value: 'PrioMind landing CTA should keep the team-decision framing concrete.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'decision',
              key: 'user/priomind/pricing/value',
              value: 'PrioMind pricing should feel safe for small teams trying a decision workflow.',
            },
          ],
        })
      );

      const injector = createInjector(store, {
        tokenBudget: 220,
        layerWeights: { user: 0.8, agent: 0.1, collaboration: 0.1 },
      });
      const header = injector.assemble({
        recentMessages: 'PrioMind landing page pricing and trust positioning for structured team decisions.',
      });

      const selectedKeys = (header.debugNodes ?? []).map((node) => node.key);
      const landingKeys = selectedKeys.filter((key) => key.startsWith('user/priomind/landing/'));

      assert.ok(selectedKeys.includes('user/priomind/pricing/value'), 'Distinct pricing family should survive judged selection');
      assert.ok(landingKeys.length <= 2, 'Selection should avoid overpacking one landing family cluster');
    });
  });

  describe('working set traces', () => {
    it('persists working set snapshots with pass and mutation provenance', () => {
      store.applyPass(
        makePass({
          pass_id: 'trace-pass',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/trace',
              value: 'Trace this working set selection.',
            },
          ],
        })
      );
      const latestMutationId = store.getHistory('user/trace').at(-1)?.id ?? null;

      const injector = createInjector(store, { workingSetSnapshotLimit: 5 });
      injector.assemble({ recentMessages: 'trace this selection', sessionId: 'session-trace' });

      const snapshots = store.listWorkingSetSnapshots();
      assert.equal(snapshots.length, 1);

      const snapshot = store.getWorkingSetSnapshot(snapshots[0].id);
      assert.ok(snapshot);
      assert.equal(snapshot.session_id, 'session-trace');
      assert.equal(snapshot.items.length, 1);
      assert.equal(snapshot.items[0].node_key, 'user/trace');
      assert.equal(snapshot.items[0].pass_id, 'trace-pass');
      assert.equal(snapshot.items[0].mutation_id, latestMutationId);
    });
  });

  describe('token budget enforcement', () => {
    it('respects token budget', () => {
      // Add many nodes
      const mutations = [];
      for (let i = 0; i < 50; i++) {
        mutations.push({
          operation: 'add' as const,
          layer: 'user' as const,
          category: 'pref',
          key: `user/item-${i}`,
          value: `This is a moderately long preference description number ${i} that takes up space`,
        });
      }
      store.applyPass(makePass({ pass_id: 'p1', mutations }));

      const budget = 200;
      const injector = createInjector(store, { tokenBudget: budget });
      const header = injector.assemble();

      assert.ok(
        header.tokens <= budget,
        `Tokens ${header.tokens} should be <= budget ${budget}`
      );
      assert.ok(header.nodesUsed < 50, 'Should not use all 50 nodes');
    });
  });

  describe('layer weight allocation', () => {
    it('allocates proportionally to layer weights', () => {
      // Add many nodes per layer
      const mutations = [];
      for (let i = 0; i < 20; i++) {
        for (const layer of ['user', 'agent', 'collaboration'] as const) {
          mutations.push({
            operation: 'add' as const,
            layer,
            category: 'item',
            key: `${layer}/item-${i}`,
            value: `Item ${i} for ${layer} layer with some padding text here`,
          });
        }
      }
      store.applyPass(makePass({ pass_id: 'p1', mutations }));

      // Heavy user weight
      const injector = createInjector(store, {
        tokenBudget: 500,
        layerWeights: { user: 0.8, agent: 0.1, collaboration: 0.1 },
      });
      const header = injector.assemble();

      assert.ok(
        header.layers.user >= header.layers.agent,
        'User layer should have at least as many nodes as agent'
      );
      assert.ok(
        header.layers.user >= header.layers.collaboration,
        'User layer should have at least as many nodes as collaboration'
      );
    });
  });

  describe('caching', () => {
    it('serves cached header on second call', () => {
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/tone',
              value: 'Prefers blunt tone',
            },
          ],
        })
      );

      const injector = createInjector(store);
      const first = injector.assemble();
      assert.equal(first.cachedAt, undefined);

      const second = injector.assemble();
      assert.ok(second.cachedAt !== undefined, 'Second call should be cached');
      assert.equal(second.text, first.text);
      assert.equal(second.nodesUsed, first.nodesUsed);
    });

    it('returns fresh header after invalidate', () => {
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/tone',
              value: 'Prefers blunt tone',
            },
          ],
        })
      );

      const injector = createInjector(store);
      injector.assemble();
      injector.invalidate();

      // Add more data
      store.applyPass(
        makePass({
          pass_id: 'p2',
          mutations: [
            {
              operation: 'add',
              layer: 'agent',
              category: 'skill',
              key: 'agent/skill/arch',
              value: 'Good at architecture',
            },
          ],
        })
      );

      const fresh = injector.assemble();
      assert.equal(fresh.cachedAt, undefined);
      assert.ok(fresh.text.includes('Good at architecture'));
    });

    it('respects cache TTL', async () => {
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/tone',
              value: 'Prefers blunt tone',
            },
          ],
        })
      );

      const injector = createInjector(store, { cacheMaxAge: 1 }); // 1ms TTL
      injector.assemble();
      await new Promise((r) => setTimeout(r, 10));
      const second = injector.assemble();
      assert.equal(second.cachedAt, undefined, 'Should be fresh after TTL');
    });
  });

  describe('header formatting', () => {
    it('does not include empty sections', () => {
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/tone',
              value: 'Prefers blunt tone',
            },
          ],
        })
      );

      const injector = createInjector(store);
      const header = injector.assemble();

      assert.ok(header.text.includes('### About the user'));
      assert.ok(!header.text.includes('### About this agent'));
      assert.ok(!header.text.includes('### About our collaboration'));
    });

    it('formats nodes as bullet points', () => {
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/tone',
              value: 'Prefers blunt tone',
            },
          ],
        })
      );

      const injector = createInjector(store);
      const header = injector.assemble();
      assert.ok(header.text.includes('- Prefers blunt tone'));
    });
  });

  describe('weights API', () => {
    it('getWeights returns current weights', () => {
      const injector = createInjector(store);
      const w = injector.getWeights();
      assert.equal(w.recency, 0.15);
      assert.equal(w.frequency, 0.1);
      assert.equal(w.emotional, 0.1);
      assert.equal(w.correction, 0.15);
      assert.equal(w.semantic, 0.5);
    });

    it('setWeight updates a weight and invalidates cache', () => {
      store.applyPass(
        makePass({
          pass_id: 'p1',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'pref',
              key: 'user/tone',
              value: 'Prefers blunt tone',
            },
          ],
        })
      );

      const injector = createInjector(store);
      injector.assemble(); // populate cache
      injector.setWeight('recency', 0.9);

      const w = injector.getWeights();
      assert.equal(w.recency, 0.9);

      // Cache should be invalidated
      const header = injector.assemble();
      assert.equal(header.cachedAt, undefined);
    });
  });
});
