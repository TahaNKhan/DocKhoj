import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Phase 02 SPA build config.
// - @preact/preset-vite: JSX with Preact (no React import shim).
// - vite-plugin-singlefile: inlines all JS+CSS+asset imports into a
//   single web/dist/index.html so the Fastify static-serve layer can
//   ship the whole SPA without separate asset paths (per FR-48 +
//   FR-50 / FR-55 — single-server-executable deployment).
// - Server: 5173 in dev. Build output: web/dist/.
// - SPA dev-server fallback for client-side routes: Vite handles this
//   automatically when `historyApiFallback` is on (default for SPA).
export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000, // inline all assets; bundle is one HTML
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
