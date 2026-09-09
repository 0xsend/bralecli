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
        expect(job['runs-on']).toBe('ubuntu-latest')
        expect(job['timeout-minutes']).toBeGreaterThan(0)
        expect(job['timeout-minutes']).toBeLessThanOrEqual(30)
        expect(job.permissions ?? config.permissions).toEqual(
          name === 'update-spec' && id === 'pull-request'
            ? { contents: 'write', 'pull-requests': 'write' }
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

  it('only the spec writer can publish and it handles two files without executing the artifact', () => {
    const job = workflow('update-spec').jobs['pull-request']!
    const proposal = job.steps.find((step) =>
      step.uses?.startsWith('peter-evans/create-pull-request@'),
    )
    expect(proposal?.with?.branch).toBe('automation/brale-spec')
    expect(proposal?.with?.base).toBe('main')
    expect(proposal?.with?.draft).toBe('always-true')
    expect(proposal?.with?.['add-paths']).toBe(
      'packages/brale/openapi/brale.json\npackages/brale/src/spec.ts\n',
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
})
