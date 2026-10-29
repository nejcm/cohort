<script lang="ts">
  import Icon from './Icon.svelte';
  import {
    api,
    artifactPath,
    artifactText,
    blobUrl,
    download,
    follow,
    badge,
    isActive,
    screenshotPath,
    usd,
    words,
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
  const current = $derived(selected ?? shots.at(-1) ?? null);
  let image = $state<string | null>(null);
  let error = $state('');
  let notice = $state('');

  const urls = new Map<string, string>();
  let settling: ReturnType<typeof setTimeout> | undefined;

  // Comparison claims land after the whole batch ends, once its summary is written; poll until then.
  async function settle(grace = 3): Promise<void> {
    const owner = id;
    const batchId = detail?.run.batchId;
    const batch = batchId
      ? await api<{ runs: RunSummary[]; summary: unknown }>('GET', `/api/batches/${encodeURIComponent(batchId)}`).catch(
          () => null,
        )
      : null;
    if (owner !== id) return;
    await load();
    if (!batch || batch.summary || owner !== id) return;
    const left = batch.runs.some((run) => isActive(run.status)) ? 3 : grace - 1;
    if (left > 0) settling = setTimeout(() => void settle(left), 2000);
  }

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
      if (detail && isActive(detail.run.status)) stop = follow(id, onEvent, () => void settle());
      else void settle();
    });
    return () => {
      stop?.();
      clearTimeout(settling);
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  });

  $effect(() => {
    if (!current) return void (image = null);
    const shot = current;
    const cached = urls.get(shot);
    if (cached) return void (image = cached);
    blobUrl(screenshotPath(id, shot)).then(
      (url) => {
        urls.set(shot, url);
        if (current === shot) image = url;
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
    const index = current ? shots.indexOf(current) : -1;
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
    if (next === null || next < 0 || next >= shots.length) return;
    event.preventDefault();
    selected = shots[next]!;
    document.getElementById(`shot-${selected}`)?.focus();
  }

  const REPORTS: [string, string][] = [
    ['report.html', 'HTML'],
    ['report.md', 'Markdown'],
    ['report.json', 'JSON'],
  ];
  const has = (name: string): boolean => detail?.artifacts.some((artifact) => artifact.id === name) === true;
  const save = (name: string): void => void download(artifactPath(id, name), name).catch((caught: Error) => (error = caught.message));
  const TONES: Record<string, string> = { completed: 'tone-good', blocked: 'tone-warn', limit_reached: 'tone-warn', agent_error: 'tone-bad' };
  const run = $derived(detail?.run);
  const report = $derived(detail?.report ?? null);
  const cost = $derived(
    report
      ? (report.usage.providerReportedCostUsd ?? report.usage.estimatedCostUsd)
      : ((usage?.providerReportedCostUsd ?? usage?.estimatedCostUsd ?? null) as number | null),
  );
</script>

<div class="head-stack">
  <a class="back" href="/runs"><Icon name="back" />Runs</a>
  {#if run}
    <div class="page-head">
      <div class="title">
        <h1 class="mono">{run.id}</h1>
        <span class="badge {badge(run.status, run.outcome, run.interruptedBy)}">{run.status}</span>
        {#if isActive(run.status)}<span class="live">Live</span>{/if}
      </div>
      {#if isActive(run.status)}
        <div class="actions"><button type="button" class="danger" onclick={cancel}><Icon name="stop" />Cancel run</button></div>
      {/if}
    </div>
  {/if}
</div>
{#if error}<div class="banner error" role="alert"><div class="body"><span>{error}</span></div></div>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
{#if run}
  <dl class="facts">
    <dt>Status</dt><dd>{run.status}</dd>
    <dt>Persona</dt><dd>{run.personaId}</dd>
    <dt>Goal</dt><dd>{run.goal}</dd>
    <dt>Model</dt>
    <dd>
      <span>{run.provider}/{run.model} · {run.effort} · {run.mode}</span>
      {#if run.untested}<span class="badge untested">untested</span>{/if}
      {#if report?.returnedModel && report.returnedModel !== run.model}<span class="hint">(returned {report.returnedModel})</span>{/if}
    </dd>
    <dt>Batch</dt><dd><span class="mono">{run.batchId}</span> · repeat #{run.repeat + 1}</dd>
    <dt>Limits</dt>
    <dd class={resolved ? 'tab' : 'muted'}>
      {resolved
        ? `${resolved.request.limits.steps} steps · ${resolved.request.limits.timeMs / 1000} s · ${usd(resolved.request.limits.dollars)}`
        : 'shown when the run finishes'}
    </dd>
    <dt>Cost</dt>
    <dd>
      <span class="fig lg">{usd(cost)}</span>
      {#if report}<span class="hint">({report.usage.accounting}; cap: {report.usage.capEnforcement})</span>
      {:else}<span class="hint">(cap: {run.capEnforcement})</span>{/if}
    </dd>
  </dl>

  <div class="detail-grid">
    <div class="stack evidence">
      <section class="section" aria-labelledby="timeline-title">
        <div class="section-head">
          <h2 id="timeline-title">Screenshots <span class="count">{shots.length}</span></h2>
          <span class="hint keys">← → to step through</span>
        </div>
        {#if shots.length === 0}
          <div class="shot-empty">No screenshots yet.</div>
        {:else}
          <ol class="timeline" role="toolbar" aria-label="Screenshots; use the arrow keys" tabindex="-1" onkeydown={onTimelineKey}>
            {#each shots as shot, index (shot)}
              <li>
                <button type="button" class="lg" id="shot-{shot}" aria-label={shot} aria-pressed={current === shot} onclick={() => (selected = shot)}>
                  <span class="n">{String(index + 1).padStart(2, '0')}</span>{shot}
                </button>
              </li>
            {/each}
          </ol>
        {/if}
        {#if image && current}
          <figure class="shot">
            <img src={image} alt="Masked screenshot {current}" />
            <figcaption><span>Masked screenshot <span class="mono">{current}</span></span></figcaption>
          </figure>
        {/if}
      </section>

      <section class="section" aria-labelledby="steps-title">
        <div class="section-head"><h2 id="steps-title">Steps <span class="count">{steps.length}</span></h2></div>
        <div class="card dense">
          <ol class="steps" aria-live="polite">
            {#if steps.length === 0}
              <li class="waiting">{isActive(run.status) ? 'Waiting for the first step…' : 'No steps recorded.'}</li>
            {/if}
            {#each steps as step (step.id)}
              <li>
                <span class="sid">{step.id}</span> <span class="action">{step.action}</span>
                <span class="end">
                  <span class="chip {step.status.split(':')[0] === 'ok' ? 'ok' : step.status === 'running' ? 'running' : 'failed'}">{step.status}</span>
                  {#if step.screenshotId}
                    <button type="button" class="link" onclick={() => (selected = step.screenshotId)}>{step.screenshotId}</button>
                  {/if}
                </span>
              </li>
            {/each}
          </ol>
        </div>
      </section>
    </div>

    <div class="stack summary">
      {#if report}
        <section class="section" aria-labelledby="outcome-title">
          <h2 id="outcome-title">Outcome: {words(report.outcome.state)}</h2>
          <div class="card outcome {TONES[report.outcome.state] ?? ''}">
            <div class="state">
              <span class="badge {badge(report.outcome.state)}">{words(report.outcome.state)}</span>
              {#if report.outcome.kind ?? report.outcome.code ?? report.outcome.limit}
                <span class="muted">reason</span><strong>{report.outcome.kind ?? report.outcome.code ?? report.outcome.limit}</strong>
              {/if}
            </div>
            {#if report.outcome.interruptedBy}<p class="muted">(interrupted by {report.outcome.interruptedBy})</p>{/if}
            <p class="reason">{report.outcome.reason}</p>
            <p class="meta">
              {report.steps} steps · {report.browserActions} browser actions · {(report.durationMs / 1000).toFixed(1)} s · replay {report.replay.status}
            </p>
            {#each report.issues as issue (issue.code + issue.message)}<p class="notice warn">{issue.code}: {issue.message}</p>{/each}
          </div>
        </section>
        <section class="section" aria-labelledby="claims-title">
          <div class="section-head"><h2 id="claims-title">Friction claims ({report.friction.length})</h2></div>
          <div class="card">
            {#if report.friction.length === 0}<p class="muted">None.</p>{/if}
            <ul class="claims">
              {#each report.friction as claim (claim.id)}
                <li>
                  <span class="kind">{words(claim.kind)}</span><span class="source">{claim.source}</span>
                  {#if claim.statement}<p>{claim.statement}</p>{:else if claim.opinion}<p class="opinion">{claim.opinion.reason}</p>{/if}
                </li>
              {/each}
            </ul>
          </div>
        </section>
      {:else}
        <section class="section" aria-labelledby="claims-title">
          <h2 id="claims-title">Friction claims</h2>
          <p class="card muted" role="status">{liveClaims} friction claim{liveClaims === 1 ? '' : 's'} so far.</p>
        </section>
      {/if}
    </div>
  </div>

  {#if detail && detail.artifacts.length > 0}
    <section class="section" aria-labelledby="downloads-title">
      <h2 id="downloads-title">Downloads</h2>
      <div class="card downloads">
        {#if REPORTS.some(([name]) => has(name))}
          <div class="dl-group">
            <span class="label">Report</span>
            <div class="row">
              {#each REPORTS.filter(([name]) => has(name)) as [name, label] (name)}
                <button type="button" aria-label="Report ({label})" onclick={() => save(name)}><Icon name="download" />{label}</button>
              {/each}
            </div>
          </div>
        {/if}
        {#if has('replay.spec.ts')}
          <div class="dl-group">
            <span class="label">Replay script</span>
            <div class="row"><button type="button" onclick={() => save('replay.spec.ts')}><Icon name="code" /><span class="mono">replay.spec.ts</span></button></div>
          </div>
        {/if}
        {#if has('trace.zip')}
          <div class="private-zone" role="note" aria-labelledby="trace-title">
            <Icon name="lock" size={20} />
            <div class="body">
              <strong id="trace-title">Trace <span class="badge private">private</span></strong>
              <p>The trace is private raw evidence that may contain secrets; never share or upload it.</p>
            </div>
            <button type="button" class="danger" aria-label="Trace (private)" onclick={() => save('trace.zip')}><Icon name="download" />Download trace</button>
          </div>
        {/if}
      </div>
    </section>
  {/if}

  {#if run.personaId === 'adhoc-first-time-user' && resolved}
    <AdhocSave {resolved} />
  {/if}
{/if}
