<script lang="ts">
  let { value, max, count = 20, size = '', tone = '' }: { value: number; max: number; count?: number; size?: string; tone?: string } = $props();
  const lit = $derived(max > 0 ? Math.round((Math.min(value, max) / max) * count) : 0);
</script>

<span class="ticks {size} {tone}" aria-hidden="true">{#each { length: count } as _, index (index)}<i class:on={index < lit}></i>{/each}</span>
