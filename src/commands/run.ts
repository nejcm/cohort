import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ConfigError } from '../config/files.ts';
import { validateSubmission, type RunSubmission } from '../config/resolve.ts';
import type { preflight } from '../core/estimate.ts';
import { EXPLORE_GOAL, saveSuggestion, suggest, SUGGEST_DOLLARS, type ExploreSummary } from '../core/explore.ts';
import { playwrightTestCliPath } from '../core/replay.ts';
import { estimate } from '../dashboard/operations.ts';
import { REPLAY_MISSING } from '../doctor.ts';
import { openIndex, runOwnedBatch, startBatch, type DetachedBatch } from '../dashboard/runner.ts';
import { bundleDir, readBundleFile, relativeRunDir } from '../evidence/bundle.ts';
import { rateText } from '../evidence/report.ts';
import { urlSecrets } from '../personas/generate.ts';
import { providerKeys } from '../providers/registry.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import { scrubEnv } from '../setup/run.ts';
import { safeUrl, SecretStore } from '../setup/secrets.ts';
import { CliError, emit, readInput, type Context, type Dependencies, type Values, type Write } from './context.ts';

export const DEFAULT_MAX_USD = 10;
/** The hidden subcommand a detached `cohort run --detach` spawns to own the batch. */
export const WORKER = '_worker';

function submissionFrom(values: Values): RunSubmission {
  const selectors = (['persona', 'tag', 'suite'] as const).filter((key) => values[key] !== undefined);
  if (selectors.length > 1) throw new ConfigError('choose one of --persona, --tag, --suite');
  const number = (key: string): number | undefined =>
    values[key] === undefined ? undefined : Number(values[key] as string);
  const limits = Object.fromEntries(
    [
      ['steps', number('steps')],
      ['timeMs', number('time-ms')],
      ['dollars', number('dollars')],
    ].filter(([, value]) => value !== undefined),
  );
  const key = selectors[0];
  const selector =
    key === 'persona'
      ? { kind: 'persona', id: values.persona }
      : key === 'tag'
        ? { kind: 'tag', tag: values.tag }
        : key === 'suite'
          ? { kind: 'suite', id: values.suite }
          : { kind: 'adhoc' };
  if (selector.kind === 'adhoc' && values.url === undefined && values.note === undefined)
    throw new ConfigError('choose --persona, --tag, --suite, or --url with --note');
  const optional = {
    url: values.url,
    note: values.note,
    mode: values.mode,
    model: values.model,
    effort: values.effort,
  };
  return validateSubmission({
    selector,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    ...(values.repeats === undefined ? {} : { repeats: number('repeats') }),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  });
}

type Plan = ReturnType<typeof preflight>;

function budgetLine(plan: Plan): string {
  return plan.maxBatchUsd === null
    ? 'maximum batch budget: unenforceable (some models have unknown prices)'
    : `maximum batch budget: $${plan.maxBatchUsd.toFixed(2)}`;
}

function costRefusal(plan: Plan, values: Values): { maxUsd: number; refusal: CliError | null } {
  const maxUsd = values['max-usd'] === undefined ? DEFAULT_MAX_USD : Number(values['max-usd']);
  if (!(Number.isFinite(maxUsd) && maxUsd > 0 && maxUsd <= 1000))
    throw new CliError('usage', '--max-usd must be in (0, 1000]');
  const preview = { preflight: plan.lines, plans: plan.plans, maxBatchUsd: plan.maxBatchUsd, maxUsd };
  if (plan.maxBatchUsd === null && values['allow-unpriced'] !== true)
    return {
      maxUsd,
      refusal: new CliError(
        'cap_unenforceable',
        'a model has unknown prices, so the dollar cap cannot be enforced; add dated prices to .cohort/models.yml or pass --allow-unpriced',
        { estimate: preview },
      ),
    };
  if (plan.maxBatchUsd !== null && plan.maxBatchUsd > maxUsd)
    return {
      maxUsd,
      refusal: new CliError(
        'over_budget',
        `maximum batch budget $${plan.maxBatchUsd.toFixed(2)} exceeds the $${maxUsd} ceiling; lower --repeats or --dollars, or raise --max-usd`,
        { estimate: preview },
      ),
    };
  return { maxUsd, refusal: null };
}

export async function estimateCommand(ctx: Context): Promise<number> {
  const { plan } = await estimate(
    ctx.root,
    ctx.providers,
    submissionFrom(ctx.values),
    ctx.values['allow-untested'] === true,
  );
  const { maxUsd, refusal } = costRefusal(plan, ctx.values);
  if (ctx.json)
    emit(ctx.write, {
      preflight: plan.lines,
      plans: plan.plans,
      maxBatchUsd: plan.maxBatchUsd,
      maxUsd,
      refusal: refusal ? { code: refusal.code, error: refusal.message } : null,
    });
  else {
    ctx.write(`${plan.lines.join('\n')}\n${budgetLine(plan)}\n`);
    ctx.write(refusal ? `cohort run would refuse: ${refusal.message}\n` : `within the $${maxUsd} ceiling\n`);
  }
  return 0;
}

export async function workerCommand(ctx: Context, deps: Dependencies): Promise<number> {
  const batch = JSON.parse(await readInput({ ...ctx, values: { file: '-' } })) as DetachedBatch;
  const started = await startBatch(
    {
      projectRoot: ctx.root,
      providers: ctx.providers,
      env: deps.env ?? process.env,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
    batch,
  );
  ctx.write(`${JSON.stringify({ batchId: started.batchId, runIds: started.runIds })}\n`);
  await started.done;
  return 0;
}

// A detached batch needs a process that outlives this one; the child owns the batch in the index and exits when done.
// `entry` is the CLI script to re-run (`src/cli.ts` or `dist/cli.js`), which only the entry module knows.
export function spawnWorker(entry: string, projectRoot: string, env: NodeJS.ProcessEnv, batch: DetachedBatch) {
  const child = spawn(process.execPath, [entry, WORKER, '--json'], {
    cwd: projectRoot,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  // Entries travel over a pipe, never argv or the index, because a start URL may carry credentials.
  child.stdin.end(JSON.stringify(batch));
  return new Promise<{ batchId: string; runIds: string[] }>((resolve, reject) => {
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0) return;
      child.stdout.destroy();
      child.unref();
      const reply = JSON.parse(text.slice(0, end)) as {
        batchId: string;
        runIds: string[];
        error?: string;
        code?: string;
      };
      if (reply.error) reject(new CliError(reply.code ?? 'internal', reply.error));
      else resolve(reply);
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new CliError('internal', `the batch process exited (${code}) before starting the batch`)),
    );
  });
}

function exploreValues(values: Values): Values {
  const refused = ['persona', 'tag', 'suite', 'note', 'repeats'].filter((key) => values[key] !== undefined);
  if (refused.length > 0) throw new CliError('usage', `cohort explore does not take --${refused.join(', --')}`);
  if (values.url === undefined) throw new CliError('usage', 'cohort explore needs --url <url>');
  return { ...values, note: EXPLORE_GOAL, repeats: '1' };
}

function exploreScrub(env: NodeJS.ProcessEnv, providers: Record<string, ProviderAdapter>, url?: string) {
  const keys = providerKeys(env, providers);
  const secrets = url && URL.canParse(url) ? urlSecrets(new URL(url)) : new SecretStore();
  return (text: string): string => scrubEnv(text, secrets, keys);
}

function writeSummary(write: Write, summary: ExploreSummary): void {
  const dir = relativeRunDir(summary.runId);
  for (const feature of summary.features) write(`feature: ${feature.name} (steps ${feature.steps.join(', ')})\n`);
  for (const item of summary.untried) write(`untried: ${item.step} ${item.reason}\n`);
  for (const item of summary.dropped) write(`dropped ${item.kind} ${item.name}: ${item.reason}\n`);
  write(
    `${summary.personas.length} persona(s), ${summary.goals.length} goal(s), ${summary.tests.length} test(s) suggested in ${dir}/suggestions; ${summary.coverage}\n`,
  );
  for (const persona of summary.personas)
    write(`review, then: cohort explore save ${summary.runId} --persona ${persona.id} --yes\n`);
  if (summary.suite) write(`review, then: cohort explore save ${summary.runId} --suite ${summary.suite.id} --yes\n`);
}

export async function suggestCommand(runId: string, ctx: Context, deps: Dependencies): Promise<number> {
  const summary = await suggest({
    projectRoot: ctx.root,
    runId,
    providers: ctx.providers,
    scrub: exploreScrub(deps.env ?? process.env, ctx.providers),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (ctx.json) emit(ctx.write, summary);
  else writeSummary(ctx.write, summary);
  return 0;
}

export async function saveCommand(runId: string, ctx: Context): Promise<number> {
  const { values } = ctx;
  const kind = values.persona !== undefined ? 'personas' : 'suites';
  const id = (values.persona ?? values.suite) as string | undefined;
  if (!id || (values.persona !== undefined && values.suite !== undefined))
    throw new CliError('usage', 'cohort explore save <run-id> needs one of --persona <id> or --suite <id>');
  if (values.yes !== true) {
    const { dir } = await bundleDir(ctx.root, runId);
    const name = kind === 'personas' ? `suggestions/personas/${id}.md` : 'suggestions/suite.yml';
    const source = /^[a-z0-9][a-z0-9-]{0,63}$/u.test(id) ? await readBundleFile(dir, name) : null;
    if (!ctx.json && source !== null) ctx.write(source);
    throw new CliError('confirmation_required', `review ${name} in ${runId}, then pass --yes to save it`);
  }
  const saved = await saveSuggestion(ctx.root, runId, kind, id, values.revision as string | undefined);
  const path = `.cohort/${kind}/${saved.id}.${kind === 'personas' ? 'md' : 'yml'}`;
  if (ctx.json) emit(ctx.write, { id: saved.id, revision: saved.revision, path, action: saved.action });
  else ctx.write(`${saved.action} ${path}\n`);
  return 0;
}

/** `cohort run` and `cohort explore`; the caller supplies the detached-batch worker since only it knows the CLI entry. */
export async function runCommand(
  given: Values,
  write: Write,
  deps: Dependencies & { worker: NonNullable<Dependencies['worker']> },
  ctx: Context,
  explore = false,
): Promise<number> {
  const projectRoot = ctx.root;
  const env = deps.env ?? process.env;
  const { providers } = ctx;
  const values = explore ? exploreValues(given) : given;
  const submission = submissionFrom(values);
  const estimated = await estimate(projectRoot, providers, submission, values['allow-untested'] === true);
  const entries = explore
    ? estimated.entries.map((entry) => ({ ...entry, explore: true as const }))
    : estimated.entries;
  const plan =
    explore && estimated.plan.maxBatchUsd !== null
      ? { ...estimated.plan, maxBatchUsd: estimated.plan.maxBatchUsd + SUGGEST_DOLLARS }
      : estimated.plan;
  if (!values.json) write(`${plan.lines.join('\n')}\n${budgetLine(plan)}\n`);
  const { maxUsd, refusal } = costRefusal(plan, values);
  if (refusal) throw refusal;
  const request = {
    submission: submission.url ? { ...submission, url: safeUrl(submission.url, new SecretStore()) } : submission,
    allowUntested: values['allow-untested'] === true,
    source: explore ? 'explore' : 'cli',
  };
  if (values.detach) {
    const started = await deps.worker({ entries, request });
    if (values.json)
      emit(write, { ...started, preflight: plan.lines, plans: plan.plans, maxBatchUsd: plan.maxBatchUsd, maxUsd });
    else
      write(
        `batch ${started.batchId} started in the background; next: cohort runs wait ${started.batchId}${explore ? `, then cohort explore suggest ${started.runIds[0]}` : ''}\n`,
      );
    return 0;
  }
  const db = await openIndex(projectRoot).catch((error: NodeJS.ErrnoException) => {
    throw new CliError(
      'index_unavailable',
      `cannot open .cohort/index.sqlite (${error.code ?? error.name}); a foreground run needs a writable index`,
    );
  });
  const batch = await runOwnedBatch(
    db,
    {
      projectRoot,
      entries,
      providers,
      env,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onRunStart: values.json
        ? undefined
        : (started) => write(`run ${started.runId} (${started.personaId}, repeat ${started.repeat + 1})\n`),
    },
    request,
  ).finally(() => db.close());
  if (explore) {
    const [explored] = batch.runs;
    if (!explored) throw new CliError('interrupted', 'the exploration run did not start');
    const summary = await suggest({
      projectRoot,
      runId: explored.runId,
      providers,
      scrub: exploreScrub(env, providers, values.url as string),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (values.json) emit(write, { batchId: batch.batchId, maxUsd, runOutcome: explored.outcome, ...summary });
    else {
      write(`${explored.runId}: ${explored.outcome.state}: ${explored.outcome.reason}\n`);
      writeSummary(write, summary);
    }
    return 0;
  }
  const exitCode = batch.skipped === 0 && batch.runs.every((item) => item.outcome.state === 'completed') ? 0 : 1;
  if (values.json)
    emit(write, {
      batchId: batch.batchId,
      preflight: plan.lines,
      plans: plan.plans,
      maxBatchUsd: plan.maxBatchUsd,
      maxUsd,
      runs: batch.runs,
      skipped: batch.skipped,
      summary: batch.summary,
      reportDir: batch.reportDir,
      exitCode,
    });
  else {
    for (const item of batch.runs) {
      const detail =
        'code' in item.outcome ? ` ${item.outcome.code}` : 'limit' in item.outcome ? ` ${item.outcome.limit}` : '';
      write(`${item.runId}: ${item.outcome.state}${detail}: ${item.outcome.reason}\n`);
    }
    if (batch.skipped > 0) write(`${batch.skipped} run(s) not started: cancelled\n`);
    for (const group of batch.summary.groups)
      write(
        `${group.personaId} ${group.provider}/${group.model} ${group.effort}: completion ${rateText(group.completion)}, blocked ${Object.values(group.blocked.byKind).reduce((a, b) => a + b, 0)}, user cancellations ${group.userCancellations}, cost $${group.costUsd.total.toFixed(4)}${group.costUsd.unknownRuns > 0 ? ` + ${group.costUsd.unknownRuns} unknown` : ''}\n`,
      );
    for (const warning of batch.summary.warnings) write(`warning: ${warning}\n`);
    write(`report: ${join(batch.reportDir, 'report.html')}\n`);
    if (batch.runs.length > 0 && playwrightTestCliPath(ctx.root) === null) write(`note: ${REPLAY_MISSING}\n`);
  }
  return exitCode;
}
