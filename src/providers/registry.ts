import { createAnthropicAdapter } from './anthropic.ts';
import { createOpenAIAdapter } from './openai.ts';
import type { ProviderAdapter } from './types.ts';

export function createProviders(env: NodeJS.ProcessEnv = process.env): Record<string, ProviderAdapter> {
  return { openai: createOpenAIAdapter({ env }), anthropic: createAnthropicAdapter({ env }) };
}

/** Every configured provider key value in `env`, from the registry plus any injected adapters. */
export function providerKeys(env: NodeJS.ProcessEnv, extra: Record<string, ProviderAdapter> = {}): string[] {
  const keyEnvs = new Set(
    [...Object.values(createProviders(env)), ...Object.values(extra)].map(({ keyEnv }) => keyEnv),
  );
  return [...keyEnvs].flatMap((name) => env[name] ?? []);
}
