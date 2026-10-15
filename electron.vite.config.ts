import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        $lib: resolve(__dirname, 'src/renderer/src/lib')
      }
    },
    plugins: [tailwindcss(), svelte({ configFile: resolve(__dirname, 'svelte.config.js') })],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
});
