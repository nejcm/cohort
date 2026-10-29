<script lang="ts">
  import { api, badge, isActive, statusLabel, usd, type RunSummary } from './api.ts';

  let { filter }: { filter: string } = $props();
  let runs = $state<RunSummary[]>([]);
  let cursor = $state<string | null>(null);
  let error = $state('');
  let loaded = $state(false);
  let paged = false;

  async function load(more = false): Promise<void> {
    try {
      const page = await api<{ runs: RunSummary[]; nextCursor: string | null }>(
        'GET',
        `/api/runs?limit=50${more && cursor ? `&cursor=${cursor}` : ''}`,
      );
      const fresh = new Set(page.runs.map((run) => run.id));
      // A refresh replaces the first page but keeps rows already loaded through "Load more".
      runs = more ? [...runs, ...page.runs] : [...page.runs, ...(paged ? runs.filter((run) => !fresh.has(run.id)) : [])];
      if (more || !paged) cursor = page.nextCursor;
      paged ||= more;
      error = '';
    } catch (caught) {
      error = (caught as Error).message;
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    void load();
    // shortcut: polls only the first page every 3 s while runs are active, so active rows further down stay stale; subscribe to a list event stream if that matters.
    const timer = setInterval(() => {
      if (runs.some((run) => isActive(run.status))) void load();
    }, 3000);
    return () => clearInterval(timer);
  });

  const needsLook = (run: RunSummary): boolean =>
    run.status === 'finished' && ['blocked', 'limit_reached', 'agent_error'].includes(run.outcome ?? '');
  const today = (run: RunSummary): boolean => new Date(run.createdAt).toDateString() === new Date().toDateString();
  const FILTERS: Record<string, (run: RunSummary) => boolean> = {
    active: (run) => isActive(run.status),
    look: needsLook,
    finished: (run) => !isActive(run.status),
  };
  const shown = $derived(FILTERS[filter] ? runs.filter(FILTERS[filter]) : runs);
  const count = (test: (run: RunSummary) => boolean): number => runs.filter(test).length;
  const sum = (list: RunSummary[]): number => list.reduce((total, run) => total + (run.costUsd ?? 0), 0);
  const TABS: [string, string][] = [
    ['', 'All'],
    ['active', 'Active'],
    ['look', 'Needs a look'],
    ['finished', 'Finished'],
  ];

  const initials = (id: string): string =>
    id
      .split(/[-_\s]+/u)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
  const tint = (id: string): string => `p${[...id].reduce((hash, char) => hash + char.charCodeAt(0), 0) % 5}`;
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
  <p class="sub">{count((run) => run.status === 'running')} running, {count((run) => run.status === 'queued')} queued.</p>
</div>
{#if error}
  <div class="banner error" role="alert">
    <div class="body"><strong>Couldn't load runs.</strong><span>{error}</span></div>
  </div>
{/if}
{#if loaded && runs.length === 0 && !error}
  <div class="empty">
    <strong>No runs yet.</strong>
    <p>Start one with <strong>New run</strong>.</p>
  </div>
{:else if runs.length > 0}
  <dl class="kpis" aria-label="Loaded runs at a glance">
    <div>
      <dt>Running</dt><dd>{count((run) => run.status === 'running')}</dd>
      <dd class="note">{count((run) => run.status === 'queued')} queued behind them</dd>
    </div>
    <div>
      <dt>Needs a look</dt><dd class="warn"><span class="tick" aria-hidden="true"></span>{count(needsLook)}</dd>
      <dd class="note">blocked, limit reached, failed</dd>
    </div>
    <div>
      <dt>Finished today</dt><dd>{count((run) => today(run) && !isActive(run.status))}</dd>
      <dd class="note">of {runs.length} loaded</dd>
    </div>
    <div>
      <dt>Spent today</dt><dd>{usd(sum(runs.filter(today)))}</dd><dd class="note">provider-reported</dd>
    </div>
  </dl>
  <ul class="tabs" aria-label="Filter runs">
    {#each TABS as [key, label] (key)}
      <li>
        <a href={key ? `/runs?f=${key}` : '/runs'} aria-current={filter === key || (!FILTERS[filter] && !key) ? 'true' : undefined}>
          {label} <span class="n">{key ? count(FILTERS[key]!) : runs.length}</span>
        </a>
      </li>
    {/each}
  </ul>
  <div class="toolbar"><span>Newest first</span><span>{runs.length} loaded · <span class="mono">{usd(sum(runs))}</span></span></div>
  <div class="table-wrap runs">
    <table class="runs fixed">
      <colgroup>{#each { length: 10 } as _, index (index)}<col />{/each}</colgroup>
      <thead>
        <tr>
          <th scope="col">Run</th><th scope="col">Status</th><th scope="col">Persona</th><th scope="col">Goal</th>
          <th scope="col">Started</th><th scope="col">Mode</th><th scope="col">Model</th>
          <th scope="col" class="num">Repeat</th><th scope="col" class="num">Duration</th><th scope="col" class="num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {#each shown as run (run.id)}
          <tr>
            <td><a class="rid" href="/runs/{encodeURIComponent(run.id)}">{run.id}</a></td>
            <td>
              <span class="st">
                <span class="badge {badge(run.status, run.outcome, run.interruptedBy)}">{statusLabel(run)}</span>
                {#if run.status === 'running'}<em>{run.steps} steps</em>{/if}
              </span>
            </td>
            <td class="clip">
              <span class="who"><span class="av {tint(run.personaId)}" aria-hidden="true">{initials(run.personaId)}</span><span class="nm">{run.personaId}</span></span>
            </td>
            <td class="clip muted" title={run.goal}>{run.goal}</td>
            <td class="mono muted">{started(run.startedAt)}</td>
            <td class="muted">{run.mode}</td>
            <td class="clip" title="{run.provider}/{run.model} · {run.effort}">
              {run.provider}/{run.model} · {run.effort}
              {#if run.untested}<span class="badge untested">untested</span>{/if}
            </td>
            <td class="num muted">#{run.repeat + 1}</td>
            <td class="num">{seconds(run.durationMs)}</td>
            <td class="num">{usd(run.costUsd)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div class="toolbar">
    <span>Showing {shown.length} runs</span>
    {#if cursor}<button type="button" onclick={() => load(true)}>Load more</button>{/if}
  </div>
{/if}
