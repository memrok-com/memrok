import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface MemrokActivityStatus {
  nodeCount: number;
  lastTranscriptScribeAt: string | null;
  lastReflectiveScribeAt: string | null;
  lastInjectionAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  lastErrorStage: string | null;
  lastSourceProcessed: string | null;
  updatedAt: string | null;
}

const DEFAULT_STATUS: MemrokActivityStatus = {
  nodeCount: 0,
  lastTranscriptScribeAt: null,
  lastReflectiveScribeAt: null,
  lastInjectionAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  lastErrorStage: null,
  lastSourceProcessed: null,
  updatedAt: null,
};

export function getStatusFilePath(dbPath: string): string {
  return join(dirname(dbPath), 'memrok.status.json');
}

export class StatusTracker {
  private readonly path: string;
  private status: MemrokActivityStatus;
  private lastInjectionWriteMs = 0;
  private readonly injectionWriteIntervalMs = 30_000;

  constructor(dbPath: string) {
    this.path = getStatusFilePath(dbPath);
    this.status = this.load();
  }

  getPath(): string {
    return this.path;
  }

  getStatus(): MemrokActivityStatus {
    return { ...this.status };
  }

  setNodeCount(nodeCount: number): void {
    this.write({ nodeCount });
  }

  recordTranscriptScribe(source?: string | null): void {
    this.write({
      lastTranscriptScribeAt: new Date().toISOString(),
      lastSourceProcessed: source ?? this.status.lastSourceProcessed,
    });
  }

  recordReflectiveScribe(): void {
    this.write({ lastReflectiveScribeAt: new Date().toISOString() });
  }

  recordInjection(): void {
    const now = Date.now();
    if (now - this.lastInjectionWriteMs < this.injectionWriteIntervalMs) return;
    this.lastInjectionWriteMs = now;
    this.write({ lastInjectionAt: new Date(now).toISOString() });
  }

  recordError(stage: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.write({
      lastErrorAt: new Date().toISOString(),
      lastErrorStage: stage,
      lastErrorMessage: message,
    });
  }

  private load(): MemrokActivityStatus {
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<MemrokActivityStatus>;
      return { ...DEFAULT_STATUS, ...parsed };
    } catch {
      return { ...DEFAULT_STATUS };
    }
  }

  private write(partial: Partial<MemrokActivityStatus>): void {
    this.status = {
      ...this.status,
      ...partial,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.status, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, this.path);
  }
}
