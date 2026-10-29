<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import { api, badge, isActive, statusLabel, usd, words, type RunSummary } from '../lib/api.ts';

  interface Group {
    personaId: string;
    goal: string;
    mode: string;
    provider: string;
    model: string;
    effort: string;
    untested: boolean;
    runs: { runId: string; costUsd: number | null }[];
    completion: { numerator: number; denominator: number; rate: number | null };
    blocked: { byKind: Record<string, number>; byDetector: Record<string, number> };
    userCancellations: number;
    agentErrors: Record<string, number>;
    limits: Record<string, number>;
    abandoned: number;
    costUsd: { total: number; unknownRuns: number };
  }
  interface Summary {
    groups: Group[];
    notStarted: number;
    totalCostUsd: number;
    unknownCostRuns: number;
    warnings: string[];
  }

  let { id }: { id: string } = $props();
  let runs = $state<RunSummary[]>([]);
  let summary = $state<Summary | null>(null);
  let createdAt = $state('');
  let loaded = $state(false);
  let error = $state('');
  const active = $derived(runs.filter((run) => isActive(run.status)).length);
  const byId = $derived(new Map(runs.map((run) => [run.id, run])));

  const sumOf = (ids: string[], key: 'friction' | 'opinions'): number | null =>
    ids.reduce<number | null>((sum, runId) => {
      const n = byId.get(runId)?.[key];
      return n === null || n === undefined ? sum : (sum ?? 0) + n;
    }, null);
  const groupIds = (group: Group): string[] => group.runs.map((entry) => entry.runId);
  const overall = $derived(
    summary?.groups.reduce((sum, group) => ({ k: sum.k + group.completion.numerator, n: sum.n + group.completion.denominator }), { k: 0, n: 0 }),
  );
  const worst = $derived(
    summary?.groups
      .filter((group) => group.completion.rate !== null)
      .toSorted((a, b) => a.completion.rate! - b.completion.rate!)[0],
  );
  const percent = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 100)}%`);
  const total = (counts: Record<string, number>): number => Object.values(counts).reduce((sum, n) => sum + n, 0);
  const counted = (counts: Record<string, number>): string =>
    Object.entries(counts)
      .map(([key, n]) => `${words(key)} ${n}`)
      .join(', ');
  const segments = (group: Group): [string, string, number][] =>
    (
      [
        ['completed', 'succeeded', group.completion.numerator],
        ['abandoned', 'interrupted', group.abandoned],
        ['limit reached', 'limit', total(group.limits)],
        ['agent error', 'failed', total(group.agentErrors)],
        ['blocked', 'blocked', total(group.blocked.byKind)],
        ['cancelled', 'cancelled', group.userCancellations],
      ] as [string, string, number][]
    ).filter(([, , n]) => n > 0);
  // Bar segments start where the previous one ended, as a share of the group's runs.
  const bars = (group: Group): { tone: string; x: number; width: number }[] => {
    let x = 0;
    return segments(group).map(([, tone, n]) => {
      const width = (n / group.runs.length) * 100;
      x += width;
      return { tone, x: x - width, width };
    });
  };

  async function load(): Promise<void> {
    try {
      const next = await api<{ batch: { createdAt: string }; runs: RunSummary[]; summary: Summary | null }>(
        'GET',
        `/api/batches/${encodeURIComponent(id)}`,
      );
      runs = next.runs;
      summary = next.summary;
      createdAt = next.batch.createdAt;
      error = '';
    } catch (caught) {
      error = (caught as Error).message;
    }
    loaded = true;
  }

  $effect(() => {
    void load();
    // The summary is written once every run ends, so poll until it exists.
    const timer = setInterval(() => {
      if (!summary || active > 0) void load();
    }, 3000);
    return () => clearInterval(timer);
  });
</script>

<div class="head-stack">
  <a class="back" href="/runs"><Icon name="back" />Runs</a>
  <div class="page-head">
    <div class="title"><h1 class="mono">{id}</h1></div>
    {#if loaded && !error}
      <p class="sub">
        {#if worst}
          <strong>{worst.personaId}</strong>{summary && summary.groups.length > 1 ? ` on ${worst.provider}/${worst.model}` : ''} completed {worst.completion.numerator} of {worst.completion.denominator} counted runs.
        {/if}
        Created {new Date(createdAt).toLocaleString()}{summary ? `, spent ${usd(summary.totalCostUsd)}${summary.unknownCostRuns ? ` + ${summary.unknownCostRuns} unknown` : ''}` : ''}.
      </p>
    {/if}
  </div>
</div>
{#if error}<div class="banner error" role="alert"><div class="body"><span>{error}</span></div></div>{/if}
{#if !loaded}
  <Skeleton label="Loading batch {id}" lines={4} />
{:else if summary}
  {@const friction = sumOf([...byId.keys()], 'friction')}
  {@const opinions = sumOf([...byId.keys()], 'opinions')}
  <dl class="kpis" aria-label="Batch at a glance">
    <div>
      <dt>Completed</dt><dd>{percent(overall && overall.n ? overall.k / overall.n : null)}</dd>
      <dd class="note">{overall?.k ?? 0} of {overall?.n ?? 0} counted runs</dd>
    </div>
    <div>
      <dt>Friction</dt><dd>{friction ?? '—'}</dd>
      <dd class="note">measured{opinions ? `, plus ${opinions} agent opinion${opinions === 1 ? '' : 's'}` : ''}</dd>
    </div>
    <div>
      <dt>Runs</dt><dd>{runs.length}</dd>
      <dd class="note">{active ? `${active} still active` : 'all ended'}{summary.notStarted ? `, ${summary.notStarted} not started` : ''}</dd>
    </div>
    <div><dt>Comparisons</dt><dd>{summary.groups.length}</dd><dd class="note">persona, goal, and model groups</dd></div>
  </dl>
  {#each summary.groups as group (group.runs[0]?.runId)}
    {@const groupFriction = sumOf(groupIds(group), 'friction')}
    {@const groupOpinions = sumOf(groupIds(group), 'opinions')}
    <section class="section batch-group" aria-label="{group.personaId} on {group.provider}/{group.model}">
      <div class="section-head">
        <h2>{group.personaId}</h2>
        <span class="hint">
          {group.provider}/{group.model} · {group.effort} · {group.mode}
          {#if group.untested}<span class="badge untested">untested</span>{/if}
        </span>
      </div>
      <div class="card">
        <p class="goal">{group.goal}</p>
        <div class="rate">
          <span class="fig lg">{percent(group.completion.rate)}</span>
          <span class="muted">completed {group.completion.numerator} of {group.completion.denominator} counted runs</span>
        </div>
        <svg class="outcome-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
          {#each bars(group) as bar, index (index)}<rect class={bar.tone} x={bar.x} width={bar.width} height="4" />{/each}
        </svg>
        <ul class="legend">
          {#each segments(group) as [label, tone, n] (label)}<li><span class="swatch {tone}" aria-hidden="true"></span>{label} {n}</li>{/each}
        </ul>
        <dl class="group-facts">
          <dt>Friction</dt>
          <dd>{groupFriction ?? '—'} measured{groupOpinions ? `, ${groupOpinions} agent opinion${groupOpinions === 1 ? '' : 's'}` : ''}</dd>
          {#if total(group.blocked.byKind)}
            <dt>Blocked</dt><dd>{counted(group.blocked.byKind)} ({counted(group.blocked.byDetector)})</dd>
          {/if}
          {#if total(group.agentErrors)}<dt>Agent errors</dt><dd>{counted(group.agentErrors)}</dd>{/if}
          {#if total(group.limits)}<dt>Limits</dt><dd>{counted(group.limits)}</dd>{/if}
          <dt>Cost</dt>
          <dd class="muted">{usd(group.costUsd.total)}{group.costUsd.unknownRuns ? ` + ${group.costUsd.unknownRuns} unknown` : ''}</dd>
        </dl>
        <ul class="group-runs">
          {#each group.runs as entry (entry.runId)}
            {@const run = byId.get(entry.runId)}
            <li>
              <a class="mono" href="/runs/{encodeURIComponent(entry.runId)}">{entry.runId}</a>
              {#if run}<span class="badge {badge(run.status, run.outcome, run.interruptedBy)}">{statusLabel(run)}</span>{/if}
              {#if run?.friction}<span>{run.friction} friction</span>{/if}
              <span class="num muted">{usd(entry.costUsd)}</span>
            </li>
          {/each}
        </ul>
      </div>
    </section>
  {/each}
  <ul class="batch-notes hint">{#each summary.warnings as warning (warning)}<li>{warning}</li>{/each}</ul>
{:else if !error}
  <p class="notice" role="status">The summary is written when every run in the batch ends.</p>
  <ul class="group-runs card">
    {#each runs as run (run.id)}
      <li>
        <a class="mono" href="/runs/{encodeURIComponent(run.id)}">{run.id}</a>
        <span class="badge {badge(run.status, run.outcome, run.interruptedBy)}">{statusLabel(run)}</span>
        <span class="muted">{run.personaId}</span>
      </li>
    {/each}
  </ul>
{/if}
