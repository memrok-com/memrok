#!/usr/bin/env node
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
let dbPath = process.env.MEMROK_DB_PATH || '/home/michael/.memrok/memrok.db';
let limit = 10;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--db' && args[i + 1]) dbPath = args[++i];
  else if (arg === '--limit' && args[i + 1]) limit = Number(args[++i]);
}

const db = new Database(dbPath, { readonly: true });

const counts = db.prepare(`
  SELECT
    SUM(CASE WHEN expired_at IS NULL THEN 1 ELSE 0 END) AS active_count,
    SUM(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END) AS expired_count
  FROM nodes
`).get();

const byLayer = db.prepare(`
  SELECT
    layer,
    SUM(CASE WHEN expired_at IS NULL THEN 1 ELSE 0 END) AS active_count,
    SUM(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END) AS expired_count
  FROM nodes
  GROUP BY layer
  ORDER BY layer ASC
`).all();

const byCategory = db.prepare(`
  SELECT
    category,
    SUM(CASE WHEN expired_at IS NULL THEN 1 ELSE 0 END) AS active_count,
    SUM(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END) AS expired_count
  FROM nodes
  GROUP BY category
  ORDER BY active_count DESC, expired_count DESC, category ASC
  LIMIT ?
`).all(limit);

const recentExpired = db.prepare(`
  SELECT key, layer, category, updated_at, expired_at, value
  FROM nodes
  WHERE expired_at IS NOT NULL
  ORDER BY expired_at DESC
  LIMIT ?
`).all(limit);

const reflectionLifecycle = db.prepare(`
  SELECT
    passes.pass_id,
    passes.timestamp,
    SUM(CASE WHEN mutations.operation = 'expire' THEN 1 ELSE 0 END) AS expired_nodes,
    SUM(CASE WHEN mutations.operation = 'update' THEN 1 ELSE 0 END) AS updated_nodes,
    SUM(CASE WHEN mutations.operation = 'add' THEN 1 ELSE 0 END) AS added_nodes
  FROM passes
  LEFT JOIN mutations ON mutations.pass_id = passes.pass_id
  WHERE passes.source = 'reflection'
  GROUP BY passes.pass_id, passes.timestamp
  ORDER BY passes.timestamp DESC
  LIMIT ?
`).all(limit);

console.log('## Memrok Lifecycle Inspect');
console.log(`dbPath: ${dbPath}`);
console.log(`active=${counts.active_count ?? 0} expired=${counts.expired_count ?? 0}`);

console.log('\n### By layer');
for (const row of byLayer) {
  console.log(`- ${row.layer}: active=${row.active_count} expired=${row.expired_count}`);
}

console.log('\n### Top categories');
for (const row of byCategory) {
  console.log(`- ${row.category}: active=${row.active_count} expired=${row.expired_count}`);
}

console.log('\n### Recent expired nodes');
for (const row of recentExpired) {
  console.log(`- [${row.layer}/${row.category}] expired=${row.expired_at} updated=${row.updated_at} key=${row.key}`);
  console.log(`  ${row.value}`);
}

console.log('\n### Reflection lifecycle');
for (const row of reflectionLifecycle) {
  console.log(`- ${row.timestamp} ${row.pass_id}: add=${row.added_nodes} update=${row.updated_nodes} expire=${row.expired_nodes}`);
}

db.close();
