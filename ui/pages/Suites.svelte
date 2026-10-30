<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import { api, type Models, type ProjectDefaults } from '../lib/api.ts';
  import { navigate } from '../lib/nav.ts';
  import Editor from '../components/Editor.svelte';
  import SuiteForm from '../components/SuiteForm.svelte';
  import type { JsonSchema } from '../../src/core/schema.ts';

  let { id }: { id: string | undefined } = $props();
  let suites = $state<{ id: string; name: string | null; entries: number; error: string | null }[]>([]);
  let personaIds = $state<string[]>([]);
  let error = $state('');
  let loaded = $state(false);
  let templated = $state(false);
  let creating = $state(false);
  let draft = $state('');
  let draftError = $state('');
  let draftInvalid = $state(false);
  let schema = $state<JsonSchema | null>(null);
  let models = $state<Models | null>(null);
  let config = $state<ProjectDefaults | null>(null);

  const template = (persona: string): string => `schemaVersion: 1
id: new-suite
name: New suite
entries:
  - persona: ${persona}
    goal: Describe what this entry should try to get done.
`;

  async function list(): Promise<void> {
    try {
      suites = (await api<{ suites: typeof suites }>('GET', '/api/suites')).suites;
      loaded = true;
    } catch (caught) {
      error = (caught as Error).message;
    }
  }

  $effect(() => {
    void list();
  });

  $effect(() => {
    if (id === 'new' && !templated)
      Promise.all([
        api<{ personas: { id: string }[] }>('GET', '/api/personas'),
        api<{ schema: JsonSchema }>('GET', '/api/suite-schema'),
        api<Models>('GET', '/api/models'),
        api<ProjectDefaults>('GET', '/api/config'),
      ]).then(
        ([found, foundSchema, foundModels, foundConfig]) => {
          personaIds = found.personas.map((persona) => persona.id);
          schema = foundSchema.schema;
          models = foundModels;
          config = foundConfig;
          draft = template(personaIds[0] ?? 'your-persona-id');
          templated = true;
        },
        (caught: Error) => (error = caught.message),
      );
  });

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    draftError = '';
    creating = true;
    try {
      const saved = await api<{ id: string }>('POST', '/api/suites', { source: draft });
      draft = '';
      templated = false;
      await list();
      navigate(`/suites/${encodeURIComponent(saved.id)}`);
    } catch (caught) {
      draftError = (caught as Error).message;
    } finally {
      creating = false;
    }
  }
</script>

{#if id === 'new'}
  <div class="head-stack">
    <a class="back" href="/suites"><Icon name="back" />Suites</a>
    <div class="page-head"><div class="title"><h1>New suite</h1></div></div>
  </div>
{:else}
  <div class="page-head">
    <div class="title"><h1>Suites</h1></div>
    <div class="actions"><a class="button" href="/suites/new"><Icon name="plus" />New suite</a></div>
    {#if loaded}<p class="sub">{suites.length} {suites.length === 1 ? 'suite' : 'suites'} in <code>.cohort/suites/</code>. A suite is a list of persona and goal entries run together.</p>{/if}
  </div>
{/if}
{#if error}<div class="banner error" role="alert"><div class="body"><span>{error}</span></div></div>{/if}
{#if id === 'new'}
  <form class="editor" onsubmit={create} aria-labelledby="create-title">
    <div class="editor-head">
      <h2 id="create-title">Suite</h2>
      <code class="hint">.cohort/suites/&lt;id&gt;.yml</code>
    </div>
    {#if draftError}<div class="banner error" role="alert"><div class="body"><span>{draftError}</span></div></div>{/if}
    {#if templated && schema}
      <SuiteForm
        bind:source={draft}
        {schema}
        personas={personaIds}
        {models}
        projectMode={config?.defaults.mode}
        error={draftError}
        idPrefix="suite"
        bind:invalid={draftInvalid}
      />
    {:else if !error}
      <Skeleton label="Loading the suite template" />
    {/if}
    <div class="editor-foot">
      <span>New suites cannot reference setup code; add one by editing the file locally.</span>
      <button type="submit" class="primary sm" disabled={!templated || creating || draftInvalid} aria-busy={creating}><Icon name="check" />Validate and create</button>
    </div>
  </form>
{:else if !loaded}
  {#if !error}<Skeleton label="Loading suites" />{/if}
{:else if suites.length === 0}
  <div class="empty">
    <Icon name="suites" size={24} />
    <strong>No suites yet.</strong>
    <p>A suite runs several persona and goal entries together.</p>
    <a class="button" href="/suites/new"><Icon name="plus" />New suite</a>
  </div>
{:else}
  <div class="split">
    <nav aria-label="Suites">
      <ul class="item-list">
        {#each suites as suite (suite.id)}
          <li>
            <a href="/suites/{encodeURIComponent(suite.id)}" aria-current={suite.id === id ? 'page' : undefined}>
              <span class="id">{suite.name ?? suite.id}</span>
              <span class="sub">{suite.entries} entries{#if suite.error} · <span class="badge failed">invalid</span>{/if}</span>
            </a>
          </li>
        {/each}
      </ul>
    </nav>
    <div>
      {#if id}
        <Editor kind="suites" {id} onsaved={list} />
      {:else}
        <div class="empty"><Icon name="suites" size={24} /><p>Select a suite to edit it.</p></div>
      {/if}
    </div>
  </div>
{/if}
