// Installs the packed tarball with npm into a fresh directory, with Bun removed from PATH, and exercises the
// installed CLI, library, dashboard and Action script. Needs `bun run build` first and npm registry access.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { startFixture } from '../tests/fixtures/friction-app/server.ts';

const repoRoot = new URL('..', import.meta.url).pathname;
const exec = promisify(execFile);
for (const built of ['dist/cli.js', 'dist/index.js', 'dist/ui/index.html'])
  assert.ok(existsSync(join(repoRoot, built)), `${built} is missing; run bun run build first`);

const PATH = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((dir) => !existsSync(join(dir, 'bun')))
  .join(delimiter);
const env = { PATH, HOME: process.env.HOME, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };
const clean = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv;
await exec('bun', ['--version'], { env: clean }).then(
  () => assert.fail('bun is still on PATH'),
  () => {},
);

const work = await mkdtemp(join(tmpdir(), 'lab-package-'));
const app = join(work, 'app');
const fixture = await startFixture();
const step = (text: string): void => void process.stdout.write(`- ${text}\n`);
try {
  // npm 11 prints an array, npm 12 an object keyed by package name.
  const [packed] = Object.values(
    JSON.parse(
      (await exec('npm', ['pack', '--json', '--pack-destination', work], { cwd: repoRoot, env: clean })).stdout,
    ),
  ) as { filename: string; version: string; files: { path: string }[] }[];
  const shipped = packed!.files.map((file) => file.path);
  for (const required of [
    'dist/cli.js',
    'dist/ui/index.html',
    'LICENSE',
    'NOTICE',
    'examples/personas/first-time-host.md',
    'examples/suites/keyboard-pack.yml',
  ])
    assert.ok(shipped.includes(required), `package contains ${required}`);
  for (const path of shipped)
    assert.match(
      path,
      /^(dist\/|examples\/personas\/|examples\/suites\/[a-z-]+-pack\.yml$|LICENSE$|NOTICE$|README\.md$|package\.json$)/u,
    );
  step(`packed ${packed!.filename}: ${shipped.length} files`);

  await mkdir(app);
  await exec('npm', ['install', '--no-audit', '--no-fund', '--silent', join(work, packed!.filename)], {
    cwd: app,
    env: clean,
  });
  const labBin = join(app, 'node_modules', '.bin', 'cohort');
  const lab = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    exec(labBin, args, { cwd: app, env: { ...clean, ...extra } }).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
    );
  step(
    `installed with npm ${(await exec('npm', ['--version'], { env: clean })).stdout.trim()}, node ${process.version}, no bun on PATH`,
  );

  assert.equal((await lab(['--version'])).stdout.trim(), packed!.version);
  assert.equal((await lab(['init'])).code, 0);
  assert.match((await lab(['persona', 'validate'])).stdout, /3 valid persona\(s\)/u);
  const doctor = JSON.parse((await lab(['doctor', '--json'])).stdout) as {
    checks: { level: string; message: string }[];
  };
  for (const pattern of [/^node /u, /^chromium installed/u, /^\.cohort\/config\.yml is valid/u])
    assert.equal(doctor.checks.find((check) => pattern.test(check.message))?.level, 'ok', String(pattern));
  step('cohort --version, init, persona validate, doctor');

  await writeFile(
    join(app, '.cohort/config.yml'),
    'schemaVersion: 1\nmodel: openai/smoke-model\nrepeats: 1\nlimits: { steps: 5, timeMs: 60000 }\n',
  );
  await writeFile(
    join(app, '.cohort/models.yml'),
    'version: smoke\nmodels:\n  - id: smoke-model\n    provider: openai\n    label: smoke\n    visionCapable: true\n    supportedEffortLevels: [low]\n    defaultEffort: low\n    pricesPerMTok: { input: 1, output: 4, cachedInput: null, cacheWrite: 1 }\n    pricingVerifiedAt: 2026-10-01\n    untested: false\n',
  );
  await writeFile(
    join(app, 'smoke-run.mjs'),
    `import { loadCatalog, loadProjectConfig, resolveSubmission, runBatch, validateSubmission } from 'cohort-lab';
const provider = {
  id: 'openai', keyEnv: 'OPENAI_API_KEY', available: () => true,
  async decide(request) {
    const step = /Latest step: (s\\d{4,})/u.exec(request.observation.text)[1];
    return { calls: [{ name: 'done', args: { step, summary: 'Landing page reached.' } }],
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, imageInputTokens: null, reportedCostUsd: null, source: 'provider' },
      returnedModel: 'smoke-model' };
  },
};
const projectRoot = process.cwd();
const [project, catalog] = await Promise.all([loadProjectConfig(projectRoot), loadCatalog(projectRoot)]);
const submission = validateSubmission({ selector: { kind: 'persona', id: 'first-time-host' }, url: process.argv[2] });
const entries = await resolveSubmission(submission, { projectRoot, project, catalog, providers: { openai: provider } });
const batch = await runBatch({ projectRoot, entries, providers: { openai: provider }, env: {} });
console.log(JSON.stringify({ batchId: batch.batchId, runs: batch.runs.map((run) => ({ runId: run.runId, state: run.outcome.state })) }));
`,
  );
  const ran = JSON.parse(
    (await exec(process.execPath, ['smoke-run.mjs', `${fixture.url}/`], { cwd: app, env: clean })).stdout,
  ) as { batchId: string; runs: { runId: string; state: string }[] };
  const runId = ran.runs[0]!.runId;
  assert.equal(ran.runs[0]!.state, 'completed');
  for (const file of ['manifest.json', 'report.html', 'trace.zip', 'replay.spec.ts', 'screenshots/shot-0000.png'])
    assert.ok(existsSync(join(app, '.cohort/runs', runId, file)), `${file} written`);
  assert.match((await lab(['report', runId, '--format', 'md'])).stdout, /completed/u);
  step(`fixture run through the installed library: ${runId} completed; cohort report`);

  const ui = spawn(labBin, ['ui', '--port', '0'], { cwd: app, env: clean, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      ui.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        const match = /dashboard: (\S+)/u.exec(out);
        if (match) resolve(match[1]!);
      });
      ui.on('exit', () => reject(new Error(`cohort ui exited: ${out}`)));
    });
    const { origin, hash } = new URL(url);
    const token = new URLSearchParams(hash.slice(1)).get('token');
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/u);
    assert.equal((await fetch(`${origin}/api/runs`)).status, 401);
    const runs = await fetch(`${origin}/api/runs`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(runs.status, 200);
    assert.match(await runs.text(), new RegExp(runId, 'u'));
  } finally {
    ui.kill('SIGINT');
  }
  step('cohort ui serves the packaged dashboard and authenticated API');

  const outputFile = join(work, 'github-output');
  await exec(process.execPath, [join(repoRoot, 'action/run.ts')], {
    cwd: app,
    env: {
      ...clean,
      COHORT_BIN: labBin,
      GITHUB_OUTPUT: outputFile,
      INPUT_PERSONA: 'first-time-host',
      INPUT_URL: `${fixture.url}/`,
    },
  }).then(
    () => assert.fail('the Action script should fail without a provider key'),
    (error: { code: number }) => assert.equal(error.code, 2),
  );
  assert.match(await readFile(outputFile, 'utf8'), /^exit-code=2$/mu);
  step('Action script maps the installed CLI result (no key: exit-code=2)');
  process.stdout.write('package smoke passed\n');
} finally {
  await fixture.close();
  await rm(work, { recursive: true, force: true });
}
