import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { evaluateInjectionCritic, type InjectionEvalFixture } from './critic.js';
import { runInjectionEvalFixtures } from './eval.js';
import type { ContextHeader, ContextHeaderDebugNode } from './types.js';

function makeDebugNode(overrides: Partial<ContextHeaderDebugNode>): ContextHeaderDebugNode {
  return {
    key: 'user/default',
    layer: 'user',
    category: 'preference',
    value: 'Default node.',
    score: 0.5,
    rawScore: 0.5,
    updatedAt: '2026-04-14T00:00:00.000Z',
    referenceCount: 1,
    correctionCount: 0,
    semanticScore: 0.5,
    queryCoverage: 0.5,
    keyTokenCoverage: 1,
    family: 'user/default',
    domain: null,
    domainMatch: null,
    outOfContextRisk: 0,
    selectedBecause: ['semantic match'],
    anchorIds: [],
    matchedAnchorIds: [],
    hygieneState: null,
    hygieneAction: null,
    hygieneScore: null,
    scoreAdjustments: {
      queryCoverageBoost: 0,
      keyMatchBoost: 0,
      domainBoost: 0,
      anchorBoost: 0,
      anchorMismatchPenalty: 0,
      broadBioPenalty: 0,
      genericMetaPenalty: 0,
      crossDomainPenalty: 0,
      hygienePenalty: 0,
      selectionSimilarityPenalty: 0,
      selectionFamilyPenalty: 0,
      selectionDomainPenalty: 0,
    },
    ...overrides,
  };
}

function makeHeader(debugNodes: ContextHeaderDebugNode[]): ContextHeader {
  return {
    text: 'header',
    tokens: 50,
    nodesUsed: debugNodes.length,
    layers: {
      user: debugNodes.filter((node) => node.layer === 'user').length,
      agent: debugNodes.filter((node) => node.layer === 'agent').length,
      collaboration: debugNodes.filter((node) => node.layer === 'collaboration').length,
    },
    debugNodes,
    assemblyMs: 1,
  };
}

function loadFixtures(): InjectionEvalFixture[] {
  const fixturesDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../fixtures/injection-evals',
  );
  return fs.readdirSync(fixturesDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8')) as InjectionEvalFixture);
}

describe('injection critic', () => {
  it('exposes the explicit failure taxonomy with useful, noise, and missing guidance', () => {
    const fixture: InjectionEvalFixture = {
      id: 'taxonomy-case',
      title: 'taxonomy case',
      description: 'Direct critic taxonomy coverage.',
      query: 'Memrok reflection serializer formatting and graph state truncation.',
      nodes: [
        {
          layer: 'user',
          category: 'project',
          key: 'user/memrok/reflection-serializer/truncation',
          value: 'Keep serializer truncation local to reflection input.',
        },
        {
          layer: 'user',
          category: 'preference',
          key: 'user/profile/global-admin',
          value: 'Broad profile residue.',
        },
        {
          layer: 'user',
          category: 'decision',
          key: 'user/health/recovery-pattern',
          value: 'Health continuity.',
        },
        {
          layer: 'user',
          category: 'project',
          key: 'user/memrok/injector-ranking',
          value: 'Injector ranking topic.',
        },
      ],
      expectations: {
        expectedIn: ['user/memrok/reflection-serializer/truncation', 'agent/memrok/reflection/formatting'],
        expectedOut: ['user/profile/global-admin', 'user/health/recovery-pattern', 'user/memrok/injector-ranking'],
      },
    };

    const header = makeHeader([
      makeDebugNode({
        key: 'user/profile/global-admin',
        value: 'Broad profile residue.',
        queryCoverage: 0.04,
        keyTokenCoverage: 0,
        semanticScore: 0.42,
        scoreAdjustments: {
          queryCoverageBoost: 0,
          keyMatchBoost: 0,
          domainBoost: 0,
          anchorBoost: 0,
          anchorMismatchPenalty: 0,
          broadBioPenalty: 0.12,
          genericMetaPenalty: 0,
          crossDomainPenalty: 0,
          hygienePenalty: 0,
          selectionSimilarityPenalty: 0,
          selectionFamilyPenalty: 0,
          selectionDomainPenalty: 0,
        },
      }),
      makeDebugNode({
        key: 'user/health/recovery-pattern',
        value: 'Health continuity.',
        domain: 'health',
        queryCoverage: 0.05,
        keyTokenCoverage: 0,
        semanticScore: 0.33,
      }),
      makeDebugNode({
        key: 'user/memrok/injector-ranking',
        value: 'Injector ranking topic.',
        domain: 'memrok',
        queryCoverage: 0.08,
        keyTokenCoverage: 0,
        semanticScore: 0.36,
      }),
    ]);

    const result = evaluateInjectionCritic(fixture, header);

    assert.equal(result.pass, false);
    assert.equal(result.usefulNodes.length, 0);
    assert.equal(result.missingNodes.some((node) => node.key === 'user/memrok/reflection-serializer/truncation'), true);
    assert.equal(result.suggestedNodes.some((node) => node.key === 'user/memrok/reflection-serializer/truncation'), true);
    assert.equal(result.noiseNodes.some((node) => node.key === 'user/profile/global-admin'), true);
    assert.equal(result.failureModes.find((mode) => mode.mode === 'generic-evergreen-overflow')?.triggered, true);
    assert.equal(result.failureModes.find((mode) => mode.mode === 'stale-domain-bleed')?.triggered, true);
    assert.equal(result.failureModes.find((mode) => mode.mode === 'semantic-only-false-positive')?.triggered, true);
    assert.equal(result.failureModes.find((mode) => mode.mode === 'wrong-topic-same-project-confusion')?.triggered, true);
    assert.equal(result.failureModes.find((mode) => mode.mode === 'useful-sparsity-ignored')?.triggered, true);
  });

  it('runs the seeded fixture suite as a repeatable regression baseline', () => {
    const fixtures = loadFixtures();
    const run = runInjectionEvalFixtures(fixtures);

    assert.ok(run.totalCases >= 5);
    assert.equal(run.results.find((result) => result.fixtureId === 'health-wellbeing-local')?.critic.pass, true);
    assert.equal(run.results.find((result) => result.fixtureId === 'ops-infra-continuity')?.critic.pass, true);

    const memrokResidue = run.results.find((result) => result.fixtureId === 'memrok-broad-residue-sensitive');
    assert.equal(memrokResidue?.critic.pass, false);
    assert.equal(memrokResidue?.critic.noiseNodes.some((node) => node.key === 'user/memrok/generic-memory-principles'), true);
    assert.equal(
      memrokResidue?.critic.failureModes.find((mode) => mode.mode === 'useful-sparsity-ignored')?.triggered,
      true,
    );

    const sameProjectConfusion = run.results.find((result) => result.fixtureId === 'memrok-wrong-topic-same-project');
    assert.equal(sameProjectConfusion?.critic.pass, false);
    assert.equal(
      sameProjectConfusion?.critic.failureModes.find((mode) => mode.mode === 'wrong-topic-same-project-confusion')?.triggered,
      true,
    );

    const brandLogo = run.results.find((result) => result.fixtureId === 'brand-logo-focus');
    assert.equal(brandLogo?.critic.pass, false);
    assert.equal(
      brandLogo?.critic.failureModes.find((mode) => mode.mode === 'useful-sparsity-ignored')?.triggered,
      true,
    );
  });
});
