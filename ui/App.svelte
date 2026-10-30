<script lang="ts">
  import Icon from './components/Icon.svelte';
  import { bootstrapToken } from './lib/api.ts';
  import Logo from './components/Logo.svelte';
  import BatchDetail from './pages/BatchDetail.svelte';
  import Explore from './pages/Explore.svelte';
  import Personas from './pages/Personas.svelte';
  import RunDetail from './pages/RunDetail.svelte';
  import RunDialog from './components/RunDialog.svelte';
  import Runs from './pages/Runs.svelte';
  import { navigate } from './lib/nav.ts';
  import Suites from './pages/Suites.svelte';

  const DOCS_URL = 'https://github.com/nejcm/cohort#readme';
  const token = bootstrapToken();
  let path = $state(location.pathname.slice(1));
  let query = $state(location.search);
  let navOpen = $state(false);
  let dialog: RunDialog | undefined = $state();

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

  function follow(event: MouseEvent): void {
    const link = (event.target as Element).closest('a');
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      link.target ||
      link.hasAttribute('download') ||
      link.origin !== location.origin ||
      link.pathname.startsWith('/api/')
    )
      return;
    event.preventDefault();
    navigate(link.pathname + link.search);
  }
</script>

<svelte:window
  onclick={follow}
  onpopstate={() => {
    path = location.pathname.slice(1);
    query = location.search;
    navOpen = false;
  }}
/>

{#snippet brand()}
  <a class="brand" href="/runs"><Logo /><span>cohort<span class="stop">.</span></span></a>
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
            <a href="/runs" aria-current={section === 'runs' ? 'page' : undefined}>
              <Icon name="play" />Runs
            </a>
          </li>
          <li>
            <a href="/personas" aria-current={section === 'personas' ? 'page' : undefined}>
              <Icon name="persona" />Personas
            </a>
          </li>
          <li>
            <a href="/suites" aria-current={section === 'suites' ? 'page' : undefined}>
              <Icon name="suites" />Suites
            </a>
          </li>
          <li>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
              <Icon name="book" />CLI docs<Icon name="external" size={14} />
            </a>
          </li>
        </ul>
      </nav>
      <p class="side-foot">Runs, screenshots and traces stay on this machine.</p>
    </aside>
    <div class="top">
      <button class="menu" type="button" aria-label="Open navigation" aria-expanded={navOpen} onclick={() => (navOpen = !navOpen)}>
        <Icon name="menu" size={18} />
      </button>
      <span class="crumb">
        <span class="host mono">{location.host}</span><span class="sep" aria-hidden="true">/</span>
        {#if route[1]}
          <a class="up" href="/{section}">{title}</a><span class="sep up" aria-hidden="true">/</span><b class="mono">{route[1]}</b>
        {:else}
          <b>{title}</b>
        {/if}
      </span>
      <div class="top-actions">
        <button type="button" class="primary sm" onclick={() => dialog?.open()}><Icon name="plus" />New run</button>
      </div>
    </div>
    <main>
      {#if section === 'personas'}
        <Personas id={route[1] || undefined} />
      {:else if section === 'suites'}
        <Suites id={route[1] || undefined} />
      {:else if route[0] === 'batches' && route[1]}
        {#key route[1]}<BatchDetail id={route[1]} />{/key}
      {:else if route[0] === 'runs' && route[1] && route[2] === 'explore'}
        {#key route[1]}<Explore id={route[1]} />{/key}
      {:else if route[1]}
        {#key route[1]}<RunDetail id={route[1]} shot={new URLSearchParams(query).get('shot')} />{/key}
      {:else}
        <Runs params={new URLSearchParams(query)} />
      {/if}
    </main>
    <RunDialog bind:this={dialog} />
  </div>
{/if}
