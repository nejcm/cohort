<script lang="ts">
  import Icon from './Icon.svelte';
  import { stringify } from 'yaml';
  import { api, ApiError, type Editable } from '../lib/api.ts';
  import { personaMarkdown } from '../lib/source.ts';
  import Skeleton from './Skeleton.svelte';

  let { resolved }: { resolved: { request: { url?: string; note?: string }; persona: Record<string, unknown> } } =
    $props();

  let suites = $state<{ id: string; name: string | null }[]>([]);
  let suiteId = $state('');
  let suite = $state<Editable | null>(null);
  let personaMissing = $state(false);
  let message = $state('');
  let error = $state('');
  let loaded = $state(false);
  let busy = $state<'preview' | 'save' | null>(null);

  const personaId = $derived(String(resolved.persona.id));
  const entry = $derived({
    persona: personaId,
    ...(resolved.request.note ? { goal: resolved.request.note } : {}),
    ...(resolved.request.url ? { url: resolved.request.url } : {}),
  });
  const persona = $derived(personaMarkdown(resolved.persona, String(resolved.persona.body ?? '')));

  $effect(() => {
    api<{ suites: { id: string; name: string | null }[] }>('GET', '/api/suites').then(
      (result) => {
        suites = result.suites;
        suiteId = result.suites[0]?.id ?? '';
        loaded = true;
      },
      (caught: Error) => (error = caught.message),
    );
  });

  async function preview(): Promise<void> {
    error = '';
    message = '';
    busy = 'preview';
    try {
      suite = await api<Editable>('GET', `/api/suites/${encodeURIComponent(suiteId)}`);
      personaMissing = await api('GET', `/api/personas/${encodeURIComponent(personaId)}`).then(
        () => false,
        (caught: ApiError) => {
          if (caught.status === 404) return true;
          throw caught;
        },
      );
    } catch (caught) {
      error = (caught as Error).message;
    } finally {
      busy = null;
    }
  }

  async function save(): Promise<void> {
    if (!suite) return;
    error = '';
    busy = 'save';
    try {
      if (personaMissing)
        await api('POST', '/api/personas', { source: persona }).catch((caught: ApiError) => {
          if (caught.status !== 409) throw caught;
        });
      await api('POST', `/api/suites/${encodeURIComponent(suite.id)}/entries`, { entry, revision: suite.revision });
      message = `Saved to .cohort/suites/${suite.id}.yml.`;
      suite = null;
    } catch (caught) {
      error =
        caught instanceof ApiError && caught.status === 409
          ? `${(caught as Error).message} Preview again to load the current file.`
          : (caught as Error).message;
    } finally {
      busy = null;
    }
  }
</script>

<section class="section" aria-labelledby="adhoc-title">
  <div class="section-head"><h2 id="adhoc-title">Save to suite</h2><span class="hint">Ad-hoc run</span></div>
  <div class="card gap">
    {#if !loaded}
      {#if !error}<Skeleton label="Loading suites" lines={2} />{/if}
    {:else if suites.length === 0}
      <p class="hint">No suites exist yet; create a <code>.cohort/suites/&lt;id&gt;.yml</code> file first.</p>
    {:else}
      <div class="form-grid">
        <label for="adhoc-suite">Suite
          <select id="adhoc-suite" bind:value={suiteId} onchange={() => (suite = null)}>
            {#each suites as item (item.id)}<option value={item.id}>{item.name ?? item.id}</option>{/each}
          </select>
        </label>
        <div class="form-actions end"><button type="button" disabled={busy !== null} aria-busy={busy === 'preview'} onclick={preview}><Icon name="eye" />Preview entry</button></div>
      </div>
      {#if suite}
        <p>Appends this entry to <code>.cohort/suites/{suite.id}.yml</code>:</p>
        <pre class="diff" aria-label="Preview of the suite entry">{#each stringify([entry]).trimEnd().split('\n') as line, index (index)}<span class="add">+ {line}</span>{/each}</pre>
        {#if personaMissing}
          <p>It also creates <code>.cohort/personas/{personaId}.md</code>, because a saved entry must reference a persona file:</p>
          <pre class="diff">{#each persona.trimEnd().split('\n') as line, index (index)}<span class="add">+ {line}</span>{/each}</pre>
        {/if}
        <div class="form-actions">
          <button type="button" class="primary" disabled={busy !== null} aria-busy={busy === 'save'} onclick={save}><Icon name="plus" />Save</button>
          <span class="notice">Appends one entry. Existing entries are unchanged.</span>
        </div>
      {/if}
    {/if}
    {#if message}<p class="notice good" role="status">{message}</p>{/if}
    {#if error}<div class="banner error" role="alert"><div class="body"><span>{error}</span></div></div>{/if}
  </div>
</section>
