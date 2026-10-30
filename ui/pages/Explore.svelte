<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Shot from '../components/Shot.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import {
    api,
    ApiError,
    artifactPath,
    artifactText,
    download,
    isActive,
    usd,
    type Editable,
    type ExploreSummary,
    type RunSummary,
  } from '../lib/api.ts';

  interface Detail {
    run: RunSummary;
    artifacts: { id: string }[];
  }
  type Kind = 'personas' | 'suites';

  let { id }: { id: string } = $props();
  let detail = $state<Detail | null>(null);
  let summary = $state<ExploreSummary | null>(null);
  let texts = $state<Record<string, string>>({});
  let shotOf = $state<Record<string, string>>({});
  let error = $state('');
  let suggesting = $state(false);
  let saving = $state<string | null>(null);
  let saved = $state<Record<string, { label: string; href: string }>>({});
  let conflicts = $state<Record<string, string>>({});
  let dismissed = $state<string[]>([]);

  const storageKey = $derived(`cohort-explore-dismissed:${id}`);
  const shots = (steps: string[]): string[] => steps.flatMap((step) => (shotOf[step] ? [shotOf[step]] : []));

  async function load(): Promise<void> {
    try {
      detail = await api<Detail>('GET', `/api/runs/${encodeURIComponent(id)}`);
      try {
        dismissed = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[];
      } catch {
        dismissed = [];
      }
      if (isActive(detail.run.status)) return;
      const has = (name: string) => detail!.artifacts.some((artifact) => artifact.id === name);
      if (has('steps.jsonl'))
        shotOf = Object.fromEntries(
          (await artifactText(id, 'steps.jsonl'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { id: string; afterScreenshotId: string | null; beforeScreenshotId: string | null })
            .map((step) => [step.id, step.afterScreenshotId ?? step.beforeScreenshotId ?? ''])
            .filter(([, shot]) => shot),
        );
      if (has('suggestions/explore.json')) await show(JSON.parse(await artifactText(id, 'suggestions/explore.json')) as ExploreSummary);
    } catch (caught) {
      error = (caught as Error).message;
    }
  }

  async function show(next: ExploreSummary): Promise<void> {
    const paths = [...next.personas.map((item) => item.path), ...next.tests.map((item) => item.path), ...(next.suite ? [next.suite.path] : [])];
    texts = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await artifactText(id, path)] as const)));
    summary = next;
  }

  async function suggest(): Promise<void> {
    suggesting = true;
    error = '';
    try {
      await show(await api<ExploreSummary>('POST', `/api/runs/${encodeURIComponent(id)}/suggestions`, {}));
    } catch (caught) {
      error = (caught as Error).message;
    } finally {
      suggesting = false;
    }
  }

  async function save(kind: Kind, itemId: string, replace = false): Promise<void> {
    const key = `${kind}:${itemId}`;
    saving = key;
    delete conflicts[key];
    try {
      const revision = replace ? (await api<Editable>('GET', `/api/${kind}/${encodeURIComponent(itemId)}`)).revision : undefined;
      const result = await api<{ id: string; path: string; action: string }>(
        'POST',
        `/api/runs/${encodeURIComponent(id)}/suggestions/save`,
        { kind, id: itemId, ...(revision ? { revision } : {}) },
      );
      saved[key] = { label: `${result.action} ${result.path}`, href: `/${kind}/${encodeURIComponent(result.id)}` };
    } catch (caught) {
      conflicts[key] =
        caught instanceof ApiError && caught.status === 409 && !replace
          ? 'exists'
          : `${(caught as Error).message}${kind === 'suites' && caught instanceof ApiError && caught.status === 400 ? ' (save its personas first)' : ''}`;
    } finally {
      saving = null;
    }
  }

  function dismiss(key: string, on: boolean): void {
    dismissed = on ? [...dismissed, key] : dismissed.filter((item) => item !== key);
    try {
      localStorage.setItem(storageKey, JSON.stringify(dismissed));
    } catch {
      // A blocked storage only loses dismissals across reloads.
    }
  }

  function testDownload(path: string): void {
    void download(artifactPath(id, path), path.split('/').at(-1)!).catch((caught: Error) => (error = caught.message));
  }

  $effect(() => {
    void id;
    void load();
  });
</script>

{#snippet collapsed(key: string, label: string)}
  <div class="card suggestion dismissed">
    <span class="muted">Dismissed {label}</span>
    <button type="button" class="sm" onclick={() => dismiss(key, false)}>Undo</button>
  </div>
{/snippet}

{#snippet saveControls(kind: Kind, itemId: string)}
  {@const key = `${kind}:${itemId}`}
  <div class="row">
    {#if saved[key]}
      <span class="notice good" role="status">{saved[key].label} <a href={saved[key].href}>Open</a></span>
    {:else}
      <button type="button" class="primary sm" disabled={saving === key} aria-busy={saving === key} onclick={() => save(kind, itemId)}><Icon name="plus" />Save</button>
      {#if conflicts[key] === 'exists'}
        <span class="notice warn" role="alert">{kind === 'personas' ? 'Persona' : 'Suite'} {itemId} exists.</span>
        <button type="button" class="danger sm" disabled={saving === key} onclick={() => save(kind, itemId, true)}>Replace</button>
      {:else if conflicts[key]}
        <span class="notice bad" role="alert">{conflicts[key]}</span>
      {/if}
    {/if}
    <button type="button" class="sm" onclick={() => dismiss(key, true)}>Dismiss</button>
  </div>
{/snippet}

<div class="head-stack">
  <a class="back" href="/runs/{encodeURIComponent(id)}"><Icon name="back" />Run {id}</a>
  <div class="page-head">
    <div class="title"><h1>Suggestions</h1></div>
    {#if summary}
      <p class="sub">{summary.coverage} · suggestion cost {usd(summary.estimatedCostUsd)}</p>
    {/if}
  </div>
</div>
{#if error}<div class="banner error" role="alert"><div class="body"><span>{error}</span></div></div>{/if}

{#if !detail}
  {#if !error}<Skeleton label="Loading run {id}" lines={3} />{/if}
{:else if isActive(detail.run.status)}
  <p class="card muted" role="status">Still exploring. <a href="/runs/{encodeURIComponent(id)}">Watch the run</a> and come back when it finishes.</p>
{:else if !summary}
  <div class="card suggest">
    <p>Ask the model to turn this exploration into personas, a suite and test specs. Nothing is saved until you choose to.</p>
    <button type="button" class="primary" disabled={suggesting} aria-busy={suggesting} onclick={suggest}><Icon name="play" />Suggest (at most $0.50)</button>
  </div>
{:else}
  <section class="section" aria-labelledby="features-title">
    <h2 id="features-title">Features <span class="count">{summary.features.length}</span></h2>
    {#each summary.features as feature (feature.name)}
      {@const key = `feature:${feature.name}`}
      {#if dismissed.includes(key)}{@render collapsed(key, feature.name)}{:else}
        <article class="card suggestion">
          <h3>{feature.name}</h3>
          <p>{feature.description}</p>
          <div class="thumbs">{#each feature.screenshots as shot (shot)}<Shot runId={id} {shot} />{/each}</div>
          <div class="row"><button type="button" class="sm" onclick={() => dismiss(key, true)}>Dismiss</button></div>
        </article>
      {/if}
    {:else}<p class="muted">No features cited.</p>{/each}
  </section>

  <section class="section" aria-labelledby="personas-title">
    <h2 id="personas-title">Personas <span class="count">{summary.personas.length}</span></h2>
    {#each summary.personas as persona (persona.id)}
      {@const key = `personas:${persona.id}`}
      {#if dismissed.includes(key)}{@render collapsed(key, persona.id)}{:else}
        <article class="card suggestion">
          <h3 class="mono">{persona.id}</h3>
          <pre class="source">{texts[persona.path]}</pre>
          <div class="thumbs">{#each shots(persona.steps) as shot (shot)}<Shot runId={id} {shot} />{/each}</div>
          {@render saveControls('personas', persona.id)}
        </article>
      {/if}
    {:else}<p class="muted">No personas suggested.</p>{/each}
  </section>

  {#if summary.suite}
    {@const suite = summary.suite}
    {@const key = `suites:${suite.id}`}
    <section class="section" aria-labelledby="suite-title">
      <h2 id="suite-title">Suite</h2>
      {#if dismissed.includes(key)}{@render collapsed(key, suite.id)}{:else}
        <article class="card suggestion">
          <h3 class="mono">{suite.id}</h3>
          <ol class="goals">
            {#each summary.goals as goal, index (index)}
              <li>
                <p><strong>{goal.persona}</strong>: {goal.goal}</p>
                <div class="thumbs">{#each shots(goal.steps) as shot (shot)}<Shot runId={id} {shot} />{/each}</div>
              </li>
            {/each}
          </ol>
          <details><summary>suite.yml</summary><pre class="source">{texts[suite.path]}</pre></details>
          {@render saveControls('suites', suite.id)}
        </article>
      {/if}
    </section>
  {/if}

  <section class="section" aria-labelledby="tests-title">
    <h2 id="tests-title">Test specs <span class="count">{summary.tests.length}</span></h2>
    <p class="hint">cohort never writes these into your project; download or copy them, then place them yourself.</p>
    {#each summary.tests as spec (spec.name)}
      {@const key = `test:${spec.name}`}
      {#if dismissed.includes(key)}{@render collapsed(key, spec.name)}{:else}
        <article class="card suggestion">
          <h3 class="mono">{spec.name}</h3>
          <div class="thumbs">{#each shots([spec.step]) as shot (shot)}<Shot runId={id} {shot} />{/each}</div>
          <details><summary>{spec.path.split('/').at(-1)}</summary><pre class="source">{texts[spec.path]}</pre></details>
          <div class="row">
            <button type="button" class="sm" onclick={() => testDownload(spec.path)}><Icon name="download" />Download</button>
            <button type="button" class="sm" onclick={() => dismiss(key, true)}>Dismiss</button>
          </div>
        </article>
      {/if}
    {/each}
  </section>

  {#if summary.untried.length > 0}
    <section class="section" aria-labelledby="untried-title">
      <h2 id="untried-title">Not tried <span class="count">{summary.untried.length}</span></h2>
      {#each summary.untried as item (item.step)}
        <article class="card suggestion">
          <p><span class="mono">{item.step}</span> {item.reason}</p>
          <p class="hint mono">{item.pageUrl}</p>
          {#if item.screenshot}<div class="thumbs"><Shot runId={id} shot={item.screenshot} /></div>{/if}
        </article>
      {/each}
    </section>
  {/if}

  {#if summary.dropped.length > 0}
    <section class="section" aria-labelledby="dropped-title">
      <h2 id="dropped-title">Dropped suggestions <span class="count">{summary.dropped.length}</span></h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">Kind</th><th scope="col">Name</th><th scope="col">Reason</th></tr></thead>
          <tbody>
            {#each summary.dropped as item, index (index)}
              <tr><td>{item.kind}</td><td>{item.name}</td><td>{item.reason}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
{/if}
