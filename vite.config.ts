import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Builds the dashboard into dist/ui, which `cohort ui` serves under a CSP without inline scripts or styles.
export default defineConfig({
  root: 'ui',
  base: '/',
  plugins: [svelte()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
