<script lang="ts">
  import { clampIndex, delayFor, framesOf, nextIndex, SPEEDS, type PlayerStep } from '../lib/player.ts';

  let {
    steps,
    selected = $bindable(),
    cursor = $bindable(),
    image,
    imageShot,
    enabled,
    preload,
  }: {
    steps: PlayerStep[];
    selected: string | null;
    cursor: string | null;
    image: string | null;
    imageShot: string | null;
    enabled: boolean;
    preload: (shot: string) => void;
  } = $props();

  let reduced = $state(false);
  $effect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = (): void => void (reduced = query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  });
  const frames = $derived(framesOf(steps));
  const found = $derived.by(() => {
    const exact = frames.findIndex((candidate) => candidate.key === cursor && candidate.shot === selected);
    return exact >= 0 ? exact : frames.findIndex((candidate) => candidate.shot === selected);
  });
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
  let loadedSrc = $state('');

  const ready = $derived(image !== null && frame !== null && imageShot === frame.shot && loadedSrc === image);
  const go = (to: number): void => {
    if (!frames.length) return;
    const target = frames[clampIndex(to, frames.length)]!;
    selected = target.shot;
    cursor = target.key;
  };

  $effect(() => {
    if (!playing) return;
    if (!usable || !frame) return void (playing = false);
    const target = nextIndex(frames.length, index);
    if (target === null) return void (playing = false);
    preload(frames[target]!.shot);
    const timer = setTimeout(() => {
      go(target);
      if (frames[target]!.failed) playing = false;
    }, delayFor(step?.durationMs ?? 0, speed, frame.weight));
    return () => clearTimeout(timer);
  });

  $effect(() => {
    void [image, width, frame, loaded, ready];
    if (!ring || !img || !ready) return;
    const natural = img.naturalWidth;
    if (!frame?.point || !natural) return ring.style.setProperty('display', 'none');
    const scale = img.clientWidth / natural;
    ring.style.setProperty('display', 'block');
    ring.style.setProperty('--x', `${frame.point.x * scale}px`);
    ring.style.setProperty('--y', `${frame.point.y * scale}px`);
  });

  function onKey(event: KeyboardEvent): void {
    if (!enabled || (event.target as HTMLElement).closest('button, select, input')) return;
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
      <button type="button" aria-label="Previous step" disabled={!enabled || index <= 0} onclick={() => { playing = false; go(index - 1); }}>Prev</button>
      <button type="button" aria-pressed={playing} disabled={!usable} title={reduced ? 'Autoplay is off (reduced motion)' : enabled ? '' : 'Available when the run finishes'} onclick={() => (playing = !playing)}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" aria-label="Next step" disabled={!enabled || index >= frames.length - 1} onclick={() => { playing = false; go(index + 1); }}>Next</button>
      <input type="range" disabled={!enabled} aria-label="Replay position" min="0" max={frames.length - 1} value={index} oninput={(event) => { playing = false; go(Number(event.currentTarget.value)); }} />
      <select aria-label="Speed" disabled={!enabled} bind:value={speed}>
        {#each SPEEDS as option (option)}<option value={option}>{option}x</option>{/each}
      </select>
    </div>
    <figure class="shot" class:failed={ready && frame?.failed}>
      {#if image && frame}
        <div class="frame" bind:clientWidth={width}>
          <img bind:this={img} src={image} alt="Masked screenshot {frame.shot}" onload={() => { loadedSrc = image ?? ''; loaded += 1; }} />
          <span class="ring" class:hidden={!ready} bind:this={ring} aria-hidden="true"></span>
        </div>
      {/if}
      <figcaption>
        <span>
          {#if ready && step}<strong>{step.id} {step.action}</strong> <span class="mono">{step.args}</span>{/if}
        </span>
        {#if ready && step}<span class="chip {frame?.failed ? 'failed' : 'ok'}">{step.status}</span>{/if}
        <span class="mono">{step?.pageUrl} · {frame?.shot}</span>
      </figcaption>
    </figure>
  </div>
{/if}
