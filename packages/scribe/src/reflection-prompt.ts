import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, 'reflection-prompt.md');
const srcPath = join(__dirname, '..', 'src', 'reflection-prompt.md');

/**
 * System prompt for the reflective scribe.
 *
 * Unlike the transcript scribe (objective extraction), the reflective scribe
 * synthesizes subjective insights from the agent's perspective — meta-patterns,
 * lessons learned, coaching observations, and self-awareness.
 *
 * Input: serialized graph state (recent/active nodes), not raw transcripts.
 * Output: same ScribePass JSON format with source: "reflection".
 */
export const REFLECTION_SYSTEM_PROMPT = readFileSync(
  existsSync(distPath) ? distPath : srcPath,
  'utf-8',
);
