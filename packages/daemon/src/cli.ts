#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createDaemon } from './daemon.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
  },
  strict: true,
});

const config = loadConfig(values.config);
const daemon = createDaemon(config);

async function shutdown() {
  console.log('[memrok] Shutting down...');
  await daemon.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await daemon.start();
console.log('[memrok] Daemon started.');
