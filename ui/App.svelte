<script lang="ts">
  import { bootstrapToken } from './api.ts';
  import Logo from './Logo.svelte';
  import Personas from './Personas.svelte';
  import RunDetail from './RunDetail.svelte';
  import RunDialog from './RunDialog.svelte';
  import Runs from './Runs.svelte';
  import Suites from './Suites.svelte';

  const token = bootstrapToken();
  let hash = $state(location.hash);
  let navOpen = $state(false);
  let dialog: RunDialog | undefined = $state();

  const [path, query] = $derived(hash.replace(/^#\/?/u, '').split('?') as [string, string | undefined]);
  const route = $derived(
    path.split('/').map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    }),
  );
  const section = $derived(['runs', 'personas', 'suites'].includes(route[0]!) ? route[0]! : 'runs');
  const title = $derived(section[0]!.toUpperCase() + section.slice(1));
  const filter = $derived(new URLSearchParams(query).get('f') ?? '');
</script>

<svelte:window
  onhashchange={() => {
    hash = location.hash;
    navOpen = false;
  }}
/>

{#snippet brand()}
  <a class="brand" href="#/runs"><Logo /><span>cohort<span class="stop">.</span></span></a>
{/snippet}

{#if !token}
  <div class="app bare">
    <div class="top">{@render brand()}</div>
    <main class="gate">
      <div class="card">
        <h1>Open the launch URL</h1>
        <p class="muted">Open the launch URL that <code class="cmd">cohort ui</code> printed; it carries this session's access token.</p>
        <p class="hint">The dashboard listens only on 127.0.0.1, and each <code>cohort ui</code> session has its own token.</p>
      </div>
    </main>
  </div>
{:else}
  <div class="app">
    <aside class="side" class:open={navOpen}>
      {@render brand()}
      <nav aria-label="Main">
        <ul>
          <li>
            <a href="#/runs" aria-current={section === 'runs' ? 'page' : undefined}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 3.5l7 4.5-7 4.5z" stroke-linejoin="round" /></svg>Runs
            </a>
          </li>
          <li>
            <a href="#/personas" aria-current={section === 'personas' ? 'page' : undefined}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.8-2.5 2.7-3.5 5-3.5s4.2 1 5 3.5" stroke-linecap="round" /></svg>Personas
            </a>
          </li>
          <li>
            <a href="#/suites" aria-current={section === 'suites' ? 'page' : undefined}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3" width="11" height="3" rx="1" /><rect x="2.5" y="9" width="11" height="3" rx="1" /></svg>Suites
            </a>
          </li>
        </ul>
      </nav>
      <p class="side-foot">Runs, screenshots and traces stay on this machine.</p>
    </aside>
    <div class="top">
      <button class="menu" type="button" aria-label="Open navigation" aria-expanded={navOpen} onclick={() => (navOpen = !navOpen)}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 5h12M3 9h12M3 13h12" stroke-linecap="round" /></svg>
      </button>
      <span class="crumb">
        <span class="host mono">{location.host}</span><span class="sep" aria-hidden="true">/</span>
        {#if route[1]}
          <a class="up" href="#/{section}">{title}</a><span class="sep up" aria-hidden="true">/</span><b class="mono">{route[1]}</b>
        {:else}
          <b>{title}</b>
        {/if}
      </span>
      <div class="top-actions">
        <button type="button" class="primary" onclick={() => dialog?.open()}>New run</button>
      </div>
    </div>
    <main>
      {#if section === 'personas'}
        <Personas id={route[1] || undefined} />
      {:else if section === 'suites'}
        <Suites id={route[1] || undefined} />
      {:else if route[1]}
        {#key route[1]}<RunDetail id={route[1]} />{/key}
      {:else}
        <Runs {filter} />
      {/if}
    </main>
    <RunDialog bind:this={dialog} />
  </div>
{/if}
