import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knownBlocker } from '../../src/core/blockers.ts';
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
  let calls = 0;
  const counting = tool(async () => {
    calls += 1;
    return {};
  });
  assert.equal((await runCustomTool('t', counting, call({ inbox: 3 }), secrets, 1000)).status, 'rejected');
  for (const inbox of ['{{password}}', 'x hunter-2-canary'])
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
