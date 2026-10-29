import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { checkProject, ConfigError, loadProjectConfig } from '../config/files.ts';
import { initProject } from '../config/init.ts';
import { DEFAULT_MASKS } from '../config/resolve.ts';
import { doctor } from '../doctor.ts';
import { generatePersona } from '../personas/generate.ts';
import { loadCatalog, resolveModel } from '../providers/catalog.ts';
import { createProviders } from '../providers/registry.ts';
import type { Effort } from '../providers/types.ts';
import { emit, type Context, type Dependencies, type Values, type Write } from './context.ts';

const GENERATE_DOLLARS = 0.5;

export async function initCommand(ctx: Context): Promise<number> {
  const { created, kept } = await initProject(ctx.root, ctx.values.template as string[] | undefined);
  if (ctx.json) emit(ctx.write, { created, kept });
  else {
    for (const path of created) ctx.write(`created ${path}\n`);
    for (const path of kept) ctx.write(`kept ${path} (exists)\n`);
    ctx.write('next: cohort doctor\n');
  }
  return 0;
}

export async function doctorCommand(ctx: Context, env: NodeJS.ProcessEnv): Promise<number> {
  const checks = await doctor(ctx.root, env, ctx.providers);
  if (ctx.json) emit(ctx.write, { checks });
  else for (const check of checks) ctx.write(`${check.level.padEnd(5)} ${check.message}\n`);
  return checks.some((check) => check.level === 'error') ? 2 : 0;
}

export async function validateCommand(json: boolean, write: Write, deps: Dependencies): Promise<number> {
  const { personas, suites, problems } = await checkProject(deps.cwd ?? process.cwd());
  if (json) emit(write, { personas, suites, problems });
  else {
    for (const problem of problems) write(`error: ${problem}\n`);
    write(`${personas} valid persona(s), ${suites} suite(s), ${problems.length} problem(s)\n`);
  }
  return problems.length === 0 ? 0 : 2;
}

export async function generateCommand(values: Values, write: Write, deps: Dependencies): Promise<number> {
  const { url, description, out } = values as Record<string, string | undefined>;
  if (!url || !description) throw new ConfigError('persona generate requires --url and --description');
  const dollars = values.dollars === undefined ? GENERATE_DOLLARS : Number(values.dollars);
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 1000)
    throw new ConfigError('--dollars must be in (0, 1000]');
  const projectRoot = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const [project, catalog] = await Promise.all([loadProjectConfig(projectRoot), loadCatalog(projectRoot)]);
  const effort = (values.effort as Effort | undefined) ?? project.effort;
  const resolved = resolveModel(catalog, (values.model as string | undefined) ?? project.model, {
    mode: 'vision',
    allowUntested: values['allow-untested'] === true,
    ...(effort ? { effort } : {}),
  });
  const provider = (deps.providers ?? createProviders(env))[resolved.provider];
  if (!provider?.available()) throw new ConfigError(`provider ${resolved.provider} is unavailable; set its API key`);
  const outPath = out === undefined ? null : resolvePath(projectRoot, out);
  if (outPath && !outPath.endsWith('.md')) throw new ConfigError('--out must name a .md file');
  const prices = resolved.catalog.entry.pricesPerMTok;
  if (!values.json && (prices.input === null || prices.output === null))
    write('warning: cost unknown; dollar cap unenforceable\n');
  const generated = await generatePersona({
    url,
    description,
    provider,
    model: resolved.model,
    effort: resolved.effort,
    prices,
    dollars,
    maskSelectors: project.screenshots?.maskSelectors ?? DEFAULT_MASKS,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (outPath)
    await writeFile(outPath, generated.markdown, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      throw new ConfigError(
        error.code === 'EEXIST' ? `${out} exists; not overwritten` : `cannot write ${out}: ${error.code}`,
      );
    });
  const reported = generated.usage?.reportedCostUsd ?? null;
  const cost =
    generated.estimatedCostUsd !== null
      ? `estimated $${generated.estimatedCostUsd.toFixed(4)}`
      : reported !== null
        ? `reported $${reported.toFixed(4)}`
        : 'cost unknown; dollar cap unenforceable';
  const { id, markdown, usage, capEnforcement } = generated;
  if (values.json) emit(write, { id, markdown, saved: outPath, cost, capEnforcement, usage });
  else {
    write(markdown);
    const named = !outPath || outPath.endsWith(`/${id}.md`) ? '' : `; rename it to ${id}.md to run it`;
    write(`${outPath ? `saved ${out}` : 'preview only'} (${resolved.provider}/${resolved.model}, ${cost})${named}\n`);
  }
  return 0;
}
