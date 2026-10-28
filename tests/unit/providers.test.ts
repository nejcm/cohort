import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { BUILTIN_TOOLS } from '../../src/core/tools.ts';
import { createAnthropicAdapter } from '../../src/providers/anthropic.ts';
import { createOpenAIAdapter } from '../../src/providers/openai.ts';
import {
  EFFORTS,
  ProviderError,
  type DecideRequest,
  type Effort,
  type ProviderAdapter,
} from '../../src/providers/types.ts';

const KEY = 'sk-test-canary-0123456789';

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, any>;
}

async function fakeServer(
  reply: (seen: Seen) => { status?: number; headers?: Record<string, string>; body: unknown },
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const entry = { path: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, any> };
      seen.push(entry);
      const { status = 200, headers = {}, body } = reply(entry);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const request = (effort: Effort): DecideRequest => ({
  model: 'model-x',
  effort,
  instructions: 'Act as a guest.',
  history: ['s0001 click ok'],
  observation: { kind: 'vision', id: 'o0001', text: 'Observation o0001', pngBase64: 'iVBORw0KGgo=' },
  tools: BUILTIN_TOOLS,
  maxOutputTokens: 512,
});

const signal = (): { signal: AbortSignal } => ({ signal: AbortSignal.timeout(5000) });

const anthropicReply = {
  model: 'model-x-2026',
  content: [
    { type: 'text', text: 'thinking aloud' },
    { type: 'tool_use', id: 'tu_1', name: 'wait', input: { ms: 100 } },
  ],
  usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 20 },
};

const openaiReply = {
  model: 'model-x-2026',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'function_call', call_id: 'c1', name: 'wait', arguments: '{"ms":100}' },
  ],
  usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 20 },
};

for (const effort of EFFORTS) {
  test(`anthropic maps ${effort} effort and parses usage`, async () => {
    const server = await fakeServer(() => ({ headers: { 'request-id': 'req_a1' }, body: anthropicReply }));
    try {
      const adapter = createAnthropicAdapter({ baseUrl: server.url, env: { ANTHROPIC_API_KEY: KEY } });
      const decision = await adapter.decide(request(effort), signal());
      const [seen] = server.seen;
      assert.equal(seen?.path, '/v1/messages');
      assert.equal(seen?.headers['x-api-key'], KEY);
      assert.equal(seen?.headers['anthropic-version'], '2023-06-01');
      assert.deepEqual(seen?.body.output_config, { effort });
      assert.deepEqual(seen?.body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
      assert.equal(seen?.body.tools.length, BUILTIN_TOOLS.length);
      assert.equal(seen?.body.messages[0].content[0].source.data, 'iVBORw0KGgo=');
      assert.ok(!JSON.stringify(seen?.body).includes(KEY));
      assert.deepEqual(decision.calls, [{ name: 'wait', args: { ms: 100 } }]);
      assert.deepEqual(decision.usage, {
        inputTokens: 1050,
        outputTokens: 20,
        cachedInputTokens: 900,
        imageInputTokens: null,
        reportedCostUsd: null,
        source: 'provider',
      });
      assert.equal(decision.returnedModel, 'model-x-2026');
      assert.equal(decision.requestId, 'req_a1');
    } finally {
      await server.close();
    }
  });

  test(`openai maps ${effort} effort and parses usage`, async () => {
    const server = await fakeServer(() => ({ headers: { 'x-request-id': 'req_o1' }, body: openaiReply }));
    try {
      const adapter = createOpenAIAdapter({ baseUrl: server.url, env: { OPENAI_API_KEY: KEY } });
      const decision = await adapter.decide(request(effort), signal());
      const [seen] = server.seen;
      assert.equal(seen?.path, '/v1/responses');
      assert.equal(seen?.headers.authorization, `Bearer ${KEY}`);
      assert.deepEqual(seen?.body.reasoning, { effort });
      assert.equal(seen?.body.store, false);
      assert.equal(seen?.body.parallel_tool_calls, false);
      assert.equal(seen?.body.tools.length, BUILTIN_TOOLS.length);
      assert.ok(JSON.stringify(seen?.body.input).includes('data:image/png;base64,iVBORw0KGgo='));
      assert.ok(!JSON.stringify(seen?.body).includes(KEY));
      assert.deepEqual(decision.calls, [{ name: 'wait', args: { ms: 100 } }]);
      assert.equal(decision.usage?.inputTokens, 1000);
      assert.equal(decision.usage?.cachedInputTokens, 800);
      assert.equal(decision.usage?.outputTokens, 20);
      assert.equal(decision.requestId, 'req_o1');
    } finally {
      await server.close();
    }
  });
}

const adapters: [string, (url: string) => ProviderAdapter][] = [
  ['anthropic', (url) => createAnthropicAdapter({ baseUrl: url, env: { ANTHROPIC_API_KEY: KEY } })],
  ['openai', (url) => createOpenAIAdapter({ baseUrl: url, env: { OPENAI_API_KEY: KEY } })],
];

for (const [name, make] of adapters) {
  test(`${name} errors are classified and never echo the key`, async () => {
    const cases: [number, boolean][] = [
      [429, true],
      [500, true],
      [400, false],
      [401, false],
    ];
    for (const [status, retryable] of cases) {
      const server = await fakeServer(() => ({ status, body: { error: { message: `bad key ${KEY}` } } }));
      try {
        await assert.rejects(make(server.url).decide(request('low'), signal()), (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.status, status);
          assert.equal(error.retryable, retryable);
          assert.ok(!error.message.includes(KEY));
          return true;
        });
      } finally {
        await server.close();
      }
    }
  });

  test(`${name} rejects malformed JSON and malformed tool arguments`, async () => {
    const broken = await fakeServer(() => ({ body: '{not json' }));
    try {
      await assert.rejects(make(broken.url).decide(request('low'), signal()), /malformed JSON/u);
    } finally {
      await broken.close();
    }
    const badArgs = await fakeServer(() => ({
      body:
        name === 'anthropic'
          ? { content: [{ type: 'tool_use', name: 'wait', input: 'oops' }], usage: {} }
          : { output: [{ type: 'function_call', name: 'wait', arguments: '{oops' }], usage: {} },
    }));
    try {
      await assert.rejects(make(badArgs.url).decide(request('low'), signal()), /not an object/u);
    } finally {
      await badArgs.close();
    }
  });

  test(`${name} refuses unsupported effort and a missing key before any request`, async () => {
    const server = await fakeServer(() => ({ body: {} }));
    try {
      await assert.rejects(make(server.url).decide(request('max' as Effort), signal()), /unsupported effort/u);
      const keyless = name === 'anthropic' ? createAnthropicAdapter({ env: {} }) : createOpenAIAdapter({ env: {} });
      assert.equal(keyless.available(), false);
      await assert.rejects(keyless.decide(request('low'), signal()), /is not set/u);
      assert.equal(server.seen.length, 0);
    } finally {
      await server.close();
    }
  });
}

test('transport failure is retryable and possibly billed', async () => {
  const adapter = createOpenAIAdapter({ baseUrl: 'http://127.0.0.1:1', env: { OPENAI_API_KEY: KEY } });
  await assert.rejects(adapter.decide(request('low'), signal()), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.retryable, true);
    assert.equal(error.possiblyBilled, true);
    return true;
  });
});

test('missing or invalid usage counts yield null usage so the reservation stays unsettled', async () => {
  const replies: [string, unknown][] = [
    ['anthropic', { content: [{ type: 'tool_use', name: 'wait', input: { ms: 100 } }] }],
    ['anthropic', { content: [], usage: { input_tokens: 10, output_tokens: -1 } }],
    ['openai', { output: [{ type: 'function_call', name: 'wait', arguments: '{"ms":100}' }] }],
    ['openai', { output: [], usage: { input_tokens: '10', output_tokens: 2 } }],
  ];
  for (const [name, body] of replies) {
    const server = await fakeServer(() => ({ body }));
    try {
      const make = adapters.find(([id]) => id === name)![1];
      assert.equal(
        (await make(server.url).decide(request('low'), signal())).usage,
        null,
        `${name} ${JSON.stringify(body)}`,
      );
    } finally {
      await server.close();
    }
  }
});
