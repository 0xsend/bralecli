import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  // ESM only. `spec.ts` locates the vendored document relative to
  // `import.meta.url`, which has no CJS equivalent, and the only consumer is a
  // Node CLI — a dual build would buy nothing and break the spec loader.
  format: ['esm'],
  dts: true,
  unbundle: true,
})
