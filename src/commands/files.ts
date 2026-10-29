import { loadProjectConfig, parsePersona, parseSuite, personaSchema, type SuiteEntry } from '../config/files.ts';
import {
  appendSuiteEntry,
  createEditable,
  EditError,
  readEditable,
  readSettings,
  removeEditable,
  saveEditable,
  saveSettings,
  type Editable,
} from '../config/editable.ts';
import { personaTemplates } from '../config/init.ts';
import { configView, modelList, personaSummaries, suiteSummaries } from '../dashboard/operations.ts';
import { loadCatalog } from '../providers/catalog.ts';
import { CliError, emit, need, readInput, type Context } from './context.ts';

const KINDS = { persona: 'personas', suite: 'suites' } as const;
const sourcePath = (kind: 'personas' | 'suites', id: string): string =>
  `.cohort/${kind}/${id}.${kind === 'personas' ? 'md' : 'yml'}`;

function saved(ctx: Context, kind: 'personas' | 'suites', item: Editable, action: string): number {
  const path = sourcePath(kind, item.id);
  if (ctx.json) emit(ctx.write, { id: item.id, revision: item.revision, path, action });
  else ctx.write(`${action} ${path}\n`);
  return 0;
}

/** `cohort persona|suite list|show|add|edit|remove`, plus `suite add-entry` and `persona schema|templates`. */
export async function fileCommand(
  noun: 'persona' | 'suite',
  verb: string | undefined,
  id: string | undefined,
  ctx: Context,
): Promise<number> {
  const kind = KINDS[noun];
  const { root, values, write } = ctx;
  if (verb === 'list') {
    const items = noun === 'persona' ? await personaSummaries(root) : await suiteSummaries(root);
    if (ctx.json) emit(write, { [kind]: items });
    else
      for (const item of items) write(`${item.id}\t${item.name ?? ''}${item.error ? `\terror: ${item.error}` : ''}\n`);
    return 0;
  }
  if (verb === 'show') {
    const item = await readEditable(root, kind, need(id, `${noun} show <id>`));
    if (ctx.json) emit(write, { ...item, path: sourcePath(kind, item.id) });
    else write(item.source);
    return 0;
  }
  if (verb === 'add') {
    const source = await readInput(ctx);
    try {
      return saved(ctx, kind, await createEditable(root, kind, source), 'created');
    } catch (error) {
      if (!(error instanceof EditError && error.status === 409 && values.force === true)) throw error;
      const sourceId = (kind === 'personas' ? parsePersona : parseSuite)(source, 'input').id;
      const before = await readEditable(root, kind, sourceId);
      return saved(ctx, kind, await saveEditable(root, kind, sourceId, source, before.revision), 'replaced');
    }
  }
  if (verb === 'edit') {
    const target = need(id, `${noun} edit <id> --file <path> [--revision <sha256>]`);
    const source = await readInput(ctx);
    const revision = (values.revision as string | undefined) ?? (await readEditable(root, kind, target)).revision;
    return saved(ctx, kind, await saveEditable(root, kind, target, source, revision), 'saved');
  }
  if (verb === 'remove') {
    const target = need(id, `${noun} remove <id> --yes`);
    if (values.yes !== true)
      throw new CliError('confirmation_required', `this deletes ${sourcePath(kind, target)}; pass --yes to confirm`);
    await removeEditable(root, kind, target);
    if (ctx.json) emit(write, { id: target, path: sourcePath(kind, target), action: 'removed' });
    else write(`removed ${sourcePath(kind, target)}\n`);
    return 0;
  }
  if (noun === 'suite' && verb === 'add-entry') {
    const target = need(id, 'suite add-entry <suite-id> --persona <id> [--goal|--url|--note|--model|--effort]');
    const entry = Object.fromEntries(
      (['persona', 'goal', 'url', 'note', 'model', 'effort'] as const).flatMap((key) =>
        values[key] === undefined ? [] : [[key, values[key]]],
      ),
    ) as unknown as SuiteEntry;
    if (!entry.persona) throw new CliError('usage', 'suite add-entry needs --persona <id>');
    const before = await readEditable(root, 'suites', target);
    return saved(ctx, kind, await appendSuiteEntry(root, target, entry, before.revision), 'saved');
  }
  if (noun === 'persona' && verb === 'schema' && id === undefined) {
    if (ctx.json) emit(write, { schema: personaSchema });
    else write(`${JSON.stringify(personaSchema, null, 2)}\n`);
    return 0;
  }
  if (noun === 'persona' && verb === 'templates' && id === undefined) {
    const templates = await personaTemplates();
    if (ctx.json) emit(write, { templates });
    else for (const template of templates) write(`${template.id}\n`);
    return 0;
  }
  throw new CliError('usage', `unknown command: cohort ${noun} ${verb ?? ''}`.trimEnd());
}

// `config|models show` adds the raw file; `edit` validates and replaces it.
async function settingsCommand(name: 'config.yml' | 'models.yml', verb: string, ctx: Context): Promise<boolean> {
  if (verb === 'edit') {
    const source = await readInput(ctx);
    const file = await saveSettings(ctx.root, name, source, ctx.values.revision as string | undefined);
    if (ctx.json) emit(ctx.write, { ...file, action: 'saved' });
    else ctx.write(`saved ${file.path}\n`);
    return true;
  }
  if (verb === 'show' && name === 'models.yml') {
    const file = await readSettings(ctx.root, name);
    if (ctx.json) emit(ctx.write, file);
    else ctx.write(file.source ?? '');
    return true;
  }
  return false;
}

export async function modelsCommand(verb: string, ctx: Context): Promise<number> {
  if (await settingsCommand('models.yml', verb, ctx)) return 0;
  const listed = modelList(await loadCatalog(ctx.root), ctx.providers);
  if (ctx.json) emit(ctx.write, listed);
  else
    for (const model of listed.models) {
      const prices =
        model.pricesPerMTok.input === null
          ? 'prices unknown'
          : `$${model.pricesPerMTok.input}/$${model.pricesPerMTok.output} per MTok`;
      ctx.write(
        `${model.id}\t${model.enabled ? 'enabled' : 'disabled'}${model.untested ? ', untested' : ''}\t${prices}\n`,
      );
    }
  return 0;
}

export async function configCommand(verb: string, ctx: Context): Promise<number> {
  if (await settingsCommand('config.yml', verb, ctx)) return 0;
  const view = configView(await loadProjectConfig(ctx.root), ctx.providers);
  const { source, revision } = await readSettings(ctx.root, 'config.yml');
  if (ctx.json) emit(ctx.write, { ...view, source, revision });
  else ctx.write(`${JSON.stringify(view, null, 2)}\n`);
  return 0;
}
