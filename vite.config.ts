import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const API_TARGET = process.env.API_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  root: path.resolve(__dirname, 'src/web'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@core': path.resolve(__dirname, 'src/core'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/healthz': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
});
