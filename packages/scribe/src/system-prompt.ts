import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, 'system-prompt.md');
const srcPath = join(__dirname, '..', 'src', 'system-prompt.md');

export const SCRIBE_SYSTEM_PROMPT = readFileSync(
  existsSync(distPath) ? distPath : srcPath,
  'utf-8',
);
