import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: process.env.GITHUB_PAGES === 'true' ? '/fqdb/' : '/',
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  resolve: {
    alias: {
      fqdb: resolve(here, '..', 'src', 'index.ts'),
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
