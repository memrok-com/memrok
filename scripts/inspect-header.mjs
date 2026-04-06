#!/usr/bin/env node
import { createStore } from '../packages/store/dist/index.js';
import { createInjector } from '../packages/injector/dist/index.js';

const args = process.argv.slice(2);
let dbPath = process.env.MEMROK_DB_PATH || '/home/michael/.memrok/memrok.db';
let tokenBudget = 1000;
let recentMessages = '';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--db' && args[i + 1]) dbPath = args[++i];
  else if (arg === '--budget' && args[i + 1]) tokenBudget = Number(args[++i]);
  else if (arg === '--recent' && args[i + 1]) recentMessages = args[++i];
}

const store = createStore(dbPath);
const injector = createInjector(store, { tokenBudget });
const header = injector.assemble({ recentMessages });

console.log('## Memrok Header Inspect');
console.log(`dbPath: ${dbPath}`);
console.log(`tokens: ${header.tokens}`);
console.log(`nodesUsed: ${header.nodesUsed}`);
console.log(`layers: user=${header.layers.user}, agent=${header.layers.agent}, collaboration=${header.layers.collaboration}`);
console.log('');
console.log('### Selected nodes');
for (const node of header.debugNodes ?? []) {
  console.log(`- [${node.layer}/${node.category}] score=${node.score.toFixed(3)} refs=${node.referenceCount} corr=${node.correctionCount} updated=${node.updatedAt}`);
  console.log(`  key: ${node.key}`);
  console.log(`  value: ${node.value}`);
}
console.log('');
console.log('### Rendered header');
console.log(header.text || '(empty)');

store.close();
