import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DaemonConfig } from './types.js';

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, name) => {
    const val = process.env[name];
    if (val === undefined) {
      throw new Error(`Environment variable ${name} is not set`);
    }
    return val;
  });
}

function walkAndSubstitute(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return substituteEnvVars(expandHome(obj));
  }
  if (Array.isArray(obj)) {
    return obj.map(walkAndSubstitute);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = walkAndSubstitute(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(configPath?: string): DaemonConfig {
  const path = configPath ?? resolve(process.cwd(), 'memrok.config.json');
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  return walkAndSubstitute(parsed) as DaemonConfig;
}

export function resolveConfig(raw: Record<string, unknown>): DaemonConfig {
  return walkAndSubstitute(raw) as DaemonConfig;
}

export { substituteEnvVars, expandHome };
