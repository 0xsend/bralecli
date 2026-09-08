import { defineConfig } from 'vitest/config'

/**
 * Without this, a per-package `vitest run` picks up the ROOT config, resolves
 * its include glob against this package's cwd, matches nothing, and exits 1 on
 * a fully green tree. The condition mirrors the root config: workspace
 * packages resolve from `src`, never a stale `dist/`.
 */
const conditions = ['@bralecli/source']

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: { include: ['src/**/*.test.ts'] },
})
