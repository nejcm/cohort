<script lang="ts">
  import { blobUrl, screenshotPath } from '../lib/api.ts';

  let { runId, shot }: { runId: string; shot: string } = $props();
  let url = $state<string | null>(null);
  let failed = $state(false);

  $effect(() => {
    let current: string | null = null;
    let live = true;
    blobUrl(screenshotPath(runId, shot)).then(
      (next) => {
        if (live) url = current = next;
        else URL.revokeObjectURL(next);
      },
      () => (failed = true),
    );
    return () => {
      live = false;
      if (current) URL.revokeObjectURL(current);
    };
  });
</script>

<a class="thumb" href="/runs/{encodeURIComponent(runId)}?shot={encodeURIComponent(shot)}" aria-label="Screenshot {shot}">
  {#if url}<img src={url} alt="Screenshot {shot}" />{:else}<span class="hint">{failed ? `${shot} unavailable` : shot}</span>{/if}
</a>
