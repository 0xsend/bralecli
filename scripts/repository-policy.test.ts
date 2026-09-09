import { readFileSync, readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

type Step = {
  id?: string
  uses?: string
  with?: Record<string, unknown>
  run?: string
  if?: string
  'continue-on-error'?: boolean
}
type Workflow = {
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency?: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<
    string,
    {
      'runs-on': string
      'timeout-minutes': number
      permissions?: Record<string, string>
      if?: string
      needs?: string | string[]
      outputs?: Record<string, string>
      steps: Step[]
    }
  >
}

function workflow(name: string): Workflow {
  return parse(
    readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'),
  ) as Workflow
}

describe('repository automation trust boundaries', () => {
  const names = readdirSync(new URL('../.github/workflows/', import.meta.url))
    .filter((name) => name.endsWith('.yml'))
    .map((name) => name.slice(0, -4))
  for (const name of names) {
    it(`${name} runs bounded jobs with scoped permissions, pinned actions, and no persisted checkout credentials`, () => {
      const config = workflow(name)
      expect(config.permissions).toEqual({ contents: 'read' })
      expect(Object.keys(config.jobs).length).toBeGreaterThan(0)
      for (const [id, job] of Object.entries(config.jobs)) {
        expect(job['runs-on']).toBe(
          name === 'release' && id === 'build' ? '${{ matrix.runner }}' : 'ubuntu-latest',
        )
        expect(job['timeout-minutes']).toBeGreaterThan(0)
        expect(job['timeout-minutes']).toBeLessThanOrEqual(30)
        expect(job.permissions ?? config.permissions).toEqual(
          name === 'update-spec' && id === 'pull-request'
            ? { contents: 'write', 'pull-requests': 'write' }
            : name === 'release' && id === 'draft'
              ? { contents: 'write' }
              : { contents: 'read' },
        )
        for (const step of job.steps) {
          if (!step.uses) continue
          expect(step.uses).toMatch(
            /^(?:[\w.-]+\/[\w.-]+@[a-f0-9]{40}|\.\/\.github\/actions\/[\w-]+)$/,
          )
          if (step.uses.startsWith('actions/checkout@')) {
            expect(step.with?.['persist-credentials']).toBe(false)
          }
        }
      }
    })
  }

  it('CI accepts only push, pull request, and manual triggers', () => {
    expect(Object.keys(workflow('ci').on).toSorted()).toEqual([
      'pull_request',
      'push',
      'workflow_dispatch',
    ])
  })

  it('CI runs all seven required checks through the isolated runner', () => {
    const jobs = workflow('ci').jobs
    const commands = {
      test: 'test',
      typecheck: 'typecheck',
      build: 'build',
      lint: 'lint',
      format: 'format:check',
      knip: 'knip',
      jscpd: 'jscpd',
    }
    expect(Object.keys(jobs).toSorted()).toEqual(Object.keys(commands).toSorted())
    for (const [id, command] of Object.entries(commands)) {
      const steps = jobs[id]!.steps
      expect(steps.map((step) => step.run).filter(Boolean)).toEqual(
        id === 'lint'
          ? ['node scripts/ci-sandbox.mjs lint', 'node scripts/ci-sandbox.mjs actions:check']
          : id === 'test'
            ? ['node --test scripts/ci-sandbox.test.mjs', 'node scripts/ci-sandbox.mjs test']
            : [`node scripts/ci-sandbox.mjs ${command}`],
      )
      expect(steps.some((step) => step.uses === './.github/actions/setup-nub')).toBe(false)
    }
  })

  it('dependency automation is manual and offers a patch instead of writing to the repository', () => {
    const config = workflow('update-deps')
    expect(Object.keys(config.on)).toEqual(['workflow_dispatch'])
    const steps = Object.values(config.jobs).flatMap((job) => job.steps)
    expect(steps.some((step) => step.uses?.startsWith('actions/upload-artifact@'))).toBe(true)
    expect(steps.map((step) => step.run ?? '').join('\n')).not.toMatch(
      /git\s+push|gh\s+pr\s+(create|merge|review)/,
    )
  })

  it('spec automation runs once daily and manually, restricted to canonical main', () => {
    const config = workflow('update-spec')
    expect(Object.keys(config.on).toSorted()).toEqual(['schedule', 'workflow_dispatch'])
    expect(config.on.schedule).toEqual([{ cron: '23 8 * * *' }])
    expect(config.concurrency).toEqual({ group: 'brale-spec-update', 'cancel-in-progress': false })
    expect(config.jobs.prepare?.if).toBe(
      "github.repository == '0xsend/bralecli' && github.ref == 'refs/heads/main'",
    )
    for (const job of Object.values(config.jobs)) {
      const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))
      expect(checkout?.with?.ref).toBe('${{ github.sha }}')
    }
  })

  it('spec preparation freezes data before compatibility executes on a separate runner', () => {
    const config = workflow('update-spec')
    const steps = config.jobs.prepare!.steps
    expect(steps.some((step) => step.uses === './.github/actions/setup-nub')).toBe(false)
    const commands = steps.map((step) => step.run ?? '').join('\n')
    expect(commands).not.toMatch(/\b(?:npm|nub|npx|bun)\b|spec-update\/spec\.ts/)
    expect(commands).toContain('node scripts/refresh-spec.ts --update-pin --format json')
    expect(commands).toContain('"$RUNNER_TEMP/spec-update/revision.json"')
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
    expect(upload?.if).toBe("steps.refresh.outputs.changed == 'true'")
    expect(upload?.with?.['if-no-files-found']).toBe('error')
    expect(config.jobs.prepare?.outputs?.['artifact-id']).toBe(
      '${{ steps.artifact.outputs.artifact-id }}',
    )
    const compatibility = config.jobs.compatibility!
    expect(compatibility?.needs).toBe('prepare')
    expect(compatibility?.if).toBe("needs.prepare.outputs.changed == 'true'")
    expect(
      compatibility?.steps.some((step) => step.run === 'node scripts/ci-sandbox.mjs compatibility'),
    ).toBe(true)
    expect(
      compatibility?.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@')),
    ).toBe(false)
    expect(config.jobs['pull-request']?.needs).toEqual(['prepare', 'compatibility'])
    expect(config.jobs['pull-request']?.if).toBe(
      "${{ !cancelled() && needs.prepare.result == 'success' && needs.prepare.outputs.changed == 'true' }}",
    )
    for (const id of ['compatibility', 'pull-request']) {
      const download = config.jobs[id]!.steps.find((step) =>
        step.uses?.startsWith('actions/download-artifact@'),
      )
      expect(download?.with?.['artifact-ids']).toBe('${{ needs.prepare.outputs.artifact-id }}')
      expect(download?.with?.['merge-multiple']).toBe(true)
      expect(download?.with?.name).toBeUndefined()
    }
  })

  it('the spec writer proposes four trusted paths without executing the artifact', () => {
    const job = workflow('update-spec').jobs['pull-request']!
    const proposal = job.steps.find((step) =>
      step.uses?.startsWith('peter-evans/create-pull-request@'),
    )
    expect(proposal?.with?.branch).toBe('automation/brale-spec')
    expect(proposal?.with?.base).toBe('main')
    expect(proposal?.with?.draft).toBe('always-true')
    expect(proposal?.with?.['add-paths']).toBe(
      'packages/brale/openapi/brale.json\npackages/brale/src/spec.ts\napps/cli/package.json\napps/cli/CHANGELOG.md\n',
    )
    expect(proposal?.with?.['branch-suffix']).toBeUndefined()
    expect(proposal?.with?.['maintainer-can-modify']).toBe(false)
    expect(job.steps.map((step) => step.uses ?? '').filter(Boolean)).toEqual([
      expect.stringMatching(/^actions\/checkout@/),
      expect.stringMatching(/^actions\/setup-node@/),
      expect.stringMatching(/^actions\/download-artifact@/),
      expect.stringMatching(/^peter-evans\/create-pull-request@/),
    ])
    const commands = job.steps.map((step) => step.run ?? '').join('\n')
    expect(commands).toContain(
      'node scripts/apply-spec-proposal.ts --proposal-dir "$RUNNER_TEMP/spec-update"',
    )
    expect(commands).not.toContain('spec-update/spec.ts')
    expect(commands).not.toMatch(/\b(?:nub|npm|npx|bun|source|eval)\b|gh\s+pr\s+(merge|review)/)
    expect(proposal?.with?.body).toContain('${{ needs.compatibility.result }}')
  })

  it('release preparation is confined to main with four native jobs before its isolated draft writer', () => {
    const config = workflow('release')
    expect(Object.keys(config.on).toSorted()).toEqual(['push', 'workflow_dispatch'])
    expect(config.on.push).toEqual({ branches: ['main'] })
    expect(config.jobs.candidate?.if).toBe(
      "github.repository == '0xsend/bralecli' && github.ref == 'refs/heads/main'",
    )
    expect(config.concurrency).toEqual({
      group: 'release-preparation',
      'cancel-in-progress': false,
    })
    expect(config.jobs.build?.needs).toBe('candidate')
    expect(config.jobs.build?.if).toBe("needs.candidate.outputs.prepare == 'true'")
    const raw = parse(
      readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
    )
    expect(raw.jobs.build.strategy.matrix.include).toEqual([
      { platform: 'darwin-arm64', runner: 'macos-15' },
      { platform: 'darwin-x64', runner: 'macos-15-intel' },
      { platform: 'linux-arm64', runner: 'ubuntu-24.04-arm' },
      { platform: 'linux-x64', runner: 'ubuntu-24.04' },
    ])
    const build = config.jobs.build!.steps.map((step) => step.run ?? '').join('\n')
    expect(build).toContain('nub ci --ignore-scripts')
    expect(build).toContain('nub run check')
    expect(build).toContain('scripts/smoke-binary.py')
    expect(build).toContain('scripts/release-artifacts.ts package')
    const job = config.jobs.draft!
    expect(job.needs).toEqual(['candidate', 'build'])
    expect(job.permissions).toEqual({ contents: 'write' })
    expect(job.steps.map((step) => step.run ?? '').join('\n')).toContain(
      'scripts/release-draft.ts upload',
    )
    expect(job.steps.map((step) => step.run ?? '').join('\n')).not.toMatch(
      /\b(?:npm|nub|bun|npx|python3)\b|--draft=false/,
    )
    const download = job.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))
    expect(download?.with?.pattern).toBe('release-${{ github.run_id }}-*')
    const upload = config.jobs.build!.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    )
    expect(upload?.with?.name).toBe('release-${{ github.run_id }}-${{ matrix.platform }}')
    expect(upload?.with?.overwrite).toBe(true)
    expect(download?.with?.['run-id']).toBeUndefined()
    for (const current of Object.values(config.jobs)) {
      expect(
        current.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.ref,
      ).toBe('${{ github.sha }}')
    }
  })
})
