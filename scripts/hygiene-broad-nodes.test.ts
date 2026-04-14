import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { Node } from '../packages/store/src/types.js';
import { assessNode } from './hygiene-broad-nodes.ts';

function makeNode(overrides: Partial<Node>): Node {
  return {
    key: 'user/profile/default',
    layer: 'user',
    category: 'preference',
    value: 'Default node value.',
    evidence: null,
    created_at: '2026-04-14T00:00:00.000Z',
    updated_at: '2026-04-14T00:00:00.000Z',
    expired_at: null,
    version: 1,
    emotional_weight: 0,
    reference_count: 1,
    correction_count: 0,
    last_referenced: null,
    first_pass_id: 'p1',
    last_pass_id: 'p1',
    hygiene: null,
    ...overrides,
  };
}

describe('hygiene broad-node heuristic', () => {
  it('flags a recent broad weakly anchored node without requiring graph age', () => {
    const nowMs = new Date('2026-04-14T12:00:00.000Z').getTime();
    const node = makeNode({
      key: 'user/profile/admin-summary',
      updated_at: '2026-04-13T12:00:00.000Z',
      value: 'Broad profile summary with biography framing, administrative preferences, and general context guidance across projects.',
    });

    const assessment = assessNode(node, nowMs);

    assert.ok(assessment, 'Recent broad residue should still be a hygiene candidate');
    assert.ok(assessment.reasonCodes.includes('broad-bio-admin'));
    assert.ok(assessment.reasonCodes.includes('weak-anchor'));
    assert.ok(assessment.reasonCodes.includes('domainless'));
    assert.ok(!assessment.reasonCodes.includes('aging-node'));
  });

  it('does not flag a specific well-anchored node just because it contains some broad-ish language', () => {
    const nowMs = new Date('2026-04-14T12:00:00.000Z').getTime();
    const node = makeNode({
      key: 'user/memrok/card-80/header-selection',
      category: 'project',
      value: 'Memrok card 80: keep context selection specific and avoid broad profile residue in header assembly.',
      reference_count: 3,
    });

    const assessment = assessNode(node, nowMs);

    assert.equal(
      assessment,
      null,
      'Specific project/topic anchoring should keep a topical node out of hygiene candidates'
    );
  });

  it('uses age only as secondary severity evidence, not as the sole front door', () => {
    const base = {
      key: 'user/profile/admin-summary',
      value: 'Broad profile summary with biography framing, administrative preferences, and general context guidance across projects.',
    };
    const recentNowMs = new Date('2026-04-14T12:00:00.000Z').getTime();
    const oldNowMs = new Date('2026-08-20T12:00:00.000Z').getTime();
    const recentNode = makeNode({
      ...base,
      updated_at: '2026-04-13T12:00:00.000Z',
    });
    const oldNode = makeNode({
      ...base,
      updated_at: '2026-04-13T12:00:00.000Z',
    });

    const recentAssessment = assessNode(recentNode, recentNowMs);
    const oldAssessment = assessNode(oldNode, oldNowMs);

    assert.ok(recentAssessment, 'Recent node should still be eligible');
    assert.ok(oldAssessment, 'Older node should still be eligible');
    assert.ok((oldAssessment?.score ?? 0) > (recentAssessment?.score ?? 0));
    assert.ok((recentAssessment?.reasonCodes ?? []).every((code) => !code.includes('old')));
    assert.ok(
      (oldAssessment?.reasonCodes ?? []).some((code) => code === 'very-old' || code === 'old-node' || code === 'aging-node')
    );
  });
});
