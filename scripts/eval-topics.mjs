#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../packages/store/dist/index.js';
import { createInjector } from '../packages/injector/dist/index.js';

const sessionsDir = '/home/michael/.openclaw/agents/main/sessions';
const dbPath = '/home/michael/.memrok/memrok.db';
const tokenBudget = 1000;
const topicArgs = process.argv.slice(2);
const topics = topicArgs.length ? topicArgs : ['540', '12', '10', '1'];

function latestSessionForTopic(topicId) {
  const files = fs.readdirSync(sessionsDir)
    .filter((f) => f.endsWith(`topic-${topicId}.jsonl`))
    .map((f) => {
      const full = path.join(sessionsDir, f);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.full;
}

function extractRecentMessages(filePath, limit = 12) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  const texts = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.type !== 'message') continue;
      const msg = row.message;
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const content = Array.isArray(msg.content)
        ? msg.content.map((p) => p?.text || '').join('\n')
        : typeof msg.content === 'string' ? msg.content : '';
      if (content.trim()) texts.push(`${msg.role}: ${content.trim()}`);
    } catch {}
  }
  return texts.slice(-limit).join('\n');
}

const store = createStore(dbPath);
const injector = createInjector(store, { tokenBudget });

for (const topic of topics) {
  const sessionFile = latestSessionForTopic(topic);
  if (!sessionFile) {
    console.log(`\n## Topic ${topic}\nNo session file found.`);
    continue;
  }
  const recentMessages = extractRecentMessages(sessionFile);
  const header = injector.assemble({ recentMessages });
  const categories = {};
  for (const node of header.debugNodes ?? []) {
    categories[node.category] = (categories[node.category] || 0) + 1;
  }
  console.log(`\n## Topic ${topic}`);
  console.log(`session: ${path.basename(sessionFile)}`);
  console.log(`tokens=${header.tokens} nodesUsed=${header.nodesUsed}`);
  console.log(`categories=${JSON.stringify(categories)}`);
  console.log('top nodes:');
  for (const node of (header.debugNodes ?? []).slice(0, 8)) {
    console.log(`- [${node.layer}/${node.category}] score=${node.score.toFixed(3)} key=${node.key}`);
    console.log(`  ${node.value}`);
  }
}

store.close();
