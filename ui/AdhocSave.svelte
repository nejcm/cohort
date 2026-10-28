<script lang="ts">
  import { stringify } from 'yaml';
  import { api, ApiError, type Editable } from './api.ts';
  import { personaMarkdown } from './source.ts';

  let { resolved }: { resolved: { request: { url?: string; note?: string }; persona: Record<string, unknown> } } =
    $props();

  let suites = $state<{ id: string; name: string | null }[]>([]);
  let suiteId = $state('');
  let suite = $state<Editable | null>(null);
  let personaMissing = $state(false);
  let message = $state('');
  let error = $state('');

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
      },
      (caught: Error) => (error = caught.message),
    );
  });

  async function preview(): Promise<void> {
    error = '';
    message = '';
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
    }
  }

  async function save(): Promise<void> {
    if (!suite) return;
    error = '';
    try {
      if (personaMissing)
        await api('POST', '/api/personas', { source: persona }).catch((caught: ApiError) => {
          if (caught.status !== 409) throw caught;
        });
      await api('POST', `/api/suites/${encodeURIComponent(suite.id)}/entries`, { entry, revision: suite.revision });
      message = `Saved to .lab/suites/${suite.id}.yml.`;
      suite = null;
    } catch (caught) {
      error =
        caught instanceof ApiError && caught.status === 409
          ? `${(caught as Error).message} Preview again to load the current file.`
          : (caught as Error).message;
    }
  }
</script>

<section aria-labelledby="adhoc-title">
  <h2 id="adhoc-title">Save to suite</h2>
  {#if suites.length === 0}
    <p class="hint">No suites exist yet; create a <code>.lab/suites/&lt;id&gt;.yml</code> file first.</p>
  {:else}
    <label for="adhoc-suite">Suite</label>
    <select id="adhoc-suite" bind:value={suiteId} onchange={() => (suite = null)}>
      {#each suites as item (item.id)}<option value={item.id}>{item.name ?? item.id}</option>{/each}
    </select>
    <button type="button" onclick={preview}>Preview entry</button>
    {#if suite}
      <p>Appends this entry to <code>.lab/suites/{suite.id}.yml</code>:</p>
      <pre>{stringify([entry])}</pre>
      {#if personaMissing}
        <p>It also creates <code>.lab/personas/{personaId}.md</code>, because a saved entry must reference a persona file:</p>
        <pre>{persona}</pre>
      {/if}
      <button type="button" onclick={save}>Save</button>
    {/if}
  {/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
