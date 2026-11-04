import { defineConfig } from 'vitest/config'

/**
 * The condition is the same one `tsconfig.base.json` uses for typechecking:
 * workspace packages resolve from `src`, so a fresh clone tests and typechecks
 * without a build, and never against a stale `dist/`.
 *
 * It is set under `ssr` as well as `resolve` because Vitest runs specs through
 * Vite's SSR pipeline, which resolves with `ssr.resolve.conditions` and ignores
 * the client-side list.
 */
const conditions = ['@bralecli/source']

/**
 * Script suites spawn a fresh Node process per case. The macOS Intel release
 * runner executes them about three times slower than other platforms under
 * parallel load, which exceeded Vitest's 5 second default and blocked release
 * drafts. Child processes keep their own shorter timeouts, so a hung child still
 * fails with its own error before this per-test ceiling.
 */
const testTimeout = 60_000

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    testTimeout,
    include: ['{apps,packages}/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
