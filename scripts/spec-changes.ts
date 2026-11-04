/** Builtin-only reviewer summary of what an OpenAPI proposal changes, by operation and component. */
import { isDeepStrictEqual } from 'node:util'

import { BoundedLines, code } from './markdown.ts'
import { isObject } from './spec-proposal.ts'

const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])
const maxItemsPerSection = 25
const maxDetails = 6
// GitHub limits PR bodies to 65,536 characters; the workflow's fixed text uses ~3,000.
const summaryBudget = 40_000

type Section = { title: string; before: Map<string, unknown>; after: Map<string, unknown> }

function entries(value: unknown): Map<string, unknown> {
  return new Map(isObject(value) ? Object.entries(value) : [])
}

/** Path-level fields (shared parameters, servers, $ref) affect every operation under the path. */
function operations(document: unknown, section: 'paths' | 'webhooks'): Map<string, unknown> {
  const result = new Map<string, unknown>()
  for (const [path, item] of entries(isObject(document) ? document[section] : undefined)) {
    if (!isObject(item)) continue
    const shared = Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !methods.has(key))
        .map(([key, value]) => [`path ${key}`, value]),
    )
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) continue
      const fields = isObject(operation) ? operation : { operation }
      result.set(`${method.toUpperCase()} ${path}`, { ...fields, ...shared })
    }
  }
  return result
}

function names(before: Map<string, unknown>, after: Map<string, unknown>) {
  const added = [...after.keys()].filter((key) => !before.has(key)).toSorted()
  const removed = [...before.keys()].filter((key) => !after.has(key)).toSorted()
  const changed = [...before.keys()]
    .filter((key) => after.has(key) && !isDeepStrictEqual(before.get(key), after.get(key)))
    .toSorted()
  return { added, removed, changed }
}

function limited(items: string[]): string {
  const shown = items.slice(0, maxDetails).join(', ')
  return items.length > maxDetails ? `${shown}, …${items.length - maxDetails} more` : shown
}

function marked(diff: ReturnType<typeof names>, changed: (name: string) => string): string[] {
  return [
    ...diff.added.map((name) => `+${code(name, 60)}`),
    ...diff.removed.map((name) => `−${code(name, 60)}`),
    ...diff.changed.map(changed),
  ]
}

/** Names the changed fields, expanding one level into maps such as properties or responses. */
function detail(before: unknown, after: unknown): string {
  const fields = { before: entries(before), after: entries(after) }
  const parts = marked(names(fields.before, fields.after), (key) => {
    const [a, b] = [fields.before.get(key), fields.after.get(key)]
    const nested = marked(names(entries(a), entries(b)), (name) => `~${code(name, 60)}`)
    return isObject(a) && isObject(b) && nested.length
      ? `${code(key, 60)} (${limited(nested)})`
      : code(key, 60)
  })
  return parts.length ? `: ${limited(parts)}` : ''
}

function sections(previous: unknown, next: unknown): Section[] {
  const result: Section[] = [
    {
      title: 'Operations',
      before: operations(previous, 'paths'),
      after: operations(next, 'paths'),
    },
    {
      title: 'Webhooks',
      before: operations(previous, 'webhooks'),
      after: operations(next, 'webhooks'),
    },
  ]
  const before = entries(isObject(previous) ? previous.components : undefined)
  const after = entries(isObject(next) ? next.components : undefined)
  for (const kind of new Set([...before.keys(), ...after.keys()].toSorted())) {
    result.push({
      title: `Components ${code(kind)}`,
      before: entries(before.get(kind)),
      after: entries(after.get(kind)),
    })
  }
  const topLevel = (document: unknown) =>
    new Map(
      [...entries(document)].filter(([key]) => !['paths', 'webhooks', 'components'].includes(key)),
    )
  result.push({ title: 'Document', before: topLevel(previous), after: topLevel(next) })
  return result
}

/**
 * Summarizes structural differences between two parsed OpenAPI documents as Markdown.
 * Callers must bound document size and depth first; `planSpecRelease` does so.
 */
export function summarizeSpecChanges(input: {
  previous: unknown
  next: unknown
  proposedVersion: string | undefined
}): string {
  const out = new BoundedLines(
    summaryBudget,
    '_Summary truncated at its size limit; review the full diff for the remaining changes._',
  )
  out.push(
    '### What changed upstream',
    '',
    input.proposedVersion
      ? `Semantic contract change: **yes**, so this proposes version ${code(input.proposedVersion)}.`
      : 'Semantic contract change: **no**. Only annotations such as descriptions or formatting changed.',
    '',
  )
  let differences = 0
  for (const section of sections(input.previous, input.next)) {
    const { added, removed, changed } = names(section.before, section.after)
    const total = added.length + removed.length + changed.length
    if (!total) continue
    differences += total
    const counts = [
      added.length && `${added.length} added`,
      removed.length && `${removed.length} removed`,
      changed.length && `${changed.length} changed`,
    ].filter(Boolean)
    const items = [
      ...added.map((name) => `- Added ${code(name)}`),
      ...removed.map((name) => `- Removed ${code(name)}`),
      ...changed.map(
        (name) =>
          `- Changed ${code(name)}${detail(section.before.get(name), section.after.get(name))}`,
      ),
    ]
    if (
      !out.push(
        `**${section.title}**: ${counts.join(', ')}`,
        '',
        ...items.slice(0, maxItemsPerSection),
      )
    )
      break
    if (items.length > maxItemsPerSection)
      out.push(`- …and ${items.length - maxItemsPerSection} more`)
    out.push('')
  }
  if (!differences)
    out.push('No structural differences: only whitespace or key order changed in the served bytes.')
  return out.toString()
}
