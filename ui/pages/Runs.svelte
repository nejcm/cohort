<script lang="ts">
  import { untrack } from 'svelte';
  import Ticks from '../components/Ticks.svelte';
  import Icon from '../components/Icon.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import { api, badge, initials, statusLabel, tint, tone, usd, words, type Journey, type RunSummary } from '../lib/api.ts';
  import { navigate } from '../lib/nav.ts';

  let { params }: { params: URLSearchParams } = $props();
  let runs = $state<RunSummary[]>([]);
  let counts = $state<Record<'all' | 'active' | 'look' | 'finished' | 'total' | 'lookTotal' | 'running' | 'queued' | 'finishedToday' | 'frictionToday' | 'spentToday', number> | null>(null);
  let cursor = $state<string | null>(null);
  let error = $state('');
  let loaded = $state(false);
  let text = $state('');
  let latest = 0;
  let busy = $state(false);
  let changed = $state(new Set<string>());
  let journeys = $state<Journey[]>([]);
  let span = $state(10);
  let allJourneys = $state(false);
  const JOURNEY_ROWS = 6;
  const worst = $derived(journeys.find((journey) => journey.counted > 0 && journey.completed < journey.counted));
  const rate = (journey: Journey): string =>
    journey.counted === 0 ? '—' : `${Math.round((journey.completed / journey.counted) * 100)}%`;

  const COLUMNS: [string, string, string?][] = [
    ['persona', 'Persona and goal'],
    ['status', 'Outcome'],
    ['friction', 'Friction', 'num'],
    ['started', 'Started'],
    ['model', 'Model'],
    ['duration', 'Duration', 'num'],
    ['cost', 'Cost', 'num'],
  ];
  const TABS: [string, string][] = [
    ['', 'All'],
    ['active', 'Active'],
    ['look', 'Needs a look'],
    ['finished', 'Finished'],
  ];
  const tab = $derived(TABS.find(([key]) => key === params.get('f'))?.[0] ?? '');
  const sort = $derived(COLUMNS.find(([key]) => key === params.get('sort'))?.[0] ?? 'created');
  const asc = $derived(params.get('dir') === 'asc');
  const search = $derived(params.get('q')?.trim() ?? '');
  function href(change: Record<string, string>): string {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(change)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    return next.size ? `/runs?${next}` : '/runs';
  }
  const setSort = (key: string, ascending: boolean): void =>
    navigate(href({ sort: key === 'created' ? '' : key, dir: ascending ? 'asc' : '' }));
  const query = $derived(
    `/api/runs?limit=50${sort === 'created' ? '' : `&sort=${sort}`}${asc ? '&dir=asc' : ''}${tab ? `&f=${tab}` : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`,
  );

  async function load(more = false, keep = more ? 0 : runs.length): Promise<void> {
    const ticket = ++latest;
    busy = true;
    const asked = query;
    const midnight = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    try {
      let list = more ? runs : [];
      let next = more ? cursor : null;
      let page;
      // A refresh refetches every loaded page so rows that left the sort order or filter drop out.
      do {
        page = await api<{ runs: RunSummary[]; nextCursor: string | null; counts: NonNullable<typeof counts> }>(
          'GET',
          `${asked}&since=${midnight}${next ? `&cursor=${next}` : ''}`,
        );
        if (ticket !== latest) return;
        const seen = new Set(list.map((run) => run.id));
        list = [...list, ...page.runs.filter((run) => !seen.has(run.id))];
        next = page.nextCursor;
      } while (next && list.length < keep);
      const before = new Map(runs.map((run) => [run.id, statusLabel(run)]));
      changed = new Set(list.filter((run) => before.has(run.id) && before.get(run.id) !== statusLabel(run)).map((run) => run.id));
      if (!more) {
        const found = await api<{ window: number; journeys: Journey[] }>('GET', '/api/journeys');
        if (ticket !== latest) return;
        journeys = found.journeys;
        span = found.window;
      }
      runs = list;
      counts = page.counts;
      cursor = next;
      error = '';
    } catch (caught) {
      if (ticket === latest) error = (caught as Error).message;
    } finally {
      loaded = true;
      if (ticket === latest) busy = false;
    }
  }

  $effect.pre(() => {
    const value = search;
    if (untrack(() => text.trim()) !== value) text = value;
  });
  $effect(() => {
    const value = text.trim();
    if (value === search) return;
    const timer = setTimeout(() => navigate(href({ q: value }), true), 250);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    void load(false, 0);
    // shortcut: refetches every loaded page every 3 s while runs are active or the last load failed; subscribe to a list event stream if that gets heavy.
    // A batch recounts comparison claims just after its last run ends, so keep polling a few ticks past that.
    let tail = 0;
    const timer = setInterval(() => {
      if (counts && counts.running + counts.queued > 0) tail = 3;
      else if (tail > 0) tail -= 1;
      else if (!error) return;
      if (!busy) void load();
    }, 3000);
    return () => clearInterval(timer);
  });

  const order = (key: string, kind?: string): void => setSort(key, sort === key ? !asc : !kind && key !== 'started');
  const SORTS: [string, string][] = [
    ['created:desc', 'Newest first'],
    ['created:asc', 'Oldest first'],
    ...COLUMNS.flatMap(([key, label]): [string, string][] => [
      [`${key}:asc`, `${label}, ascending`],
      [`${key}:desc`, `${label}, descending`],
    ]),
  ];
  function pick(event: Event): void {
    const [key, dir] = (event.currentTarget as HTMLSelectElement).value.split(':');
    setSort(key!, dir === 'asc');
  }
  const sum = (list: RunSummary[]): number => list.reduce((total, run) => total + (run.costUsd ?? 0), 0);

  const seconds = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
  const started = (at: string | null): string => {
    if (!at) return '—';
    const date = new Date(at);
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return date.toDateString() === new Date().toDateString()
      ? `Today ${time}`
      : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  };
</script>

<div class="page-head">
  <div class="title"><h1>Runs</h1></div>
  {#if counts && counts.total > 0}
    <p class="spend" title="Reported or estimated">Spent today {usd(counts.spentToday)}</p>
    <p class="sub">
      {#if counts.running + counts.queued > 0}{counts.running} running, {counts.queued} queued.{/if}
      {#if worst}
        <strong>{worst.personaId}</strong> completed {worst.completed} of {worst.counted} recent runs of “{worst.goal}”
      {:else if journeys.length > 0 && journeys.every((journey) => journey.counted > 0)}
        Every journey completed its recent runs.
      {:else if journeys.some((journey) => journey.counted === 0)}
        {@const stuck = journeys.find((journey) => journey.counted === 0)!}
        <strong>{stuck.personaId}</strong> was blocked or cancelled on every recent run of “{stuck.goal}”
      {/if}
    </p>
  {/if}
</div>
{#if error}
  <div class="banner error" role="alert">
    <div class="body"><strong>Couldn't load runs.</strong><span>{error} Retrying every few seconds.</span></div>
  </div>
{/if}
{#if loaded && counts?.total === 0 && !error}
  <div class="empty">
    <Icon name="play" size={24} />
    <strong>No runs yet.</strong>
    <p>Start one with <strong>New run</strong>.</p>
  </div>
{:else if counts}
  <dl class="kpis" aria-label="Runs at a glance">
    <div>
      <dt>Needs a look</dt><dd class:warn={counts.lookTotal > 0}>{counts.lookTotal}</dd>
      <dd><Ticks value={counts.lookTotal} max={counts.total} tone="warn" /></dd>
      <dd class="note">blocked, limit reached, failed</dd>
    </div>
    <div>
      <dt>Friction today</dt><dd>{counts.frictionToday}</dd>
      <dd class="note">claims the harness measured</dd>
    </div>
    <div>
      <dt>Finished today</dt><dd>{counts.finishedToday}</dd>
      <dd><Ticks value={counts.finishedToday} max={counts.total} /></dd>
      <dd class="note">of {counts.total} runs</dd>
    </div>
    <div>
      <dt>Running</dt><dd>{counts.running}</dd>
      <dd class="note">{counts.queued} queued behind them</dd>
    </div>
  </dl>
  {#if journeys.length > 0}
    <section class="section journeys" aria-labelledby="journeys-title">
      <div class="section-head">
        <h2 id="journeys-title">Journeys <span class="count">{journeys.length}</span></h2>
        <span class="hint">Each persona and goal over its latest {span} runs, lowest completion first</span>
      </div>
      <div class="table-wrap boxed">
        <table class="journeys">
          <thead>
            <tr>
              <th scope="col">Persona and goal</th>
              <th scope="col">Latest runs</th>
              <th scope="col" class="num">Completed</th>
              <th scope="col" class="num">Friction</th>
              <th scope="col" class="num">Last run</th>
            </tr>
          </thead>
          <tbody>
            {#each allJourneys ? journeys : journeys.slice(0, JOURNEY_ROWS) as journey (journey.personaId + '\n' + journey.goal)}
              <tr>
                <td class="clip">
                  <span class="who"><span class="av {tint(journey.personaId)}" aria-hidden="true">{initials(journey.personaId)}</span><span class="nm">{journey.personaId}</span></span>
                  <span class="goal" title={journey.goal}>{journey.goal}</span>
                </td>
                <td>
                  <ol class="marks" aria-label="Latest {journey.latest.length} runs, oldest first">
                    {#each journey.latest as run (run.id)}
                      <li><a class="mark {tone(run.outcome, run.interruptedBy)}" href="/runs/{encodeURIComponent(run.id)}" title="{run.id}: {words(run.outcome)}" aria-label="{run.id}: {words(run.outcome)}"></a></li>
                    {/each}
                  </ol>
                </td>
                <td class="num">
                  <span class="fig rate">{rate(journey)}</span>
                  <Ticks value={journey.completed} max={journey.counted || 1} count={10} size="sm" />
                  <span class="of">{journey.completed} of {journey.counted}{journey.blocked ? `, ${journey.blocked} blocked` : ''}</span>
                </td>
                <td class="num" class:muted={!journey.friction}>{journey.friction ?? '—'}<span class="ph"> friction</span></td>
                <td class="num muted">
                  {started(journey.lastAt)}
                  {#if journey.models > 1}<span class="of">{journey.models} models</span>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if journeys.length > JOURNEY_ROWS}
        <button type="button" class="link more" onclick={() => (allJourneys = !allJourneys)}>
          {allJourneys ? 'Show fewer' : `Show all ${journeys.length} journeys`}
        </button>
      {/if}
    </section>
  {/if}
  <ul class="tabs" aria-label="Filter runs">
    {#each TABS as [key, label] (key)}
      <li>
        <a href={href({ f: key })} aria-current={tab === key ? 'true' : undefined}>
          {label} <span class="n">{counts[(key || 'all') as keyof typeof counts]}</span>
        </a>
      </li>
    {/each}
  </ul>
  <div class="toolbar">
    <input class="search sm" type="search" placeholder="Filter by run, goal, persona, model" aria-label="Search runs" bind:value={text} />
    <select class="sort-pick sm" aria-label="Sort runs" value="{sort}:{asc ? 'asc' : 'desc'}" onchange={pick}>
      {#each SORTS as [value, label] (value)}<option {value}>{label}</option>{/each}
    </select>
    <span class="tab">{runs.length} loaded · {usd(sum(runs))}</span></div>
  <div class="table-wrap runs boxed">
    <table class="runs fixed">
      <colgroup>{#each COLUMNS as [key] (key)}<col />{/each}</colgroup>
      <thead>
        <tr>
          {#each COLUMNS as [key, label, kind] (key)}
            <th scope="col" class={kind} aria-sort={sort === key ? (asc ? 'ascending' : 'descending') : undefined}>
              <span class="head">{label}</span>
              <button type="button" class="sort" onclick={() => order(key, kind)}>
                {label}<span class="dir" aria-hidden="true">{sort === key ? (asc ? '↑' : '↓') : ''}</span>
              </button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each runs as run (run.id)}
          <tr class:changed={changed.has(run.id)}>
            <td class="clip">
              <a class="rid who" href="/runs/{encodeURIComponent(run.id)}"><span class="av {tint(run.personaId)}" aria-hidden="true">{initials(run.personaId)}</span><span class="nm">{run.personaId}</span></a>
              <span class="goal" title={run.goal}>{run.goal}</span>
            </td>
            <td>
              <span class="st">
                <span class="badge {badge(run.status, run.outcome, run.interruptedBy)}">{statusLabel(run)}</span>
                {#if run.status === 'running'}<em>{run.steps} steps</em>{/if}
              </span>
            </td>
            <td class="num" class:muted={!run.friction} title={run.opinions ? `plus ${run.opinions} agent opinion${run.opinions === 1 ? '' : 's'}` : undefined}>
              {run.friction ?? '—'}<span class="ph"> friction</span>
            </td>
            <td class="muted tab clip">{started(run.startedAt)}<span class="goal mono">{run.id}</span></td>
            <td class="clip muted" title="{run.provider}/{run.model} · {run.effort} · {run.mode} · repeat #{run.repeat + 1}">
              {run.provider}/{run.model}
              {#if run.untested}<span class="badge untested">untested</span>{/if}
              <span class="goal">{run.effort} · {run.mode} · #{run.repeat + 1}</span>
            </td>
            <td class="num muted">{seconds(run.durationMs)}</td>
            <td class="num muted">{usd(run.costUsd)}</td>
          </tr>
        {:else}
          <tr><td colspan={COLUMNS.length} class="muted">No runs match.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div class="toolbar">
    <span>Showing {runs.length} of {counts[(tab || 'all') as keyof typeof counts]} runs</span>
    {#if cursor}<button type="button" disabled={busy} onclick={() => load(true)}><Icon name="chevronDown" />Load more</button>{/if}
  </div>
{:else if !error}
  <Skeleton label="Loading runs" lines={4} />
{/if}
