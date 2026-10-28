<script lang="ts">
  import { bootstrapToken } from './api.ts';
  import Personas from './Personas.svelte';
  import RunDetail from './RunDetail.svelte';
  import RunDialog from './RunDialog.svelte';
  import Runs from './Runs.svelte';
  import Suites from './Suites.svelte';

  const token = bootstrapToken();
  let hash = $state(location.hash);
  let dialog: RunDialog | undefined = $state();

  const route = $derived(
    hash
      .replace(/^#\/?/u, '')
      .split('/')
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return '';
        }
      }),
  );
  const section = $derived(['runs', 'personas', 'suites'].includes(route[0]!) ? route[0] : 'runs');
</script>

<svelte:window onhashchange={() => (hash = location.hash)} />

{#if !token}
  <main>
    <h1>Synthetic Customer Lab</h1>
    <p>Open the launch URL that <code>lab ui</code> printed; it carries this session's access token.</p>
  </main>
{:else}
  <header>
    <nav aria-label="Main">
      <a href="#/runs" aria-current={section === 'runs' ? 'page' : undefined}>Runs</a>
      <a href="#/personas" aria-current={section === 'personas' ? 'page' : undefined}>Personas</a>
      <a href="#/suites" aria-current={section === 'suites' ? 'page' : undefined}>Suites</a>
    </nav>
    <button type="button" onclick={() => dialog?.open()}>New run</button>
  </header>
  <main>
    {#if section === 'personas'}
      <Personas id={route[1] || undefined} />
    {:else if section === 'suites'}
      <Suites id={route[1] || undefined} />
    {:else if route[1]}
      {#key route[1]}<RunDetail id={route[1]} />{/key}
    {:else}
      <Runs />
    {/if}
  </main>
  <RunDialog bind:this={dialog} />
{/if}
