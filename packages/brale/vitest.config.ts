import { defineConfig } from 'vitest/config'

/**
 * Without this, a per-package `vitest run` picks up the ROOT config, resolves
 * its include glob against this package's cwd, matches nothing, and exits 1 on
 * a fully green tree.
 */
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
