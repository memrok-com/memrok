#!/usr/bin/env node
import Database from 'better-sqlite3';

const dbPath = process.env.MEMROK_DB_PATH || '/home/michael/.memrok/memrok.db';
const limit = Number(process.argv[2] || '5');
const db = new Database(dbPath, { readonly: true });

const passes = db.prepare(`
  SELECT pass_id, timestamp, source, model, mutations_count, observations
  FROM passes
  WHERE source = 'reflection'
  ORDER BY timestamp DESC
  LIMIT ?
`).all(limit);

console.log('## Recent reflection passes');
for (const pass of passes) {
  console.log(`\n- ${pass.timestamp} ${pass.pass_id} model=${pass.model ?? 'unknown'} mutations=${pass.mutations_count}`);
  const muts = db.prepare(`
    SELECT operation, layer, category, key, value
    FROM mutations
    WHERE pass_id = ?
    ORDER BY timestamp ASC
  `).all(pass.pass_id);

  const opCounts = muts.reduce((acc, m) => {
    acc[m.operation] = (acc[m.operation] || 0) + 1;
    return acc;
  }, {});
  console.log(`  operations=${JSON.stringify(opCounts)}`);

  for (const mut of muts.slice(0, 10)) {
    console.log(`  - [${mut.operation}] [${mut.layer}/${mut.category}] ${mut.key}`);
    console.log(`    ${mut.value}`);
  }
  if (muts.length > 10) console.log(`  ... ${muts.length - 10} more`);
}

db.close();
