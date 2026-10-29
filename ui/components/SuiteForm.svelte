<script lang="ts">
  import FormField from './FormField.svelte';
  import Icon from './Icon.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import type { Models } from '../lib/api.ts';
  import type { JsonSchema } from '../../src/core/schema.ts';
  import { fieldError, fieldGroups, fieldProblems, formProblem, moveAt, readAt, setAt } from '../lib/source.ts';

  type Path = (string | number)[];
  let {
    source = $bindable(),
    schema,
    personas,
    models = null,
    projectMode = 'vision',
    error = '',
    idPrefix,
    invalid = $bindable(false),
  }: {
    source: string;
    schema: JsonSchema;
    personas: string[];
    models?: Models | null;
    projectMode?: 'vision' | 'text';
    error?: string;
    idPrefix: string;
    invalid?: boolean;
  } = $props();

  const defaultsSchema = $derived(schema.properties!.defaults!);
  const entrySchema = $derived(schema.properties!.entries!.items!);
  const OUTSIDE = ['model', 'effort', 'setup', 'routes'];
  const problem = $derived(formProblem(source, schema, false));
  let raw = $state(false);
  let editError = $state('');
  const read = (path: Path): unknown => readAt(source, path, false);
  const entries = $derived.by(() => {
    const found = read(['entries']);
    return !raw && !problem && Array.isArray(found) ? found : [];
  });
  const details = $derived(fieldGroups(schema, ['defaults', 'entries']).flatMap((group) => group.fields));
  const defaultGroups = $derived(fieldGroups(defaultsSchema, OUTSIDE, ['defaults']));
  const entryFields = (index: number) => fieldGroups(entrySchema, OUTSIDE, ['entries', index])[0]!.fields;
  const problems = $derived.by(() => {
    if (raw || problem) return [];
    const fields = [
      ...details,
      ...fieldGroups(defaultsSchema, [], ['defaults']).flatMap((group) => group.fields),
      ...entries.flatMap((_, index) => fieldGroups(entrySchema, [], ['entries', index])[0]!.fields),
    ];
    return [...fieldProblems(source, fields, false), ...(entries.length === 0 ? ['.entries: add at least one entry'] : [])];
  });
  const listProblem = $derived(problems.map((text) => fieldError(text, ['entries'])).find((found) => found !== null));
  const mode = $derived((read(['defaults', 'mode']) ?? projectMode) as 'vision' | 'text');

  $effect(() => {
    if (problem) raw = true;
  });
  $effect(() => {
    invalid = problems.length > 0;
  });

  const messageFor = (path: Path, index?: number): string | null =>
    [...problems, error].map((text) => fieldError(text, path, index)).find((found) => found !== null) ?? null;
  function write(path: Path, value: unknown): void {
    if (JSON.stringify(read(path)) === JSON.stringify(value ?? null)) return;
    try {
      source = setAt(source, path, value, false);
      editError = '';
    } catch (caught) {
      editError = (caught as Error).message;
    }
  }
  const picker = (path: Path) => ({
    get: (): string => String(read(path) ?? ''),
    set: (value: string): void => write(path, value || undefined),
  });
  function move(index: number, by: number): void {
    try {
      source = moveAt(source, ['entries'], index, index + by);
      editError = '';
    } catch (caught) {
      editError = (caught as Error).message;
    }
  }
</script>

{#if raw}
  <div class="banner info" role="status">
    <div class="body">
      <span>{problem ? `Editing the source because ${problem}.` : 'The file fits the form again.'}</span>
    </div>
    {#if !problem}<div class="actions"><button type="button" class="sm" onclick={() => (raw = false)}>Edit as form</button></div>{/if}
  </div>
  <label class="sr-only" for="{idPrefix}-source">Source</label>
  <textarea id="{idPrefix}-source" class="source" spellcheck="false" bind:value={source}></textarea>
{:else}
  {#if editError}<div class="banner error" role="alert"><div class="body"><span>{editError}</span></div></div>{/if}
  {#if read(['defaults', 'routes'])}
    <div class="banner info"><div class="body"><span>Route rules are kept as written; change them by editing the file locally.</span></div></div>
  {/if}
  <div class="metered-body">
    <fieldset>
      <legend>Details</legend>
      <div class="form-grid">
        {#each details as field (field.path.join('.'))}<FormField {field} {idPrefix} {read} {write} {messageFor} />{/each}
      </div>
    </fieldset>
    {#each defaultGroups as group, groupIndex (group.legend)}
      <fieldset>
        <legend>{groupIndex === 0 ? 'Suite defaults' : `Default ${group.legend.toLowerCase()}`}</legend>
        <div class="form-grid">
          {#each group.fields as field (field.path.join('.'))}<FormField {field} {idPrefix} {read} {write} {messageFor} />{/each}
        </div>
        {#if groupIndex === 0 && models}
          {@const model = picker(['defaults', 'model'])}
          {@const effort = picker(['defaults', 'effort'])}
          <div class="form-grid cols-4">
            <ModelPicker
              {models}
              {mode}
              bind:model={model.get, model.set}
              bind:effort={effort.get, effort.set}
              inherited="persona or project"
              idPrefix="{idPrefix}-default"
            />
          </div>
        {/if}
      </fieldset>
    {/each}
    {#if listProblem}<p class="field-error" role="alert">Entries: {listProblem}</p>{/if}
    {#each entries as entry, index (index)}
      {@const model = picker(['entries', index, 'model'])}
      {@const effort = picker(['entries', index, 'effort'])}
      <fieldset>
        <legend>Entry {index + 1}: {(entry as { persona?: string } | null)?.persona || '?'}</legend>
        <div class="list-row">
          <button type="button" class="sm" disabled={index === 0} onclick={() => move(index, -1)} aria-label="Move entry {index + 1} up">Up</button>
          <button type="button" class="sm" disabled={index === entries.length - 1} onclick={() => move(index, 1)} aria-label="Move entry {index + 1} down">Down</button>
          <button type="button" class="sm" onclick={() => write(['entries', index], undefined)} aria-label="Remove entry {index + 1}">Remove</button>
        </div>
        <div class="form-grid">
          {#each entryFields(index) as field (field.path.join('.'))}
            <FormField {field} {idPrefix} {read} {write} {messageFor} options={field.path.at(-1) === 'persona' ? personas : undefined} />
          {/each}
        </div>
        {#if models}
          <div class="form-grid cols-4">
            <ModelPicker
              {models}
              {mode}
              bind:model={model.get, model.set}
              bind:effort={effort.get, effort.set}
              inherited="suite default"
              idPrefix="{idPrefix}-entry-{index}"
            />
          </div>
        {/if}
      </fieldset>
    {/each}
    <div><button type="button" class="sm" onclick={() => write(['entries', entries.length], { persona: personas[0] ?? '' })}><Icon name="plus" />Add entry</button></div>
  </div>
{/if}
