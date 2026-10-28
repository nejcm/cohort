<script lang="ts">
  import type { Models } from './api.ts';

  let {
    models,
    mode,
    model = $bindable(''),
    effort = $bindable(''),
    inherited = 'project default',
    inheritedModels = [],
    idPrefix,
  }: {
    models: Models;
    mode: 'vision' | 'text';
    model?: string;
    effort?: string;
    inherited?: string;
    /** Models the blank choice resolves to, so it offers only efforts they all support. */
    inheritedModels?: string[];
    idPrefix: string;
  } = $props();

  const EFFORTS = ['low', 'medium', 'high'];
  const chosen = $derived(models.models.find((entry) => entry.id === model));
  const fallback = $derived(models.models.filter((entry) => inheritedModels.includes(entry.id)));
  const efforts = $derived(
    chosen
      ? chosen.supportedEffortLevels
      : EFFORTS.filter((level) => fallback.every((entry) => entry.supportedEffortLevels.includes(level))),
  );
  const unusable = (entry: Models['models'][number]): string | null =>
    !entry.enabled
      ? 'not usable until its catalog entry is completed'
      : mode === 'vision' && entry.visionCapable !== true
        ? 'no vision capability'
        : null;
  const hidden = $derived(models.providers.filter((provider) => !provider.available).map((provider) => provider.id));

  $effect(() => {
    if (effort && !efforts.includes(effort)) effort = '';
  });
</script>

<div class="picker">
  <label for="{idPrefix}-model">Model</label>
  <select id="{idPrefix}-model" bind:value={model}>
    <option value="">Inherit ({inherited})</option>
    {#each models.providers.filter((provider) => provider.available) as provider (provider.id)}
      <optgroup label={provider.id}>
        {#each models.models.filter((entry) => entry.provider === provider.id) as entry (entry.id)}
          <option value={entry.id} disabled={unusable(entry) !== null}>
            {entry.label} ({entry.id}){entry.untested ? ' — untested' : ''}{unusable(entry) ? ` — ${unusable(entry)}` : ''}
          </option>
        {/each}
      </optgroup>
    {/each}
  </select>
  <label for="{idPrefix}-effort">Effort</label>
  <select id="{idPrefix}-effort" bind:value={effort}>
    <option value="">Inherit{chosen?.defaultEffort ? ` (model default: ${chosen.defaultEffort})` : ''}</option>
    {#each efforts as level (level)}
      <option value={level}>{level}{chosen?.defaultEffort === level ? ' (default)' : ''}</option>
    {/each}
  </select>
  {#if chosen?.untested}
    <p class="warning" role="status">{chosen.id} is untested with this tool; runs need an explicit opt-in.</p>
  {/if}
  {#if chosen && chosen.pricesPerMTok.input === null}
    <p class="warning" role="status">{chosen.id} has no catalog prices: cost unknown; dollar cap unenforceable.</p>
  {/if}
  {#if hidden.length > 0}
    <p class="hint">Hidden (no API key in the environment): {hidden.join(', ')}</p>
  {/if}
</div>
