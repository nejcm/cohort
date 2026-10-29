import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { run } from '../../src/cli.ts';
import type { ToolCall } from '../../src/core/tools.ts';
import { startBatch, type DetachedBatch } from '../../src/dashboard/runner.ts';
import { fakeProvider, lastStepId, type Turn } from '../helpers/fake-provider.ts';

const KEY = 'sk-explore-canary-8484';
const URL_SECRET = 'url-token-canary-9595';
const MODELS = `version: test
models:
  - id: test-model
    provider: openai
    label: test
    visionCapable: true
    supportedEffortLevels: [low]
    defaultEffort: low
    pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1, cacheWrite: 1 }
    pricingVerifiedAt: 2026-10-01
    untested: false
`;
// Two identical buttons force a css locator; the link's name carries the start-URL token.
const PAGE = (body: string, token: string) =>
  `<!doctype html><html><body style="margin:0"><button style="position:fixed;left:0;top:0;width:300px;height:150px" onclick="location.href='/deleted'">Delete account</button><button style="position:fixed;left:0;top:600px" onclick="location.href='/deleted'">Delete account</button><a style="position:fixed;left:400px;top:0;width:300px;height:150px" href="/search">Shared link ${token}</a>${body}</body></html>`;
const persona = (id: string, extra = '') =>
  `---\nschemaVersion: 1\nid: ${id}\nname: Searcher\ntags: [explore]\ndevice: { viewport: { width: 800, height: 600 }, touch: false }\nlocale: en-US\ntimezone: UTC\n${extra}---\n\nYou look for things. ${KEY} ${URL_SECRET}\n`;

let server: Server;
let origin: string;
let root: string;
const hits: string[] = [];
let script: Turn[] = [];
let suggestions: (request: Parameters<Turn>[0]) => ToolCall = () => ({ name: 'none', args: {} });
let index = 0;
const provider = fakeProvider((request) =>
  request.tools.some((tool) => tool.name === 'write_suggestions')
    ? suggestions(request)
    : script[Math.min(index++, script.length - 1)]!(request, index),
);
const env = { OPENAI_API_KEY: KEY };
const workers: Promise<void>[] = [];

async function worker(batch: DetachedBatch) {
  const started = await startBatch(
    { projectRoot: root, providers: { openai: provider }, env },
    JSON.parse(JSON.stringify(batch)) as DetachedBatch,
  );
  workers.push(started.done);
  return { batchId: started.batchId, runIds: started.runIds };
}

async function cli(argv: string[]) {
  let out = '';
  const code = await run([...argv, '--json'], (text) => void (out += text), {
    cwd: root,
    env,
    providers: { openai: provider } as never,
    stdin: Readable.from([]),
    worker,
  });
  return { code, out, json: JSON.parse(out) as any };
}

function explore(turns: Turn[], extra: string[] = []) {
  script = turns;
  index = 0;
  return cli(['explore', '--url', `${origin}/?token=${URL_SECRET}`, ...extra]);
}

const goto =
  (url: string): Turn =>
  () => ({ name: 'goto', args: { url } });
const done: Turn = (request) => ({ name: 'done', args: { step: lastStepId(request), summary: 'Seen enough.' } });
const clickDelete: Turn = (request) => ({
  name: 'click',
  args: { observationId: request.observation.id, target: { kind: 'point', x: 60, y: 40 } },
});
const stuck: Turn = (request) => ({
  name: 'click',
  args: { observationId: request.observation.id, target: { kind: 'point', x: 700, y: 500 } },
});
const clickLink: Turn = (request) => ({
  name: 'click',
  args: { observationId: request.observation.id, target: { kind: 'point', x: 440, y: 40 } },
});
const press =
  (key: string): Turn =>
  (request) => ({ name: 'press', args: { observationId: request.observation.id, key } });
const write = (args: Record<string, unknown>): ToolCall => ({
  name: 'write_suggestions',
  args: { features: [], personas: [], goals: [], tests: [], ...args },
});

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries.filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
  );
}

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    hits.push(url.pathname);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      PAGE(
        `<h1 style="margin-top:200px">${url.pathname === '/search' ? 'Search' : 'Home'}</h1>`,
        url.searchParams.get('token') ?? '',
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = await mkdtemp(join(tmpdir(), 'lab-explore-'));
  await mkdir(join(root, '.cohort'), { recursive: true });
  await writeFile(join(root, '.cohort/models.yml'), MODELS);
  await writeFile(join(root, '.cohort/config.yml'), 'schemaVersion: 1\nmodel: openai/test-model\n');
});

after(async () => {
  await Promise.all(workers);
  server.close();
  await rm(root, { recursive: true, force: true });
});

test('explore refuses destructive controls, keeps only cited suggestions, and saves only after review', async () => {
  suggestions = () =>
    write({
      features: [
        { name: 'Search page', description: 'A page titled Search.', steps: ['s0002'] },
        { name: 'Hidden admin panel', description: 'Never shown.', steps: ['s0099'] },
        { name: 'Account deletion', description: 'Refused.', steps: ['s0001'] },
        { name: 'Wire transfer', description: 'Hidden.', steps: ['s0099', 's0000'] },
        { name: 'Opening page', description: 'Only the start navigation.', steps: ['s0000'] },
      ],
      personas: [
        { markdown: persona('searcher'), steps: ['s0002'] },
        { markdown: persona('ghost'), steps: ['s0042'] },
        { markdown: persona('operator', 'model: openai/test-model\n'), steps: ['s0002'] },
      ],
      goals: [
        { persona: 'searcher', goal: `Open the search page ${KEY}.`, steps: ['s0002'] },
        { persona: 'nobody', goal: 'Do something.', steps: ['s0002'] },
      ],
      tests: [
        { name: 'search', step: 's0002' },
        { name: 'delete-account', step: 's0001' },
        { name: 'start', step: 's0000' },
      ],
    });
  const explored = await explore([clickDelete, goto('/search'), press('Tab'), press('Enter'), done]);
  assert.equal(explored.code, 0, explored.out);
  const { json } = explored;
  assert.equal(json.runOutcome.state, 'completed');
  assert.ok(!hits.includes('/deleted'));
  assert.deepEqual(
    json.untried.map((item: any) => item.step),
    ['s0001', 's0004'],
  );
  assert.match(json.untried[0].reason, /Delete account/u);
  assert.match(json.untried[1].reason, /Delete account/u);
  assert.deepEqual(json.features, [
    {
      name: 'Search page',
      description: 'A page titled Search.',
      steps: ['s0002'],
      screenshots: [json.features[0].screenshots[0]],
    },
  ]);
  assert.ok(json.features[0].screenshots[0]);
  assert.deepEqual(
    json.dropped.map((item: any) => `${item.kind} ${item.name}`),
    [
      'feature Hidden admin panel',
      'feature Account deletion',
      'feature Wire transfer',
      'feature Opening page',
      'persona ghost',
      'persona operator',
      'goal Do something.',
      'test delete-account',
      'test start',
    ],
  );
  assert.deepEqual(
    json.personas.map((item: any) => item.id),
    ['searcher'],
  );
  assert.deepEqual(json.tests, [{ name: 'search', path: 'suggestions/tests/search.spec.ts', step: 's0002' }]);
  assert.equal(json.suite.id, `explore-${json.runId.slice(-6)}`);

  const dir = join(root, '.cohort/runs', json.runId);
  const spec = await readFile(join(dir, json.tests[0].path), 'utf8');
  assert.match(spec, /\/search/u);
  assert.equal(hits.filter((path) => path === '/search').length, 1, 'the generated test is never run');
  for (const text of [explored.out, ...(await filesUnder(join(dir, 'suggestions')))]) {
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes(URL_SECRET));
  }
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.artifacts.some((artifact: any) => artifact.path === 'suggestions/explore.json'));
  await assert.rejects(readFile(join(root, '.cohort/personas/searcher.md')));

  const unreviewed = await cli(['explore', 'save', json.runId, '--persona', 'searcher']);
  assert.deepEqual([unreviewed.code, unreviewed.json.code], [2, 'confirmation_required']);
  const missing = await cli(['explore', 'save', json.runId, '--persona', 'ghost', '--yes']);
  assert.deepEqual([missing.code, missing.json.code], [2, 'not_found']);
  const saved = await cli(['explore', 'save', json.runId, '--persona', 'searcher', '--yes']);
  assert.deepEqual([saved.code, saved.json.action, saved.json.path], [0, 'created', '.cohort/personas/searcher.md']);
  const again = await cli(['explore', 'save', json.runId, '--persona', 'searcher', '--yes']);
  assert.deepEqual([again.code, again.json.code], [2, 'conflict']);
  const stale = await cli(['explore', 'save', json.runId, '--persona', 'searcher', '--yes', '--revision', 'sha256:0']);
  assert.deepEqual([stale.code, stale.json.code], [2, 'conflict']);
  const replaced = await cli([
    'explore',
    'save',
    json.runId,
    '--persona',
    'searcher',
    '--yes',
    '--revision',
    saved.json.revision,
  ]);
  assert.deepEqual([replaced.code, replaced.json.action], [0, 'replaced']);
  const suite = await cli(['explore', 'save', json.runId, '--suite', json.suite.id, '--yes']);
  assert.equal(suite.code, 0, suite.out);
  assert.equal((await cli(['persona', 'validate'])).code, 0);
});

test('explore stops at its step budget and on repeated no-op loops, and still suggests from what it saw', async () => {
  suggestions = () => write({ features: [{ name: 'Search', description: 'The search page.', steps: ['s0001'] }] });
  const budget = await explore([goto('/search'), goto('/'), goto('/search')], ['--steps', '2']);
  assert.equal(budget.code, 0, budget.out);
  assert.deepEqual([budget.json.runOutcome.state, budget.json.runOutcome.limit], ['limit_reached', 'steps']);
  assert.equal(budget.json.features.length, 1);

  const sent = provider.requests.length;
  const loop = await explore([stuck]);
  assert.equal(loop.code, 0, loop.out);
  assert.deepEqual([loop.json.runOutcome.state, loop.json.runOutcome.code], ['agent_error', 'loop']);
  assert.ok(provider.requests.length - sent <= 5, 'three no-op repeats end the run');
  assert.equal(loop.json.features.length, 1);

  script = [goto('/search'), done];
  index = 0;
  const plain = await cli(['explore', '--url', `${origin}/?view=main&utm_source=email`]);
  assert.equal(plain.code, 0, plain.out);
  assert.equal(plain.json.runOutcome.state, 'completed');
  const plainSteps = await readFile(join(root, '.cohort/runs', plain.json.runId, 'steps.jsonl'), 'utf8');
  assert.ok(!plainSteps.includes('[url-value]'));

  const over = await explore([done], ['--dollars', '1', '--max-usd', '1.2']);
  assert.deepEqual([over.code, over.json.code], [2, 'over_budget']);
  const mixed = await cli(['explore', '--url', origin, '--persona', 'searcher']);
  assert.deepEqual([mixed.code, mixed.json.code], [2, 'usage']);
});

test('a detached exploration shows up in runs and keeps start-URL secrets out of steps, prompts, and specs', async () => {
  suggestions = () =>
    write({
      features: [{ name: 'Search', description: 'Reached by a link.', steps: ['s0001'] }],
      tests: [{ name: 'link', step: 's0001' }],
    });
  const started = await explore([clickLink, goto(`/search?token=${URL_SECRET}`), done], ['--detach']);
  assert.equal(started.code, 0, started.out);
  const waited = await cli(['runs', 'wait', started.json.batchId, '--timeout-ms', '60000']);
  assert.equal(waited.json.done, true);
  const runId = started.json.runIds[0];
  const suggested = await cli(['explore', 'suggest', runId]);
  assert.equal(suggested.code, 0, suggested.out);
  assert.deepEqual(
    suggested.json.features.map((feature: any) => feature.name),
    ['Search'],
  );
  assert.equal(suggested.json.tests.length, 1);
  const dir = join(root, '.cohort/runs', runId);
  const steps = await readFile(join(dir, 'steps.jsonl'), 'utf8');
  assert.match(steps, /secret_in_goto/u);
  assert.ok(!steps.includes('{{'), 'a URL value is never a fill placeholder');
  const prompt = provider.requests.at(-1)!.observation.text;
  for (const text of [steps, prompt, suggested.out, ...(await filesUnder(join(dir, 'suggestions')))])
    assert.ok(!text.includes(URL_SECRET));
});
