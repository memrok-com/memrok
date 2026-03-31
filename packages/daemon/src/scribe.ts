import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScribeConfig } from './types.js';
import type { ScribePass } from '@memrok/store';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SYSTEM_PROMPT_PATH = resolve(__dirname, '../../scribe/src/system-prompt.md');

function loadSystemPrompt(configPath?: string): string {
  const promptPath = configPath ?? DEFAULT_SYSTEM_PROMPT_PATH;
  try {
    return readFileSync(promptPath, 'utf-8');
  } catch {
    return 'You are a memory extraction agent. Parse the transcript and return JSON with mutations.';
  }
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

interface OpenAIResponse {
  choices: Array<{ message: { content: string } }>;
}

export class ScribeInterface {
  private config: ScribeConfig;
  private systemPrompt: string;

  constructor(config: ScribeConfig) {
    this.config = config;
    this.systemPrompt = loadSystemPrompt(config.systemPromptPath);
  }

  async callModel(transcript: string): Promise<ScribePass> {
    const provider = this.config.provider;

    let responseText: string;
    if (provider === 'anthropic') {
      responseText = await this.callAnthropic(transcript);
    } else {
      responseText = await this.callOpenAICompatible(transcript);
    }

    return this.parseResponse(responseText);
  }

  private async callAnthropic(transcript: string): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error('Anthropic API key is required');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 4096,
        system: this.systemPrompt,
        messages: [{ role: 'user', content: transcript }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as AnthropicResponse;
    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock?.text) throw new Error('No text in Anthropic response');
    return textBlock.text;
  }

  private async callOpenAICompatible(transcript: string): Promise<string> {
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: transcript },
        ],
        temperature: 0,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as OpenAIResponse;
    return data.choices[0]?.message?.content ?? '';
  }

  parseResponse(text: string): ScribePass {
    // Extract JSON from response (may be wrapped in markdown code block)
    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);

    // Validate minimum structure
    if (!parsed.pass_id || !Array.isArray(parsed.mutations)) {
      throw new Error('Invalid scribe response: missing pass_id or mutations');
    }

    const VALID_OPERATIONS = new Set(['add', 'update', 'expire']);
    const VALID_LAYERS = new Set(['user', 'agent', 'collaboration']);
    const MAX_KEY_LENGTH = 200;
    const MAX_VALUE_LENGTH = 2000;

    const validMutations = parsed.mutations.filter((mut: Record<string, unknown>) => {
      if (!VALID_OPERATIONS.has(mut.operation as string)) {
        console.warn(`[scribe] Dropping mutation with invalid operation: ${mut.operation}`);
        return false;
      }
      if (!VALID_LAYERS.has(mut.layer as string)) {
        console.warn(`[scribe] Dropping mutation with invalid layer: ${mut.layer}`);
        return false;
      }
      if (typeof mut.key === 'string' && mut.key.length > MAX_KEY_LENGTH) {
        console.warn(`[scribe] Dropping mutation with key exceeding ${MAX_KEY_LENGTH} chars: ${mut.key.slice(0, 50)}...`);
        return false;
      }
      if (typeof mut.value === 'string' && mut.value.length > MAX_VALUE_LENGTH) {
        console.warn(`[scribe] Dropping mutation with value exceeding ${MAX_VALUE_LENGTH} chars`);
        return false;
      }
      return true;
    });

    parsed.mutations = validMutations;
    return parsed as ScribePass;
  }
}
