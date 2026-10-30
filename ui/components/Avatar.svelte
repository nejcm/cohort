<script lang="ts">
  let { id }: { id: string } = $props();

  const hash = (text: string): number =>
    [...text].reduce((h, char) => Math.imul(h ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const seed = $derived(hash(id));
  const kind = $derived(['blob', 'bot', 'critter', 'ghost', 'shroom', 'bird'][seed % 6]);
  const head = 'M3 37V34c0-6 3-9 6-10a10 10 0 1 1 14 0c3 1 6 4 6 10v3Z';
  const shape = $derived((seed >>> 4) % 3);
  const face = $derived((seed >>> 8) % 3);
  const hue = $derived((seed >>> 12) % 5);
</script>

<span class="av {kind} p{hue}" aria-hidden="true">
  <svg viewBox="0 0 32 32">
    <g class="body">
      {#if kind === 'blob'}
        {#if shape === 0}
          <path class="skin" d="M4 37C4 19 9 10 16 10s12 9 12 27Z" />
        {:else if shape === 1}
          <path class="skin" d="M5 37V19c0-6 4-10 8-9 2-3 4-3 6 0 4-1 8 3 8 9v18Z" />
        {:else}
          <path class="skin" d="M7 37V34c0-10 2-27 9-27s9 17 9 27v3Z" />
        {/if}
      {:else if kind === 'bot'}
        <g class="wiggle"><path class="line" d="M16 11V6" /><circle class="lamp" cx="16" cy="5" r="2.2" /></g>
        <rect class="skin" x="10" y="26" width="12" height="11" rx="2" />
        <rect class="skin" x="5" y="10" width="22" height="17" rx={shape === 0 ? 8 : 4} />
        <rect class="screen" x="8" y="13" width="16" height="10" rx="3" />
      {:else if kind === 'critter'}
        <g class="wiggle">
          {#if shape === 0}
            <path class="skin" d="M6 17 8 5l8 7Z" /><path class="skin" d="M26 17 24 5l-8 7Z" />
          {:else if shape === 1}
            <circle class="skin" cx="8" cy="11" r="4.5" /><circle class="skin" cx="24" cy="11" r="4.5" />
          {:else}
            <ellipse class="skin" cx="11.5" cy="8" rx="2.8" ry="7" /><ellipse class="skin" cx="20.5" cy="8" rx="2.8" ry="7" />
          {/if}
        </g>
        <path class="skin" d={head} />
      {:else if kind === 'ghost'}
        <path
          class="skin"
          d={shape === 1
            ? 'M7 30V15a9 9 0 0 1 18 0v15l-3-2.5-3 2.5-3-2.5-3 2.5-3-2.5Z'
            : 'M6 30V17a10 10 0 0 1 20 0v13l-2.5-2-2.5 2-2.5-2-2.5 2-2.5-2-2.5 2-2.5-2Z'}
        />
        {#if shape === 2}<path class="skin wiggle" d="M16 8q-1-4 3-4-2 1-1 4Z" />{/if}
      {:else if kind === 'shroom'}
        <rect class="stem" x="8" y="14" width="16" height="23" rx="6" />
        <g class="wiggle">
          <path class="skin" d={shape === 1 ? 'M2 17q0-12 14-12t14 12Z' : 'M3 17a13 11 0 0 1 26 0Z'} />
          <circle class="spot" cx="10" cy="11" r="2" /><circle class="spot" cx="19" cy="8.5" r="1.6" />
          {#if shape !== 2}<circle class="spot" cx="23.5" cy="13" r="1.4" />{/if}
        </g>
      {:else}
        <g class="wiggle">
          {#if shape === 0}
            <path class="skin" d="M15 11q-2-6 2-7-1 3 1 7Z" />
          {:else if shape === 1}
            <path class="ink-line" d="M16 10q-2-4 0-6M16 10q2-4 5-4" />
          {:else}
            <path class="skin" d="M13 11q0-5 3-6 3 1 3 6Z" />
          {/if}
        </g>
        <path class="skin" d={head} />
        <path class="beak" d="M14 23h4l-2 2.6Z" />
      {/if}
      <g class="eyes">
        {#if kind === 'bot'}
          {#if face === 0}
            <rect class="glow" x="11" y="16" width="3" height="4" rx="1" /><rect class="glow" x="18" y="16" width="3" height="4" rx="1" />
          {:else if face === 1}
            <circle class="glow" cx="16" cy="18" r="2.6" />
          {:else}
            <path class="glow-line" d="M11 19l1.5-2 1.5 2M18 19l1.5-2 1.5 2" />
          {/if}
        {:else if face === 0}
          <circle class="ink" cx="12" cy="20" r="2" /><circle class="ink" cx="20" cy="20" r="2" />
          <circle class="glint" cx="12.7" cy="19.3" r="0.7" /><circle class="glint" cx="20.7" cy="19.3" r="0.7" />
        {:else if face === 1}
          <circle class="white" cx="16" cy="19" r="4" /><circle class="ink" cx="16" cy="19.5" r="2.2" />
        {:else}
          <path class="ink-line" d="M10.5 20.5q1.5-2 3 0M18.5 20.5q1.5-2 3 0" />
        {/if}
      </g>
      {#if kind !== 'bot' && kind !== 'bird'}
        <circle class="cheek" cx="9" cy="23.5" r="1.6" /><circle class="cheek" cx="23" cy="23.5" r="1.6" />
        <path class="ink-line" d={face === 1 ? 'M14.5 25.5q1.5 1.2 3 0' : 'M14.5 24q1.5 1.5 3 0'} />
      {/if}
    </g>
  </svg>
</span>
