import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { Store, ApplyResult } from '@memrok/store';
import { ScribeInterface } from './scribe.js';
import type { ScribeConfig } from './types.js';

export interface BootstrapOptions {
  store: Store;
  scribeConfig: ScribeConfig;
  files?: string[];
  memoryDir?: string;
}

export interface BootstrapFileResult {
  file: string;
  status: 'ok' | 'skipped' | 'error';
  mutations?: number;
  error?: string;
  applyResult?: ApplyResult;
}

export interface BootstrapResult {
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: number;
  totalMutations: number;
  results: BootstrapFileResult[];
}

/**
 * Scan a directory recursively for .md files.
 */
function scanMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(d: string): void {
    const entries = readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results.sort();
}

/**
 * Bootstrap existing memory files into the graph by running each through the scribe.
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { store, scribeConfig } = options;
  const scribe = new ScribeInterface(scribeConfig);

  // Collect all files to process
  const filePaths: string[] = [];

  if (options.memoryDir) {
    filePaths.push(...scanMarkdownFiles(options.memoryDir));
  }

  if (options.files) {
    for (const f of options.files) {
      if (!filePaths.includes(f)) {
        filePaths.push(f);
      }
    }
  }

  const result: BootstrapResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    totalMutations: 0,
    results: [],
  };

  // Process files one at a time
  for (const filePath of filePaths) {
    const fileName = basename(filePath);

    // Read file content
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bootstrap] Failed to read ${filePath}: ${msg}`);
      result.filesFailed++;
      result.results.push({ file: filePath, status: 'error', error: msg });
      continue;
    }

    // Skip empty files
    if (!content.trim()) {
      result.filesSkipped++;
      result.results.push({ file: filePath, status: 'skipped' });
      continue;
    }

    // Run through scribe
    try {
      const pass = await scribe.callModel(content);

      // Tag the pass source for provenance
      pass.source = `bootstrap:${fileName}`;

      // Apply mutations to store
      const applyResult = store.applyPass(pass);

      result.filesProcessed++;
      result.totalMutations += pass.mutations.length;
      result.results.push({
        file: filePath,
        status: 'ok',
        mutations: pass.mutations.length,
        applyResult,
      });

      console.log(
        `[bootstrap] ${fileName}: ${pass.mutations.length} mutations extracted`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bootstrap] Failed to process ${filePath}: ${msg}`);
      result.filesFailed++;
      result.results.push({ file: filePath, status: 'error', error: msg });
    }
  }

  return result;
}
