#!/usr/bin/env node
import { createStore } from '../packages/store/dist/index.js';

const args = process.argv.slice(2);
let dbPath = process.env.MEMROK_DB_PATH || '/home/michael/.memrok/memrok.db';
let limit = 20;
let json = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--db' && args[i + 1]) dbPath = args[++i];
  else if (arg === '--limit' && args[i + 1]) limit = Number(args[++i]);
  else if (arg === '--json') json = true;
}

const store = createStore(dbPath);
const events = store.listInjectionEvalEvents(limit);

if (json) {
  console.log(JSON.stringify({ dbPath, events }, null, 2));
  store.close();
  process.exit(0);
}

console.log('## Memrok Injection Eval Events');
console.log(`dbPath: ${dbPath}`);
console.log(`events: ${events.length}`);

for (const event of events) {
  console.log(`\n- #${event.id} kind=${event.event_kind} session=${event.session_id ?? 'none'} created=${event.created_at}`);
  console.log(`  queryChars=${event.query_chars} queryHash=${event.query_hash ?? 'none'} nodesUsed=${event.nodes_used} headerTokens=${event.header_tokens}`);
  console.log(`  queryExcerpt: ${event.query_excerpt ?? '(none)'}`);
  console.log(`  selected: ${event.selected_nodes.map((node) => node.key).join(', ') || '(none)'}`);
  console.log(`  rejectedAvailable: ${Boolean(event.metadata?.topRejectedCandidatesAvailable)}`);
}

store.close();
