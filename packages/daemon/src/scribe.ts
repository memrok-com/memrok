import type { ModelCaller } from '@memrok/scribe';
import { ScribeInterface as BaseScribeInterface } from '@memrok/scribe';
import type { ScribeConfig } from './types.js';

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

interface OpenAIResponse {
  choices: Array<{ message: { content: string | Array<{ type?: string; text?: string }> } }>;
}

async function callAnthropic(
  config: ScribeConfig,
  systemPrompt: string,
  transcript: string,
): Promise<string> {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('Anthropic API key is required');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: transcript }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as AnthropicResponse;
  const textBlock = data.content.find((block) => block.type === 'text');
  if (!textBlock?.text) throw new Error('No text in Anthropic response');
  return textBlock.text;
}

async function callOpenAICompatible(
  config: ScribeConfig,
  systemPrompt: string,
  transcript: string,
): Promise<string> {
  const provider = config.provider;
  const baseUrl =
    provider === 'ollama'
      ? (config.baseUrl ?? 'http://127.0.0.1:11434/v1')
      : (config.baseUrl ?? 'https://api.openai.com/v1');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript },
      ],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  const content = data.choices[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function createModelCaller(config: ScribeConfig): ModelCaller {
  return async (systemPrompt: string, userMessage: string): Promise<string> => {
    if (config.provider === 'anthropic') {
      return callAnthropic(config, systemPrompt, userMessage);
    }
    return callOpenAICompatible(config, systemPrompt, userMessage);
  };
}

export class ScribeInterface extends BaseScribeInterface {
  constructor(config: ScribeConfig) {
    super(createModelCaller(config), { systemPromptPath: config.systemPromptPath });
  }
}
