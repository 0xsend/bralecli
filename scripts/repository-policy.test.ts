import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

type Step = { uses?: string; with?: Record<string, unknown>; run?: string }
type Workflow = {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<
    string,
    {
      'runs-on': string
      'timeout-minutes': number
      permissions?: Record<string, string>
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
  for (const name of ['ci', 'update-deps']) {
    it(`${name} runs bounded read-only jobs with pinned actions and no persisted checkout credentials`, () => {
      const config = workflow(name)
      expect(config.permissions).toEqual({ contents: 'read' })
      expect(Object.keys(config.jobs).length).toBeGreaterThan(0)
      for (const job of Object.values(config.jobs)) {
        expect(job['runs-on']).toBe('ubuntu-latest')
        expect(job['timeout-minutes']).toBeGreaterThan(0)
        expect(job['timeout-minutes']).toBeLessThanOrEqual(30)
        expect(job.permissions ?? config.permissions).toEqual({ contents: 'read' })
        for (const step of job.steps) {
          if (!step.uses) continue
          expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/)
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

  it('dependency automation is manual and offers a patch instead of writing to the repository', () => {
    const config = workflow('update-deps')
    expect(Object.keys(config.on)).toEqual(['workflow_dispatch'])
    const steps = Object.values(config.jobs).flatMap((job) => job.steps)
    expect(steps.some((step) => step.uses?.startsWith('actions/upload-artifact@'))).toBe(true)
    expect(steps.map((step) => step.run ?? '').join('\n')).not.toMatch(
      /git\s+push|gh\s+pr\s+(create|merge|review)/,
    )
  })
})
