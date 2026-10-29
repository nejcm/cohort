// Seeds a throwaway project with real run bundles (fixture app + scripted model) for local dashboard development.
// Run: node scripts/seed.ts [dir]   then: cd <dir> && node ../src/cli.ts ui   (default dir: .seed)
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run } from '../src/cli.ts';
import { startFixture } from '../tests/fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId, type Turn } from '../tests/helpers/fake-provider.ts';

const root = resolve(process.argv[2] ?? '.seed');
const personasDir = new URL('../examples/personas/', import.meta.url).pathname;
const PERSONAS = [
  'mobile-first-guest',
  'keyboard-only-navigator',
  'returning-desktop-user',
  'small-screen-form-filler',
  'cautious-banking-user',
];
const MODELS = [
  {
    id: 'fast-mini',
    label: 'Fast mini',
    prices: '{ input: 0.25, output: 1, cachedInput: 0.03, cacheWrite: 0.3125 }',
    tokens: [900, 60],
  },
  {
    id: 'deep-pro',
    label: 'Deep pro',
    prices: '{ input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 }',
    tokens: [1800, 120],
  },
] as const;

type Outcome = 'completed' | 'abandoned' | 'blocked' | 'limit_reached' | 'agent_error';
interface Batch {
  persona: string;
  mutated: boolean;
  model: (typeof MODELS)[number]['id'];
  outcomes: Outcome[];
}
const BATCHES: Batch[] = [
  {
    persona: 'mobile-first-guest',
    mutated: false,
    model: 'fast-mini',
    outcomes: ['completed', 'completed', 'completed', 'abandoned'],
  },
  {
    persona: 'mobile-first-guest',
    mutated: true,
    model: 'fast-mini',
    outcomes: ['abandoned', 'completed', 'abandoned', 'limit_reached'],
  },
  {
    persona: 'keyboard-only-navigator',
    mutated: false,
    model: 'deep-pro',
    outcomes: ['completed', 'completed', 'limit_reached'],
  },
  {
    persona: 'keyboard-only-navigator',
    mutated: true,
    model: 'deep-pro',
    outcomes: ['limit_reached', 'abandoned', 'completed'],
  },
  {
    persona: 'returning-desktop-user',
    mutated: false,
    model: 'fast-mini',
    outcomes: ['completed', 'completed', 'completed'],
  },
  {
    persona: 'small-screen-form-filler',
    mutated: true,
    model: 'deep-pro',
    outcomes: ['completed', 'abandoned', 'blocked', 'completed'],
  },
  {
    persona: 'cautious-banking-user',
    mutated: false,
    model: 'fast-mini',
    outcomes: ['blocked', 'blocked', 'abandoned'],
  },
  { persona: 'cautious-banking-user', mutated: true, model: 'deep-pro', outcomes: ['completed', 'abandoned'] },
  { persona: 'mobile-first-guest', mutated: false, model: 'fast-mini', outcomes: ['agent_error', 'agent_error'] },
  {
    persona: 'returning-desktop-user',
    mutated: true,
    model: 'fast-mini',
    outcomes: ['completed', 'limit_reached', 'completed', 'completed', 'abandoned'],
  },
];

const stepNumber = (step: string): number => Number(step.slice(1));
const call = (name: string, args: Record<string, unknown>, step: string) => ({ name, args: { ...args, step } });
const wait = { name: 'wait', args: { ms: 100 } };

function journey(outcome: Outcome, mutated: boolean): Turn {
  const friction = mutated ? 'The link wording does not say what it does.' : 'The page loads slowly on my connection.';
  return (request) => {
    const step = lastStepId(request);
    const n = stepNumber(step);
    if (outcome === 'limit_reached')
      return n % 2 === 0
        ? wait
        : { name: 'scroll', args: { observationId: request.observation.id, target: null, deltaX: 0, deltaY: 200 } };
    if (outcome === 'blocked')
      return n < 1
        ? { name: 'goto', args: { url: '/lab/oauth' } }
        : call('report_blocked', { kind: 'oauth', reason: 'Login goes through an external provider.' }, step);
    const path = ['/arrival', '/request', '/contact'][n];
    if (path && n < 3) return { name: 'goto', args: { url: path } };
    if (n === 3) return call('report_friction', { reason: friction }, step);
    return outcome === 'abandoned'
      ? call('give_up', { kind: 'journey_abandoned', reason: 'I could not tell which option fits my trip.' }, step)
      : call('done', { summary: 'The request form is reachable.' }, step);
  };
}

await rm(root, { recursive: true, force: true });
await mkdir(join(root, '.cohort', 'personas'), { recursive: true });
await writeFile(
  join(root, '.cohort', 'config.yml'),
  'schemaVersion: 1\nmodel: openai/fast-mini\nlimits: { steps: 8, timeMs: 60000 }\n',
);
await writeFile(
  join(root, '.cohort', 'models.yml'),
  `version: seed\nmodels:\n${MODELS.map(
    (m) =>
      `  - id: ${m.id}\n    provider: openai\n    label: ${m.label}\n    visionCapable: true\n    supportedEffortLevels: [low]\n    defaultEffort: low\n    pricesPerMTok: ${m.prices}\n    pricingVerifiedAt: 2026-10-01\n    untested: false\n`,
  ).join('')}`,
);
for (const id of PERSONAS) await cp(join(personasDir, `${id}.md`), join(root, '.cohort', 'personas', `${id}.md`));

const clean = await startFixture();
const mutated = await startFixture({ mutations: ['confusing_label', 'icon_only', 'extra_field'] });
try {
  for (const batch of BATCHES) {
    const model = MODELS.find((m) => m.id === batch.model)!;
    let started = 0;
    const provider = fakeProvider(
      (request, index) => {
        if (stepNumber(lastStepId(request)) <= 0) started += 1;
        return journey(batch.outcomes[started - 1]!, batch.mutated)(request, index);
      },
      { inputTokens: model.tokens[0], outputTokens: model.tokens[1] },
    );
    const target = batch.mutated ? mutated : clean;
    const url = batch.outcomes.every((o) => o === 'agent_error') ? 'http://127.0.0.1:9/' : target.url;
    let text = '';
    await run(
      [
        'run',
        '--persona',
        batch.persona,
        '--url',
        url,
        '--model',
        `openai/${batch.model}`,
        '--repeats',
        String(batch.outcomes.length),
        '--json',
      ],
      (chunk) => void (text += chunk),
      { cwd: root, env: {}, providers: { openai: provider } },
    );
    process.stdout.write(`${batch.persona} ${batch.model}${batch.mutated ? ' mutated' : ''}: ${text.length} bytes\n`);
  }
} finally {
  await clean.close();
  await mutated.close();
}
process.stdout.write(`seeded ${root}\n`);
