<script lang="ts">
  import { clampIndex, delayFor, framesOf, nextIndex, SPEEDS, type PlayerStep } from '../lib/player.ts';

  let {
    steps,
    selected = $bindable(),
    image,
    enabled,
    preload,
  }: {
    steps: PlayerStep[];
    selected: string | null;
    image: string | null;
    enabled: boolean;
    preload: (shot: string) => void;
  } = $props();

  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const frames = $derived(framesOf(steps));
  const found = $derived(frames.findIndex((frame) => frame.shot === selected));
  const index = $derived(found < 0 ? frames.length - 1 : found);
  const frame = $derived(frames[index] ?? null);
  const step = $derived(frame ? steps.find((candidate) => candidate.id === frame.stepId) : undefined);
  const usable = $derived(enabled && !reduced && frames.length > 1);
  let playing = $state(false);
  let speed = $state<number>(1);
  let img = $state<HTMLImageElement>();
  let ring = $state<HTMLSpanElement>();
  let width = $state(0);
  let loaded = $state(0);

  const go = (to: number): void => {
    if (frames.length) selected = frames[clampIndex(to, frames.length)]!.shot;
  };

  $effect(() => {
    if (!playing) return;
    if (!usable || !frame) return void (playing = false);
    const target = nextIndex(frames, index);
    if (target === null) return void (playing = false);
    preload(frames[target]!.shot);
    const timer = setTimeout(() => go(target), delayFor(step?.durationMs ?? 0, speed, frame.weight));
    return () => clearTimeout(timer);
  });

  $effect(() => {
    void [image, width, frame, loaded];
    if (!ring || !img) return;
    const natural = img.naturalWidth;
    if (!frame?.point || !natural) return ring.style.setProperty('display', 'none');
    const scale = img.clientWidth / natural;
    ring.style.setProperty('display', 'block');
    ring.style.setProperty('--x', `${frame.point.x * scale}px`);
    ring.style.setProperty('--y', `${frame.point.y * scale}px`);
  });

  function onKey(event: KeyboardEvent): void {
    if (event.key === ' ' && usable) {
      event.preventDefault();
      playing = !playing;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      playing = false;
      go(index + (event.key === 'ArrowRight' ? 1 : -1));
    }
  }
</script>

{#if frames.length > 0}
  <div class="player" role="toolbar" aria-label="Replay player" tabindex="-1" onkeydown={onKey}>
    <div class="player-controls">
      <button type="button" aria-label="Previous step" disabled={index <= 0} onclick={() => { playing = false; go(index - 1); }}>Prev</button>
      <button type="button" aria-pressed={playing} disabled={!usable} title={reduced ? 'Autoplay is off (reduced motion)' : enabled ? '' : 'Available when the run finishes'} onclick={() => (playing = !playing)}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" aria-label="Next step" disabled={index >= frames.length - 1} onclick={() => { playing = false; go(index + 1); }}>Next</button>
      <input type="range" aria-label="Replay position" min="0" max={frames.length - 1} value={index} oninput={(event) => { playing = false; go(Number(event.currentTarget.value)); }} />
      <select aria-label="Speed" bind:value={speed}>
        {#each SPEEDS as option (option)}<option value={option}>{option}x</option>{/each}
      </select>
    </div>
    <figure class="shot" class:failed={frame?.failed}>
      {#if image && frame}
        <div class="frame" bind:clientWidth={width}>
          <img bind:this={img} src={image} alt="Masked screenshot {frame.shot}" onload={() => (loaded += 1)} />
          <span class="ring" bind:this={ring} aria-hidden="true"></span>
        </div>
      {/if}
      <figcaption>
        <span>
          {#if step}<strong>{step.id} {step.action}</strong> <span class="mono">{step.args}</span>{/if}
        </span>
        {#if step}<span class="chip {frame?.failed ? 'failed' : 'ok'}">{step.status}</span>{/if}
        <span class="mono">{step?.pageUrl} · {frame?.shot}</span>
      </figcaption>
    </figure>
  </div>
{/if}
