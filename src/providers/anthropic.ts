import {
  effortOrThrow,
  parseArguments,
  postJson,
  ProviderError,
  userText,
  type AdapterOptions,
  type ProviderAdapter,
} from './types.ts';

const KEY_ENV = 'ANTHROPIC_API_KEY';

// Wire facts (unverified live): Messages API, `output_config.effort`, forced tool_choice rejected on newer models.
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
      const usage = (json.usage ?? {}) as Record<string, number | undefined>;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      return {
        calls: content
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({ name: String(block.name), args: parseArguments(block.input) })),
        usage: {
          inputTokens: (usage.input_tokens ?? 0) + cacheRead + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          cachedInputTokens: usage.cache_read_input_tokens === undefined ? null : cacheRead,
          imageInputTokens: null,
          reportedCostUsd: null,
          source: 'provider',
        },
        returnedModel: typeof json.model === 'string' ? json.model : null,
        requestId: headers.get('request-id') ?? undefined,
      };
    },
  };
}
