import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const repoRoot = new URL('../..', import.meta.url).pathname;

interface Step {
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

test('the Action never interpolates inputs into shell, takes no secrets as inputs, and uploads nothing', async () => {
  const action = parse(await readFile(join(repoRoot, 'action.yml'), 'utf8')) as {
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    runs: { using: string; steps: Step[] };
  };
  assert.equal(action.runs.using, 'composite');
  for (const step of action.runs.steps) {
    assert.equal(step.uses, undefined, 'no third-party steps, so nothing is uploaded');
    assert.doesNotMatch(step.run ?? '', /\$\{\{/u, `inputs reach "${step.run}" only through env`);
  }
  for (const name of Object.keys(action.inputs)) assert.doesNotMatch(name, /key|token|secret|password/iu);
  assert.match(action.runs.steps[0]!.run!, /GITHUB_ACTION_PATH \+ '\/package\.json'/u, 'installs this release');
  assert.deepEqual(Object.keys(action.outputs).toSorted(), [...OUTPUTS].toSorted());
});

const OUTPUTS = [
  'batch-id',
  'report-path',
  'exit-code',
  'runs',
  'completed',
  'abandoned',
  'blocked',
  'agent-error',
  'limit-reached',
];

test('the Action script passes inputs as argv and maps the JSON result to outputs and the exit code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lab-action-'));
  const stub = join(dir, 'cohort');
  const outputFile = join(dir, 'output');
  await writeFile(
    stub,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ batchId: 'batch_x', reportDir: '/w/.cohort/runs/batch_x', exitCode: 1,
  runs: [{ outcome: { state: 'completed' } }, { outcome: { state: 'blocked' } }, { outcome: { state: 'blocked' } }] }));
process.exitCode = 1;
`,
  );
  await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}');
  await chmod(stub, 0o755);
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [join(repoRoot, 'action/run.ts')],
      {
        env: {
          PATH: process.env.PATH,
          COHORT_BIN: stub,
          GITHUB_OUTPUT: outputFile,
          INPUT_SUITE: 'smoke; echo pwned $(id)',
          INPUT_MODEL: '',
          INPUT_REPEATS: '2',
          INPUT_ALLOW_UNTESTED: 'true',
          OPENAI_API_KEY: 'sk-action-canary-123456',
        },
      },
      (_error, stdout) => resolve({ code: child.exitCode, stdout }),
    );
  });
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')), [
    'run',
    '--json',
    '--suite',
    'smoke; echo pwned $(id)',
    '--repeats',
    '2',
    '--allow-untested',
  ]);
  const outputs = Object.fromEntries(
    (await readFile(outputFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string]),
  );
  assert.deepEqual(Object.keys(outputs).toSorted(), [...OUTPUTS].toSorted());
  assert.equal(outputs['batch-id'], 'batch_x');
  assert.equal(outputs['report-path'], '/w/.cohort/runs/batch_x/report.html');
  assert.deepEqual([outputs.runs, outputs.completed, outputs.blocked, outputs['exit-code']], ['3', '1', '2', '1']);
  assert.doesNotMatch(result.stdout, /sk-action-canary/u);
});

test('the documented workflow keeps keys in secrets and never uploads traces or saved logins', async () => {
  const doc = await readFile(join(repoRoot, 'docs/github-action.md'), 'utf8');
  const block = /```yaml\n([\s\S]*?)```/u.exec(doc)?.[1];
  assert.ok(block, 'docs/github-action.md has a yaml example');
  const workflow = parse(block) as { jobs: Record<string, { steps: Step[] }> };
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const lab = steps.find((step) => step.uses?.includes('cohort-lab'))!;
  assert.ok(lab, 'the example uses the Action');
  for (const value of Object.values(lab.env ?? {})) assert.match(value, /^\$\{\{ secrets\.[A-Z_]+ \}\}$/u);
  assert.ok(Object.keys(lab.with ?? {}).every((name) => !/key|token|secret/iu.test(name)));
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact'))!;
  const paths = upload.with!.path!.split('\n').map((line) => line.trim());
  assert.ok(paths.includes('!.cohort/runs/**/trace.zip'), 'traces are excluded');
  assert.ok(
    !paths.some((path) => path.includes('.cohort/auth') && !path.startsWith('!')),
    'saved logins are not uploaded',
  );
});
