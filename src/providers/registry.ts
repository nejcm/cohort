import { createAnthropicAdapter } from './anthropic.ts';
import { createOpenAIAdapter } from './openai.ts';
import type { ProviderAdapter } from './types.ts';

export function createProviders(env: NodeJS.ProcessEnv = process.env): Record<string, ProviderAdapter> {
  return { openai: createOpenAIAdapter({ env }), anthropic: createAnthropicAdapter({ env }) };
}
