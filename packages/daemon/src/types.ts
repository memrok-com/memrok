export interface WatcherConfig {
  paths: string[];
  debounceMs?: number;
}

export interface ConsolidationConfig {
  deltaThreshold?: number;
  idleMinutes?: number;
  maxInterval?: number;
}

export interface ScribeConfig {
  provider: 'anthropic' | 'openai' | 'ollama' | 'custom';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  systemPromptPath?: string;
}

export interface ApiConfig {
  port?: number;
  host?: string;
}

export interface StoreConfig {
  path: string;
}

export interface DaemonConfig {
  store: StoreConfig;
  watcher: WatcherConfig;
  consolidation?: ConsolidationConfig;
  scribe: ScribeConfig;
  injector?: { tokenBudget?: number };
  api?: ApiConfig;
}

import type { MemrokActivityStatus } from './status.js';

export interface DaemonStatus {
  running: boolean;
  uptime: number;
  lastPass: string | null;
  pendingMessages: number;
  watchedFiles: number;
  activity?: MemrokActivityStatus;
}

export interface MemrokDaemon {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): DaemonStatus;
}

export interface CursorState {
  [filePath: string]: number; // byte offset
}
