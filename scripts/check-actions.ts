import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parse } from 'yaml'

type Step = { uses?: string }
type Definition = {
  jobs?: Record<string, { uses?: string; steps?: Step[] }>
  runs?: { using: string; steps?: Step[] }
}

const root = resolve(import.meta.dirname, '..')
const visited = new Set<string>()
const pinnedAction = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[a-f0-9]{40}$/

async function inspect(reference: string): Promise<void> {
  if (visited.has(reference)) return
  if (visited.size >= 100) throw new Error('Action graph exceeds 100 dependencies')
  visited.add(reference)
  let definition: Definition
  if (reference.startsWith('./')) {
    const directory = resolve(root, reference)
    if (!directory.startsWith(`${root}/`))
      throw new Error(`Action escapes repository: ${reference}`)
    definition = parse(await readFile(`${directory}/action.yml`, 'utf8')) as Definition
  } else {
    if (!pinnedAction.test(reference)) throw new Error(`Action must be SHA-pinned: ${reference}`)
    const [location, revision] = reference.split('@')
    const [owner, repository, ...path] = location!.split('/')
    const base = `https://raw.githubusercontent.com/${owner}/${repository}/${revision}/${path.length ? `${path.join('/')}/` : ''}`
    let response = await fetch(`${base}action.yml`, { signal: AbortSignal.timeout(15_000) })
    if (response.status === 404) {
      response = await fetch(`${base}action.yaml`, { signal: AbortSignal.timeout(15_000) })
    }
    if (!response.ok) throw new Error(`Cannot inspect ${reference}: HTTP ${response.status}`)
    definition = parse(await response.text()) as Definition
  }
  if (!definition.runs?.using) throw new Error(`Missing action runtime: ${reference}`)
  if (definition.runs.using === 'composite') {
    if (!definition.runs.steps?.length) throw new Error(`Empty composite action: ${reference}`)
    await Promise.all(
      definition.runs.steps.map(async (step) => {
        if (!step.uses) return
        if (!reference.startsWith('./') && step.uses.startsWith('./')) {
          throw new Error(`Remote local action needs explicit review: ${reference} -> ${step.uses}`)
        }
        await inspect(step.uses)
      }),
    )
  }
}

const workflows = (await readdir(`${root}/.github/workflows`)).filter((name) =>
  /\.ya?ml$/.test(name),
)
if (!workflows.length) throw new Error('No workflows found')
await Promise.all(
  workflows.map(async (filename) => {
    const definition = parse(
      await readFile(`${root}/.github/workflows/${filename}`, 'utf8'),
    ) as Definition
    if (!definition.jobs || !Object.keys(definition.jobs).length)
      throw new Error(`No jobs: ${filename}`)
    await Promise.all(
      Object.values(definition.jobs).map(async (job) => {
        if (job.uses) throw new Error(`Reusable workflow needs explicit review: ${job.uses}`)
        await Promise.all(
          (job.steps ?? []).map(async (step) => {
            if (step.uses) await inspect(step.uses)
          }),
        )
      }),
    )
  }),
)
console.log(
  `Verified SHA pinning across ${workflows.length} workflows and ${visited.size} actions, including composite dependencies`,
)
