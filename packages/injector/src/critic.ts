import type { ContextHeader, ContextHeaderDebugNode, InjectorConfig } from './types.js';

export type InjectionFailureMode =
  | 'stale-domain-bleed'
  | 'generic-evergreen-overflow'
  | 'semantic-only-false-positive'
  | 'wrong-topic-same-project-confusion'
  | 'useful-sparsity-ignored';

export interface InjectionEvalFixtureNode {
  layer: 'user' | 'agent' | 'collaboration';
  category: string;
  key: string;
  value: string;
  evidence?: string;
  hygiene?: {
    state: 'suppressed' | 'deprioritized';
    action: 'exclude' | 'deprioritize';
    score: number;
    rationale: string;
    reasonCodes: string[];
  };
}

export interface InjectionEvalFixture {
  id: string;
  title: string;
  description: string;
  query: string;
  options?: InjectorConfig;
  nodes: InjectionEvalFixtureNode[];
  expectations: {
    expectedIn: string[];
    expectedOut: string[];
    allowedExtras?: string[];
  };
}

export interface InjectionCriticNodeAssessment {
  key: string;
  layer: ContextHeaderDebugNode['layer'];
  category: string;
  value: string;
  explanation: string;
}

export interface InjectionCriticFailure {
  mode: InjectionFailureMode;
  triggered: boolean;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
  evidenceKeys: string[];
}

export interface InjectionCriticResult {
  pass: boolean;
  usefulNodes: InjectionCriticNodeAssessment[];
  noiseNodes: InjectionCriticNodeAssessment[];
  missingNodes: InjectionCriticNodeAssessment[];
  suggestedNodes: InjectionCriticNodeAssessment[];
  failureModes: InjectionCriticFailure[];
  summary: {
    selectedCount: number;
    usefulCount: number;
    noiseCount: number;
    missingCount: number;
    expectedInMatched: number;
    expectedOutSelected: number;
    allowedExtraCount: number;
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1)
  );
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[/.]+/g, '/');
}

function getKeySegments(key: string): string[] {
  return normalizeKey(key).split('/').filter(Boolean);
}

const GENERIC_SEGMENTS = new Set([
  'user', 'agent', 'collaboration', 'collab', 'profile', 'bio', 'admin',
  'pref', 'preference', 'belief', 'decision', 'dynamic', 'skill', 'pattern',
  'project', 'projects', 'topic', 'topics', 'work', 'state', 'current',
  'style', 'process', 'trust', 'friction', 'priority', 'fact',
]);

function classifyNodeDomainFromKey(key: string): string | null {
  const segments = getKeySegments(key);
  if (segments.length < 2) return null;
  if (segments[0] === 'user' || segments[0] === 'agent' || segments[0] === 'collaboration' || segments[0] === 'collab') {
    return segments[1];
  }
  return segments[0];
}

function collectExpectedDomains(fixture: InjectionEvalFixture): Set<string> {
  const domains = new Set<string>();
  const nodesByKey = new Map(fixture.nodes.map((node) => [node.key, node]));
  for (const key of fixture.expectations.expectedIn) {
    const node = nodesByKey.get(key);
    const domain = node ? classifyNodeDomainFromKey(node.key) : classifyNodeDomainFromKey(key);
    if (domain) domains.add(domain);
  }
  return domains;
}

function collectExpectedTopics(fixture: InjectionEvalFixture): Set<string> {
  const topics = new Set<string>();
  for (const key of fixture.expectations.expectedIn) {
    const segments = getKeySegments(key);
    for (const segment of segments) {
      if (segment.startsWith('topic-') || segment.startsWith('card-')) {
        topics.add(segment);
      }
    }
  }
  return topics;
}

function hasMeaningfulFamilyOverlap(key: string, expectedKeys: string[]): boolean {
  const candidateSegments = getKeySegments(key).slice(2).filter((segment) => !GENERIC_SEGMENTS.has(segment));
  if (candidateSegments.length === 0) return false;

  return expectedKeys.some((expectedKey) => {
    const expectedSegments = new Set(
      getKeySegments(expectedKey).slice(2).filter((segment) => !GENERIC_SEGMENTS.has(segment))
    );
    return candidateSegments.some((segment) => expectedSegments.has(segment));
  });
}

function describeNode(node: ContextHeaderDebugNode, explanation: string): InjectionCriticNodeAssessment {
  return {
    key: node.key,
    layer: node.layer,
    category: node.category,
    value: node.value,
    explanation,
  };
}

function describeMissingNode(
  key: string,
  fixture: InjectionEvalFixture,
  explanation: string,
): InjectionCriticNodeAssessment {
  const node = fixture.nodes.find((candidate) => candidate.key === key);
  return {
    key,
    layer: node?.layer ?? 'user',
    category: node?.category ?? 'unknown',
    value: node?.value ?? '(missing fixture node value)',
    explanation,
  };
}

export function evaluateInjectionCritic(
  fixture: InjectionEvalFixture,
  header: ContextHeader,
): InjectionCriticResult {
  const debugNodes = header.debugNodes ?? [];
  const selectedSet = new Set(debugNodes.map((node) => node.key));
  const expectedIn = new Set(fixture.expectations.expectedIn);
  const expectedOut = new Set(fixture.expectations.expectedOut);
  const allowedExtras = new Set(fixture.expectations.allowedExtras ?? []);
  const expectedDomains = collectExpectedDomains(fixture);
  const expectedTopics = collectExpectedTopics(fixture);

  const usefulNodes = debugNodes
    .filter((node) => expectedIn.has(node.key))
    .map((node) =>
      describeNode(
        node,
        'Matched an explicitly expected in-context node for this probe.'
      )
    );

  const missingNodes = fixture.expectations.expectedIn
    .filter((key) => !selectedSet.has(key))
    .map((key) =>
      describeMissingNode(
        key,
        fixture,
        'Expected useful node was not selected for this probe.'
      )
    );

  const noiseNodes: InjectionCriticNodeAssessment[] = [];
  const genericOverflowEvidence: string[] = [];
  const domainBleedEvidence: string[] = [];
  const semanticOnlyEvidence: string[] = [];
  const wrongTopicEvidence: string[] = [];

  for (const node of debugNodes) {
    const explicitlyOut = expectedOut.has(node.key);
    const domain = node.domain ?? classifyNodeDomainFromKey(node.key);
    const genericOverflow =
      node.scoreAdjustments.broadBioPenalty >= 0.08 ||
      node.scoreAdjustments.genericMetaPenalty >= 0.08;
    const semanticOnlyFalsePositive =
      node.semanticScore >= 0.3 &&
      node.queryCoverage < 0.12 &&
      node.keyTokenCoverage === 0 &&
      node.matchedAnchorIds.length === 0 &&
      node.domainMatch !== true;
    const staleDomainBleed =
      expectedDomains.size > 0 &&
      domain !== null &&
      !expectedDomains.has(domain) &&
      node.queryCoverage < 0.18;
    const sameProjectWrongTopic =
      explicitlyOut &&
      domain !== null &&
      expectedDomains.has(domain) &&
      (!hasMeaningfulFamilyOverlap(node.key, fixture.expectations.expectedIn)) &&
      (
        expectedTopics.size === 0 ||
        !node.matchedAnchorIds.some((id) => {
          const [, anchor] = id.split(':');
          return anchor ? expectedTopics.has(anchor) : false;
        })
      ) &&
      node.queryCoverage < 0.24;

    if (genericOverflow) genericOverflowEvidence.push(node.key);
    if (staleDomainBleed) domainBleedEvidence.push(node.key);
    if (semanticOnlyFalsePositive) semanticOnlyEvidence.push(node.key);
    if (sameProjectWrongTopic) wrongTopicEvidence.push(node.key);

    if (!explicitlyOut && !genericOverflow && !staleDomainBleed && !semanticOnlyFalsePositive && !sameProjectWrongTopic) {
      continue;
    }

    if (expectedIn.has(node.key) || allowedExtras.has(node.key)) continue;

    const reasons: string[] = [];
    if (explicitlyOut) reasons.push('fixture marks this node as expected-out');
    if (genericOverflow) reasons.push('node looks like broad evergreen residue');
    if (staleDomainBleed) reasons.push('node bleeds from a different domain than the expected focus');
    if (semanticOnlyFalsePositive) reasons.push('node only matched semantically without grounded local evidence');
    if (sameProjectWrongTopic) reasons.push('node is same-project but appears to belong to the wrong topic');

    noiseNodes.push(describeNode(node, reasons.join('; ')));
  }

  const failureModes: InjectionCriticFailure[] = [
    {
      mode: 'stale-domain-bleed',
      triggered: domainBleedEvidence.length > 0,
      confidence: domainBleedEvidence.length >= 2 ? 'high' : domainBleedEvidence.length === 1 ? 'medium' : 'low',
      rationale: domainBleedEvidence.length > 0
        ? 'Selected nodes drifted into domains outside the expected local focus.'
        : 'No cross-domain bleed was detected against the fixture focus.',
      evidenceKeys: domainBleedEvidence,
    },
    {
      mode: 'generic-evergreen-overflow',
      triggered: genericOverflowEvidence.length > 0,
      confidence: genericOverflowEvidence.length >= 2 ? 'high' : genericOverflowEvidence.length === 1 ? 'medium' : 'low',
      rationale: genericOverflowEvidence.length > 0
        ? 'Broad evergreen/profile/meta residue occupied header space.'
        : 'No broad evergreen overflow was detected.',
      evidenceKeys: genericOverflowEvidence,
    },
    {
      mode: 'semantic-only-false-positive',
      triggered: semanticOnlyEvidence.length > 0,
      confidence: semanticOnlyEvidence.length >= 2 ? 'high' : semanticOnlyEvidence.length === 1 ? 'medium' : 'low',
      rationale: semanticOnlyEvidence.length > 0
        ? 'At least one node survived on semantic resemblance without grounded evidence.'
        : 'No semantic-only false positive was detected.',
      evidenceKeys: semanticOnlyEvidence,
    },
    {
      mode: 'wrong-topic-same-project-confusion',
      triggered: wrongTopicEvidence.length > 0,
      confidence: wrongTopicEvidence.length >= 2 ? 'high' : wrongTopicEvidence.length === 1 ? 'medium' : 'low',
      rationale: wrongTopicEvidence.length > 0
        ? 'Selected nodes stayed in-project but drifted to the wrong topic family.'
        : 'No wrong-topic same-project confusion was detected.',
      evidenceKeys: wrongTopicEvidence,
    },
    {
      mode: 'useful-sparsity-ignored',
      triggered: missingNodes.length > 0,
      confidence: missingNodes.length >= 2 ? 'high' : missingNodes.length === 1 ? 'medium' : 'low',
      rationale: missingNodes.length > 0
        ? 'Expected useful local nodes were omitted from the header.'
        : 'Expected useful local nodes were present.',
      evidenceKeys: missingNodes.map((node) => node.key),
    },
  ];

  const suggestedNodes = missingNodes.map((node) => ({
    ...node,
    explanation: 'This is the most obvious missing local candidate the critic expected to see instead.',
  }));

  return {
    pass: noiseNodes.length === 0 && missingNodes.length === 0,
    usefulNodes,
    noiseNodes,
    missingNodes,
    suggestedNodes,
    failureModes,
    summary: {
      selectedCount: debugNodes.length,
      usefulCount: usefulNodes.length,
      noiseCount: noiseNodes.length,
      missingCount: missingNodes.length,
      expectedInMatched: usefulNodes.length,
      expectedOutSelected: debugNodes.filter((node) => expectedOut.has(node.key)).length,
      allowedExtraCount: debugNodes.filter((node) => allowedExtras.has(node.key)).length,
    },
  };
}
