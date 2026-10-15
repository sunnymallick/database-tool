// Renderer-only dev server for working on the UI in a normal browser.
// There is no Electron preload here, so src/renderer/src/lib/api.ts falls
// back to the in-memory mock backend in src/renderer/src/lib/mock/.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      $lib: resolve(__dirname, 'src/renderer/src/lib')
    }
  },
  plugins: [tailwindcss(), svelte({ configFile: resolve(__dirname, 'svelte.config.js') })],
  server: { port: Number(process.env.WEB_PORT ?? 5181), strictPort: true, host: '127.0.0.1' }
});
