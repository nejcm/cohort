<script lang="ts">
  import { api, ApiError, type Editable, type Models, type ProjectDefaults } from './api.ts';
  import ModelPicker from './ModelPicker.svelte';
  import { readAt, setAt } from './source.ts';

  let { kind, id, onsaved }: { kind: 'personas' | 'suites'; id: string; onsaved: () => void } = $props();

  let loaded = $state<Editable | null>(null);
  let source = $state('');
  let models = $state<Models | null>(null);
  let config = $state<ProjectDefaults | null>(null);
  let error = $state('');
  let message = $state('');
  let conflict = $state(false);
  let saving = $state(false);

  const markdown = $derived(kind === 'personas');
  const file = $derived(`.lab/${kind}/${id}.${kind === 'personas' ? 'md' : 'yml'}`);
  const dirty = $derived(loaded !== null && source !== loaded.source);
  const setup = $derived(readAt(source, kind === 'personas' ? ['setup'] : ['defaults', 'setup'], markdown));
  const entries = $derived(kind === 'suites' ? ((readAt(source, ['entries'], false) as { persona?: string }[] | null) ?? []) : []);
  const mode = $derived(
    ((kind === 'suites' ? readAt(source, ['defaults', 'mode'], false) : null) ?? config?.defaults.mode ?? 'vision') as
      | 'vision'
      | 'text',
  );

  async function load(): Promise<void> {
    try {
      loaded = await api<Editable>('GET', `/api/${kind}/${encodeURIComponent(id)}`);
      source = loaded.source;
      conflict = false;
      error = loaded.error ?? '';
    } catch (caught) {
      error = (caught as Error).message;
    }
  }

  $effect(() => {
    void id;
    message = '';
    void load();
    void Promise.all([api<Models>('GET', '/api/models'), api<ProjectDefaults>('GET', '/api/config')]).then(
      ([foundModels, foundConfig]) => {
        models = foundModels;
        config = foundConfig;
      },
      (caught: Error) => (error = caught.message),
    );
  });

  const field = (path: (string | number)[]) => ({
    get: (): string => String(readAt(source, path, markdown) ?? ''),
    set: (value: string): void => {
      if (value === String(readAt(source, path, markdown) ?? '')) return;
      try {
        source = setAt(source, path, value, markdown);
      } catch (caught) {
        error = `Fix the YAML before using the picker: ${(caught as Error).message}`;
      }
    },
  });
  const topModel = $derived(field(kind === 'personas' ? ['model'] : ['defaults', 'model']));
  const topEffort = $derived(field(kind === 'personas' ? ['effort'] : ['defaults', 'effort']));

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!loaded) return;
    saving = true;
    error = '';
    message = '';
    const sent = source;
    try {
      loaded = await api<Editable>('PUT', `/api/${kind}/${encodeURIComponent(id)}`, {
        source: sent,
        revision: loaded.revision,
      });
      // Text typed while the save was in flight stays; it is simply unsaved again.
      if (source === sent) source = loaded.source;
      message = `Saved ${file}.`;
      onsaved();
    } catch (caught) {
      conflict = caught instanceof ApiError && caught.status === 409;
      error = (caught as Error).message;
    } finally {
      saving = false;
    }
  }
</script>

<form class="editor" onsubmit={save} aria-labelledby="editor-title">
  <h2 id="editor-title">{file}{dirty ? ' (unsaved)' : ''}</h2>
  {#if conflict}
    <div class="error" role="alert">
      <p>{file} changed on disk since you opened it. Your edits are still here; nothing was overwritten.</p>
      <button type="button" onclick={load}>Reload from disk (discard my edits)</button>
    </div>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if setup}
    <p class="hint">Setup reference <code>{String(setup)}</code> is read-only here; change it by editing the file locally.</p>
  {/if}
  {#if models}
    <fieldset>
      <legend>{kind === 'personas' ? 'Model defaults' : 'Suite defaults'}</legend>
      <ModelPicker
        {models}
        {mode}
        bind:model={topModel.get, topModel.set}
        bind:effort={topEffort.get, topEffort.set}
        inherited={kind === 'personas' ? 'project default' : 'persona or project'}
        inheritedModels={kind === 'personas' && config ? [config.defaults.model] : []}
        idPrefix="{kind}-default"
      />
    </fieldset>
    {#each entries as entry, index (index)}
      {@const entryModel = field(['entries', index, 'model'])}
      {@const entryEffort = field(['entries', index, 'effort'])}
      <fieldset>
        <legend>Entry {index + 1}: {entry.persona ?? '?'}</legend>
        <ModelPicker
          {models}
          {mode}
          bind:model={entryModel.get, entryModel.set}
          bind:effort={entryEffort.get, entryEffort.set}
          inherited="suite default"
          idPrefix="entry-{index}"
        />
      </fieldset>
    {/each}
  {/if}
  <label for="editor-source">Source</label>
  <textarea id="editor-source" rows="20" spellcheck="false" bind:value={source}></textarea>
  <div class="actions">
    <button type="button" onclick={load} disabled={!dirty}>Revert</button>
    <button type="submit" disabled={saving || !dirty}>Validate and save</button>
  </div>
</form>
