<script lang="ts">
  import Icon from './Icon.svelte';
  import { api, usd, type Models, type ProjectDefaults } from './api.ts';
  import { navigate } from './nav.ts';
  import ModelPicker from './ModelPicker.svelte';

  interface Plan {
    personaId: string;
    provider: string;
    model: string;
    effort: string;
    modelFrom: string;
    effortFrom: string;
    untested: boolean;
    repeats: number;
    limits: { steps: number; timeMs: number; dollars: number };
    estimatePerRun: { minUsd: number; maxUsd: number; basis: 'unmeasured' } | null;
  }
  interface Preview {
    plans: Plan[];
    maxBatchUsd: number | null;
  }

  let dialog: HTMLDialogElement;
  let models = $state<Models | null>(null);
  let config = $state<ProjectDefaults | null>(null);
  let personas = $state<{ id: string; tags: string[] }[]>([]);
  let suites = $state<{ id: string; name: string | null }[]>([]);
  let loadError = $state('');

  let kind = $state<'persona' | 'tag' | 'suite' | 'adhoc'>('persona');
  let target = $state('');
  let url = $state('');
  let note = $state('');
  let mode = $state('');
  let repeats = $state<number | null>(null);
  let steps = $state<number | null>(null);
  let timeMs = $state<number | null>(null);
  let dollars = $state<number | null>(null);
  let model = $state('');
  let effort = $state('');
  let allowUntested = $state(false);

  let preview = $state<Preview | null>(null);
  let previewError = $state('');
  let submitting = $state(false);

  const tags = $derived([...new Set(personas.flatMap((persona) => persona.tags))].toSorted());
  const targets = $derived(
    kind === 'persona' ? personas.map((persona) => persona.id) : kind === 'tag' ? tags : suites.map((suite) => suite.id),
  );
  const effectiveMode = $derived((mode || config?.defaults.mode || 'vision') as 'vision' | 'text');
  let inheritedModels = $state<string[]>([]);
  const untested = $derived(
    models?.models.find((entry) => entry.id === model)?.untested === true ||
      preview?.plans.some((plan) => plan.untested) === true,
  );

  const number = (value: number | null | undefined): number | undefined =>
    value === null || value === undefined || Number.isNaN(value) ? undefined : value;
  // Untouched inherited fields stay omitted so server-side precedence decides them.
  const submission = $derived.by(() => {
    const limits = Object.fromEntries(
      Object.entries({ steps: number(steps), timeMs: number(timeMs), dollars: number(dollars) }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    const selector =
      kind === 'adhoc'
        ? { kind }
        : kind === 'tag'
          ? { kind, tag: target }
          : { kind, id: target };
    return {
      selector,
      ...(url.trim() ? { url: url.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(mode ? { mode } : {}),
      ...(number(repeats) === undefined ? {} : { repeats: number(repeats) }),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
    };
  });
  const ready = $derived(kind === 'adhoc' ? url.trim() !== '' && note.trim() !== '' : target !== '');

  export async function open(): Promise<void> {
    loadError = '';
    [kind, url, note, mode, model, effort, allowUntested] = ['persona', '', '', '', '', '', false];
    [repeats, steps, timeMs, dollars] = [null, null, null, null];
    inheritedModels = [];
    dialog.showModal();
    try {
      [models, config, { personas }, { suites }] = await Promise.all([
        api<Models>('GET', '/api/models'),
        api<ProjectDefaults>('GET', '/api/config'),
        api<{ personas: { id: string; tags: string[] }[] }>('GET', '/api/personas'),
        api<{ suites: { id: string; name: string | null }[] }>('GET', '/api/suites'),
      ]);
    } catch (error) {
      loadError = (error as Error).message;
    }
  }

  $effect(() => {
    if (!targets.includes(target)) target = targets[0] ?? '';
  });

  let generation = 0;
  $effect(() => {
    const body = { submission, allowUntested, preview: true };
    const current = ++generation;
    preview = null;
    previewError = '';
    if (!ready || !models) return;
    const timer = setTimeout(() => {
      api<Preview>('POST', '/api/runs', body).then(
        (result) => {
          if (current !== generation) return;
          preview = result;
          if (!body.submission.model)
            inheritedModels = [...new Set(result.plans.map((plan) => `${plan.provider}/${plan.model}`))];
        },
        (error: Error) => {
          if (current === generation) previewError = error.message;
        },
      );
    }, 250);
    return () => clearTimeout(timer);
  });

  async function start(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    submitting = true;
    try {
      const result = await api<{ runIds: string[] }>('POST', '/api/runs', { submission, allowUntested });
      dialog.close();
      navigate(`/runs/${encodeURIComponent(result.runIds[0]!)}`);
    } catch (error) {
      previewError = (error as Error).message;
    } finally {
      submitting = false;
    }
  }

  const runCount = $derived(preview?.plans.reduce((sum, plan) => sum + plan.repeats, 0) ?? 0);
</script>

<dialog bind:this={dialog} aria-labelledby="run-dialog-title">
  <form onsubmit={start}>
    <header>
      <div>
        <h2 id="run-dialog-title">New run</h2>
        <p class="hint">Blank override fields inherit from the persona, suite or project config.</p>
      </div>
    </header>
    <div class="dialog-body">
      {#if loadError}<div class="banner error" role="alert"><div class="body"><span>{loadError}</span></div></div>{/if}
      <fieldset>
        <legend>What to run</legend>
        <div class="form-grid">
          <label for="run-kind">Dispatch
            <select id="run-kind" bind:value={kind}>
              <option value="persona">Persona</option>
              <option value="tag">Tag</option>
              <option value="suite">Suite</option>
              <option value="adhoc">Ad-hoc first-time user</option>
            </select>
          </label>
          {#if kind !== 'adhoc'}
            <label for="run-target">{kind === 'persona' ? 'Persona' : kind === 'tag' ? 'Tag' : 'Suite'}
              <select id="run-target" bind:value={target}>
                {#each targets as item (item)}<option value={item}>{item}</option>{/each}
              </select>
            </label>
          {/if}
          <label for="run-url"><span>URL <span class="opt">{kind === 'adhoc' ? 'required for ad-hoc' : 'optional'}</span></span>
            <input id="run-url" type="url" bind:value={url} required={kind === 'adhoc'} placeholder="inherit" />
          </label>
          <label for="run-note" class={kind === 'adhoc' ? 'span-2' : ''}>
            <span>{kind === 'adhoc' ? 'Goal' : 'Note'} {#if kind !== 'adhoc'}<span class="opt">optional</span>{/if}</span>
            <textarea id="run-note" rows="2" bind:value={note} required={kind === 'adhoc'}></textarea>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Overrides (blank inherits)</legend>
        <div class="form-grid cols-4">
          <label for="run-mode">Mode
            <select id="run-mode" bind:value={mode}>
              <option value="">Inherit ({config?.defaults.mode ?? 'vision'})</option>
              <option value="vision">vision</option>
              <option value="text">text</option>
            </select>
          </label>
          <label for="run-repeats">Repeats
            <input id="run-repeats" type="number" min="1" max="100" bind:value={repeats} placeholder="inherit" />
          </label>
          <label for="run-steps">Step cap
            <input id="run-steps" type="number" min="1" bind:value={steps} placeholder="inherit" />
          </label>
          <label for="run-time"><span>Time cap <span class="opt">ms</span></span>
            <input id="run-time" type="number" min="1" bind:value={timeMs} placeholder="inherit" />
          </label>
          <label for="run-dollars">Dollar cap per run
            <input id="run-dollars" type="number" min="0.01" step="0.01" bind:value={dollars} placeholder="inherit" />
          </label>
          {#if models}
            <ModelPicker
              {models}
              mode={effectiveMode}
              bind:model
              bind:effort
              inherited={config?.defaults.model ?? 'project default'}
              {inheritedModels}
              idPrefix="run"
            />
          {/if}
          {#if untested}
            <label class="check risk span-2">
              <input type="checkbox" bind:checked={allowUntested} />
              <span><strong>Allow the untested model</strong> <span class="badge untested">untested</span></span>
            </label>
          {/if}
        </div>
      </fieldset>
      <section class="estimate" aria-live="polite" aria-labelledby="estimate-title">
        <div class="estimate-head"><h3 id="estimate-title">Estimate</h3><span class="hint">Updates as you edit</span></div>
        {#if previewError}
          <div class="banner error" role="alert"><div class="body"><span>{previewError}</span></div></div>
        {:else if preview}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Persona</th><th scope="col">Model</th><th scope="col">Effort</th>
                  <th scope="col" class="num">Runs</th><th scope="col">Caps</th><th scope="col" class="num">Cost per run</th>
                </tr>
              </thead>
              <tbody>
                {#each preview.plans as plan, index (index)}
                  <tr>
                    <td>{plan.personaId}</td>
                    <td>
                      <span class="mono">{plan.provider}/{plan.model}</span>
                      {#if plan.untested}<span class="badge untested">untested</span>{/if}
                      <span class="hint block">from {plan.modelFrom}</span>
                    </td>
                    <td>{plan.effort} <span class="hint block">from {plan.effortFrom}</span></td>
                    <td class="num">{plan.repeats}</td>
                    <td class="mono muted caps">{plan.limits.steps} steps · {plan.limits.timeMs / 1000} s · {usd(plan.limits.dollars)}</td>
                    <td class="num">
                      {#if plan.estimatePerRun}
                        {`${plan.estimatePerRun.basis} estimate ${usd(plan.estimatePerRun.minUsd)}–${usd(plan.estimatePerRun.maxUsd)}`}
                      {:else}
                        <span class="unknown">cost unknown; dollar cap unenforceable</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="budget">
            {#if preview.maxBatchUsd === null}
              <span class="unknown">Batch budget: unknown — some prices are missing, so only step and time caps apply</span>
            {:else}
              <span>Batch budget: at most <span class="num">{usd(preview.maxBatchUsd)}</span> <span class="muted">(sum of dollar caps)</span></span>
            {/if}
          </p>
        {:else if ready}
          <p class="budget muted">Estimating…</p>
        {/if}
      </section>
    </div>
    <footer>
      {#if untested && !allowUntested}<p class="notice warn">Allow the untested model to start.</p>{/if}
      <button type="button" onclick={() => dialog.close()}>Close</button>
      <button type="submit" class="primary" disabled={!preview || submitting || (untested && !allowUntested)} aria-busy={submitting}>
        <Icon name="play" />Start {runCount} run{runCount === 1 ? '' : 's'}
      </button>
    </footer>
  </form>
</dialog>
