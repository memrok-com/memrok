#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createDaemon } from './daemon.js';
import { createStore } from '@memrok/store';
import { bootstrap } from './bootstrap.js';

const subcommand = process.argv[2];

if (subcommand === 'bootstrap') {
  // Parse bootstrap-specific args (skip argv[0], argv[1], argv[2])
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      config: { type: 'string', short: 'c' },
      'memory-dir': { type: 'string' },
      file: { type: 'string', multiple: true },
    },
    strict: true,
  });

  if (!values['memory-dir'] && !values.file?.length) {
    console.error('Usage: memrok-daemon bootstrap --memory-dir <path> [--file <path>...]');
    process.exit(1);
  }

  const config = loadConfig(values.config);
  const store = createStore(config.store.path);

  try {
    const result = await bootstrap({
      store,
      scribeConfig: config.scribe,
      memoryDir: values['memory-dir'],
      files: values.file,
    });

    console.log(`[bootstrap] Complete: ${result.filesProcessed} processed, ${result.filesSkipped} skipped, ${result.filesFailed} failed, ${result.totalMutations} total mutations`);
  } finally {
    store.close();
  }
} else {
  // Default: start daemon
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
}
