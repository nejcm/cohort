<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { api, initials, tint, usd, type Models } from '../lib/api.ts';
  import { navigate } from '../lib/nav.ts';
  import Editor from '../components/Editor.svelte';
  import ModelPicker from '../components/ModelPicker.svelte';
  import PersonaForm from '../components/PersonaForm.svelte';
  import type { JsonSchema } from '../../src/core/schema.ts';
  import { readAt } from '../lib/source.ts';

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
  let templates = $state<{ id: string; source: string }[] | null>(null);
  let templateId = $state('');
  let draftKey = $state(0);

  let models = $state<Models | null>(null);
  let schema = $state<JsonSchema | null>(null);
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
    if (id === 'new' && !schema)
      api<{ schema: JsonSchema }>('GET', '/api/persona-schema').then(
        (found) => (schema = found.schema),
        (caught: Error) => (error = caught.message),
      );
    if (id === 'new' && !templates)
      api<{ templates: { id: string; source: string }[] }>('GET', '/api/persona-templates').then(
        (found) => (templates = found.templates),
        (caught: Error) => (error = caught.message),
      );
  });

  function pickTemplate(): void {
    draft = templates?.find((template) => template.id === templateId)?.source ?? TEMPLATE;
    draftKey += 1;
    generated = null;
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    draftError = '';
    try {
      const saved = await api<{ id: string }>('POST', '/api/personas', { source: draft });
      draft = TEMPLATE;
      templateId = '';
      generated = null;
      await list();
      navigate(`/personas/${encodeURIComponent(saved.id)}`);
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
      draftKey += 1;
      templateId = '';
    } catch (caught) {
      draftError = (caught as Error).message;
    } finally {
      generating = false;
    }
  }
</script>

{#if id === 'new'}
  <div class="head-stack">
    <a class="back" href="/personas"><Icon name="back" />Personas</a>
    <div class="page-head"><div class="title"><h1>New persona</h1></div></div>
  </div>
{:else}
  <div class="page-head">
    <div class="title"><h1>Personas</h1></div>
    <div class="actions"><a class="button" href="/personas/new"><Icon name="plus" />New persona</a></div>
    <p class="sub">{personas.length} {personas.length === 1 ? 'persona' : 'personas'} in <span class="mono">.cohort/personas/</span>, each a Markdown file with YAML frontmatter.</p>
  </div>
{/if}
{#if error}<div class="banner error" role="alert"><div class="body"><span>{error}</span></div></div>{/if}
{#if id === 'new'}
  <div class="form-grid loose">
    <form class="editor" onsubmit={create} aria-labelledby="create-title">
      <div class="editor-head">
        <h2 id="create-title">Write it yourself</h2>
        <div class="actions">
          <label for="draft-template"><span class="sr-only">Start from</span>
            <select id="draft-template" class="sm" bind:value={templateId} onchange={pickTemplate}>
              <option value="">Blank persona</option>
              {#each templates ?? [] as template (template.id)}
                <option value={template.id}>Template: {readAt(template.source, ['name'], true) ?? template.id}</option>
              {/each}
            </select>
          </label>
          <span class="hint">Free</span>
        </div>
      </div>
      {#if draftError}<div class="banner error" role="alert"><div class="body"><span>{draftError}</span></div></div>{/if}
      {#if generated}
        <div class="banner info" role="status">
          <div class="body">
            <span>Draft from {generated.provider}/{generated.model}; cost {usd(generated.reportedCostUsd ?? generated.estimatedCostUsd)}.
            Review it below; nothing is saved until you create it.</span>
          </div>
        </div>
      {/if}
      {#if schema}
        {#key draftKey}<PersonaForm bind:source={draft} {schema} {models} error={draftError} idPrefix="draft" />{/key}
      {/if}
      <div class="editor-foot">
        <span>New personas cannot reference setup code; add one by editing the file locally.</span>
        <button type="submit" class="primary sm"><Icon name="check" />Validate and create</button>
      </div>
    </form>
    <form class="metered" onsubmit={generate} aria-labelledby="generate-title" aria-busy={generating}>
      <div class="metered-head"><h2 id="generate-title">Generate a draft</h2><span class="badge meter">$ one metered model call</span></div>
      <div class="metered-body">
        <label for="gen-url">Landing page URL<input id="gen-url" type="url" required bind:value={genUrl} disabled={generating} /></label>
        <label for="gen-description">Who should this persona be?
          <textarea id="gen-description" rows="4" required bind:value={genDescription} disabled={generating}></textarea>
        </label>
        <div class="form-grid cols-4">
          <label for="gen-dollars">Dollar cap
            <input id="gen-dollars" type="number" min="0.01" max="1000" step="0.01" required bind:value={genDollars} disabled={generating} />
          </label>
          {#if models}
            <ModelPicker {models} mode="vision" bind:model={genModel} bind:effort={genEffort} idPrefix="gen" />
          {/if}
        </div>
        {#if models?.models.find((entry) => entry.id === genModel)?.untested}
          <label class="check risk">
            <input type="checkbox" bind:checked={genAllowUntested} />
            <span><strong>Allow the untested model</strong> <span class="badge untested">untested</span></span>
          </label>
        {/if}
        <div class="form-actions">
          <button type="submit" disabled={generating} aria-busy={generating}><Icon name="sparkle" />{generating ? 'Generating…' : 'Generate preview'}</button>
        </div>
      </div>
    </form>
  </div>
{:else}
  <div class="split">
    <nav aria-label="Personas">
      <ul class="item-list">
        {#each personas as persona (persona.id)}
          <li>
            <a href="/personas/{encodeURIComponent(persona.id)}" aria-current={persona.id === id ? 'page' : undefined}>
              <span class="av {tint(persona.id)}" aria-hidden="true">{initials(persona.id)}</span>
              <span class="id">{persona.name ?? persona.id}</span>
              <span class="sub">
                {persona.tags.join(' · ')}
                {#if persona.setup}<span class="badge meter">setup</span>{/if}
                {#if persona.error}<span class="badge failed">invalid</span>{/if}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    </nav>
    <div>
      {#if id}
        <Editor kind="personas" {id} onsaved={list} />
      {:else}
        <div class="empty"><Icon name="persona" size={24} /><p>Select a persona to edit it.</p></div>
      {/if}
    </div>
  </div>
{/if}
