// Regenerates one bundle per outcome plus their batch report from the fixture app and a scripted model, laid out like .cohort/runs.
// Run: node examples/report-examples.ts
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { run } from '../src/cli.ts';
import { writeBatchReports } from '../src/evidence/bundle.ts';
import { buildBatchReport, type RunReport } from '../src/evidence/report.ts';
import { startFixture } from '../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId, type Turn } from '../tests/helpers/fake-provider.ts';

const out = new URL('../docs/report-examples', import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), 'lab-examples-'));
const fixture = await startFixture();
const put = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};
await put('.cohort/config.yml', 'schemaVersion: 1\nmodel: openai/example-model\nlimits: { steps: 4, timeMs: 30000 }\n');
await put(
  '.cohort/models.yml',
  'version: example\nmodels:\n  - id: example-model\n    provider: openai\n    label: Example model\n    visionCapable: true\n    supportedEffortLevels: [low]\n    defaultEffort: low\n    pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1 }\n    pricingVerifiedAt: 2026-10-01\n    untested: false\n',
);
await put(
  '.cohort/personas/guest.md',
  '---\nschemaVersion: 1\nid: guest\nname: Guest\ntags: [guest]\ndevice: { viewport: { width: 800, height: 600 }, touch: false }\nlocale: en-US\ntimezone: UTC\ngoal: Request a stay.\n---\n\nYou are a first-time guest.\n',
);

const cited =
  (name: string, args: Record<string, unknown>): Turn =>
  (request) => ({
    name,
    args: { ...args, step: lastStepId(request) },
  });
const examples: { name: string; path: string; turn: Turn }[] = [
  { name: 'completed', path: '/', turn: cited('done', { summary: 'The request form is reachable.' }) },
  {
    name: 'abandoned',
    path: '/',
    turn: cited('give_up', { kind: 'journey_abandoned', reason: 'The arrival times do not fit my trip.' }),
  },
  { name: 'blocked', path: '/lab/oauth', turn: cited('report_blocked', { kind: 'oauth', reason: 'Login provider.' }) },
  {
    name: 'limit_reached',
    path: '/',
    turn: (request, index) =>
      index % 2 === 0
        ? { name: 'wait', args: { ms: 100 } }
        : { name: 'scroll', args: { observationId: request.observation.id, target: null, deltaX: 0, deltaY: 200 } },
  },
  { name: 'interrupted', path: '/', turn: () => new Promise<never>(() => controller.abort('user')) },
  { name: 'agent_error', path: 'unreachable', turn: () => ({ name: 'wait', args: { ms: 100 } }) },
];

const reports: RunReport[] = [];
let controller = new AbortController();
try {
  await rm(out, { recursive: true, force: true });
  for (const example of examples) {
    controller = new AbortController();
    const url = example.path === 'unreachable' ? 'http://127.0.0.1:9/' : `${fixture.url}${example.path}`;
    let text = '';
    await run(['run', '--persona', 'guest', '--url', url, '--json'], (chunk) => void (text += chunk), {
      cwd: root,
      env: {},
      providers: { openai: fakeProvider(example.turn) },
      signal: controller.signal,
    });
    const [result] = (JSON.parse(text) as { runs: { outDir: string; outcome: { state: string; code?: string } }[] })
      .runs;
    assert.ok(result);
    assert.equal(result.outcome.code === 'interrupted' ? 'interrupted' : result.outcome.state, example.name);
    const target = join(out, basename(result.outDir));
    // Native traces are private evidence and never published.
    await cp(result.outDir, target, { recursive: true, filter: (path) => !path.endsWith('trace.zip') });
    reports.push(JSON.parse(await readFile(join(target, 'report.json'), 'utf8')) as RunReport);
  }
  const batchId = 'batch_20261028_000000_000000';
  await mkdir(join(out, batchId));
  await writeBatchReports(join(out, batchId), buildBatchReport(batchId, reports, 0));
  for (const entry of await readdir(out, { recursive: true }))
    if (/\.(json|jsonl|md|html|ts)$/u.test(entry))
      assert.ok(!(await readFile(join(out, entry), 'utf8')).includes(root), `${entry} names the temp project`);
} finally {
  await fixture.close();
  await rm(root, { recursive: true, force: true });
}
