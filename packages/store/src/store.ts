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
  ArchiveObservation,
  CreateArchiveObservationInput,
  DerivedArtifact,
  CreateDerivedArtifactInput,
  CreateWorkingSetSnapshotInput,
  WorkingSetRetentionPolicy,
  WorkingSetSnapshot,
  WorkingSetSnapshotItem,
  WorkingSetSnapshotTrace,
  ProvenanceLink,
} from './types.js';

export function createStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);

  function parseJson<T>(value: string | null): T | null {
    if (!value) return null;
    return JSON.parse(value) as T;
  }

  function serializeJson(value: Record<string, unknown> | undefined): string | null {
    return value === undefined ? null : JSON.stringify(value);
  }

  function mapArchiveObservation(row: Record<string, unknown> | undefined): ArchiveObservation | null {
    if (!row) return null;
    return {
      id: row.id as number,
      kind: row.kind as string,
      source: row.source as string,
      session_id: (row.session_id as string | null) ?? null,
      content: row.content as string,
      metadata: parseJson<Record<string, unknown>>((row.metadata as string | null) ?? null),
      created_at: row.created_at as string,
    };
  }

  function mapDerivedArtifact(row: Record<string, unknown> | undefined): DerivedArtifact | null {
    if (!row) return null;
    return {
      id: row.id as number,
      kind: row.kind as string,
      observation_id: (row.observation_id as number | null) ?? null,
      content: row.content as string,
      metadata: parseJson<Record<string, unknown>>((row.metadata as string | null) ?? null),
      created_at: row.created_at as string,
    };
  }

  function mapWorkingSetSnapshot(row: Record<string, unknown> | undefined): WorkingSetSnapshot | null {
    if (!row) return null;
    return {
      id: row.id as number,
      session_id: (row.session_id as string | null) ?? null,
      query: (row.query as string | null) ?? null,
      header_text: row.header_text as string,
      header_tokens: row.header_tokens as number,
      nodes_used: row.nodes_used as number,
      created_at: row.created_at as string,
    };
  }

  function mapWorkingSetSnapshotItem(row: Record<string, unknown>): WorkingSetSnapshotItem {
    return {
      id: row.id as number,
      snapshot_id: row.snapshot_id as number,
      node_key: row.node_key as string,
      pass_id: (row.pass_id as string | null) ?? null,
      mutation_id: (row.mutation_id as number | null) ?? null,
      layer: row.layer as WorkingSetSnapshotItem['layer'],
      category: row.category as string,
      value: row.value as string,
      score: row.score as number,
      raw_score: row.raw_score as number,
      reason: (row.reason as string | null) ?? null,
    };
  }

  // Prepared statements
  const insertArchiveObservation = db.prepare(`
    INSERT INTO archive_observations (kind, source, session_id, content, metadata)
    VALUES (@kind, @source, @session_id, @content, @metadata)
  `);

  const getArchiveObservationById = db.prepare(
    'SELECT * FROM archive_observations WHERE id = ?'
  );

  const listArchiveObservationRows = db.prepare(
    'SELECT * FROM archive_observations ORDER BY id DESC LIMIT ?'
  );

  const insertDerivedArtifact = db.prepare(`
    INSERT INTO derived_artifacts (kind, observation_id, content, metadata)
    VALUES (@kind, @observation_id, @content, @metadata)
  `);

  const getDerivedArtifactById = db.prepare(
    'SELECT * FROM derived_artifacts WHERE id = ?'
  );

  const listDerivedArtifactRows = db.prepare(
    'SELECT * FROM derived_artifacts ORDER BY id DESC LIMIT ?'
  );

  const insertMutation = db.prepare(`
    INSERT INTO mutations (pass_id, operation, layer, category, key, value, evidence, source, emotional_weight, explicit, correction)
    VALUES (@pass_id, @operation, @layer, @category, @key, @value, @evidence, @source, @emotional_weight, @explicit, @correction)
  `);

  const insertPass = db.prepare(`
    INSERT INTO passes (pass_id, source, model, derived_artifact_id, turns_processed, mutations_count, observations, duration_ms)
    VALUES (@pass_id, @source, @model, @derived_artifact_id, @turns_processed, @mutations_count, @observations, @duration_ms)
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

  const getLatestMutationByKeyAndPass = db.prepare(
    'SELECT * FROM mutations WHERE key = ? AND pass_id = ? ORDER BY id DESC LIMIT 1'
  );

  const getMutationById = db.prepare(
    'SELECT * FROM mutations WHERE id = ?'
  );

  const getAllPasses = db.prepare(
    'SELECT * FROM passes ORDER BY timestamp ASC'
  );

  const getPassById = db.prepare(
    'SELECT * FROM passes WHERE pass_id = ?'
  );

  const getAllMutationsOrdered = db.prepare(
    'SELECT * FROM mutations ORDER BY id ASC'
  );

  const insertWorkingSetSnapshot = db.prepare(`
    INSERT INTO working_set_snapshots (session_id, query, header_text, header_tokens, nodes_used)
    VALUES (@session_id, @query, @header_text, @header_tokens, @nodes_used)
  `);

  const insertWorkingSetSnapshotItem = db.prepare(`
    INSERT INTO working_set_snapshot_items
      (snapshot_id, node_key, pass_id, mutation_id, layer, category, value, score, raw_score, reason)
    VALUES
      (@snapshot_id, @node_key, @pass_id, @mutation_id, @layer, @category, @value, @score, @raw_score, @reason)
  `);

  const getWorkingSetSnapshotById = db.prepare(
    'SELECT * FROM working_set_snapshots WHERE id = ?'
  );

  const getWorkingSetSnapshotItemsById = db.prepare(
    'SELECT * FROM working_set_snapshot_items WHERE snapshot_id = ? ORDER BY id ASC'
  );

  const listWorkingSetSnapshotRows = db.prepare(
    'SELECT * FROM working_set_snapshots ORDER BY id DESC LIMIT ?'
  );

  const deleteWorkingSetSnapshotById = db.prepare(
    'DELETE FROM working_set_snapshots WHERE id = ?'
  );

  const listWorkingSetSnapshotIdsForRetention = db.prepare(
    'SELECT id FROM working_set_snapshots ORDER BY id DESC LIMIT -1 OFFSET ?'
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
      derived_artifact_id: pass.derived_artifact_id ?? null,
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

  const createWorkingSetSnapshotTx = db.transaction((
    input: CreateWorkingSetSnapshotInput,
    retention?: WorkingSetRetentionPolicy,
  ): WorkingSetSnapshotTrace => {
    const result = insertWorkingSetSnapshot.run({
      session_id: input.sessionId ?? null,
      query: input.query ?? null,
      header_text: input.headerText,
      header_tokens: input.headerTokens,
      nodes_used: input.nodesUsed,
    });

    const snapshotId = Number(result.lastInsertRowid);
    for (const item of input.items) {
      insertWorkingSetSnapshotItem.run({
        snapshot_id: snapshotId,
        node_key: item.nodeKey,
        pass_id: item.passId ?? null,
        mutation_id: item.mutationId ?? null,
        layer: item.layer,
        category: item.category,
        value: item.value,
        score: item.score,
        raw_score: item.rawScore,
        reason: item.reason ?? null,
      });
    }

    if (retention && retention.maxSnapshots >= 0) {
      const rows = listWorkingSetSnapshotIdsForRetention.all(retention.maxSnapshots) as Array<{ id: number }>;
      for (const row of rows) {
        deleteWorkingSetSnapshotById.run(row.id);
      }
    }

    const snapshot = mapWorkingSetSnapshot(getWorkingSetSnapshotById.get(snapshotId) as Record<string, unknown>)!;
    const items = getWorkingSetSnapshotItemsById
      .all(snapshotId)
      .map((row) => mapWorkingSetSnapshotItem(row as Record<string, unknown>));
    return { ...snapshot, items };
  });

  function getProvenanceForPass(passId: string): ProvenanceLink {
    const pass = (getPassById.get(passId) as Pass | undefined) ?? null;
    if (!pass) {
      return { observation: null, artifact: null, pass: null };
    }

    const artifact = pass.derived_artifact_id
      ? mapDerivedArtifact(getDerivedArtifactById.get(pass.derived_artifact_id) as Record<string, unknown>)
      : null;
    const observation = artifact?.observation_id
      ? mapArchiveObservation(getArchiveObservationById.get(artifact.observation_id) as Record<string, unknown>)
      : null;

    return { observation, artifact, pass };
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
    createArchiveObservation: (input: CreateArchiveObservationInput) => {
      const result = insertArchiveObservation.run({
        kind: input.kind,
        source: input.source,
        session_id: input.sessionId ?? null,
        content: input.content,
        metadata: serializeJson(input.metadata),
      });
      return mapArchiveObservation(
        getArchiveObservationById.get(Number(result.lastInsertRowid)) as Record<string, unknown>
      )!;
    },
    listArchiveObservations: (limit = 100) =>
      listArchiveObservationRows
        .all(limit)
        .map((row) => mapArchiveObservation(row as Record<string, unknown>)!)
        .filter(Boolean),
    getArchiveObservation: (id: number) =>
      mapArchiveObservation(getArchiveObservationById.get(id) as Record<string, unknown>),
    createDerivedArtifact: (input: CreateDerivedArtifactInput) => {
      const result = insertDerivedArtifact.run({
        kind: input.kind,
        observation_id: input.observationId ?? null,
        content: input.content,
        metadata: serializeJson(input.metadata),
      });
      return mapDerivedArtifact(
        getDerivedArtifactById.get(Number(result.lastInsertRowid)) as Record<string, unknown>
      )!;
    },
    listDerivedArtifacts: (limit = 100) =>
      listDerivedArtifactRows
        .all(limit)
        .map((row) => mapDerivedArtifact(row as Record<string, unknown>)!)
        .filter(Boolean),
    getDerivedArtifact: (id: number) =>
      mapDerivedArtifact(getDerivedArtifactById.get(id) as Record<string, unknown>),
    applyPass: (pass: ScribePass) => applyPassTx(pass),
    queryNodes,
    getNode: (key: string) => (getNodeByKey.get(key) as Node) ?? null,
    getHistory: (key: string) => getMutationsByKey.all(key) as Mutation[],
    listPasses: () => getAllPasses.all() as Pass[],
    createWorkingSetSnapshot: (
      input: CreateWorkingSetSnapshotInput,
      retention?: WorkingSetRetentionPolicy,
    ) => createWorkingSetSnapshotTx(input, retention),
    listWorkingSetSnapshots: (limit = 50) =>
      listWorkingSetSnapshotRows
        .all(limit)
        .map((row) => mapWorkingSetSnapshot(row as Record<string, unknown>)!)
        .filter(Boolean),
    getWorkingSetSnapshot: (id: number) => {
      const snapshot = mapWorkingSetSnapshot(getWorkingSetSnapshotById.get(id) as Record<string, unknown>);
      if (!snapshot) return null;
      const items = getWorkingSetSnapshotItemsById
        .all(id)
        .map((row) => mapWorkingSetSnapshotItem(row as Record<string, unknown>));
      return { ...snapshot, items };
    },
    getProvenanceForPass,
    getProvenanceForWorkingSetSnapshot: (snapshotId: number) => {
      const items = getWorkingSetSnapshotItemsById.all(snapshotId) as Array<Record<string, unknown>>;
      const seenMutations = new Set<number>();
      const seenPasses = new Set<string>();
      const links: ProvenanceLink[] = [];
      for (const item of items) {
        const mutationId = (item.mutation_id as number | null) ?? null;
        if (mutationId !== null && seenMutations.has(mutationId)) continue;
        const mutation = mutationId !== null
          ? (getMutationById.get(mutationId) as Mutation | undefined)
          : undefined;
        const passId = mutation?.pass_id ?? ((item.pass_id as string | null) ?? null);
        if (!passId || seenPasses.has(passId)) continue;
        if (mutationId !== null) seenMutations.add(mutationId);
        seenPasses.add(passId);
        links.push(getProvenanceForPass(passId));
      }
      return links;
    },
    rebuild,
    close: () => db.close(),
  };
}
