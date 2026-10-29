<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import type { Models } from '../lib/api.ts';
  import type { JsonSchema } from '../../src/core/schema.ts';
  import {
    bodyOf,
    fieldError,
    fieldGroups,
    fieldProblems,
    formProblem,
    multiline,
    readAt,
    setAt,
    withBody,
    type Field,
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

  const messageFor = (path: string[], index?: number): string | null =>
    [...problems, error].map((text) => fieldError(text, path, index)).find((found) => found !== null) ?? null;
  const describedBy = (id: string, message: string | null): string | undefined => (message ? `${id}-error` : undefined);
  async function add(field: Field, index: number): Promise<void> {
    write([...field.path, index], '');
    await tick();
    document.getElementById(`${idPrefix}-${field.path.join('-')}-${index}`)?.focus();
  }

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
  const binding = (field: Field) => ({
    text: () => String(read(field.path) ?? ''),
    setText: (value: string) => write(field.path, value === '' && !field.required ? undefined : value),
    number: () => {
      const value = read(field.path);
      return typeof value === 'number' ? value : null;
    },
    setNumber: (value: number | null) => write(field.path, value ?? undefined),
    checked: () => read(field.path) === true,
    setChecked: (value: boolean) => write(field.path, value),
  });
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
            {@const id = `${idPrefix}-${field.path.join('-')}`}
            {@const problemText = messageFor(field.path)}
            {@const invalidAttr = problemText ? 'true' : undefined}
            {@const bound = binding(field)}
            {@const kind = field.schema.enum ? 'enum' : field.schema.type}
            {#if kind === 'boolean'}
              <label class="check" for={id}>
                <input {id} type="checkbox" bind:checked={bound.checked, bound.setChecked} aria-invalid={invalidAttr} aria-describedby={describedBy(id, problemText)} />
                <span>{field.label}{#if problemText}{' '}<span class="field-error" id="{id}-error">{problemText}</span>{/if}</span>
              </label>
            {:else if kind === 'array'}
              {@const items = (read(field.path) as unknown[] | null) ?? []}
              <div class="list span-2" role="group" aria-labelledby="{id}-label">
                <span class="list-label" id="{id}-label">{field.label}{#if problemText}{' '}<span class="field-error" id="{id}-error">{problemText}</span>{/if}</span>
                {#each items as item, index (index)}
                  {@const itemId = `${id}-${index}`}
                  {@const itemProblem = messageFor(field.path, index)}
                  <div class="list-row">
                    <input
                      id={itemId}
                      value={String(item ?? '')}
                      oninput={(event) => write([...field.path, index], event.currentTarget.value)}
                      aria-label="{field.label} {index + 1}"
                      aria-invalid={itemProblem ? 'true' : undefined}
                      aria-describedby={describedBy(itemId, itemProblem)}
                    />
                    <button type="button" class="sm" onclick={() => write([...field.path, index], undefined)} aria-label="Remove {field.label} {index + 1}">Remove</button>
                  </div>
                  {#if itemProblem}<span class="field-error" id="{itemId}-error">{itemProblem}</span>{/if}
                {/each}
                <div><button type="button" class="sm" onclick={() => add(field, items.length)}><Icon name="plus" />Add</button></div>
              </div>
            {:else}
              <label for={id} class={kind === 'string' && multiline(field.schema) ? 'span-2' : undefined}>
                <span>{field.label}{#if !field.required}{' '}<span class="opt">optional</span>{/if}</span>
                {#if field.schema.enum}
                  <select {id} bind:value={bound.text, bound.setText} aria-invalid={invalidAttr} aria-describedby={describedBy(id, problemText)}>
                    {#if !field.required}<option value="">Not set</option>{/if}
                    {#each field.schema.enum as option (option)}<option value={String(option)}>{String(option)}</option>{/each}
                  </select>
                {:else if kind === 'integer' || kind === 'number'}
                  <input
                    {id}
                    type="number"
                    min={field.schema.minimum}
                    max={field.schema.maximum}
                    step={kind === 'integer' ? 1 : 'any'}
                    bind:value={bound.number, bound.setNumber}
                    aria-invalid={invalidAttr} aria-describedby={describedBy(id, problemText)}
                  />
                {:else if multiline(field.schema)}
                  <textarea {id} rows="3" bind:value={bound.text, bound.setText} aria-invalid={invalidAttr} aria-describedby={describedBy(id, problemText)}></textarea>
                {:else}
                  <input {id} bind:value={bound.text, bound.setText} aria-invalid={invalidAttr} aria-describedby={describedBy(id, problemText)} />
                {/if}
                {#if problemText}<span class="field-error" id="{id}-error">{problemText}</span>{/if}
              </label>
            {/if}
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
