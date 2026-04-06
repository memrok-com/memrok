#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/store/dist/index.js';
import { serializeGraphForReflection, REFLECTION_SYSTEM_PROMPT, ScribeInterface } from '../packages/scribe/dist/index.js';
import { runEmbeddedPiAgent } from '/home/michael/.npm-global/lib/node_modules/openclaw/dist/runtime-embedded-pi.runtime.js';

const openclawConfig = JSON.parse(fs.readFileSync('/home/michael/.openclaw/openclaw.json', 'utf8'));
const memrokCfg = openclawConfig.plugins?.entries?.memrok?.config || {};
const provider = memrokCfg.reflection?.provider || memrokCfg.scribeProvider;
const model = memrokCfg.reflection?.model || memrokCfg.scribeModel;
const dbPath = '/home/michael/.memrok/memrok.db';
const apply = process.argv.includes('--apply');
const tmpDir = path.join(os.homedir(), '.memrok', 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const store = createStore(dbPath);
const graphState = serializeGraphForReflection(store);
const sessionId = `manual-reflection-${Date.now()}`;
const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
const prompt = `${REFLECTION_SYSTEM_PROMPT}\n\nGRAPH_STATE:\n${graphState}\n`;

console.log('## Manual reflection trigger');
console.log(`provider=${provider}`);
console.log(`model=${model}`);
console.log(`inputBytes=${Buffer.byteLength(graphState, 'utf8')}`);

const result = await runEmbeddedPiAgent({
  sessionId,
  sessionFile,
  workspaceDir: '/home/michael/openclaw',
  config: openclawConfig,
  prompt,
  timeoutMs: 120000,
  runId: sessionId,
  provider,
  model,
  disableTools: true,
  trigger: 'manual',
});

const text = (result.payloads || []).filter((p) => !p.isError && typeof p.text === 'string').map((p) => p.text).join('\n').trim();
console.log('\n## Raw model output\n');
console.log(text || '(empty)');

const scribe = new ScribeInterface(async () => text, { systemPrompt: REFLECTION_SYSTEM_PROMPT });
const pass = scribe.parseResponse(text);
if (apply) {
  pass.pass_id = `${pass.pass_id}-manual-${Date.now()}`;
}
console.log('\n## Parsed mutations');
console.log(`count=${pass.mutations.length}`);
for (const mut of pass.mutations) {
  console.log(`- [${mut.operation}] [${mut.layer}/${mut.category}] ${mut.key}`);
  console.log(`  ${mut.value}`);
}

if (apply) {
  console.log('\n## Applying pass to store');
  const result = store.applyPass(pass);
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('\n(dry run only, pass not applied)');
}

store.close();
try { fs.unlinkSync(sessionFile); } catch {}
