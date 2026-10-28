<script lang="ts">
  import { api, isActive, usd, type RunSummary } from './api.ts';

  let runs = $state<RunSummary[]>([]);
  let cursor = $state<string | null>(null);
  let error = $state('');
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

  const status = (run: RunSummary): string =>
    run.status === 'finished'
      ? `${run.outcome ?? 'finished'}${run.blockedKind ? ` (${run.blockedKind})` : ''}${run.interruptedBy ? ` by ${run.interruptedBy}` : ''}`
      : run.status;
  const seconds = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
</script>

<h1>Runs</h1>
{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if runs.length === 0 && !error}
  <p>No runs yet. Start one with <strong>New run</strong>.</p>
{:else}
  <table class="runs">
    <thead>
      <tr>
        <th>Run</th><th>Status</th><th>Persona</th><th>Goal</th><th>Started</th><th>Mode</th><th>Model</th>
        <th>Repeat</th><th>Duration</th><th>Cost</th>
      </tr>
    </thead>
    <tbody>
      {#each runs as run (run.id)}
        <tr>
          <td><a href="#/runs/{encodeURIComponent(run.id)}">{run.id}</a></td>
          <td><span class="status {run.status} {run.outcome ?? ''}">{status(run)}</span></td>
          <td>{run.personaId}</td>
          <td class="goal">{run.goal}</td>
          <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}</td>
          <td>{run.mode}</td>
          <td>
            {run.provider}/{run.model} · {run.effort}
            {#if run.untested}<span class="badge">untested</span>{/if}
          </td>
          <td>#{run.repeat + 1}</td>
          <td>{seconds(run.durationMs)}</td>
          <td>{usd(run.costUsd)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if cursor}<button type="button" onclick={() => load(true)}>Load more</button>{/if}
{/if}
