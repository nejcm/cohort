import {
  effortOrThrow,
  parseArguments,
  postJson,
  ProviderError,
  tokenCount,
  userText,
  type AdapterOptions,
  type ProviderAdapter,
} from './types.ts';

const KEY_ENV = 'ANTHROPIC_API_KEY';

// Wire facts (live-checked 2026-10-29): Messages API, `output_config.effort`, forced tool_choice rejected on newer models.
export function createAnthropicAdapter(options: AdapterOptions = {}): ProviderAdapter {
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
  return {
    id: 'anthropic',
    keyEnv: KEY_ENV,
    available: () => Boolean(env[KEY_ENV]),
    async decide(request, { signal }) {
      const key = env[KEY_ENV];
      if (!key)
        throw new ProviderError(`${KEY_ENV} is not set`, { status: null, retryable: false, possiblyBilled: false });
      const body = {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: [{ type: 'text', text: request.instructions, cache_control: { type: 'ephemeral' } }],
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        output_config: { effort: effortOrThrow(request.effort) },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: request.observation.pngBase64 },
              },
              { type: 'text', text: userText(request) },
            ],
          },
        ],
      };
      const { json, headers } = await postJson(
        `${baseUrl}/v1/messages`,
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body,
        key,
        signal,
      );
      const content = Array.isArray(json.content) ? (json.content as Record<string, unknown>[]) : [];
      const usage = (json.usage ?? {}) as Record<string, unknown>;
      const inputCount = tokenCount(usage.input_tokens);
      const outputCount = tokenCount(usage.output_tokens);
      const cacheRead = usage.cache_read_input_tokens === undefined ? 0 : tokenCount(usage.cache_read_input_tokens);
      const cacheWrite =
        usage.cache_creation_input_tokens === undefined ? 0 : tokenCount(usage.cache_creation_input_tokens);
      const counted = inputCount !== null && outputCount !== null && cacheRead !== null && cacheWrite !== null;
      // The catalog prices only the 5-minute TTL this adapter requests; refuse rather than undercount another TTL.
      const ttls = (usage.cache_creation ?? {}) as Record<string, unknown>;
      if (Object.entries(ttls).some(([ttl, tokens]) => ttl !== 'ephemeral_5m_input_tokens' && tokens !== 0))
        throw new ProviderError(`cache write with an unpriced TTL: ${Object.keys(ttls).join(', ')}`, {
          status: null,
          retryable: false,
          possiblyBilled: true,
        });
      return {
        calls: content
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({ name: String(block.name), args: parseArguments(block.input) })),
        usage: counted
          ? {
              inputTokens: inputCount + cacheRead + cacheWrite,
              outputTokens: outputCount,
              cachedInputTokens: usage.cache_read_input_tokens === undefined ? null : cacheRead,
              cacheWriteInputTokens: usage.cache_creation_input_tokens === undefined ? null : cacheWrite,
              imageInputTokens: null,
              reportedCostUsd: null,
              source: 'provider',
            }
          : null,
        returnedModel: typeof json.model === 'string' ? json.model : null,
        requestId: headers.get('request-id') ?? undefined,
      };
    },
  };
}
