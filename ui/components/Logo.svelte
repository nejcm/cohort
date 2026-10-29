<script lang="ts">
  let { size = 22 }: { size?: number } = $props();
</script>

<svg class="logo" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
  <g fill="currentColor">
    <circle cx="38" cy="18" r="5" /><circle cx="50" cy="18" r="5.5" /><circle cx="62" cy="18" r="5" />
    <circle cx="38" cy="30" r="5.5" /><circle cx="62" cy="30" r="5.5" />
    <circle cx="38" cy="42" r="5" /><circle cx="50" cy="42" r="5.5" /><circle cx="62" cy="42" r="5" />
    <circle cx="26" cy="62" r="5" /><circle cx="38" cy="62" r="5.5" /><circle cx="50" cy="62" r="5.5" />
    <circle cx="62" cy="62" r="5.5" /><circle cx="74" cy="62" r="5" />
    <circle cx="14" cy="74" r="5" /><circle cx="26" cy="74" r="5.5" /><circle cx="38" cy="74" r="5.5" />
    <circle cx="50" cy="74" r="5.5" /><circle cx="62" cy="74" r="5.5" /><circle cx="74" cy="74" r="5.5" />
    <circle cx="86" cy="74" r="5" />
    <circle cx="14" cy="86" r="5.5" /><circle cx="26" cy="86" r="5.5" /><circle cx="38" cy="86" r="5.5" />
    <circle cx="50" cy="86" r="5.5" /><circle cx="62" cy="86" r="5.5" /><circle cx="74" cy="86" r="5.5" />
    <circle cx="86" cy="86" r="5.5" />
  </g>
  <circle class="dot" cx="50" cy="30" r="7" />
</svg>
