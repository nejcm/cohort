<script lang="ts">
  import { api, usd, type Models } from './api.ts';
  import Editor from './Editor.svelte';
  import ModelPicker from './ModelPicker.svelte';

  interface Summary {
    id: string;
    name: string | null;
    tags: string[];
    goal: string | null;
    setup: string | null;
    error: string | null;
  }

  let { id }: { id: string | undefined } = $props();
  let personas = $state<Summary[]>([]);
  let error = $state('');

  const TEMPLATE = `---
schemaVersion: 1
id: new-persona
name: New persona
tags: []
device: { viewport: { width: 1280, height: 720 }, touch: false }
locale: en-US
timezone: UTC
goal: Describe what this person wants to get done.
---

Describe who this person is and how they behave.
`;
  let draft = $state(TEMPLATE);
  let draftError = $state('');

  let models = $state<Models | null>(null);
  let genUrl = $state('');
  let genDescription = $state('');
  let genDollars = $state(0.5);
  let genModel = $state('');
  let genEffort = $state('');
  let genAllowUntested = $state(false);
  let generating = $state(false);
  let generated = $state<{ markdown: string; provider: string; model: string; estimatedCostUsd: number | null; reportedCostUsd: number | null } | null>(null);

  async function list(): Promise<void> {
    try {
      personas = (await api<{ personas: Summary[] }>('GET', '/api/personas')).personas;
    } catch (caught) {
      error = (caught as Error).message;
    }
  }

  $effect(() => {
    void list();
  });

  $effect(() => {
    if (id === 'new' && !models)
      api<Models>('GET', '/api/models').then(
        (found) => (models = found),
        (caught: Error) => (error = caught.message),
      );
  });

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    draftError = '';
    try {
      const saved = await api<{ id: string }>('POST', '/api/personas', { source: draft });
      draft = TEMPLATE;
      generated = null;
      await list();
      location.hash = `#/personas/${encodeURIComponent(saved.id)}`;
    } catch (caught) {
      draftError = (caught as Error).message;
    }
  }

  async function generate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    generating = true;
    draftError = '';
    try {
      generated = await api('POST', '/api/personas/generate', {
        url: genUrl,
        description: genDescription,
        dollars: genDollars,
        ...(genModel ? { model: genModel } : {}),
        ...(genEffort ? { effort: genEffort } : {}),
        allowUntested: genAllowUntested,
      });
      draft = generated!.markdown;
    } catch (caught) {
      draftError = (caught as Error).message;
    } finally {
      generating = false;
    }
  }
</script>

<h1>Personas</h1>
{#if error}<p class="error" role="alert">{error}</p>{/if}
<div class="split">
  <nav aria-label="Personas">
    <ul class="list">
      {#each personas as persona (persona.id)}
        <li>
          <a href="#/personas/{encodeURIComponent(persona.id)}" aria-current={persona.id === id ? 'page' : undefined}>
            {persona.name ?? persona.id}
          </a>
          <span class="hint">{persona.tags.join(', ')}</span>
          {#if persona.setup}<span class="badge">setup</span>{/if}
          {#if persona.error}<span class="badge error">invalid</span>{/if}
        </li>
      {/each}
    </ul>
    <a href="#/personas/new">+ New persona</a>
  </nav>
  <div>
    {#if id === 'new'}
      <form onsubmit={generate} aria-labelledby="generate-title">
        <h2 id="generate-title">Generate a draft (one metered model call)</h2>
        <label for="gen-url">Landing page URL</label>
        <input id="gen-url" type="url" required bind:value={genUrl} />
        <label for="gen-description">Who should this persona be?</label>
        <textarea id="gen-description" rows="3" required bind:value={genDescription}></textarea>
        <label for="gen-dollars">Dollar cap for this call</label>
        <input id="gen-dollars" type="number" min="0.01" max="1000" step="0.01" required bind:value={genDollars} />
        {#if models}
          <ModelPicker {models} mode="vision" bind:model={genModel} bind:effort={genEffort} idPrefix="gen" />
          {#if models.models.find((entry) => entry.id === genModel)?.untested}
            <label class="inline"><input type="checkbox" bind:checked={genAllowUntested} /> Allow the untested model</label>
          {/if}
        {/if}
        <button type="submit" disabled={generating}>{generating ? 'Generating…' : 'Generate preview'}</button>
      </form>
      {#if generated}
        <p role="status">
          Draft from {generated.provider}/{generated.model}; cost {usd(generated.reportedCostUsd ?? generated.estimatedCostUsd)}.
          Review it below; nothing is saved until you create it.
        </p>
      {/if}
      <form onsubmit={create} aria-labelledby="create-title">
        <h2 id="create-title">New persona</h2>
        <p class="hint">New personas cannot reference setup code; add a setup reference by editing the file locally.</p>
        {#if draftError}<p class="error" role="alert">{draftError}</p>{/if}
        <label for="draft-source">Markdown</label>
        <textarea id="draft-source" rows="18" spellcheck="false" bind:value={draft}></textarea>
        <button type="submit">Validate and create</button>
      </form>
    {:else if id}
      <Editor kind="personas" {id} onsaved={list} />
    {:else}
      <p>Select a persona to edit it.</p>
    {/if}
  </div>
</div>
