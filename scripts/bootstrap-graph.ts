#!/usr/bin/env node
/**
 * Bootstrap the Memrok graph from existing memory files.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx npx tsx scripts/bootstrap-graph.ts
 *
 * Reads ~/openclaw/MEMORY.md and ~/openclaw/memory/*.md, runs each through
 * the scribe, and applies mutations to ~/.memrok/memrok.db.
 *
 * Idempotent: skips files whose bootstrap:<filename> pass already exists.
 * Skips files older than 60 days.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createStore } from '@memrok/store';
import { ScribeInterface, SCRIBE_SYSTEM_PROMPT } from '@memrok/scribe';
import type { ModelCaller } from '@memrok/scribe';
import type { ApplyResult } from '@memrok/store';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_PATH = resolve(homedir(), '.memrok', 'memrok.db');
const MEMORY_DIR = resolve(homedir(), 'openclaw', 'memory');
const MEMORY_INDEX = resolve(homedir(), 'openclaw', 'MEMORY.md');
const MODEL = 'claude-sonnet-4-20250514';
const MAX_AGE_DAYS = 60;
const RATE_LIMIT_MS = 15000;

// ---------------------------------------------------------------------------
// Anthropic model caller
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

function createAnthropicModelCaller(apiKey: string): ModelCaller {
  return async (systemPrompt: string, userMessage: string): Promise<string> => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText} — ${body}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content.find((block) => block.type === 'text');
    if (!textBlock?.text) throw new Error('No text in Anthropic response');
    return textBlock.text;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOlderThanDays(filePath: string, days: number): boolean {
  const stat = statSync(filePath);
  const ageMs = Date.now() - stat.mtimeMs;
  return ageMs > days * 24 * 60 * 60 * 1000;
}

function collectFiles(): string[] {
  const files: string[] = [];

  // MEMORY.md index
  try {
    statSync(MEMORY_INDEX);
    files.push(MEMORY_INDEX);
  } catch {
    console.warn(`[bootstrap] MEMORY.md not found at ${MEMORY_INDEX}, skipping`);
  }

  // memory/*.md
  try {
    const entries = readdirSync(MEMORY_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(join(MEMORY_DIR, entry.name));
      }
    }
  } catch {
    console.warn(`[bootstrap] Memory dir not found at ${MEMORY_DIR}, skipping`);
  }

  return files.sort();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface FileResult {
  file: string;
  status: 'ok' | 'skipped' | 'error' | 'already-done';
  mutations?: number;
  error?: string;
  applyResult?: ApplyResult;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  // Open store
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const store = createStore(DB_PATH);
  console.log(`[bootstrap] Opened store at ${DB_PATH}`);

  // Build set of already-bootstrapped filenames
  const existingPasses = store.listPasses();
  const bootstrappedSources = new Set(
    existingPasses
      .map((p) => p.source)
      .filter((s): s is string => typeof s === 'string' && s.startsWith('bootstrap:')),
  );

  // Create scribe
  const modelCaller = createAnthropicModelCaller(apiKey);
  const scribe = new ScribeInterface(modelCaller, { systemPrompt: SCRIBE_SYSTEM_PROMPT });

  const files = collectFiles();
  console.log(`[bootstrap] Found ${files.length} file(s) to consider`);

  const results: FileResult[] = [];
  let filesProcessed = 0;
  let filesSkipped = 0;
  let filesFailed = 0;
  let totalMutations = 0;
  let firstCall = true;

  for (const filePath of files) {
    const fileName = basename(filePath);
    const sourceTag = `bootstrap:${fileName}`;

    // Idempotency: skip if already bootstrapped
    if (bootstrappedSources.has(sourceTag)) {
      console.log(`[bootstrap] ${fileName}: already bootstrapped, skipping`);
      filesSkipped++;
      results.push({ file: filePath, status: 'already-done' });
      continue;
    }

    // Skip files older than MAX_AGE_DAYS
    try {
      if (isOlderThanDays(filePath, MAX_AGE_DAYS)) {
        console.log(`[bootstrap] ${fileName}: older than ${MAX_AGE_DAYS} days, skipping`);
        filesSkipped++;
        results.push({ file: filePath, status: 'skipped' });
        continue;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bootstrap] ${fileName}: could not stat — ${msg}`);
      filesFailed++;
      results.push({ file: filePath, status: 'error', error: msg });
      continue;
    }

    // Read file
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bootstrap] ${fileName}: read error — ${msg}`);
      filesFailed++;
      results.push({ file: filePath, status: 'error', error: msg });
      continue;
    }

    if (!content.trim()) {
      console.log(`[bootstrap] ${fileName}: empty, skipping`);
      filesSkipped++;
      results.push({ file: filePath, status: 'skipped' });
      continue;
    }

    // Rate limit: wait between API calls (skip before the very first)
    if (!firstCall) {
      await sleep(RATE_LIMIT_MS);
    }
    firstCall = false;

    // Run through scribe with retry on rate limit
    try {
      let pass;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          pass = await scribe.callModel(content);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('429') && attempt < 2) {
            const backoff = (attempt + 1) * 30000;
            console.log(`[bootstrap] ${fileName}: rate limited, retrying in ${backoff / 1000}s...`);
            await sleep(backoff);
            continue;
          }
          throw err;
        }
      }
      if (!pass) throw new Error('Failed after retries');
      pass.source = sourceTag;
      pass.model = MODEL;

      const applyResult = store.applyPass(pass);

      filesProcessed++;
      totalMutations += pass.mutations.length;
      results.push({ file: filePath, status: 'ok', mutations: pass.mutations.length, applyResult });

      console.log(
        `[bootstrap] ${fileName}: ${pass.mutations.length} mutations` +
          ` (created=${applyResult.nodes_created} updated=${applyResult.nodes_updated} expired=${applyResult.nodes_expired})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bootstrap] ${fileName}: scribe error — ${msg}`);
      filesFailed++;
      results.push({ file: filePath, status: 'error', error: msg });
    }
  }

  store.close();

  // Summary
  console.log('\n--- Bootstrap complete ---');
  console.log(`  Files processed : ${filesProcessed}`);
  console.log(`  Files skipped   : ${filesSkipped}`);
  console.log(`  Files failed    : ${filesFailed}`);
  console.log(`  Total mutations : ${totalMutations}`);

  if (filesFailed > 0) {
    console.log('\nErrors:');
    for (const r of results) {
      if (r.status === 'error') {
        console.log(`  ${basename(r.file)}: ${r.error}`);
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[bootstrap] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
