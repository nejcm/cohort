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

const KEY_ENV = 'OPENAI_API_KEY';

// Wire facts (unverified live): Responses API, `reasoning.effort`, `store: false` so requests are not retained as stored responses.
export function createOpenAIAdapter(options: AdapterOptions = {}): ProviderAdapter {
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl ?? 'https://api.openai.com';
  return {
    id: 'openai',
    keyEnv: KEY_ENV,
    available: () => Boolean(env[KEY_ENV]),
    async decide(request, { signal }) {
      const key = env[KEY_ENV];
      if (!key)
        throw new ProviderError(`${KEY_ENV} is not set`, { status: null, retryable: false, possiblyBilled: false });
      const body = {
        model: request.model,
        instructions: request.instructions,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_image', image_url: `data:image/png;base64,${request.observation.pngBase64}` },
              { type: 'input_text', text: userText(request) },
            ],
          },
        ],
        tools: request.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        })),
        tool_choice: 'required',
        parallel_tool_calls: false,
        reasoning: { effort: effortOrThrow(request.effort) },
        max_output_tokens: request.maxOutputTokens,
        store: false,
      };
      const { json, headers } = await postJson(
        `${baseUrl}/v1/responses`,
        { authorization: `Bearer ${key}` },
        body,
        key,
        signal,
      );
      const output = Array.isArray(json.output) ? (json.output as Record<string, unknown>[]) : [];
      const usage = (json.usage ?? {}) as {
        input_tokens?: unknown;
        output_tokens?: unknown;
        input_tokens_details?: { cached_tokens?: unknown };
      };
      const inputCount = tokenCount(usage.input_tokens);
      const outputCount = tokenCount(usage.output_tokens);
      return {
        calls: output
          .filter((item) => item.type === 'function_call')
          .map((item) => ({ name: String(item.name), args: parseArguments(item.arguments) })),
        usage:
          inputCount === null || outputCount === null
            ? null
            : {
                inputTokens: inputCount,
                outputTokens: outputCount,
                cachedInputTokens: tokenCount(usage.input_tokens_details?.cached_tokens),
                imageInputTokens: null,
                reportedCostUsd: null,
                source: 'provider',
              },
        returnedModel: typeof json.model === 'string' ? json.model : null,
        requestId: headers.get('x-request-id') ?? undefined,
      };
    },
  };
}
