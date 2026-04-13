#!/usr/bin/env node
import fs from 'node:fs';
import { createStore } from '../packages/store/dist/index.js';
import { createInjector } from '../packages/injector/dist/index.js';

const args = process.argv.slice(2);
let dbPath = process.env.MEMROK_DB_PATH || '/home/michael/.memrok/memrok.db';
let tokenBudget = 1000;
let recentMessages = '';
let json = false;
let noPersist = false;
let outputPath = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--db' && args[i + 1]) dbPath = args[++i];
  else if (arg === '--budget' && args[i + 1]) tokenBudget = Number(args[++i]);
  else if (arg === '--recent' && args[i + 1]) recentMessages = args[++i];
  else if (arg === '--json') json = true;
  else if (arg === '--dry-run' || arg === '--no-persist') noPersist = true;
  else if (arg === '--out' && args[i + 1]) outputPath = args[++i];
}

const store = createStore(dbPath);
const injector = createInjector(store, { tokenBudget });
const header = injector.assemble({ recentMessages, noPersist });

function emit(text) {
  if (outputPath) {
    fs.writeFileSync(outputPath, text);
    return;
  }
  process.stdout.write(text);
}

if (json) {
  emit(`${JSON.stringify(header, null, 2)}\n`);
  store.close();
  process.exit(0);
}

const lines = [];
lines.push('## Memrok Header Inspect');
lines.push(`dbPath: ${dbPath}`);
lines.push(`tokens: ${header.tokens}`);
lines.push(`nodesUsed: ${header.nodesUsed}`);
lines.push(`layers: user=${header.layers.user}, agent=${header.layers.agent}, collaboration=${header.layers.collaboration}`);
lines.push(`noPersist: ${noPersist}`);
const highRisk = (header.debugNodes ?? []).filter((node) => node.outOfContextRisk >= 0.5);
lines.push(`highOutOfContextRisk: ${highRisk.length}`);
lines.push('');
lines.push('### Selected nodes');
for (const node of header.debugNodes ?? []) {
  lines.push(`- [${node.layer}/${node.category}] score=${node.score.toFixed(3)} raw=${node.rawScore.toFixed(3)} risk=${node.outOfContextRisk.toFixed(2)} refs=${node.referenceCount} corr=${node.correctionCount} updated=${node.updatedAt}`);
  lines.push(`  key: ${node.key}`);
  lines.push(`  family: ${node.family} domain=${node.domain ?? 'none'} domainMatch=${node.domainMatch === null ? 'n/a' : String(node.domainMatch)}`);
  lines.push(`  semantic=${node.semanticScore.toFixed(3)} queryCoverage=${node.queryCoverage.toFixed(3)} keyCoverage=${node.keyTokenCoverage}`);
  lines.push(`  hygiene: state=${node.hygieneState ?? 'none'} action=${node.hygieneAction ?? 'none'} score=${node.hygieneScore === null ? 'n/a' : node.hygieneScore.toFixed(2)}`);
  lines.push(`  because: ${(node.selectedBecause ?? []).join(', ') || 'baseline relevance'}`);
  lines.push(
    `  adjustments: query+${node.scoreAdjustments.queryCoverageBoost.toFixed(3)} key+${node.scoreAdjustments.keyMatchBoost.toFixed(3)} ` +
    `domain+${node.scoreAdjustments.domainBoost.toFixed(3)} broad-${node.scoreAdjustments.broadBioPenalty.toFixed(3)} ` +
    `meta-${node.scoreAdjustments.genericMetaPenalty.toFixed(3)} cross-${node.scoreAdjustments.crossDomainPenalty.toFixed(3)} ` +
    `hygiene-${node.scoreAdjustments.hygienePenalty.toFixed(3)} ` +
    `dup-${node.scoreAdjustments.selectionSimilarityPenalty.toFixed(3)} family-${node.scoreAdjustments.selectionFamilyPenalty.toFixed(3)} ` +
    `domainSel-${node.scoreAdjustments.selectionDomainPenalty.toFixed(3)}`
  );
  lines.push(`  value: ${node.value}`);
}
lines.push('');
lines.push('### Rendered header');
lines.push(header.text || '(empty)');

emit(`${lines.join('\n')}\n`);

store.close();
