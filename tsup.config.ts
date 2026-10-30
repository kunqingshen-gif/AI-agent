import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: false,
  sourcemap: false,
  minify: false,
  splitting: false,
  shims: false,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
