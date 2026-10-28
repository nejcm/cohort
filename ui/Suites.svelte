<script lang="ts">
  import { api } from './api.ts';
  import Editor from './Editor.svelte';

  let { id }: { id: string | undefined } = $props();
  let suites = $state<{ id: string; name: string | null; entries: number; error: string | null }[]>([]);
  let error = $state('');

  async function list(): Promise<void> {
    try {
      suites = (await api<{ suites: typeof suites }>('GET', '/api/suites')).suites;
    } catch (caught) {
      error = (caught as Error).message;
    }
  }

  $effect(() => {
    void list();
  });
</script>

<h1>Suites</h1>
{#if error}<p class="error" role="alert">{error}</p>{/if}
<div class="split">
  <nav aria-label="Suites">
    {#if suites.length === 0}<p class="hint">No suites. Create <code>.lab/suites/&lt;id&gt;.yml</code> locally.</p>{/if}
    <ul class="list">
      {#each suites as suite (suite.id)}
        <li>
          <a href="#/suites/{encodeURIComponent(suite.id)}" aria-current={suite.id === id ? 'page' : undefined}>
            {suite.name ?? suite.id}
          </a>
          <span class="hint">{suite.entries} entries</span>
          {#if suite.error}<span class="badge error">invalid</span>{/if}
        </li>
      {/each}
    </ul>
  </nav>
  <div>
    {#if id}
      <Editor kind="suites" {id} onsaved={list} />
    {:else}
      <p>Select a suite to edit it.</p>
    {/if}
  </div>
</div>
