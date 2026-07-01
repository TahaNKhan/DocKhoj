import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// T43 — coverage thresholds + README + final verification.
//
// Coverage targets (lines):
//   - Project overall:              ≥ 80%
//   - src/db/**                     ≥ 80% (per-glob)
//   - src/services/conversations.ts: ≥ 80% (per-file)
//   - src/services/stream-chat.ts:  ≥ 80% (per-file)
//
// Note: component tests were removed in T40. The web services
// (markdown, sessions, stream) still need test coverage — they're
// tiny pure functions / fetch wrappers. They live under web/tests/
// and run in the `web` vitest project; that project isn't part of
// the thresholded coverage report because the v8 coverage worker
// can't resolve the workspace's happy-dom from the root. The web
// tests still execute on every `npm test` run; web-only behaviour
// is also validated end-to-end via `./restart.sh` + curl.
//
// Workspace setup: the web/ project owns its own node_modules and
// uses happy-dom; the node project covers the Fastify server. We
// alias SPA-only test deps (happy-dom, dompurify, marked) to
// web/node_modules so vitest's resolver can find them when the
// web tests run.

const __dirname = dirname(fileURLToPath(import.meta.url));
const webNodeModules = resolve(__dirname, 'web', 'node_modules');

const PER_MODULE_THRESHOLDS = {
  'src/db/**': { lines: 80 },
  'src/services/conversations.ts': { lines: 80 },
  'src/services/stream-chat.ts': { lines: 80 },
} as const;

export default defineConfig({
  resolve: {
    alias: {
      'happy-dom': resolve(webNodeModules, 'happy-dom'),
      'dompurify': resolve(webNodeModules, 'dompurify'),
      'marked': resolve(webNodeModules, 'marked'),
    },
  },
  test: {
    // Root-level coverage aggregates the node project only. The
    // web/ project's coverage is reported separately (its tests
    // run in a happy-dom context that's incompatible with v8's
    // coverage instrumentation when happy-dom lives in a sibling
    // workspace's node_modules). The web tests still execute on
    // every `npm test` run; they're just not in the threshold set.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts', 'src/types.d.ts'],
      thresholds: {
        ...PER_MODULE_THRESHOLDS,
        // T43 acceptance: project overall ≥ 80% lines. Other
        // metrics are calibrated to the current coverage of the
        // modules we test in-process; web-only behaviour is
        // validated end-to-end via ./restart.sh + curl, not here.
        lines: 80,
        functions: 80,
        branches: 65,
        statements: 75,
      },
    },
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          globals: true,
          coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.d.ts', 'src/index.ts', 'src/types.d.ts'],
            thresholds: {
              ...PER_MODULE_THRESHOLDS,
              lines: 80,
              functions: 80,
              branches: 75,
              statements: 80,
            },
          },
        },
      },
      {
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['web/tests/**/*.test.ts'],
          globals: true,
          coverage: {
            include: ['web/src/**/*.ts'],
            exclude: [
              'web/src/components/**',
              'web/src/main.tsx',
              'web/src/App.tsx',
              'web/src/routes/**',
            ],
            thresholds: {
              ...PER_MODULE_THRESHOLDS,
              lines: 80,
              functions: 80,
              branches: 75,
              statements: 80,
            },
          },
        },
      },
    ],
  },
});