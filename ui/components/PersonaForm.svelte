<script lang="ts">
  import FormField from './FormField.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import type { Models } from '../lib/api.ts';
  import type { JsonSchema } from '../../src/core/schema.ts';
  import {
    bodyOf,
    fieldError,
    fieldGroups,
    fieldProblems,
    formProblem,
    readAt,
    setAt,
    withBody,
  } from '../lib/source.ts';

  let {
    source = $bindable(),
    schema,
    models = null,
    mode = 'vision',
    inheritedModels = [],
    error = '',
    idPrefix,
    invalid = $bindable(false),
  }: {
    source: string;
    schema: JsonSchema;
    models?: Models | null;
    mode?: 'vision' | 'text';
    inheritedModels?: string[];
    error?: string;
    idPrefix: string;
    invalid?: boolean;
  } = $props();

  const problem = $derived(formProblem(source, schema));
  const OUTSIDE = ['model', 'effort', 'setup'];
  const groups = $derived(fieldGroups(schema, OUTSIDE));
  let raw = $state(false);
  let editError = $state('');
  const problems = $derived(raw ? [] : fieldProblems(source, fieldGroups(schema, []).flatMap((group) => group.fields)));
  const outsideProblems = $derived(problems.filter((text) => OUTSIDE.some((key) => text.startsWith(`.${key}:`))));
  const bodyMissing = $derived(!raw && bodyOf(source).trim() === '');

  $effect(() => {
    if (problem) raw = true;
  });
  $effect(() => {
    invalid = problems.length > 0 || bodyMissing;
  });

  const messageFor = (path: (string | number)[], index?: number): string | null =>
    [...problems, error].map((text) => fieldError(text, path, index)).find((found) => found !== null) ?? null;
  const read = (path: (string | number)[]): unknown => readAt(source, path, true);
  function write(path: (string | number)[], value: unknown): void {
    if (JSON.stringify(read(path)) === JSON.stringify(value ?? null)) return;
    try {
      source = setAt(source, path, value, true);
      editError = '';
    } catch (caught) {
      editError = (caught as Error).message;
    }
  }
  const model = {
    get: (): string => String(read(['model']) ?? ''),
    set: (value: string): void => write(['model'], value || undefined),
  };
  const effort = {
    get: (): string => String(read(['effort']) ?? ''),
    set: (value: string): void => write(['effort'], value || undefined),
  };
</script>

{#if raw}
  <div class="banner info" role="status">
    <div class="body">
      <span>{problem ? `Editing the source because ${problem}.` : 'The frontmatter fits the form again.'}</span>
    </div>
    {#if !problem}<div class="actions"><button type="button" class="sm" onclick={() => (raw = false)}>Edit as form</button></div>{/if}
  </div>
  <label class="sr-only" for="{idPrefix}-source">Source</label>
  <textarea id="{idPrefix}-source" class="source" spellcheck="false" bind:value={source}></textarea>
{:else}
  {#if editError}<div class="banner error" role="alert"><div class="body"><span>{editError}</span></div></div>{/if}
  {#each outsideProblems as text (text)}<div class="banner error" role="alert"><div class="body"><span>{text.slice(1)}</span></div></div>{/each}
  <div class="metered-body">
    {#each groups as group (group.legend)}
      <fieldset>
        <legend>{group.legend}</legend>
        <div class="form-grid">
          {#each group.fields as field (field.path.join('.'))}
            <FormField {field} {idPrefix} {read} {write} {messageFor} />
          {/each}
        </div>
      </fieldset>
    {/each}
    {#if models}
      <fieldset>
        <legend>Model defaults</legend>
        <div class="form-grid cols-4">
          <ModelPicker
            {models}
            {mode}
            bind:model={model.get, model.set}
            bind:effort={effort.get, effort.set}
            inherited="project default"
            {inheritedModels}
            idPrefix="{idPrefix}-default"
          />
        </div>
      </fieldset>
    {/if}
  </div>
  <label class="sr-only" for="{idPrefix}-body">Persona description (Markdown)</label>
  <textarea
    id="{idPrefix}-body"
    class="source"
    spellcheck="false"
    bind:value={() => bodyOf(source), (body) => (source = withBody(source, body))}
    aria-invalid={bodyMissing ? 'true' : undefined}
    aria-describedby={bodyMissing ? `${idPrefix}-body-error` : undefined}
  ></textarea>
  {#if bodyMissing}<p class="field-error" id="{idPrefix}-body-error">The persona description cannot be empty.</p>{/if}
{/if}
