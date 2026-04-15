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
      const header = injector.assemble();

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
      const header = injector.assemble();

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
        recentMessages: 'Memrok injector bug: debug topic 101 ranking and fix selection regressions in product context.',
      });

      const topicalIdx = header.text.indexOf(
        'Works on Memrok injector ranking and debugging topic selection regressions.'
      );
      const broadIdx = header.text.indexOf(
        'Prefers concise admin updates and has a broad biography across many projects.'
      );

      assert.ok(topicalIdx !== -1, 'Topical user node should be included');
      assert.equal(broadIdx, -1, 'Broad user node should be excluded when it lacks local evidence');

      const topicalNode = (header.debugNodes ?? []).find((node) => node.key === 'user/memrok/injector-ranking');
      assert.ok(topicalNode, 'Topical node should expose debug attribution');
      assert.ok((topicalNode?.semanticScore ?? 0) > 0);
      assert.ok((topicalNode?.queryCoverage ?? 0) > 0);
      assert.equal(topicalNode?.domain, 'memrok');
      assert.equal(topicalNode?.domainMatch, true);
      assert.ok((topicalNode?.selectedBecause ?? []).length > 0);
    });

    it('excludes broad biography-admin nodes that only contribute generic residue in focused product contexts', () => {
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
              value: 'Currently debugging Memrok product issues in injector ranking for topic 101.',
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
        recentMessages: 'Debug Memrok topic 101 ranking bug in the injector and fix product selection behavior.',
      });

      const broadNode = (header.debugNodes ?? []).find((node) => node.key === 'user/bio/profile');
      const topicalNode = (header.debugNodes ?? []).find((node) => node.key === 'user/memrok/debugging');

      assert.ok(topicalNode, 'Topical user node should be selected');
      assert.equal(broadNode, undefined, 'Broad biography/admin node should be gated out');
    });

    it('respects stored hygiene suppression for broad nodes in focused contexts', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-hygiene-suppression',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/profile/global-admin',
              value: 'Broad profile note: prefers biography framing and global admin summaries across projects.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'project',
              key: 'user/memrok/fizzy-card-80',
              value: 'Working on Memrok card 80 to reduce focused-context injection noise.',
            },
          ],
        })
      );
      store.upsertNodeHygiene({
        nodeKey: 'user/profile/global-admin',
        state: 'suppressed',
        action: 'exclude',
        score: 0.9,
        rationale: 'Old broad node with weak anchors and cross-domain leakage risk.',
        reasonCodes: ['very-old', 'broad-bio-admin', 'weak-anchor'],
        source: 'test:hygiene',
      });

      const injector = createInjector(store);
      const header = injector.assemble({
        recentMessages: 'Memrok card 80 patch: fix focused topic injection noise and broad-node leakage in context selection.',
      });

      const broadNode = (header.debugNodes ?? []).find((node) => node.key === 'user/profile/global-admin');
      const topicalNode = (header.debugNodes ?? []).find((node) => node.key === 'user/memrok/fizzy-card-80');

      assert.ok(topicalNode, 'Focused Memrok node should survive');
      assert.equal(broadNode, undefined, 'Hygiene-suppressed broad node should not leak into focused context');
    });

    it('does not let a hygiene-excluded broad node re-enter on semantic similarity alone', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-hygiene-semantic-only',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/profile/global-admin',
              value: 'Broad profile note with Memrok ranking, context selection, and injection themes stated as general background across projects.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'project',
              key: 'user/memrok/card-80',
              value: 'Working on Memrok card 80 focused-context injection precision.',
            },
          ],
        })
      );
      store.upsertNodeHygiene({
        nodeKey: 'user/profile/global-admin',
        state: 'suppressed',
        action: 'exclude',
        score: 0.9,
        rationale: 'Broad node usually pollutes focused headers.',
        reasonCodes: ['broad-bio-admin'],
        source: 'test:hygiene',
      });

      const injector = createInjector(store);
      const header = injector.assemble({
        recentMessages: 'Memrok ranking regression in focused context injection and topic precision for card 80 patch debugging.',
      });

      const broadNode = (header.debugNodes ?? []).find((node) => node.key === 'user/profile/global-admin');
      const topicalNode = (header.debugNodes ?? []).find((node) => node.key === 'user/memrok/card-80');

      assert.ok(topicalNode, 'Focused node should still be present');
      assert.equal(
        broadNode,
        undefined,
        'Semantic resemblance without anchors, key overlap, or meaningful coverage should not override hygiene exclusion'
      );
    });

    it('allows a hygiene-excluded broad node back in when the current query provides strong grounded evidence', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-hygiene-override',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/profile/global-admin',
              value: 'Broad profile note: prefers biography framing and global admin summaries across projects.',
            },
          ],
        })
      );
      store.upsertNodeHygiene({
        nodeKey: 'user/profile/global-admin',
        state: 'suppressed',
        action: 'exclude',
        score: 0.88,
        rationale: 'Broad node usually pollutes focused headers.',
        reasonCodes: ['broad-bio-admin'],
        source: 'test:hygiene',
      });

      const injector = createInjector(store);
      const header = injector.assemble({
        recentMessages: 'Review the user profile global admin summary and biography framing preferences in the profile note.',
      });

      const broadNode = (header.debugNodes ?? []).find((node) => node.key === 'user/profile/global-admin');

      assert.ok(broadNode, 'Strong grounded query evidence should override hygiene suppression');
      assert.equal(broadNode?.hygieneAction, 'exclude');
      assert.ok(
        (broadNode?.keyTokenCoverage ?? 0) >= 3 || (broadNode?.queryCoverage ?? 0) >= 0.45,
        'Override should come from grounded key/family overlap or meaningful query coverage'
      );
      assert.ok((broadNode?.scoreAdjustments.hygienePenalty ?? 0) > 0);
      assert.ok((broadNode?.selectedBecause ?? []).includes('hygiene override'));
    });

    it('excludes weakly grounded cross-domain user nodes in a Priomind-focused context', () => {
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
      assert.equal(memrokNode, undefined, 'Memrok node should be excluded without local Priomind evidence');
      assert.equal(infraNode, undefined, 'Infra node should be excluded without local Priomind evidence');
    });

    it('boosts local-domain user nodes in a health-focused context while excluding stale domain bleed', () => {
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
      assert.equal(priomindNode, undefined, 'Cross-domain node should be excluded when health-local evidence is available');
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
      assert.equal(memrokAgentNode, undefined, 'Cross-domain agent node should be excluded without local Priomind evidence');
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

    it('prefers Tandem topic-local anchors over globally salient same-project memories', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-tandem-topic-anchors',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'project',
              key: 'user/tandem/topic-101/ranking',
              value: 'Tandem topic 101 is about Memrok ranking fixes, judged recall, and cross-topic bleed.',
              signals: { emotional_weight: 0.2 },
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'project',
              key: 'user/tandem/topic-202/community',
              value: 'Tandem topic 202 is about community rituals and forum moderation defaults.',
              signals: { emotional_weight: 0.95, correction: true },
            },
          ],
        })
      );

      for (let i = 0; i < 4; i++) {
        store.applyPass(
          makePass({
            pass_id: `p-tandem-global-${i}`,
            mutations: [
              {
                operation: 'update',
                layer: 'user',
                category: 'project',
                key: 'user/tandem/topic-202/community',
                value: 'Tandem topic 202 is about community rituals and forum moderation defaults.',
                signals: { emotional_weight: 0.95, correction: true },
              },
            ],
          })
        );
      }

      const injector = createInjector(store, {
        tokenBudget: 180,
        layerWeights: { user: 1, agent: 0, collaboration: 0 },
      });
      const header = injector.assemble({
        recentMessages: 'Tandem topic 101: reduce cross-topic bleed in Memrok ranking and judged recall.',
      });

      const localNode = (header.debugNodes ?? []).find((node) => node.key === 'user/tandem/topic-101/ranking');
      const globalNode = (header.debugNodes ?? []).find((node) => node.key === 'user/tandem/topic-202/community');

      assert.ok(localNode, 'Local Tandem topic node should be selected');
      assert.equal(globalNode, undefined, 'Competing same-project topic should be excluded when it mismatches the local anchor');
      assert.ok((localNode?.matchedAnchorIds ?? []).includes('project:tandem'));
      assert.ok((localNode?.matchedAnchorIds ?? []).includes('topic:topic-101'));
      assert.ok((localNode?.selectedBecause ?? []).includes('topic-anchor match'));
    });

    it('supports person anchors as a local retrieval prior without changing anchor-free behavior', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-person-anchor',
          mutations: [
            {
              operation: 'add',
              layer: 'collaboration',
              category: 'relationship',
              key: 'collaboration/people/tobi/feedback-style',
              value: 'With Tobi, keep the review loop concrete and short.',
            },
            {
              operation: 'add',
              layer: 'collaboration',
              category: 'relationship',
              key: 'collaboration/people/mira/feedback-style',
              value: 'With Mira, compare multiple framing options before deciding.',
              signals: { emotional_weight: 0.9, correction: true },
            },
          ],
        })
      );

      const injector = createInjector(store, {
        tokenBudget: 220,
        layerWeights: { user: 0.2, agent: 0.2, collaboration: 0.6 },
      });
      const header = injector.assemble({
        recentMessages: 'Prepare feedback with Tobi about the ranking draft.',
      });

      const tobiNode = (header.debugNodes ?? []).find((node) => node.key === 'collaboration/people/tobi/feedback-style');
      const miraNode = (header.debugNodes ?? []).find((node) => node.key === 'collaboration/people/mira/feedback-style');

      assert.ok(tobiNode, 'Person-local collaboration node should be selected');
      assert.equal(miraNode, undefined, 'Other person node should be excluded when it conflicts with the local anchor');
      assert.ok((tobiNode?.matchedAnchorIds ?? []).includes('person:tobi'));
      assert.ok((tobiNode?.selectedBecause ?? []).includes('person-anchor match'));
    });

    it('leaves header space unused when only one node has strong local evidence', () => {
      store.applyPass(
        makePass({
          pass_id: 'p-sparse-header',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'project',
              key: 'user/schmidle-impuls/logo/review',
              value: 'Schmidle Impuls logo review should stay close to the current business brief and typography choices.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'belief',
              key: 'user/memrok/community',
              value: 'Memrok community notes matter for plugin distribution and OpenClaw collaboration.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/health/routine',
              value: 'Old health notes focus on sleep routine and recovery experiments.',
            },
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/profile/general-style',
              value: 'Generic profile: prefers concise updates across projects.',
            },
          ],
        })
      );

      const injector = createInjector(store, {
        tokenBudget: 320,
        layerWeights: { user: 1, agent: 0, collaboration: 0 },
      });
      const header = injector.assemble({
        recentMessages: 'Schmidle Impuls business logo direction, typography, and current brief review.',
      });

      const selectedKeys = (header.debugNodes ?? []).map((node) => node.key);
      assert.deepEqual(selectedKeys, ['user/schmidle-impuls/logo/review']);
      assert.equal(header.nodesUsed, 1, 'Header should stay sparse instead of filling with weak residue');
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

    it('skips working set snapshot persistence in no-persist mode', () => {
      store.applyPass(
        makePass({
          pass_id: 'trace-pass-no-persist',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'preference',
              key: 'user/trace/no-persist',
              value: 'Inspect this header without persisting a trace.',
            },
          ],
        })
      );

      const injector = createInjector(store, { workingSetSnapshotLimit: 5 });
      const header = injector.assemble({
        recentMessages: 'inspect without persisting',
        sessionId: 'session-no-persist',
        noPersist: true,
      });

      assert.ok(header.text.includes('Inspect this header without persisting a trace.'));
      assert.equal(store.listWorkingSetSnapshots().length, 0);
    });

    it('logs bounded injection eval events when enabled', () => {
      store.applyPass(
        makePass({
          pass_id: 'eval-event-pass',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'project',
              key: 'user/memrok/eval-events',
              value: 'Memrok runtime injections should emit bounded evaluation evidence.',
            },
          ],
        })
      );

      const injector = createInjector(store, {
        injectionEvalEvents: {
          enabled: true,
          maxQueryChars: 18,
          maxHeaderChars: 80,
          maxNodeValueChars: 32,
          metadata: { source: 'test-config' },
          retention: { maxEvents: 10 },
        },
      });
      injector.assemble({
        recentMessages: 'Memrok eval events should capture runtime injection evidence without dumping too much private context.',
        sessionId: 'session-eval-event',
      });

      const events = store.listInjectionEvalEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0].event_kind, 'runtime');
      assert.equal(events[0].session_id, 'session-eval-event');
      assert.ok((events[0].query_excerpt?.length ?? 0) <= 18);
      assert.ok(events[0].query_hash);
      assert.ok((events[0].header_text?.length ?? 0) <= 80);
      assert.equal(events[0].selected_nodes.length, 1);
      assert.equal(events[0].selected_nodes[0].key, 'user/memrok/eval-events');
      assert.ok(events[0].selected_nodes[0].valueExcerpt.length <= 32);
      assert.equal(events[0].metadata?.source, 'test-config');
      assert.equal((events[0].metadata?.privacy as Record<string, unknown>).queryExcerptChars, 18);
      assert.equal(events[0].metadata?.topRejectedCandidatesAvailable, false);
    });

    it('can log explicit probe eval events without normal persistence', () => {
      store.applyPass(
        makePass({
          pass_id: 'eval-event-probe-pass',
          mutations: [
            {
              operation: 'add',
              layer: 'user',
              category: 'project',
              key: 'user/memrok/probe-events',
              value: 'Explicit probes can choose to record an eval event.',
            },
          ],
        })
      );

      const injector = createInjector(store, {
        injectionEvalEvents: { enabled: false },
      });
      injector.assemble({
        recentMessages: 'probe event',
        sessionId: 'probe-session',
        noPersist: true,
        logEvalEvent: true,
        evalEventKind: 'probe',
        evalEventMetadata: { probeId: 'manual-probe-1' },
      });

      assert.equal(store.listWorkingSetSnapshots().length, 0);
      const events = store.listInjectionEvalEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0].event_kind, 'probe');
      assert.equal(events[0].metadata?.probeId, 'manual-probe-1');
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
