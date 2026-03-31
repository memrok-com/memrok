import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import type {
  Store,
  ScribePass,
  ApplyResult,
  Node,
  Mutation,
  Pass,
  NodeFilter,
  MutationInput,
} from './types.js';

export function createStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);

  // Prepared statements
  const insertMutation = db.prepare(`
    INSERT INTO mutations (pass_id, operation, layer, category, key, value, evidence, source, emotional_weight, explicit, correction)
    VALUES (@pass_id, @operation, @layer, @category, @key, @value, @evidence, @source, @emotional_weight, @explicit, @correction)
  `);

  const insertPass = db.prepare(`
    INSERT INTO passes (pass_id, source, model, turns_processed, mutations_count, observations, duration_ms)
    VALUES (@pass_id, @source, @model, @turns_processed, @mutations_count, @observations, @duration_ms)
  `);

  const getNodeByKey = db.prepare('SELECT * FROM nodes WHERE key = ?');

  const insertNode = db.prepare(`
    INSERT INTO nodes (key, layer, category, value, evidence, created_at, updated_at, version, emotional_weight, reference_count, correction_count, last_referenced, first_pass_id, last_pass_id)
    VALUES (@key, @layer, @category, @value, @evidence, @created_at, @updated_at, @version, @emotional_weight, @reference_count, @correction_count, @last_referenced, @first_pass_id, @last_pass_id)
  `);

  const updateNode = db.prepare(`
    UPDATE nodes SET
      value = @value,
      evidence = @evidence,
      updated_at = @updated_at,
      version = version + 1,
      emotional_weight = @emotional_weight,
      reference_count = reference_count + 1,
      correction_count = correction_count + @correction_add,
      last_referenced = @last_referenced,
      last_pass_id = @last_pass_id
    WHERE key = @key
  `);

  const expireNode = db.prepare(`
    UPDATE nodes SET
      expired_at = @expired_at,
      updated_at = @updated_at,
      version = version + 1,
      last_pass_id = @last_pass_id
    WHERE key = @key
  `);

  const getMutationsByKey = db.prepare(
    'SELECT * FROM mutations WHERE key = ? ORDER BY id ASC'
  );

  const getAllPasses = db.prepare(
    'SELECT * FROM passes ORDER BY timestamp ASC'
  );

  const getAllMutationsOrdered = db.prepare(
    'SELECT * FROM mutations ORDER BY id ASC'
  );

  function now(): string {
    return new Date().toISOString();
  }

  function applyMutationToNode(
    mut: MutationInput,
    passId: string,
    timestamp: string
  ): 'created' | 'updated' | 'expired' | 'noop' {
    const existing = getNodeByKey.get(mut.key) as Node | undefined;
    const emotionalWeight = mut.signals?.emotional_weight ?? 0.0;
    const isCorrection = mut.signals?.correction ?? false;

    if (mut.operation === 'add') {
      if (existing) {
        // Treat as update if node already exists
        updateNode.run({
          key: mut.key,
          value: mut.value,
          evidence: mut.evidence ?? null,
          updated_at: timestamp,
          emotional_weight: emotionalWeight,
          correction_add: isCorrection ? 1 : 0,
          last_referenced: timestamp,
          last_pass_id: passId,
        });
        return 'updated';
      }
      insertNode.run({
        key: mut.key,
        layer: mut.layer,
        category: mut.category,
        value: mut.value,
        evidence: mut.evidence ?? null,
        created_at: timestamp,
        updated_at: timestamp,
        version: 1,
        emotional_weight: emotionalWeight,
        reference_count: 1,
        correction_count: isCorrection ? 1 : 0,
        last_referenced: timestamp,
        first_pass_id: passId,
        last_pass_id: passId,
      });
      return 'created';
    }

    if (mut.operation === 'update') {
      if (!existing) {
        // Create if doesn't exist
        insertNode.run({
          key: mut.key,
          layer: mut.layer,
          category: mut.category,
          value: mut.value,
          evidence: mut.evidence ?? null,
          created_at: timestamp,
          updated_at: timestamp,
          version: 1,
          emotional_weight: emotionalWeight,
          reference_count: 1,
          correction_count: isCorrection ? 1 : 0,
          last_referenced: timestamp,
          first_pass_id: passId,
          last_pass_id: passId,
        });
        return 'created';
      }
      updateNode.run({
        key: mut.key,
        value: mut.value,
        evidence: mut.evidence ?? null,
        updated_at: timestamp,
        emotional_weight: emotionalWeight,
        correction_add: isCorrection ? 1 : 0,
        last_referenced: timestamp,
        last_pass_id: passId,
      });
      return 'updated';
    }

    if (mut.operation === 'expire') {
      if (!existing) return 'noop';
      expireNode.run({
        key: mut.key,
        expired_at: timestamp,
        updated_at: timestamp,
        last_pass_id: passId,
      });
      return 'expired';
    }

    return 'noop';
  }

  const applyPassTx = db.transaction((pass: ScribePass): ApplyResult => {
    const timestamp = now();
    let nodesCreated = 0;
    let nodesUpdated = 0;
    let nodesExpired = 0;

    // Record the pass
    insertPass.run({
      pass_id: pass.pass_id,
      source: pass.source ?? null,
      model: pass.model ?? null,
      turns_processed: pass.meta?.turns_processed ?? null,
      mutations_count: pass.mutations.length,
      observations: pass.meta?.observations ?? null,
      duration_ms: pass.meta?.duration_ms ?? null,
    });

    // Apply each mutation
    for (const mut of pass.mutations) {
      insertMutation.run({
        pass_id: pass.pass_id,
        operation: mut.operation,
        layer: mut.layer,
        category: mut.category,
        key: mut.key,
        value: mut.value,
        evidence: mut.evidence ?? null,
        source: pass.source ?? null,
        emotional_weight: mut.signals?.emotional_weight ?? 0.0,
        explicit: mut.signals?.explicit === true ? 1 : 0,
        correction: mut.signals?.correction ? 1 : 0,
      });

      const result = applyMutationToNode(mut, pass.pass_id, timestamp);
      if (result === 'created') nodesCreated++;
      else if (result === 'updated') nodesUpdated++;
      else if (result === 'expired') nodesExpired++;
    }

    return {
      pass_id: pass.pass_id,
      mutations_applied: pass.mutations.length,
      nodes_created: nodesCreated,
      nodes_updated: nodesUpdated,
      nodes_expired: nodesExpired,
    };
  });

  function queryNodes(filter?: NodeFilter): Node[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    const active = filter?.active ?? true;
    if (active) {
      conditions.push('expired_at IS NULL');
    } else {
      conditions.push('expired_at IS NOT NULL');
    }

    if (filter?.layer) {
      conditions.push('layer = @layer');
      params.layer = filter.layer;
    }
    if (filter?.category) {
      conditions.push('category = @category');
      params.category = filter.category;
    }
    if (filter?.keyPrefix) {
      conditions.push('key LIKE @keyPrefix');
      params.keyPrefix = filter.keyPrefix + '%';
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM nodes ${where} ORDER BY key`).all(params) as Node[];
  }

  function rebuild(): void {
    const rebuildTx = db.transaction(() => {
      db.exec('DELETE FROM nodes');
      const mutations = getAllMutationsOrdered.all() as Mutation[];
      for (const mut of mutations) {
        applyMutationToNode(
          {
            operation: mut.operation as MutationInput['operation'],
            layer: mut.layer as MutationInput['layer'],
            category: mut.category,
            key: mut.key,
            value: mut.value,
            evidence: mut.evidence ?? undefined,
            signals: {
              emotional_weight: mut.emotional_weight,
              explicit: !!mut.explicit,
              correction: !!mut.correction,
            },
          },
          mut.pass_id,
          mut.timestamp
        );
      }
    });
    rebuildTx();
  }

  return {
    applyPass: (pass: ScribePass) => applyPassTx(pass),
    queryNodes,
    getNode: (key: string) => (getNodeByKey.get(key) as Node) ?? null,
    getHistory: (key: string) => getMutationsByKey.all(key) as Mutation[],
    listPasses: () => getAllPasses.all() as Pass[],
    rebuild,
    close: () => db.close(),
  };
}
