import { watch, type FSWatcher } from 'chokidar';
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { WatcherConfig, CursorState } from './types.js';

const DEFAULT_DEBOUNCE_MS = 5000;

export interface WatcherEvents {
  data: [filePath: string, newContent: string];
}

export class TranscriptWatcher extends EventEmitter {
  private config: WatcherConfig;
  private cursors: CursorState = {};
  private cursorPath: string;
  private fsWatcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;

  constructor(config: WatcherConfig, cursorPath?: string) {
    super();
    this.config = config;
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.cursorPath = cursorPath ?? resolve(process.cwd(), '.memrok-cursors.json');
    this.loadCursors();
  }

  private loadCursors(): void {
    try {
      const data = readFileSync(this.cursorPath, 'utf-8');
      this.cursors = JSON.parse(data);
    } catch {
      this.cursors = {};
    }
  }

  saveCursors(): void {
    writeFileSync(this.cursorPath, JSON.stringify(this.cursors, null, 2));
  }

  getCursors(): CursorState {
    return { ...this.cursors };
  }

  readNewContent(filePath: string): string | null {
    const offset = this.cursors[filePath] ?? 0;
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return null;
    }

    if (size <= offset) return null;

    const fd = openSync(filePath, 'r');
    try {
      const length = size - offset;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, offset);
      this.cursors[filePath] = size;
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  }

  start(): void {
    if (this.fsWatcher) return;

    this.fsWatcher = watch(this.config.paths, {
      ignoreInitial: false,
      persistent: true,
      depth: 2,
    });

    const handleChange = (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return;

      const existing = this.debounceTimers.get(filePath);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(filePath, setTimeout(() => {
        this.debounceTimers.delete(filePath);
        const content = this.readNewContent(filePath);
        if (content) {
          this.emit('data', filePath, content);
          this.saveCursors();
        }
      }, this.debounceMs));
    };

    this.fsWatcher.on('add', handleChange);
    this.fsWatcher.on('change', handleChange);
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    this.saveCursors();
  }

  getWatchedCount(): number {
    if (!this.fsWatcher) return 0;
    const watched = this.fsWatcher.getWatched();
    let count = 0;
    for (const files of Object.values(watched)) {
      count += files.filter(f => f.endsWith('.jsonl')).length;
    }
    return count;
  }
}
