<script lang="ts">
  let { label, lines = 3 }: { label: string; lines?: number } = $props();
  const WIDTHS = ['w-80', 'w-60', 'w-40', 'w-25'];
</script>

<div class="loading" role="status" aria-label={label}>
  {#each { length: lines } as _, index (index)}<span class="skeleton {WIDTHS[index % WIDTHS.length]}"></span>{/each}
</div>
