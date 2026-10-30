import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SecretStore } from '../../src/setup/secrets.ts';
import { createSetupSession } from '../../src/setup/session.ts';

const PROVIDER_KEY = 'sk-session-provider-canary';
const hooks = globalThis as { setupHook?: (event: string) => void };
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'lab-setup-session-'));
  await mkdir(join(root, '.cohort/setup'), { recursive: true });
});
after(async () => {
  delete hooks.setupHook;
  await rm(root, { recursive: true, force: true });
});

async function fixture(name: string, source: string): Promise<string> {
  const path = join(root, '.cohort/setup', `${name}.ts`);
  await writeFile(path, source);
  return path;
}

function session(env: NodeJS.ProcessEnv = {}, alsoScrub?: () => readonly string[]) {
  const secrets = new SecretStore();
  const created = createSetupSession({
    projectRoot: root,
    env,
    secrets,
    providerKeys: [PROVIDER_KEY],
    ...(alsoScrub ? { alsoScrub } : {}),
  });
  return { secrets, session: created };
}

const ids = (signal = new AbortController().signal) => ({ runId: 'run_1', scopeId: 'run_1', signal });

async function thrown(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => assert.fail('run() should have thrown'),
    (error: unknown) => error,
  );
}

test('an env value read before the module throws is scrubbed to [env]', async () => {
  const path = await fixture(
    'read-then-throw',
    "export default async (ctx) => { throw new Error('bad ' + ctx.env('LEAK') + '\\nsecond line'); };\n",
  );
  const { session: setup } = session({ LEAK: 'session-canary-77' });
  const error = await thrown(setup.run({ path, ...ids() }));
  assert.equal(setup.describe(error), 'bad [env]');
  assert.equal(setup.scrub('again session-canary-77'), 'again [env]');
});

test('a too-short env value withholds the error message', async () => {
  const path = await fixture(
    'read-short',
    "export default async (ctx) => { throw new Error('bad ' + ctx.env('LEAK')); };\n",
  );
  const { session: setup } = session({ LEAK: '42' });
  const error = await thrown(setup.run({ path, ...ids() }));
  assert.equal(setup.describe(error), 'error message withheld: it may contain an environment value');
});

test('cleanups registered before a throw run on close, once; a failing cleanup is reported scrubbed', async () => {
  const events: string[] = [];
  hooks.setupHook = (event) => void events.push(event);
  const path = await fixture(
    'cleanup-then-throw',
    `export default async (ctx) => {
  ctx.onCleanup(async () => globalThis.setupHook('first'));
  ctx.onCleanup(async () => globalThis.setupHook('second'));
  throw new Error('setup broke');
};\n`,
  );
  const { session: setup } = session();
  assert.equal(setup.describe(await thrown(setup.run({ path, ...ids() }))), 'setup broke');
  assert.deepEqual(await setup.close(1000), []);
  assert.deepEqual(events, ['second', 'first']);
  assert.deepEqual(await setup.close(1000), []);
  assert.deepEqual(events, ['second', 'first']);

  const failing = await fixture(
    'cleanup-fails',
    `export default async (ctx) => {
  const leak = ctx.env('LEAK');
  ctx.onCleanup(async () => { throw new Error('teardown leaked ' + leak); });
  throw new Error('setup broke');
};\n`,
  );
  const { session: other } = session({ LEAK: 'cleanup-canary-88' });
  await thrown(other.run({ path: failing, ...ids() }));
  assert.deepEqual(await other.close(1000), [{ code: 'cleanup_failed', message: 'teardown leaked [env]' }]);
});

test('a hung module is rejected by its signal and close still runs its cleanups', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  hooks.setupHook = (event) => {
    events.push(event);
    if (event === 'registered') controller.abort(new Error('cancelled'));
  };
  const path = await fixture(
    'hang',
    `export default (ctx) => {
  ctx.onCleanup(async () => globalThis.setupHook('cleaned'));
  globalThis.setupHook('registered');
  return new Promise(() => {});
};\n`,
  );
  const { session: setup } = session();
  assert.equal(setup.describe(await thrown(setup.run({ path, ...ids(controller.signal) }))), 'cancelled');
  assert.deepEqual(await setup.close(1000), []);
  assert.deepEqual(events, ['registered', 'cleaned']);
});

test('invalid tools or a bad startUrl throw before any secret binds', async () => {
  const tools = await fixture(
    'bad-tools',
    `export default async () => ({
  startUrl: 'https://example.test/',
  secrets: { password: 'hunter-2-canary' },
  tools: { fill: { description: 'Shadows a built-in.', inputSchema: { type: 'object' }, execute: async () => ({}) } },
});\n`,
  );
  const url = await fixture(
    'bad-url',
    "export default async () => ({ startUrl: 'not a url', secrets: { password: 'hunter-2-canary' } });\n",
  );
  for (const [path, message] of [
    [tools, 'custom tool fill would override a built-in tool'],
    [url, 'setup returned an invalid startUrl'],
  ] as const) {
    const { secrets, session: setup } = session();
    assert.equal(setup.describe(await thrown(setup.run({ path, ...ids() }))), message);
    assert.deepEqual(secrets.names, []);
  }
});

test('scrub redacts bound secrets, provider keys, and alsoScrub values added after run', async () => {
  const path = await fixture(
    'ok',
    `export default async (ctx) => ({
  startUrl: 'https://example.test/' + ctx.env('PATH_PART'),
  secrets: { password: 'hunter-2-canary' },
});\n`,
  );
  const late: string[] = [];
  const { secrets, session: setup } = session({ PATH_PART: 'path-canary-55' }, () => late);
  const result = await setup.run({ path, ...ids() });
  assert.equal(result.startUrl, 'https://example.test/path-canary-55');
  assert.deepEqual(secrets.names, ['password']);
  late.push('late-canary-66');
  assert.equal(
    setup.scrub(`a hunter-2-canary b ${PROVIDER_KEY} c late-canary-66 d ${result.startUrl}`),
    'a {{password}} b [env] c [env] d https://example.test/[env]',
  );
});
