<script lang="ts" module>
  const PATHS = {
    back: 'M12.5 8h-9M7 4.5 3.5 8 7 11.5',
    book: 'M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10.5H4.5A1.5 1.5 0 0 0 3 14zM3 14a1.5 1.5 0 0 0 1.5 1.5H13v-3',
    check: 'M3.5 8.5l3 3 6-7',
    chevronDown: 'M4 6l4 4 4-4',
    code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
    download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
    external: 'M6.5 3.5h-2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-2M9 2.5h4.5V7M13.5 2.5 7.5 8.5',
    eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM10 8a2 2 0 1 1-4 0 2 2 0 1 1 4 0z',
    lock: 'M4.5 7h7a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5v-4A1.5 1.5 0 0 1 4.5 7zM5.5 7V5a2.5 2.5 0 0 1 5 0v2',
    menu: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
    persona: 'M10.5 5.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0zM3 13.5c.8-2.5 2.7-3.5 5-3.5s4.2 1 5 3.5',
    play: 'M5 3.5l7 4.5-7 4.5z',
    plus: 'M8 3.5v9M3.5 8h9',
    reload: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3',
    sparkle: 'M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11v3M11 12.5h3',
    stop: 'M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 1 1 11 0zM6 6l4 4M10 6l-4 4',
    suites: 'M3.5 3h9a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM3.5 9h9a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1z',
    undo: 'M6 3.5 3 6.5l3 3M3 6.5h6.5a3 3 0 0 1 0 6H7',
  } as const;
</script>

<script lang="ts">
  let { name, size = 16 }: { name: keyof typeof PATHS; size?: number } = $props();
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>
