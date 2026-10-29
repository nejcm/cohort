<script lang="ts">
  import Icon from './Icon.svelte';
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

<div class="page-head">
  <div class="title"><h1>Suites</h1></div>
  <p class="sub">{suites.length} {suites.length === 1 ? 'suite' : 'suites'} in <span class="mono">.cohort/suites/</span>. A suite is a list of persona and goal entries run together.</p>
</div>
{#if error}<div class="banner error" role="alert"><div class="body"><span>{error}</span></div></div>{/if}
<div class="split">
  <nav aria-label="Suites">
    {#if suites.length === 0}<p class="hint">No suites. Create <code>.cohort/suites/&lt;id&gt;.yml</code> locally.</p>{/if}
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
