import { validate, type JsonSchema } from '../core/schema.ts';
import { CatalogError, resolveModel, type ModelCatalog, type ResolvedModel } from '../providers/catalog.ts';
import type { Effort, ProviderAdapter } from '../providers/types.ts';
import {
  ADHOC_PERSONA,
  ConfigError,
  effortSchema,
  limitsSchema,
  loadPersona,
  loadPersonasByTag,
  loadSuite,
  modeSchema,
  qualifiedModel,
  repeatsSchema,
  type Limits,
  type Mode,
  type Persona,
  type ProjectConfig,
  type Suite,
  type SuiteEntry,
} from './files.ts';

export type Selector =
  | { kind: 'persona'; id: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'suite'; id: string }
  | { kind: 'adhoc' };

export interface RunSubmission {
  selector: Selector;
  url?: string;
  note?: string;
  mode?: Mode;
  repeats?: number;
  model?: string;
  effort?: Effort;
  limits?: Partial<Limits>;
}

export interface RunRequest {
  readonly selector: Selector;
  readonly url?: string;
  readonly note?: string;
  readonly mode: Mode;
  readonly provider: string;
  readonly model: string;
  readonly effort: Effort;
  readonly catalog: ResolvedModel['catalog'];
  readonly repeats: number;
  readonly limits: Readonly<Limits>;
}

type Layer = 'run' | 'suite_entry' | 'suite_default' | 'persona' | 'project' | 'catalog_default';

export interface ResolvedEntry {
  readonly request: RunRequest;
  readonly persona: Persona;
  readonly suiteId: string | null;
  readonly entryIndex: number;
  readonly task: string;
  readonly setup: string | null;
  readonly storageState: string | null;
  readonly allowedOrigins: readonly string[];
  readonly resourceOrigins: readonly string[];
  readonly screenshots: { readonly maxWidth: number; readonly maskSelectors: readonly string[] };
  readonly layers: {
    readonly modelFrom: Layer;
    readonly effortFrom: Layer;
    readonly goal: string | null;
    readonly goalFrom: 'run' | 'suite_entry' | 'persona' | null;
    readonly urlFrom: 'run' | 'suite_entry' | 'suite_default' | 'setup';
    readonly suiteNote: string | null;
    readonly runNote: string | null;
  };
}

const DEFAULT_LIMITS: Limits = Object.freeze({ steps: 40, timeMs: 600_000, dollars: 2 });
const DEFAULT_MODE: Mode = 'vision';
const DEFAULT_REPEATS = 3;
export const DEFAULT_MASKS = ['input[type="password"]', '[data-lab-secret]'];

const submissionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['selector'],
  properties: {
    selector: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'id'],
          properties: { kind: { enum: ['persona', 'suite'] }, id: { type: 'string', minLength: 1 } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'tag'],
          properties: { kind: { const: 'tag' }, tag: { type: 'string', minLength: 1 } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { const: 'adhoc' } },
        },
      ],
    },
    url: { type: 'string', pattern: '^https?://', maxLength: 4096 },
    note: { type: 'string', minLength: 1, maxLength: 4000 },
    mode: modeSchema,
    repeats: repeatsSchema,
    model: qualifiedModel,
    effort: effortSchema,
    limits: limitsSchema,
  },
};

export function validateSubmission(value: unknown): RunSubmission {
  if (typeof value === 'object' && value !== null)
    for (const key of ['provider', 'catalog'])
      if (key in value) throw new ConfigError(`submission.${key}: resolved server-side; do not submit it`);
  const error = validate(submissionSchema, value, 'submission');
  if (error) throw new ConfigError(error);
  const submission = value as RunSubmission;
  if (submission.selector.kind === 'adhoc' && (!submission.url || !submission.note))
    throw new ConfigError('ad-hoc runs require both url and note');
  return submission;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function pick<T>(layers: [Layer, T | undefined][]): [Layer, T] | null {
  for (const [layer, value] of layers) if (value !== undefined) return [layer, value];
  return null;
}

function taskText(persona: Persona, goal: string | null, suiteNote: string | null, runNote: string | null): string {
  return [
    persona.body,
    goal ? `Goal: ${goal}` : '',
    suiteNote ? `Suite note: ${suiteNote}` : '',
    runNote ? `Run note: ${runNote}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface ResolveOptions {
  projectRoot: string;
  project: ProjectConfig;
  catalog: ModelCatalog;
  providers: Readonly<Record<string, Pick<ProviderAdapter, 'available' | 'keyEnv'>>>;
  allowUntested?: boolean;
}

export async function resolveSubmission(submission: RunSubmission, options: ResolveOptions): Promise<ResolvedEntry[]> {
  const { project, projectRoot } = options;
  let suite: Suite | null = null;
  let targets: { persona: Persona; entry: SuiteEntry | null }[];
  const { selector } = submission;
  if (selector.kind === 'persona') targets = [{ persona: await loadPersona(projectRoot, selector.id), entry: null }];
  else if (selector.kind === 'tag')
    targets = (await loadPersonasByTag(projectRoot, selector.tag)).map((persona) => ({ persona, entry: null }));
  else if (selector.kind === 'suite') {
    suite = await loadSuite(projectRoot, selector.id);
    const personas = new Map<string, Persona>();
    targets = [];
    for (const [index, entry] of suite.entries.entries()) {
      if (!personas.has(entry.persona))
        personas.set(
          entry.persona,
          await loadPersona(projectRoot, entry.persona).catch((error: unknown) => {
            throw error instanceof ConfigError
              ? new ConfigError(`.lab/suites/${suite!.id}.yml entries[${index}]: ${error.message}`)
              : error;
          }),
        );
      targets.push({ persona: personas.get(entry.persona)!, entry });
    }
  } else targets = [{ persona: ADHOC_PERSONA, entry: null }];

  const defaults = suite?.defaults ?? {};
  if ((project.routes?.length ?? 0) > 0 || (defaults.routes?.length ?? 0) > 0)
    throw new ConfigError('routes are not implemented yet (Phase 5); remove them to run');

  return targets.map(({ persona, entry }, entryIndex) => {
    const where = suite ? `.lab/suites/${suite.id}.yml entries[${entryIndex}]` : `persona ${persona.id}`;
    const mode = submission.mode ?? defaults.mode ?? project.mode ?? DEFAULT_MODE;
    if (mode === 'text') throw new ConfigError('text mode is not implemented yet; use vision');
    const repeats = submission.repeats ?? defaults.repeats ?? project.repeats ?? DEFAULT_REPEATS;
    const limits = {
      ...DEFAULT_LIMITS,
      ...project.limits,
      ...persona.limits,
      ...defaults.limits,
      ...submission.limits,
    };
    const [modelFrom, qualified] = pick<string>([
      ['run', submission.model],
      ['suite_entry', entry?.model],
      ['suite_default', defaults.model],
      ['persona', persona.model],
      ['project', project.model],
    ])!;
    const chosenEffort = pick<Effort>([
      ['run', submission.effort],
      ['suite_entry', entry?.effort],
      ['suite_default', defaults.effort],
      ['persona', persona.effort],
      ['project', project.effort],
    ]);
    let resolved: ResolvedModel;
    try {
      resolved = resolveModel(options.catalog, qualified, {
        mode,
        allowUntested: options.allowUntested ?? false,
        ...(chosenEffort ? { effort: chosenEffort[1] } : {}),
      });
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      const from = chosenEffort ? ` (model from ${modelFrom}, effort from ${chosenEffort[0]})` : '';
      throw new ConfigError(`${where}: ${error.message}${from}`);
    }
    const adapter = options.providers[resolved.provider];
    if (!adapter) throw new ConfigError(`${where}: no adapter for provider ${resolved.provider}`);
    if (!adapter.available())
      throw new ConfigError(`${where}: provider ${resolved.provider} is unavailable; set ${adapter.keyEnv}`);

    const adhoc = selector.kind === 'adhoc';
    const [goalFrom, goal] = pick<string>([
      ['run', adhoc ? submission.note : undefined],
      ['suite_entry', entry?.goal],
      ['persona', persona.goal],
    ]) ?? [null, null];
    const suiteNote = entry?.note ?? defaults.note ?? null;
    const runNote = adhoc ? null : (submission.note ?? null);
    const [urlFrom, url] = pick<string>([
      ['run', submission.url],
      ['suite_entry', entry?.url],
      ['suite_default', defaults.url],
    ]) ?? ['setup', undefined];
    const setup = defaults.setup ?? persona.setup ?? null;
    if (!url && !setup) throw new ConfigError(`${where}: no start URL; pass --url or configure a url or setup`);
    const request: RunRequest = {
      selector: structuredClone(selector),
      ...(url ? { url } : {}),
      ...(submission.note ? { note: submission.note } : {}),
      mode,
      provider: resolved.provider,
      model: resolved.model,
      effort: resolved.effort,
      catalog: resolved.catalog,
      repeats,
      limits,
    };
    return deepFreeze({
      request,
      persona,
      suiteId: suite?.id ?? null,
      entryIndex,
      task: taskText(persona, goal, suiteNote, runNote),
      setup,
      storageState: defaults.storageState ?? persona.storageState ?? null,
      allowedOrigins: [...(project.allowedOrigins ?? []), ...(defaults.allowedOrigins ?? [])],
      resourceOrigins: [...(project.resourceOrigins ?? [])],
      screenshots: {
        maxWidth: project.screenshots?.maxWidth ?? 1024,
        maskSelectors: project.screenshots?.maskSelectors ?? DEFAULT_MASKS,
      },
      layers: {
        modelFrom,
        effortFrom: chosenEffort?.[0] ?? 'catalog_default',
        goal,
        goalFrom: goalFrom as ResolvedEntry['layers']['goalFrom'],
        // Setup always returns the start URL, so it wins over any configured URL.
        urlFrom: (setup ? 'setup' : urlFrom) as ResolvedEntry['layers']['urlFrom'],
        suiteNote,
        runNote,
      },
    });
  });
}
