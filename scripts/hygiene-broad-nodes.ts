#!/usr/bin/env node
import { createStore } from '../packages/store/src/index.js';
import type { Node, NodeHygieneAction, NodeHygieneState } from '../packages/store/src/types.js';
import { fileURLToPath } from 'node:url';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or', 'but', 'not',
  'this', 'that', 'it', 'be', 'as', 'do', 'did', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'shall',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her',
  'its', 'our', 'their', 'what', 'which', 'who', 'when', 'where', 'how',
]);

const BROAD_BIO_ADMIN_KEYWORDS = new Set([
  'admin', 'administrative', 'biography', 'bio', 'background', 'profile',
  'profiles', 'identity', 'personal', 'personally', 'about', 'role', 'roles',
  'title', 'titles', 'preference', 'preferences', 'style', 'tone', 'routine',
  'routines', 'schedule', 'schedules', 'timezone', 'location', 'demographic',
]);

const GENERIC_META_KEYWORDS = new Set([
  'memory', 'memories', 'context', 'selection', 'ranking', 'retrieval',
  'recall', 'judgment', 'curation', 'graph', 'graphs', 'topic', 'topics',
  'meta', 'system', 'baseline',
]);

const PROJECT_ANCHOR_ALIASES = new Set([
  'memrok', 'priomind', 'tandem', 'zhaw', 'fcl', 'orbitals', 'fizzy', 'openclaw',
]);

const PERSON_MARKER_SEGMENTS = new Set([
  'person', 'people', 'contact', 'contacts', 'relationship', 'relationships',
]);

const GENERIC_ANCHOR_SEGMENTS = new Set([
  'user', 'agent', 'collaboration', 'collab', 'profile', 'bio', 'admin',
  'pref', 'preference', 'belief', 'decision', 'dynamic', 'skill', 'pattern',
  'project', 'projects', 'topic', 'topics', 'work', 'state', 'current',
  'style', 'process', 'trust', 'friction', 'priority', 'fact',
]);

type Assessment = {
  node: Node;
  ageDays: number;
  broadScore: number;
  genericMetaScore: number;
  weakAnchor: boolean;
  domainless: boolean;
  score: number;
  state: NodeHygieneState;
  action: NodeHygieneAction;
  reasonCodes: string[];
  rationale: string;
  details: Record<string, unknown>;
};

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );
}

export function countKeywordOverlap(tokens: Set<string>, keywords: Set<string>): number {
  let matches = 0;
  for (const token of tokens) {
    if (keywords.has(token)) matches++;
  }
  return matches;
}

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[/.]+/g, '/');
}

export function getKeySegments(key: string): string[] {
  return normalizeKey(key).split('/').filter(Boolean);
}

export function normalizeAnchorId(value: string): string | null {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length >= 2 ? normalized : null;
}

export function findProjectAnchor(segments: string[]): string | null {
  for (const segment of segments) {
    if (PROJECT_ANCHOR_ALIASES.has(segment)) return segment;
  }
  return null;
}

export function findPersonAnchor(segments: string[]): string | null {
  for (let i = 0; i < segments.length - 1; i++) {
    if (PERSON_MARKER_SEGMENTS.has(segments[i])) {
      const anchor = normalizeAnchorId(segments[i + 1]);
      if (anchor) return anchor;
    }
  }
  return null;
}

export function findTopicAnchor(segments: string[]): string | null {
  const project = findProjectAnchor(segments);
  if (project) {
    const projectIndex = segments.indexOf(project);
    for (let i = projectIndex + 1; i < segments.length; i++) {
      const segment = segments[i];
      if (GENERIC_ANCHOR_SEGMENTS.has(segment)) continue;
      const anchor = normalizeAnchorId(`${project}-${segment}`);
      if (anchor) return anchor;
    }
  }

  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === 'topic' || segments[i] === 'topics') {
      const anchor = normalizeAnchorId(`topic-${segments[i + 1]}`);
      if (anchor) return anchor;
    }
  }

  return null;
}

export function classifyNodeDomain(node: Node): string | null {
  const segments = getKeySegments(node.key);
  if (segments.length < 2) return null;
  const signature =
    segments[0] === 'user' || segments[0] === 'agent' || segments[0] === 'collaboration' || segments[0] === 'collab'
      ? segments[1]
      : segments[0];
  return PROJECT_ANCHOR_ALIASES.has(signature) ? signature : null;
}

export function computeBroadBioAdminScore(node: Node): number {
  const tokens = tokenize(`${node.key} ${node.category} ${node.value}`);
  const matches = countKeywordOverlap(tokens, BROAD_BIO_ADMIN_KEYWORDS);

  let score = Math.min(1, matches / 4);
  if (node.category === 'preference' || node.category === 'pref') {
    score = Math.max(score, 0.45);
  }
  if (node.key.includes('/bio') || node.key.includes('/profile') || node.key.includes('/admin')) {
    score = Math.max(score, 0.7);
  }

  return score;
}

export function computeGenericMetaScore(node: Node): number {
  const tokens = tokenize(`${node.key} ${node.category} ${node.value}`);
  const matches = countKeywordOverlap(tokens, GENERIC_META_KEYWORDS);
  return Math.min(1, matches / 4);
}

export function assessNode(node: Node, nowMs: number): Assessment | null {
  const ageDays = Math.max(0, (nowMs - new Date(node.updated_at).getTime()) / (1000 * 60 * 60 * 24));
  const broadScore = computeBroadBioAdminScore(node);
  const genericMetaScore = computeGenericMetaScore(node);
  const segments = getKeySegments(node.key);
  const weakAnchor = !findProjectAnchor(segments) && !findPersonAnchor(segments) && !findTopicAnchor(segments);
  const domainless = classifyNodeDomain(node) === null;

  const broadRisk = broadScore >= 0.45;
  const genericRisk = genericMetaScore >= 0.3;
  const leakageRisk =
    (weakAnchor && domainless) ||
    (weakAnchor && genericRisk) ||
    (domainless && broadRisk);
  const durableSurfaceRisk = node.reference_count >= 4;

  if (!broadRisk && !genericRisk) return null;
  if (!leakageRisk && !durableSurfaceRisk) return null;

  let score = 0;
  const reasonCodes: string[] = [];

  if (ageDays >= 120) {
    score += 0.12;
    reasonCodes.push('very-old');
  } else if (ageDays >= 75) {
    score += 0.08;
    reasonCodes.push('old-node');
  } else if (ageDays >= 30) {
    score += 0.04;
    reasonCodes.push('aging-node');
  }

  if (broadScore >= 0.7) {
    score += 0.32;
    reasonCodes.push('broad-bio-admin');
  } else if (broadScore >= 0.45) {
    score += 0.2;
    reasonCodes.push('broad-preference');
  }

  if (genericMetaScore >= 0.5) {
    score += 0.14;
    reasonCodes.push('generic-meta');
  }

  if (weakAnchor) {
    score += 0.16;
    reasonCodes.push('weak-anchor');
  }

  if (domainless) {
    score += 0.08;
    reasonCodes.push('domainless');
  }

  if (durableSurfaceRisk) {
    score += 0.06;
    reasonCodes.push('durable-surface-risk');
  }

  const boundedScore = Math.min(0.98, score);
  if (boundedScore < 0.55) return null;

  const action: NodeHygieneAction = boundedScore >= 0.8 ? 'exclude' : 'deprioritize';
  const state: NodeHygieneState = action === 'exclude' ? 'suppressed' : 'deprioritized';
  const rationale = [
    `${Math.round(ageDays)}d old`,
    broadScore >= 0.7 ? 'broad bio/admin wording' : 'broad preference wording',
    weakAnchor ? 'weak structural anchoring' : 'some structural anchoring',
    domainless ? 'no clear project/domain anchor' : 'project/domain anchor present',
    genericMetaScore >= 0.5 ? 'generic meta residue' : null,
  ].filter(Boolean).join('; ');

  return {
    node,
    ageDays,
    broadScore,
    genericMetaScore,
    weakAnchor,
    domainless,
    score: boundedScore,
    state,
    action,
    reasonCodes,
    rationale,
    details: {
      ageDays: Number(ageDays.toFixed(1)),
      broadScore: Number(broadScore.toFixed(3)),
      genericMetaScore: Number(genericMetaScore.toFixed(3)),
      weakAnchor,
      domainless,
      referenceCount: node.reference_count,
      updatedAt: node.updated_at,
    },
  };
}

export function collectAssessments(nodes: Node[], nowMs: number, limit = 100): Assessment[] {
  return nodes
    .map((node) => assessNode(node, nowMs))
    .filter((assessment): assessment is Assessment => assessment !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

function main(): void {
  const args = process.argv.slice(2);
  let dbPath = process.env.MEMROK_DB_PATH || '/home/michael/.memrok/memrok.db';
  let dryRun = true;
  let limit = 100;
  const clearKeys: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--db' && args[i + 1]) dbPath = args[++i];
    else if (arg === '--apply') dryRun = false;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--limit' && args[i + 1]) limit = Number(args[++i]);
    else if (arg === '--clear-key' && args[i + 1]) clearKeys.push(args[++i]);
  }

  const store = createStore(dbPath);

  if (clearKeys.length > 0) {
    const cleared = clearKeys.map((key) => ({
      key,
      cleared: store.clearNodeHygiene(key, 'script:hygiene-broad-nodes:clear', 'Manual hygiene clear'),
    }));

    console.log('## Memrok Hygiene Clear');
    console.log(`dbPath: ${dbPath}`);
    for (const entry of cleared) {
      console.log(`- ${entry.cleared ? 'cleared' : 'missing'} ${entry.key}`);
    }
    store.close();
    process.exit(0);
  }

  const assessments = collectAssessments(store.queryNodes({ active: true }), Date.now(), limit);

  console.log('## Memrok Broad-Node Hygiene');
  console.log(`dbPath: ${dbPath}`);
  console.log(`mode: ${dryRun ? 'dry-run' : 'apply'}`);
  console.log(`candidates: ${assessments.length}`);
  console.log('');

  for (const assessment of assessments) {
    const current = assessment.node.hygiene;
    const currentLabel = current
      ? `current=${current.state}/${current.action}@${current.score.toFixed(2)}`
      : 'current=none';
    console.log(
      `- action=${assessment.action} score=${assessment.score.toFixed(2)} age=${Math.round(assessment.ageDays)}d ${currentLabel}`
    );
    console.log(`  key: ${assessment.node.key}`);
    console.log(`  reasons: ${assessment.reasonCodes.join(', ')}`);
    console.log(`  rationale: ${assessment.rationale}`);
    console.log(`  value: ${assessment.node.value}`);
  }

  if (!dryRun) {
    for (const assessment of assessments) {
      store.upsertNodeHygiene({
        nodeKey: assessment.node.key,
        state: assessment.state,
        action: assessment.action,
        score: assessment.score,
        rationale: assessment.rationale,
        reasonCodes: assessment.reasonCodes,
        details: assessment.details,
        source: 'script:hygiene-broad-nodes',
      });
    }

    console.log('');
    console.log(`Applied ${assessments.length} hygiene changes.`);
  }

  store.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
