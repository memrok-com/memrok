import type { GraphStore, Node, Pass } from '@memrok/store';

export interface ReflectionSerializerOptions {
  /** Include nodes updated within last N days. Default: 30 */
  recentDays?: number;
  /** Include nodes with reference_count >= N regardless of age. Default: 3 */
  minReferenceCount?: number;
  /** Include nodes with correction_count >= N regardless of age. Default: 1 */
  minCorrectionCount?: number;
  /** Hard cap on serialized nodes after scoping. Default: 80 */
  maxNodes?: number;
}

const LAYER_ORDER = ['user', 'agent', 'collaboration'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_PATTERN = /\b(as of|status|node count|graph nodes|scribe passes|updated at|current state|snapshot)\b/;
const OPERATIONAL_PATTERN = /\b(live|running|active|idle|healthy|unhealthy|degraded|blocked|synced|online|offline|count|total)\b/;
const DECISION_TRANSIENCE_PATTERN = /\b(current|currently|temporary|temporarily|for now|until|during|while|this sprint|this week|this release)\b/;
const OPERATIONAL_CATEGORIES = new Set(['dynamic', 'process', 'fact']);

function looksLikeSnapshotNode(node: Node): boolean {
  const haystack = `${node.key} ${node.value}`.toLowerCase();
  return SNAPSHOT_PATTERN.test(haystack);
}

function looksOperationalState(node: Node): boolean {
  const haystack = `${node.key} ${node.value}`.toLowerCase();
  if (OPERATIONAL_CATEGORIES.has(node.category)) {
    return OPERATIONAL_PATTERN.test(haystack);
  }

  if (node.category === 'decision') {
    return (SNAPSHOT_PATTERN.test(haystack) || DECISION_TRANSIENCE_PATTERN.test(haystack)) &&
      OPERATIONAL_PATTERN.test(haystack);
  }

  return false;
}

function ageInDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS));
}

function keyFamilies(key: string): string[] {
  const parts = key.split('.');
  const families: string[] = [];
  for (let i = 1; i < Math.min(parts.length, 3); i++) {
    families.push(parts.slice(0, i + 1).join('.'));
  }
  return families;
}

interface CurationSignal {
  score: number;
  reasons: string[];
  newerRelatedKeys: string[];
}

function computeCurationSignal(node: Node, allNodes: Node[], store: GraphStore): CurationSignal {
  let score = 0;
  const reasons: string[] = [];

  const snapshotLike = looksLikeSnapshotNode(node);
  const operationalState = looksOperationalState(node);
  if (snapshotLike) {
    score += 4;
    reasons.push('snapshot/status wording');
  }
  if (operationalState) {
    score += 3;
    reasons.push('operational-state wording');
  }

  const ageDays = ageInDays(node.updated_at);
  if (ageDays >= 30) {
    score += 3;
    reasons.push(`old snapshot age (${ageDays}d)`);
  } else if (ageDays >= 14) {
    score += 2;
    reasons.push(`aging state (${ageDays}d)`);
  } else if (ageDays >= 7 && (snapshotLike || operationalState)) {
    score += 1;
    reasons.push(`situational state is already ${ageDays}d old`);
  }

  if (node.reference_count <= 1 && ageDays >= 7) {
    score += 2;
    reasons.push('low reinforcement since capture');
  } else if (node.reference_count <= 2 && ageDays >= 14) {
    score += 1;
    reasons.push('weak recent reinforcement');
  }

  const history = store.getHistory(node.key);
  const nonExpireHistory = history.filter((mutation) => mutation.operation !== 'expire');
  const distinctValues = new Set(nonExpireHistory.map((mutation) => mutation.value.trim()));
  if ((snapshotLike || operationalState) && distinctValues.size >= 2) {
    score += 3;
    reasons.push('same key has been rewritten with different state');
  } else if ((snapshotLike || operationalState) && node.version >= 3) {
    score += 2;
    reasons.push(`same key shows recurring state churn (v${node.version})`);
  }

  const families = new Set(keyFamilies(node.key));
  const newerRelated = allNodes
    .filter((candidate) => candidate.key !== node.key)
    .filter((candidate) => keyFamilies(candidate.key).some((family) => families.has(family)))
    .filter((candidate) => candidate.updated_at > node.updated_at)
    .filter((candidate) => looksLikeSnapshotNode(candidate) || looksOperationalState(candidate))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const newerRelatedKeys = newerRelated.slice(0, 3).map((candidate) => candidate.key);
  if (newerRelatedKeys.length > 0) {
    score += 4;
    reasons.push(`fresher same-family state exists (${newerRelatedKeys.join(', ')})`);
  }

  return { score, reasons, newerRelatedKeys };
}

function formatNode(node: Node, curationSignal?: CurationSignal): string {
  const lines: string[] = [];
  lines.push(`[${node.key}]`);
  lines.push(`  value: ${node.value}`);
  if (node.evidence) {
    lines.push(`  evidence: ${node.evidence}`);
  }
  const flags: string[] = [
    `ref=${node.reference_count}`,
    `corrections=${node.correction_count}`,
    `updated=${node.updated_at.slice(0, 10)}`,
  ];
  lines.push(`  stats: ${flags.join(', ')}`);
  if (curationSignal && curationSignal.score > 0) {
    lines.push(`  curation: expiry_pressure=${curationSignal.score}; reasons=${curationSignal.reasons.join('; ')}`);
    if (curationSignal.newerRelatedKeys.length > 0) {
      lines.push(`  newer_state: ${curationSignal.newerRelatedKeys.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function formatPass(pass: Pass): string {
  return [
    `- ${pass.timestamp}`,
    pass.source ? `source=${pass.source}` : null,
    pass.mutations_count != null ? `mutations=${pass.mutations_count}` : null,
    pass.observations ? `observations=${pass.observations}` : null,
  ].filter(Boolean).join(' | ');
}

function compareReflectionPriority(a: Node, b: Node): number {
  return (
    b.correction_count - a.correction_count ||
    b.reference_count - a.reference_count ||
    b.updated_at.localeCompare(a.updated_at) ||
    a.key.localeCompare(b.key)
  );
}

/**
 * Serializes a scoped view of the knowledge graph for the reflective scribe.
 *
 * Scope criteria (any one is sufficient):
 * - Node updated within the last `recentDays` days
 * - Node has reference_count >= `minReferenceCount` (durable regardless of age)
 * - Node has correction_count >= `minCorrectionCount` (corrected beliefs worth reflecting on)
 *
 * Output is organized by layer and formatted as readable text, suitable as the
 * user message to ScribeInterface.callModel() with inputLabel "GRAPH_STATE".
 */
export function serializeGraphForReflection(
  store: GraphStore,
  options?: ReflectionSerializerOptions,
): string {
  const recentDays = options?.recentDays ?? 30;
  const minReferenceCount = options?.minReferenceCount ?? 3;
  const minCorrectionCount = options?.minCorrectionCount ?? 1;
  const maxNodes = options?.maxNodes ?? 80;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - recentDays);
  const cutoffIso = cutoff.toISOString();

  const allNodes = store.queryNodes({ active: true });
  const recentPasses = store.listPasses()
    .filter((pass) => pass.source !== 'reflection' && !pass.source?.startsWith('bootstrap:'))
    .slice(-8);

  const scoped = allNodes.filter(
    (node) =>
      node.updated_at >= cutoffIso ||
      node.reference_count >= minReferenceCount ||
      node.correction_count >= minCorrectionCount,
  );
  const selected = scoped
    .slice()
    .sort(compareReflectionPriority)
    .slice(0, Math.max(0, maxNodes));
  const curationSignals = new Map<string, CurationSignal>();
  for (const node of allNodes) {
    curationSignals.set(node.key, computeCurationSignal(node, allNodes, store));
  }
  const staleCandidates = allNodes
    .map((node) => ({ node, signal: curationSignals.get(node.key)! }))
    .filter(({ node, signal }) => (looksLikeSnapshotNode(node) || looksOperationalState(node)) && signal.score >= 4)
    .sort((a, b) => {
      return (
        b.signal.score - a.signal.score ||
        a.node.updated_at.localeCompare(b.node.updated_at) ||
        a.node.key.localeCompare(b.node.key)
      );
    })
    .slice(0, 12);

  const lines: string[] = [];
  lines.push(
    `Scope: ${selected.length} of ${scoped.length} scoped nodes (from ${allNodes.length} active; ` +
      `criteria: updated within ${recentDays}d OR ref≥${minReferenceCount} OR corrections≥${minCorrectionCount}; ` +
      `max=${maxNodes})`,
  );
  if (scoped.length > selected.length) {
    lines.push(`Truncated ${scoped.length - selected.length} lower-priority nodes from reflection input.`);
  }
  if (recentPasses.length > 0) {
    lines.push('');
    lines.push('## RECENT PASSES');
    for (const pass of recentPasses) lines.push(formatPass(pass));
  }
  if (staleCandidates.length > 0) {
    lines.push('');
    lines.push('## CURATION PRIORITY: STALE OR SUPERSEDED NODES');
    lines.push('Review these aggressively for expiry, replacement, or demotion.');
    lines.push('Bias toward expiring snapshot-like operational state when fresher same-family evidence exists or reinforcement is weak.');
    lines.push('');
    for (const { node, signal } of staleCandidates) {
      lines.push(formatNode(node, signal));
    }
  }

  if (selected.length === 0) {
    lines.push('');
    lines.push('No nodes match the reflection scope.');
    return lines.join('\n');
  }

  const byLayer = new Map<string, Node[]>();
  for (const layer of LAYER_ORDER) {
    byLayer.set(layer, []);
  }
  for (const node of selected) {
    const arr = byLayer.get(node.layer);
    if (arr) {
      arr.push(node);
    } else {
      // Unknown layer — collect anyway
      byLayer.set(node.layer, [node]);
    }
  }

  for (const [layer, nodes] of byLayer) {
    if (nodes.length === 0) continue;
    lines.push('');
    lines.push(`## ${layer.toUpperCase()} (${nodes.length} nodes)`);
    lines.push('');
    for (const node of nodes) {
      lines.push(formatNode(node, curationSignals.get(node.key)));
    }
  }

  return lines.join('\n');
}
