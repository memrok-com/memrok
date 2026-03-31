import { createStore } from '@memrok/store';
import { createInjector } from '@memrok/injector';
import type { Store } from '@memrok/store';
import type { Injector } from '@memrok/injector';
import type { Server } from 'node:http';
import type { DaemonConfig, DaemonStatus, MemrokDaemon } from './types.js';
import { TranscriptWatcher } from './watcher.js';
import { ConsolidationEngine } from './consolidation.js';
import { ScribeInterface } from './scribe.js';
import { createApiServer } from './api.js';

export function createDaemon(config: DaemonConfig): MemrokDaemon {
  let store: Store;
  let injector: Injector;
  let watcher: TranscriptWatcher;
  let consolidation: ConsolidationEngine;
  let scribe: ScribeInterface;
  let server: Server;
  let startTime = 0;
  let lastPassTime: string | null = null;
  let running = false;

  function getStatus(): DaemonStatus {
    return {
      running,
      uptime: running ? Date.now() - startTime : 0,
      lastPass: lastPassTime,
      pendingMessages: consolidation?.getState().newMessageCount ?? 0,
      watchedFiles: watcher?.getWatchedCount() ?? 0,
    };
  }

  async function runScribePass(): Promise<void> {
    // In a full implementation, this would:
    // 1. Gather transcript data from watcher
    // 2. Call scribe.callModel() with the transcript
    // 3. Apply the resulting pass to the store
    // 4. Invalidate injector cache
    // For now, this is the integration point
    lastPassTime = new Date().toISOString();
    injector.invalidate();
  }

  async function start(): Promise<void> {
    if (running) return;

    store = createStore(config.store.path);
    injector = createInjector(store, config.injector);
    scribe = new ScribeInterface(config.scribe);
    consolidation = new ConsolidationEngine(config.consolidation);
    watcher = new TranscriptWatcher(config.watcher);

    consolidation.setTriggerCallback(runScribePass);

    watcher.on('data', (_filePath: string, content: string) => {
      // Count lines as rough message count
      const lines = content.split('\n').filter(l => l.trim()).length;
      consolidation.recordMessages(lines);
    });

    server = createApiServer(config.api, {
      store,
      injector,
      consolidation,
      getStatus,
      onNotify: (data: unknown) => {
        const d = data as { messageCount?: number };
        consolidation.recordMessages(d.messageCount ?? 1);
      },
      onTrigger: async () => {
        await consolidation.forceTrigger();
      },
    });

    watcher.start();
    consolidation.startLoop();
    startTime = Date.now();
    running = true;
  }

  async function stop(): Promise<void> {
    if (!running) return;
    running = false;

    consolidation.stopLoop();
    watcher.stop();

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    store.close();
  }

  return { start, stop, getStatus };
}
