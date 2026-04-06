import type { Node, Pass, Store } from '@memrok/store';

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

function looksLikeSnapshotNode(node: Node): boolean {
  const haystack = `${node.key} ${node.value}`.toLowerCase();
  return /\b(as of|status|node count|graph nodes|scribe passes|updated at|current state|snapshot)\b/.test(haystack);
}

function formatNode(node: Node): string {
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
  store: Store,
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
  const staleCandidates = allNodes
    .filter((node) => looksLikeSnapshotNode(node))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
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
    lines.push('## CANDIDATE STALE OR SUPERSEDED NODES');
    lines.push('Review these aggressively for expiry, replacement, or demotion if newer evidence exists.');
    lines.push('');
    for (const node of staleCandidates) {
      lines.push(formatNode(node));
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
      lines.push(formatNode(node));
    }
  }

  return lines.join('\n');
}
