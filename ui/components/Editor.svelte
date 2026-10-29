<script lang="ts">
  import Icon from './Icon.svelte';
  import { api, ApiError, type Editable, type Models, type ProjectDefaults } from '../lib/api.ts';
  import PersonaForm from './PersonaForm.svelte';
  import Skeleton from './Skeleton.svelte';
  import SuiteForm from './SuiteForm.svelte';
  import type { JsonSchema } from '../../src/core/schema.ts';
  import { readAt } from '../lib/source.ts';

  let { kind, id, onsaved }: { kind: 'personas' | 'suites'; id: string; onsaved: () => void } = $props();

  let loaded = $state<Editable | null>(null);
  let source = $state('');
  let models = $state<Models | null>(null);
  let config = $state<ProjectDefaults | null>(null);
  let schema = $state<JsonSchema | null>(null);
  let personas = $state<string[]>([]);
  let error = $state('');
  let message = $state('');
  let conflict = $state(false);
  let saving = $state(false);
  let invalid = $state(false);

  const markdown = $derived(kind === 'personas');
  const file = $derived(`.cohort/${kind}/${id}.${kind === 'personas' ? 'md' : 'yml'}`);
  const dirty = $derived(loaded !== null && source !== loaded.source);
  const setup = $derived(readAt(source, kind === 'personas' ? ['setup'] : ['defaults', 'setup'], markdown));

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
    schema = null;
    api<{ schema: JsonSchema }>('GET', `/api/${kind === 'personas' ? 'persona' : 'suite'}-schema`).then(
      (found) => (schema = found.schema),
      (caught: Error) => (error = caught.message),
    );
    if (kind === 'suites')
      api<{ personas: { id: string }[] }>('GET', '/api/personas').then(
        (found) => (personas = found.personas.map((persona) => persona.id)),
        (caught: Error) => (error = caught.message),
      );
  });

  $effect(() => {
    void id;
    message = '';
    loaded = null;
    void load();
    void Promise.all([api<Models>('GET', '/api/models'), api<ProjectDefaults>('GET', '/api/config')]).then(
      ([foundModels, foundConfig]) => {
        models = foundModels;
        config = foundConfig;
      },
      (caught: Error) => (error = caught.message),
    );
  });

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
  <div class="editor-head">
    <h2 id="editor-title">{file}{#if dirty}{" "}<span class="unsaved">(unsaved)</span>{/if}</h2>
    <div class="actions">
      <button type="button" onclick={load} disabled={!dirty}><Icon name="undo" />Revert</button>
      <button type="submit" class="primary" disabled={saving || !dirty || invalid} aria-busy={saving}><Icon name="check" />Validate and save</button>
    </div>
  </div>
  {#if conflict}
    <div class="banner warn" role="alert">
      <div class="body">
        <strong>Changed on disk.</strong>
        <span>{file} changed on disk since you opened it. Your edits are still here; nothing was overwritten.</span>
      </div>
      <div class="actions"><button type="button" class="sm danger" onclick={load}><Icon name="reload" />Reload from disk (discard my edits)</button></div>
    </div>
  {:else if error}
    <div class="banner error" role="alert"><div class="body"><span>{error}</span></div></div>
  {/if}
  {#if setup}
    <div class="banner info">
      <div class="body"><span>Setup reference <code>{String(setup)}</code> is read-only here; change it by editing the file locally.</span></div>
    </div>
  {/if}
  {#if kind === 'personas'}
    {#if schema && loaded}
      {#key id}
        <PersonaForm
          bind:source
          {schema}
          {models}
          mode={config?.defaults.mode}
          inheritedModels={config ? [config.defaults.model] : []}
          {error}
          idPrefix="editor"
          bind:invalid
        />
      {/key}
    {:else if !error}
      <Skeleton label="Loading {file}" lines={4} />
    {/if}
  {:else if schema && loaded}
    {#key id}
      <SuiteForm
        bind:source
        {schema}
        {personas}
        {models}
        projectMode={config?.defaults.mode}
        inheritedModels={config ? [config.defaults.model] : []}
        {error}
        idPrefix="editor"
        bind:invalid
      />
    {/key}
  {:else if !error}
    <Skeleton label="Loading {file}" lines={4} />
  {/if}
  <div class="editor-foot">
    {#if message}<p class="notice good" role="status">{message}</p>{:else}<span>{markdown ? 'Markdown + YAML frontmatter' : 'YAML'} · {file}</span>{/if}
    {#if loaded}<span class="mono">{source.split('\n').length} lines</span>{/if}
  </div>
</form>
