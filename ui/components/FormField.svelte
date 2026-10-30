<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { multiline, type Field } from '../lib/source.ts';

  type Path = (string | number)[];
  let {
    field,
    idPrefix,
    read,
    write,
    messageFor,
    options,
    suggestions,
    hint,
  }: {
    field: Field;
    idPrefix: string;
    read: (path: Path) => unknown;
    write: (path: Path, value: unknown) => void;
    messageFor: (path: Path, index?: number) => string | null;
    options?: string[];
    /** Offered values for a free-text field; any other value can still be typed. */
    suggestions?: string[];
    hint?: string;
  } = $props();

  const id = $derived(`${idPrefix}-${field.path.join('-')}`);
  const problemText = $derived(messageFor(field.path));
  const invalidAttr = $derived(problemText ? 'true' : undefined);
  const choices = $derived(options ?? field.schema.enum?.map(String));
  const kind = $derived(choices ? 'enum' : field.schema.type);
  const describedBy = (target: string, message: string | null): string | undefined => (message ? `${target}-error` : undefined);

  async function add(index: number): Promise<void> {
    write([...field.path, index], '');
    await tick();
    document.getElementById(`${id}-${index}`)?.focus();
  }
  const text = (): string => String(read(field.path) ?? '');
  const setText = (value: string): void => write(field.path, value === '' && !field.required ? undefined : value);
  const number = (): number | null => {
    const value = read(field.path);
    return typeof value === 'number' ? value : null;
  };
  const setNumber = (value: number | null): void => write(field.path, value ?? undefined);
  const checked = (): boolean => read(field.path) === true;
  const setChecked = (value: boolean): void => write(field.path, value);
</script>

{#if kind === 'boolean'}
  <label class="check" for={id}>
    <input {id} type="checkbox" bind:checked={checked, setChecked} aria-invalid={invalidAttr} aria-describedby={describedBy(id, problemText)} />
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
    <div><button type="button" class="sm" onclick={() => add(items.length)}><Icon name="plus" />Add</button></div>
  </div>
{:else}
  <label for={id} class={kind === 'string' && multiline(field.schema) ? 'span-2' : undefined}>
    <span>{field.label}{#if !field.required}{' '}<span class="opt">optional</span>{/if}</span>
    {#if choices}
      <select {id} bind:value={text, setText} aria-invalid={invalidAttr} aria-describedby={describedBy(id, problemText)}>
        {#if !field.required}<option value="">Not set</option>{/if}
        {#if text() && !choices.includes(text())}<option value={text()}>{text()}</option>{/if}
        {#each choices as option (option)}<option value={option}>{option}</option>{/each}
      </select>
    {:else if kind === 'integer' || kind === 'number'}
      <input
        {id}
        type="number"
        min={field.schema.minimum}
        max={field.schema.maximum}
        step={kind === 'integer' ? 1 : 'any'}
        bind:value={number, setNumber}
        aria-invalid={invalidAttr} aria-describedby={describedBy(id, problemText)}
      />
    {:else if multiline(field.schema)}
      <textarea {id} rows="3" bind:value={text, setText} aria-invalid={invalidAttr} aria-describedby={describedBy(id, problemText)}></textarea>
    {:else}
      <input
        {id}
        bind:value={text, setText}
        list={suggestions?.length ? `${id}-list` : undefined}
        aria-invalid={invalidAttr}
        aria-describedby={[problemText ? `${id}-error` : '', hint ? `${id}-hint` : ''].join(' ').trim() || undefined}
      />
      {#if suggestions?.length}<datalist id="{id}-list">{#each suggestions as option (option)}<option value={option}></option>{/each}</datalist>{/if}
    {/if}
    {#if hint}<span class="hint" id="{id}-hint">{hint}</span>{/if}
    {#if problemText}<span class="field-error" id="{id}-error">{problemText}</span>{/if}
  </label>
{/if}
