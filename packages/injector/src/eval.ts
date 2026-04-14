import { createStore } from '@memrok/store';
import type { ScribePass } from '@memrok/store';
import { createInjector } from './injector.js';
import { evaluateInjectionCritic, type InjectionCriticResult, type InjectionEvalFixture } from './critic.js';
import type { ContextHeader } from './types.js';

export interface InjectionEvalCaseResult {
  fixtureId: string;
  title: string;
  description: string;
  query: string;
  header: ContextHeader;
  selectedKeys: string[];
  critic: InjectionCriticResult;
}

export interface InjectionEvalRun {
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  results: InjectionEvalCaseResult[];
}

export interface InjectionEvalComparisonCase {
  fixtureId: string;
  passChanged: boolean;
  previousPass: boolean | null;
  currentPass: boolean;
  selectedAdded: string[];
  selectedRemoved: string[];
  newFailureModes: string[];
  resolvedFailureModes: string[];
}

export interface InjectionEvalComparison {
  baselineGeneratedAt: string | null;
  currentGeneratedAt: string;
  cases: InjectionEvalComparisonCase[];
}

function fixtureToPass(fixture: InjectionEvalFixture): ScribePass {
  return {
    pass_id: `fixture-${fixture.id}`,
    source: `fixture:${fixture.id}`,
    mutations: fixture.nodes.map((node) => ({
      operation: 'add' as const,
      layer: node.layer,
      category: node.category,
      key: node.key,
      value: node.value,
      evidence: node.evidence,
    })),
  };
}

export function runInjectionEvalFixture(fixture: InjectionEvalFixture): InjectionEvalCaseResult {
  const store = createStore(':memory:');

  try {
    store.applyPass(fixtureToPass(fixture));
    for (const node of fixture.nodes) {
      if (!node.hygiene) continue;
      store.upsertNodeHygiene({
        nodeKey: node.key,
        state: node.hygiene.state,
        action: node.hygiene.action,
        score: node.hygiene.score,
        rationale: node.hygiene.rationale,
        reasonCodes: node.hygiene.reasonCodes,
        source: `fixture:${fixture.id}:hygiene`,
      });
    }

    const injector = createInjector(store, fixture.options);
    const header = injector.assemble({ recentMessages: fixture.query, noPersist: true });
    const critic = evaluateInjectionCritic(fixture, header);

    return {
      fixtureId: fixture.id,
      title: fixture.title,
      description: fixture.description,
      query: fixture.query,
      header,
      selectedKeys: (header.debugNodes ?? []).map((node) => node.key),
      critic,
    };
  } finally {
    store.close();
  }
}

export function runInjectionEvalFixtures(fixtures: InjectionEvalFixture[]): InjectionEvalRun {
  const results = fixtures.map((fixture) => runInjectionEvalFixture(fixture));
  const passedCases = results.filter((result) => result.critic.pass).length;

  return {
    generatedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    results,
  };
}

export function compareInjectionEvalRuns(
  baseline: Partial<InjectionEvalRun> | null,
  current: InjectionEvalRun,
): InjectionEvalComparison {
  const baselineMap = new Map(
    (baseline?.results ?? []).map((result) => [result.fixtureId, result])
  );

  const cases = current.results.map((result) => {
    const previous = baselineMap.get(result.fixtureId) ?? null;
    const previousSelected = new Set(previous?.selectedKeys ?? []);
    const currentSelected = new Set(result.selectedKeys);
    const previousFailures = new Set(
      (previous?.critic?.failureModes ?? [])
        .filter((mode) => mode.triggered)
        .map((mode) => mode.mode)
    );
    const currentFailures = new Set(
      result.critic.failureModes.filter((mode) => mode.triggered).map((mode) => mode.mode)
    );

    return {
      fixtureId: result.fixtureId,
      passChanged: previous ? previous.critic.pass !== result.critic.pass : false,
      previousPass: previous ? previous.critic.pass : null,
      currentPass: result.critic.pass,
      selectedAdded: result.selectedKeys.filter((key) => !previousSelected.has(key)),
      selectedRemoved: Array.from(previousSelected).filter((key) => !currentSelected.has(key)),
      newFailureModes: Array.from(currentFailures).filter((mode) => !previousFailures.has(mode)),
      resolvedFailureModes: Array.from(previousFailures).filter((mode) => !currentFailures.has(mode)),
    };
  });

  return {
    baselineGeneratedAt: baseline?.generatedAt ?? null,
    currentGeneratedAt: current.generatedAt,
    cases,
  };
}
