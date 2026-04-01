import { readFileSync } from 'node:fs';
import type { ScribePass } from '@memrok/store';
import { SCRIBE_SYSTEM_PROMPT } from './system-prompt.js';

export type ModelCaller = (
  systemPrompt: string,
  userMessage: string,
) => Promise<string>;

export interface ScribeOptions {
  systemPrompt?: string;
  systemPromptPath?: string;
}

const VALID_OPERATIONS = new Set(['add', 'update', 'expire']);
const VALID_LAYERS = new Set(['user', 'agent', 'collaboration']);
const MAX_KEY_LENGTH = 200;
const MAX_VALUE_LENGTH = 2000;

export function loadSystemPrompt(options?: ScribeOptions): string {
  if (options?.systemPrompt !== undefined) {
    return options.systemPrompt;
  }
  if (options?.systemPromptPath) {
    return readFileSync(options.systemPromptPath, 'utf-8');
  }
  return SCRIBE_SYSTEM_PROMPT;
}

export class ScribeInterface {
  private readonly modelCaller: ModelCaller;
  private readonly systemPrompt: string;

  constructor(modelCaller: ModelCaller, options?: ScribeOptions) {
    this.modelCaller = modelCaller;
    this.systemPrompt = loadSystemPrompt(options);
  }

  async callModel(transcript: string): Promise<ScribePass> {
    const responseText = await this.modelCaller(this.systemPrompt, transcript);
    return this.parseResponse(responseText);
  }

  parseResponse(text: string): ScribePass {
    if (typeof text !== 'string') {
      throw new Error(`Scribe: expected string response from model, got ${typeof text}`);
    }
    let jsonStr = text.trim();

    // Strip markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    // If model prepended prose before JSON, find the first { and parse from there
    if (!jsonStr.startsWith('{')) {
      const braceIdx = jsonStr.indexOf('{');
      if (braceIdx >= 0) {
        jsonStr = jsonStr.slice(braceIdx);
      }
    }

    const parsed = JSON.parse(jsonStr) as ScribePass;

    if (!parsed.pass_id || !Array.isArray(parsed.mutations)) {
      throw new Error('Invalid scribe response: missing pass_id or mutations');
    }

    parsed.mutations = parsed.mutations.filter((mut) => {
      if (!VALID_OPERATIONS.has(mut.operation)) {
        console.warn(`[scribe] Dropping mutation with invalid operation: ${String(mut.operation)}`);
        return false;
      }
      if (!VALID_LAYERS.has(mut.layer)) {
        console.warn(`[scribe] Dropping mutation with invalid layer: ${String(mut.layer)}`);
        return false;
      }
      if (typeof mut.key === 'string' && mut.key.length > MAX_KEY_LENGTH) {
        console.warn(
          `[scribe] Dropping mutation with key exceeding ${MAX_KEY_LENGTH} chars: ${mut.key.slice(0, 50)}...`,
        );
        return false;
      }
      if (typeof mut.value === 'string' && mut.value.length > MAX_VALUE_LENGTH) {
        console.warn(`[scribe] Dropping mutation with value exceeding ${MAX_VALUE_LENGTH} chars`);
        return false;
      }
      return true;
    });

    return parsed;
  }
}

export { SCRIBE_SYSTEM_PROMPT };
export { REFLECTION_SYSTEM_PROMPT } from './reflection-prompt.js';
export { serializeGraphForReflection } from './reflection-serializer.js';
export type { ReflectionSerializerOptions } from './reflection-serializer.js';
