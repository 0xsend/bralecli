import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

describe('the executable', () => {
  it('opts out of nub .env auto-discovery in its shebang', () => {
    // Observed in the field with bridgexyzctl: run from a directory whose .env
    // holds sandbox credentials, nub injects them after the operator's
    // `env -u`, and a prod command 401s against the wrong credential. The
    // shebang is the only place this can be enforced for direct invocation.
    const firstLine = readFileSync(fileURLToPath(new URL('bin.ts', import.meta.url)), 'utf8').split(
      '\n',
    )[0]
    expect(firstLine).toContain('#!/usr/bin/env -S nub')
    expect(firstLine).toContain('--no-env-file')
  })
})
