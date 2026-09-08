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

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
