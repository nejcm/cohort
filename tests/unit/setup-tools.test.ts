import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'node:net';
import { knownBlocker } from '../../src/core/blockers.ts';
import { serveTools } from '../../src/core/replay.ts';
import { SecretStore } from '../../src/setup/secrets.ts';
import { customToolDefinitions, runCustomTool } from '../../src/setup/tools.ts';
import type { CustomTool } from '../../src/setup/types.ts';

const schema = { type: 'object', additionalProperties: false, properties: { inbox: { type: 'string' } } };
const tool = (execute: CustomTool['execute'], inputSchema: Record<string, unknown> = schema): CustomTool => ({
  description: 'Test tool.',
  inputSchema,
  execute,
});

test('custom tool definitions reject built-in overrides, bad names, and schemas the validator would weaken', () => {
  const ok = tool(async () => ({}));
  assert.deepEqual(customToolDefinitions({ read_inbox: ok }), [
    { name: 'read_inbox', description: 'Test tool.', parameters: schema },
  ]);
  assert.throws(() => customToolDefinitions({ fill: ok }), /override a built-in/u);
  assert.throws(() => customToolDefinitions({ navigate: ok }), /override a built-in/u);
  assert.throws(() => customToolDefinitions({ 'Read Inbox': ok }), /is invalid/u);
  assert.throws(
    () =>
      customToolDefinitions({ t: tool(async () => ({}), { type: 'object', properties: { a: { format: 'email' } } }) }),
    /t\.inputSchema\.properties\.a\.format is not a supported schema keyword/u,
  );
  assert.throws(() => customToolDefinitions({ t: tool(async () => ({}), { type: 'string' }) }), /type object/u);
  assert.throws(() => customToolDefinitions({ t: { ...ok, execute: undefined as never } }), /execute function/u);
});

const call = (args: Record<string, unknown>) => ({ name: 't', args });

test('custom tool calls are schema-checked, refuse secrets in arguments, and time out', async () => {
  const secrets = new SecretStore();
  secrets.bind('password', 'hunter-2-canary');
  secrets.bind('quoted', 'q"u\\ote-canary');
  let calls = 0;
  const counting = tool(async () => {
    calls += 1;
    return {};
  });
  assert.equal((await runCustomTool('t', counting, call({ inbox: 3 }), secrets, 1000)).status, 'rejected');
  for (const inbox of ['{{password}}', 'x hunter-2-canary', 'q"u\\ote-canary'])
    assert.deepEqual(await runCustomTool('t', counting, call({ inbox }), secrets, 1000), {
      status: 'rejected',
      code: 'secret_in_custom_args',
      message: 'custom tool arguments may not hold secrets',
    });
  assert.equal(calls, 0);

  let aborted = false;
  const hanging = tool(
    (_args, { signal }) => new Promise(() => signal.addEventListener('abort', () => (aborted = true), { once: true })),
  );
  assert.deepEqual(await runCustomTool('t', hanging, call({}), secrets, 20), {
    status: 'error',
    code: 'tool_timeout',
    message: 'custom tool t ran past 20 ms',
  });
  assert.ok(aborted, 'the tool signal aborts on timeout');

  let late: unknown;
  const slow = tool(async (_args, { bindSecret }) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      bindSecret('late', 'late-canary');
    } catch (error) {
      late = error;
    }
    return {};
  });
  assert.equal((await runCustomTool('t', slow, call({}), secrets, 10)).status, 'error');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(late instanceof Error, 'bindSecret refuses after the call ended');
  assert.ok(!secrets.names.includes('late'));
});

test('custom tool output binds fresh secrets, returns only placeholders, and is redacted and bounded', async () => {
  const secrets = new SecretStore();
  let issued = 0;
  const totp = tool(async (_args, { bindSecret }) => {
    issued += 1;
    const code = `81${issued}042`;
    return { text: `Code ${code} sent.`, secretRefs: { totp: bindSecret('totp', code) } };
  });
  const first = await runCustomTool('totp', totp, { name: 'totp', args: {} }, secrets, 1000);
  assert.deepEqual(first, { status: 'ok', output: 'Code {{totp}} sent.\ntotp: {{totp}}', bound: { totp: '811042' } });
  await runCustomTool('totp', totp, { name: 'totp', args: {} }, secrets, 1000);
  assert.equal(secrets.substitute('{{totp}}'), '812042', 'the latest binding wins');
  assert.equal(secrets.redact('811042'), '{{totp}}', 'earlier values stay redacted');

  const forged = tool(async () => ({ secretRefs: { code: '{{nope}}' } }));
  assert.equal(
    ((await runCustomTool('f', forged, { name: 'f', args: {} }, secrets, 1000)) as any).code,
    'invalid_tool_output',
  );
  const huge = tool(async () => ({ text: 'x'.repeat(3000) }));
  assert.equal(
    ((await runCustomTool('h', huge, { name: 'h', args: {} }, secrets, 1000)) as any).code,
    'invalid_tool_output',
  );
  const thrower = tool(async () => {
    throw new Error('inbox refused 812042\nstack');
  });
  assert.deepEqual(await runCustomTool('e', thrower, { name: 'e', args: {} }, secrets, 1000), {
    status: 'error',
    code: 'tool_error',
    message: 'inbox refused {{totp}}',
  });
});

test('the identity-provider list matches hosts and subdomains, not lookalikes', () => {
  assert.deepEqual(knownBlocker('https://accounts.google.com/o/oauth2/auth'), {
    kind: 'oauth',
    host: 'accounts.google.com',
  });
  assert.equal(knownBlocker('https://acme.okta.com/login')?.kind, 'oauth');
  assert.equal(knownBlocker('https://checkout.stripe.com/c/pay')?.kind, 'payment');
  assert.equal(knownBlocker('https://okta.com.evil.test/'), null);
  assert.equal(knownBlocker('https://notaccounts.google.com/'), null);
  assert.equal(knownBlocker('not a url'), null);
});

test('the replay tool bridge closes rejected connections and stops running tools past the replay deadline', async () => {
  let runs = 0;
  const env: NodeJS.ProcessEnv = {};
  const bridge = await serveTools(
    {
      t: tool(async () => {
        runs += 1;
        return {};
      }),
    },
    new SecretStore(),
    (text) => text,
    80,
    env,
  );
  try {
    const { port } = new URL(env.LAB_TOOL_BRIDGE!);
    const reply = await new Promise<string>((resolve) => {
      let data = '';
      const socket = connect(Number(port), '127.0.0.1', () =>
        socket.write(
          'POST / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\nAuthorization: Bearer nope\r\nContent-Length: 2\r\n\r\n{}',
        ),
      );
      socket.on('data', (chunk) => (data += String(chunk)));
      socket.on('close', () => resolve(data));
    });
    assert.match(reply, /^HTTP\/1\.1 403/u);

    const invoke = () =>
      fetch(env.LAB_TOOL_BRIDGE!, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.LAB_TOOL_TOKEN}` },
        body: JSON.stringify({ name: 't', args: {} }),
      });
    assert.equal((await invoke()).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const late = await invoke();
    assert.deepEqual(
      [late.status, await late.json()],
      [500, { error: 'tool_timeout: the replay ran past its time limit' }],
    );
    assert.equal(runs, 1);
  } finally {
    bridge.close();
  }
});
