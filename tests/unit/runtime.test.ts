import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { loadSetupModule, SetupLoadError } from '../../src/setup/load.ts';
import type { SetupContext } from '../../src/setup/types.ts';

let root: string;
const setupDir = (): string => join(root, '.cohort', 'setup');

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'lab-setup-'));
  await mkdir(join(setupDir(), 'lib'), { recursive: true });
});
after(() => rm(root, { recursive: true, force: true }));

test('loads a TS setup with an explicit .ts relative helper import', async () => {
  await writeFile(
    join(setupDir(), 'lib', 'start.ts'),
    'export const path = (scope: string): string => `/?scope=${scope}`;\n',
  );
  await writeFile(
    join(setupDir(), 'app.ts'),
    `import { path } from './lib/start.ts';
interface Ctx { scopeId: string }
export default async (ctx: Ctx) => ({ startUrl: 'http://localhost' + path(ctx.scopeId) });
`,
  );
  const setup = await loadSetupModule(root, join(setupDir(), 'app.ts'));
  assert.deepEqual(await setup({ scopeId: 'abc' } as SetupContext), { startUrl: 'http://localhost/?scope=abc' });
});

const env = (name: string): string => (name === 'COHORT_FIXTURE_ORIGIN' ? 'http://127.0.0.1:9' : '');

test('loads the shipped example setup module', async () => {
  await copyFile(new URL('../../examples/setup/fixture.ts', import.meta.url), join(setupDir(), 'fixture.ts'));
  const setup = await loadSetupModule(root, join(setupDir(), 'fixture.ts'));
  assert.deepEqual(await setup({ scopeId: 's1', env } as unknown as SetupContext), {
    startUrl: 'http://127.0.0.1:9/?scope=s1',
  });
});

test('rejects setup modules outside .cohort/setup, through symlinks, or without a default export', async () => {
  await writeFile(join(root, 'outside.ts'), 'export default () => ({ startUrl: "x" });\n');
  await assert.rejects(loadSetupModule(root, join(root, 'outside.ts')), SetupLoadError);
  await assert.rejects(loadSetupModule(root, join(setupDir(), '..', '..', 'outside.ts')), /inside \.cohort\/setup/u);
  await symlink(join(root, 'outside.ts'), join(setupDir(), 'link.ts'));
  await assert.rejects(loadSetupModule(root, join(setupDir(), 'link.ts')), /symlink/u);
  await writeFile(join(setupDir(), 'named.ts'), 'export const setup = 1;\n');
  await assert.rejects(loadSetupModule(root, join(setupDir(), 'named.ts')), /no default function/u);
  await writeFile(join(setupDir(), 'data.json'), '{}');
  await assert.rejects(loadSetupModule(root, join(setupDir(), 'data.json')), /\.ts, \.js, or \.mjs/u);
});

test('rejects a symlinked .cohort directory even when its setup module looks contained', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'lab-outside-'));
  const project = await mkdtemp(join(tmpdir(), 'lab-project-'));
  try {
    await mkdir(join(outside, 'setup'));
    await writeFile(join(outside, 'setup', 'evil.ts'), 'export default () => ({ startUrl: "x" });\n');
    await symlink(outside, join(project, '.cohort'));
    await assert.rejects(loadSetupModule(project, join(project, '.cohort', 'setup', 'evil.ts')), /symlink/u);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('node:sqlite works in a child Node process; its warning is recorded', async (t) => {
  const script = `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('create table runs (id text primary key, cost real)');
db.prepare('insert into runs values (?, ?)').run('r1', 0.25);
process.stdout.write(JSON.stringify(db.prepare('select * from runs').all()));`;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', script]);
  assert.deepEqual(JSON.parse(stdout), [{ id: 'r1', cost: 0.25 }]);
  t.diagnostic(`node ${process.version} sqlite stderr: ${stderr.trim() || '(none)'}`);
});
