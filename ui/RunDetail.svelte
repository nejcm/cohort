<script lang="ts">
  import {
    api,
    artifactPath,
    artifactText,
    blobUrl,
    download,
    follow,
    isActive,
    screenshotPath,
    usd,
    type LiveEvent,
    type RunSummary,
  } from './api.ts';
  import AdhocSave from './AdhocSave.svelte';

  interface Claim {
    id: string;
    kind: string;
    source: string;
    statement?: string;
    opinion?: { reason: string };
  }
  interface Report {
    outcome: { state: string; reason: string; kind?: string; code?: string; limit?: string; interruptedBy?: string };
    friction: Claim[];
    steps: number;
    browserActions: number;
    durationMs: number;
    returnedModel: string | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number | null;
      providerReportedCostUsd: number | null;
      accounting: string;
      capEnforcement: string;
    };
    replay: { path: string; status: string };
    issues: { code: string; message: string }[];
  }
  interface Detail {
    run: RunSummary;
    report: Report | null;
    artifacts: { id: string; mediaType: string; bytes: number; sensitivity: string }[];
    screenshots: string[];
  }
  interface Step {
    id: string;
    action: string;
    status: string;
    screenshotId: string | null;
  }
  interface Resolved {
    request: { url?: string; note?: string; limits: { steps: number; timeMs: number; dollars: number } };
    persona: Record<string, unknown> & { body?: string };
  }

  let { id }: { id: string } = $props();
  let detail = $state<Detail | null>(null);
  let resolved = $state<Resolved | null>(null);
  let steps = $state<Step[]>([]);
  let shots = $state<string[]>([]);
  let usage = $state<Record<string, unknown> | null>(null);
  let liveClaims = $state(0);
  let selected = $state<string | null>(null);
  let image = $state<string | null>(null);
  let error = $state('');
  let notice = $state('');

  const urls = new Map<string, string>();

  async function load(): Promise<void> {
    try {
      const next = await api<Detail>('GET', `/api/runs/${encodeURIComponent(id)}`);
      detail = next;
      shots = [...new Set([...shots, ...next.screenshots])];
      const has = (name: string) => next.artifacts.some((artifact) => artifact.id === name);
      if (has('steps.jsonl')) {
        steps = (await artifactText(id, 'steps.jsonl'))
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const step = JSON.parse(line) as {
              id: string;
              action: { name: string };
              result: { status: string; code?: string };
              afterScreenshotId: string | null;
            };
            return {
              id: step.id,
              action: step.action.name,
              status: step.result.code ? `${step.result.status}: ${step.result.code}` : step.result.status,
              screenshotId: step.afterScreenshotId,
            };
          });
      }
      if (has('resolved-config.json')) resolved = JSON.parse(await artifactText(id, 'resolved-config.json')) as Resolved;
      error = '';
    } catch (caught) {
      error = (caught as Error).message;
    }
  }

  function onEvent(event: LiveEvent): void {
    const data = event.data as Record<string, unknown> & { stepId?: string; screenshotId?: string | null };
    if (event.type === 'observation.created' && data.screenshotId) shots = [...new Set([...shots, data.screenshotId])];
    else if (event.type === 'step.started' && data.stepId)
      steps = [...steps.filter((step) => step.id !== data.stepId), {
        id: data.stepId,
        action: String(data.action),
        status: 'running',
        screenshotId: null,
      }];
    else if (event.type === 'step.completed' && data.stepId)
      steps = steps.map((step) =>
        step.id === data.stepId
          ? { ...step, status: String(data.status), screenshotId: data.screenshotId ?? null }
          : step,
      );
    else if (event.type === 'usage.updated') usage = data;
    else if (event.type === 'friction.created') liveClaims += 1;
    else if (event.type === 'run.started' || event.type === 'run.finished') void load();
  }

  $effect(() => {
    void id;
    detail = null;
    resolved = null;
    steps = [];
    shots = [];
    usage = null;
    liveClaims = 0;
    selected = null;
    let stop: (() => void) | undefined;
    void load().then(() => {
      if (detail && isActive(detail.run.status)) stop = follow(id, onEvent, () => void load());
    });
    return () => {
      stop?.();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  });

  $effect(() => {
    if (!selected) return void (image = null);
    const shot = selected;
    const cached = urls.get(shot);
    if (cached) return void (image = cached);
    blobUrl(screenshotPath(id, shot)).then(
      (url) => {
        urls.set(shot, url);
        if (selected === shot) image = url;
      },
      (caught: Error) => (error = caught.message),
    );
  });

  async function cancel(): Promise<void> {
    try {
      await api('POST', `/api/runs/${encodeURIComponent(id)}/cancel`, {});
      notice = 'Cancellation requested.';
      await load();
    } catch (caught) {
      error = (caught as Error).message;
    }
  }

  function onTimelineKey(event: KeyboardEvent): void {
    const index = selected ? shots.indexOf(selected) : -1;
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
    if (next === null || next < 0 || next >= shots.length) return;
    event.preventDefault();
    selected = shots[next]!;
    document.getElementById(`shot-${selected}`)?.focus();
  }

  const DOWNLOADS: [string, string][] = [
    ['report.html', 'Report (HTML)'],
    ['report.md', 'Report (Markdown)'],
    ['report.json', 'Report (JSON)'],
    ['replay.spec.ts', 'Replay script'],
    ['trace.zip', 'Trace (private)'],
  ];
  const run = $derived(detail?.run);
  const report = $derived(detail?.report ?? null);
  const cost = $derived(
    report
      ? (report.usage.providerReportedCostUsd ?? report.usage.estimatedCostUsd)
      : ((usage?.providerReportedCostUsd ?? usage?.estimatedCostUsd ?? null) as number | null),
  );
</script>

<p><a href="#/runs">← Runs</a></p>
{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if notice}<p role="status">{notice}</p>{/if}
{#if run}
  <h1>{run.id}</h1>
  <dl class="facts">
    <dt>Status</dt><dd><span class="status {run.status}">{run.status}</span></dd>
    <dt>Persona</dt><dd>{run.personaId}</dd>
    <dt>Goal</dt><dd>{run.goal}</dd>
    <dt>Model</dt>
    <dd>
      {run.provider}/{run.model} · {run.effort} · {run.mode}
      {#if run.untested}<span class="badge">untested</span>{/if}
      {#if report?.returnedModel && report.returnedModel !== run.model}<span class="hint">(returned {report.returnedModel})</span>{/if}
    </dd>
    <dt>Batch</dt><dd>{run.batchId}, repeat #{run.repeat + 1}</dd>
    <dt>Limits</dt>
    <dd>
      {resolved
        ? `${resolved.request.limits.steps} steps, ${resolved.request.limits.timeMs / 1000} s, ${usd(resolved.request.limits.dollars)}`
        : 'shown when the run finishes'}
    </dd>
    <dt>Cost</dt>
    <dd>
      {usd(cost)}
      {#if report}<span class="hint">({report.usage.accounting}; cap: {report.usage.capEnforcement})</span>
      {:else}<span class="hint">(cap: {run.capEnforcement})</span>{/if}
    </dd>
  </dl>
  {#if isActive(run.status)}<button type="button" onclick={cancel}>Cancel run</button>{/if}

  {#if report}
    <section aria-labelledby="outcome-title">
      <h2 id="outcome-title">Outcome: {report.outcome.state}</h2>
      <p>
        {report.outcome.kind ?? report.outcome.code ?? report.outcome.limit ?? ''}
        {report.outcome.interruptedBy ? `(interrupted by ${report.outcome.interruptedBy})` : ''}
        {report.outcome.reason}
      </p>
      <p class="hint">{report.steps} steps, {report.browserActions} browser actions, {(report.durationMs / 1000).toFixed(1)} s; replay {report.replay.status}</p>
      {#each report.issues as issue (issue.code + issue.message)}<p class="warning">{issue.code}: {issue.message}</p>{/each}
    </section>
    <section aria-labelledby="claims-title">
      <h2 id="claims-title">Friction claims ({report.friction.length})</h2>
      {#if report.friction.length === 0}<p>None.</p>{/if}
      <ul>
        {#each report.friction as claim (claim.id)}
          <li><strong>{claim.kind}</strong> <span class="hint">{claim.source}</span> {claim.statement ?? claim.opinion?.reason ?? ''}</li>
        {/each}
      </ul>
    </section>
  {:else if liveClaims > 0}
    <p>{liveClaims} friction claim{liveClaims === 1 ? '' : 's'} so far.</p>
  {/if}

  <section aria-labelledby="steps-title">
    <h2 id="steps-title">Steps</h2>
    {#if steps.length === 0}<p class="hint">{isActive(run.status) ? 'Waiting for the first step…' : 'No steps recorded.'}</p>{/if}
    <ol class="steps">
      {#each steps as step (step.id)}
        <li>
          <code>{step.id}</code> {step.action} <span class="status {step.status}">{step.status}</span>
          {#if step.screenshotId}
            <button type="button" class="link" onclick={() => (selected = step.screenshotId)}>{step.screenshotId}</button>
          {/if}
        </li>
      {/each}
    </ol>
  </section>

  <section aria-labelledby="timeline-title">
    <h2 id="timeline-title">Screenshot timeline</h2>
    {#if shots.length === 0}<p class="hint">No screenshots yet.</p>{/if}
    <div class="timeline" role="toolbar" aria-label="Screenshots; use the arrow keys" tabindex="-1" onkeydown={onTimelineKey}>
      {#each shots as shot (shot)}
        <button type="button" id="shot-{shot}" aria-pressed={selected === shot} onclick={() => (selected = shot)}>{shot}</button>
      {/each}
    </div>
    {#if image && selected}<img src={image} alt="Masked screenshot {selected}" />{/if}
  </section>

  {#if detail && detail.artifacts.length > 0}
    <section aria-labelledby="downloads-title">
      <h2 id="downloads-title">Downloads</h2>
      <p class="warning">The trace is private raw evidence that may contain secrets; never share or upload it.</p>
      {#each DOWNLOADS.filter(([name]) => detail?.artifacts.some((artifact) => artifact.id === name)) as [name, label] (name)}
        <button type="button" onclick={() => download(artifactPath(id, name), name).catch((caught: Error) => (error = caught.message))}>
          {label}
        </button>
      {/each}
    </section>
  {/if}

  {#if run.personaId === 'adhoc-first-time-user' && resolved}
    <AdhocSave {resolved} />
  {/if}
{/if}
