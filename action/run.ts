import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

// Inputs arrive as environment variables, never interpolated into a shell, and keys stay in the job environment.
const FLAGS = ['persona', 'tag', 'suite', 'url', 'note', 'model', 'effort', 'repeats', 'max-usd'] as const;
const STATES = ['completed', 'abandoned', 'blocked', 'agent_error', 'limit_reached'] as const;

interface RunJson {
  batchId?: string;
  reportDir?: string;
  runs?: { outcome: { state: string } }[];
  exitCode?: number;
  error?: string;
}

const env = process.env;
const args = ['run', '--json'];
for (const flag of FLAGS) {
  const value = env[`INPUT_${flag.toUpperCase().replace('-', '_')}`];
  if (value) args.push(`--${flag}`, value);
}
if (env.INPUT_ALLOW_UNTESTED === 'true') args.push('--allow-untested');
if (env.INPUT_ALLOW_UNPRICED === 'true') args.push('--allow-unpriced');

const child = spawn(env.COHORT_BIN ?? 'cohort', args, { stdio: ['ignore', 'pipe', 'inherit'] });
let stdout = '';
child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString('utf8')));
const exitCode = await new Promise<number>((resolve) => {
  child.on('error', () => resolve(2));
  child.on('close', (code) => resolve(code ?? 2));
});

let result: RunJson = {};
try {
  result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as RunJson;
} catch {
  result = { error: 'cohort did not print a JSON result' };
}
const counts = Object.fromEntries(
  STATES.map((state) => [state, (result.runs ?? []).filter((item) => item.outcome.state === state).length]),
);
const outputs: Record<string, string | number> = {
  'batch-id': result.batchId ?? '',
  'report-path': result.reportDir ? `${result.reportDir}/report.html` : '',
  'exit-code': exitCode,
  runs: result.runs?.length ?? 0,
  completed: counts.completed!,
  abandoned: counts.abandoned!,
  blocked: counts.blocked!,
  'agent-error': counts.agent_error!,
  'limit-reached': counts.limit_reached!,
};
if (env.GITHUB_OUTPUT)
  await appendFile(
    env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([name, value]) => `${name}=${String(value).replaceAll('\n', ' ')}\n`)
      .join(''),
  );
const summary = result.error
  ? `cohort: ${result.error}`
  : `cohort batch ${outputs['batch-id']}: ${outputs.runs} run(s), ${counts.completed} completed, ${counts.blocked} blocked, ${counts.abandoned} abandoned, ${counts.agent_error} agent error(s), ${counts.limit_reached} limit(s); report ${outputs['report-path']}`;
process.stdout.write(`${summary}\nexit code ${exitCode}\n`);
process.exitCode = exitCode;
