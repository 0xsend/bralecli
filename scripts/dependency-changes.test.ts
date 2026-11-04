import { describe, expect, it } from 'vitest'

import { summarizeDependencyChanges, type DependencySnapshot } from './dependency-changes.ts'

function lockfile(input: { vitest: string; extra?: string; transitive: string[] }): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    '      vitest:',
    `        specifier: ^${input.vitest}`,
    `        version: ${input.vitest}(@types/node@26.4.1)`,
    ...(input.extra
      ? ['      oxlint:', `        specifier: ^${input.extra}`, `        version: ${input.extra}`]
      : []),
    '',
    '  apps/cli:',
    '    dependencies:',
    "      '@bralecli/brale':",
    '        specifier: workspace:*',
    '        version: link:../../packages/brale',
    '',
    'packages:',
    '',
    ...input.transitive.flatMap((key) => [
      `  '${key}':`,
      '    resolution: {integrity: sha512-x}',
      '',
    ]),
  ].join('\n')
}

function flakeLock(nixpkgs: { rev: string; lastModified: number }): string {
  return JSON.stringify({
    nodes: {
      nixpkgs: {
        locked: {
          type: 'github',
          owner: 'NixOS',
          repo: 'nixpkgs',
          narHash: 'sha256-x',
          ...nixpkgs,
        },
      },
      'flake-utils': {
        locked: { type: 'github', owner: 'numtide', repo: 'flake-utils', rev: 'a'.repeat(40) },
      },
      root: { inputs: { nixpkgs: 'nixpkgs' } },
    },
    root: 'root',
    version: 7,
  })
}

function hostile(rev: string): string {
  return JSON.stringify({
    nodes: {
      nixpkgs: {
        locked: { type: 'github', owner: 'evil)(x', repo: 'nixpkgs', rev, lastModified: 1 },
      },
    },
  })
}

const before: DependencySnapshot = {
  nodeVersion: '24.20.0\n',
  lockfile: lockfile({
    vitest: '3.2.7',
    transitive: [
      'vitest@3.2.7',
      '@types/node@26.4.1',
      'left-pad@1.3.0',
      'chalk@4.1.2',
      'chalk@5.3.0',
    ],
  }),
  flakeLock: flakeLock({ rev: '1'.repeat(40), lastModified: 1_790_000_000 }),
}

describe('dependency update summary', () => {
  it('reports Node, direct, Nix, and transitive changes as old → new', () => {
    const after: DependencySnapshot = {
      nodeVersion: '24.21.0\n',
      lockfile: lockfile({
        vitest: '3.3.0',
        extra: '1.82.0',
        transitive: ['vitest@3.3.0', '@types/node@26.4.1', 'oxlint@1.82.0', 'chalk@5.4.0'],
      }),
      flakeLock: flakeLock({ rev: '2'.repeat(40), lastModified: 1_792_000_000 }),
    }
    const summary = summarizeDependencyChanges(before, after)
    expect(summary).toContain('Node.js (`.node-version`): `24.20.0` → `24.21.0`')
    expect(summary).toContain('| `.` | `vitest` | `^3.2.7` → `^3.3.0` | `3.2.7` → `3.3.0` |')
    expect(summary).toContain('| `.` | `oxlint` | added `^1.82.0` | added `1.82.0` |')
    expect(summary).not.toContain('@bralecli/brale')
    expect(summary).toContain(
      `| \`nixpkgs\` | \`NixOS/nixpkgs\` | [\`${'1'.repeat(12)}\` → \`${'2'.repeat(12)}\`](https://github.com/NixOS/nixpkgs/compare/${'1'.repeat(40)}...${'2'.repeat(40)}) | \`2026-09-21\` → \`2026-10-14\` |`,
    )
    expect(summary).not.toContain('flake-utils')
    expect(summary).toContain('2 updated, 1 added, 1 removed, including transitive dependencies.')
    expect(summary).toContain('- `chalk`: `4.1.2`, `5.3.0` → `5.4.0`')
    expect(summary).toContain('- `vitest`: `3.2.7` → `3.3.0`')
    expect(summary).toContain('- Added `oxlint` `1.82.0`')
    expect(summary).toContain('- Removed `left-pad` `1.3.0`')
    expect(summary.indexOf('### All locked packages')).toBeGreaterThan(
      summary.indexOf('### Nix flake inputs'),
    )
  })

  it('says so when nothing changed', () => {
    expect(summarizeDependencyChanges(before, { ...before })).toBe(
      '## Dependency changes\n\nNo dependency changes.\n',
    )
  })

  it('links Nix comparisons only for well-formed GitHub coordinates', () => {
    const summary = summarizeDependencyChanges(
      { ...before, flakeLock: hostile('1'.repeat(40)) },
      { ...before, flakeLock: hostile('2'.repeat(40)) },
    )
    expect(summary).toContain(`| \`nixpkgs\` | \`evil)(x/nixpkgs\` | \`${'1'.repeat(12)}\` → \``)
    expect(summary).not.toContain('https://')
  })
})
