import { describe, it, beforeEach, afterEach } from 'node:test';
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
      assert.equal(header.layers.user, 0);
      assert.equal(header.layers.agent, 0);
      assert.equal(header.layers.collaboration, 0);
      assert.equal(header.cachedAt, undefined);
      assert.ok(header.assemblyMs >= 0);
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
      assert.equal(header.nodesUsed, 3);
      assert.equal(header.layers.user, 1);
      assert.equal(header.layers.agent, 1);
      assert.equal(header.layers.collaboration, 1);
      assert.ok(header.tokens > 0);
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
        header.layers.user > header.layers.agent,
        'User layer should have more nodes than agent'
      );
      assert.ok(
        header.layers.user > header.layers.collaboration,
        'User layer should have more nodes than collaboration'
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
      assert.equal(w.recency, 0.3);
      assert.equal(w.frequency, 0.15);
      assert.equal(w.emotional, 0.2);
      assert.equal(w.correction, 0.15);
      assert.equal(w.semantic, 0.2);
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
