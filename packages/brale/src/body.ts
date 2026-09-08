/**
 * Repairs generated-command request bodies using the vendored contract.
 *
 * The generated `api` surface exposes every top-level request-body property as
 * a command-line flag, and argv only carries strings. When the contract
 * declares a property as an object or array, the generator has no string
 * conversion to apply, so the flag's raw text survives into the serialized
 * body as a JSON *string* — `{"source":"{\"value_type\":...}"}` — and Brale
 * rejects the write. This module knows, from the document, exactly which
 * top-level properties are JSON containers, and re-parses only those.
 */

import {
  REFERENCE_DEPTH_LIMIT,
  resolveReference,
  type DocumentLike,
  type SchemaLike,
} from './references.js'

/** A flag value that cannot satisfy the container shape the contract declares. */
export class BodyValueError extends Error {
  override readonly name = 'BodyValueError'
  readonly property: string

  constructor(options: { property: string; detail: string }) {
    super(
      `--${options.property} expects a JSON ${options.detail}. ` +
        `Pass it as one quoted argument, e.g. --${options.property} '{"key":"value"}'.`,
    )
    this.property = options.property
  }
}

function schemaMembers(document: DocumentLike, entries: unknown, depth: number): SchemaLike[] {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry): entry is SchemaLike => typeof entry === 'object' && entry !== null)
    .map((entry) => resolveReference(document, entry, depth))
    .filter((entry): entry is SchemaLike => entry !== undefined)
}

/**
 * Whether the contract declares this schema as an object or array. A
 * `anyOf`/`oneOf` that also admits a plain string stays a string: an ambiguous
 * value must not be reinterpreted behind the caller's back.
 */
function isJsonContainer(document: DocumentLike, input: SchemaLike, depth: number): boolean {
  if (depth > REFERENCE_DEPTH_LIMIT) return false
  const schema = resolveReference(document, input, depth)
  if (!schema) return false

  const type = schema.type
  if (type === 'object' || type === 'array') return true
  if (Array.isArray(type))
    return (type.includes('object') || type.includes('array')) && !type.includes('string')
  if (typeof type === 'string') return false

  if (schema.properties || schema.items || schema.additionalProperties || schema.patternProperties)
    return true

  if (
    schemaMembers(document, schema.allOf, depth).some((m) =>
      isJsonContainer(document, m, depth + 1),
    )
  )
    return true

  for (const key of ['anyOf', 'oneOf']) {
    const members = schemaMembers(document, schema[key], depth)
    if (members.length === 0) continue
    const anyContainer = members.some((member) => isJsonContainer(document, member, depth + 1))
    const anyString = members.some((member) => member.type === 'string')
    if (anyContainer && !anyString) return true
  }

  return false
}

/** Templated spec paths match a concrete pathname segment-for-segment. */
function pathMatches(templatePath: string, pathname: string): boolean {
  const templateSegments = templatePath.split('/')
  const pathSegments = pathname.split('/')
  if (templateSegments.length !== pathSegments.length) return false
  return templateSegments.every(
    (segment, index) =>
      (segment.startsWith('{') && segment.endsWith('}') && pathSegments[index] !== '') ||
      segment === pathSegments[index],
  )
}

/**
 * The top-level request-body properties the contract declares as JSON
 * containers for this operation, or an empty set when the operation is unknown
 * or carries no JSON body. Ambiguous pathnames resolve to the candidate with
 * the fewest templated segments, mirroring how routers prefer literal routes.
 */
export function jsonContainerBodyProperties(
  document: DocumentLike,
  options: { method: string; pathname: string },
): Set<string> {
  const method = options.method.toLowerCase()
  const containers = new Set<string>()

  let matched: Record<string, unknown> | undefined
  let matchedTemplateCount = Number.POSITIVE_INFINITY
  for (const [templatePath, item] of Object.entries(document.paths ?? {})) {
    if (!item[method] || !pathMatches(templatePath, options.pathname)) continue
    const templateCount = templatePath.match(/\{/g)?.length ?? 0
    if (templateCount < matchedTemplateCount) {
      matched = item
      matchedTemplateCount = templateCount
    }
  }
  if (!matched) return containers

  const operation = matched[method] as {
    requestBody?: { content?: Record<string, { schema?: SchemaLike }> }
  }
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema
  if (!bodySchema) return containers

  const resolved = resolveReference(document, bodySchema, 0)
  const properties = resolved?.properties
  if (typeof properties !== 'object' || properties === null) return containers

  for (const [name, schema] of Object.entries(properties as Record<string, SchemaLike>))
    if (isJsonContainer(document, schema, 0)) containers.add(name)

  return containers
}

/**
 * Returns `bodyText` with container-typed properties re-parsed from their
 * string form, ready to send. Text that is not a JSON object passes through
 * untouched: a raw `--body` payload was authored by the operator and is not
 * this module's to rewrite.
 */
export function coerceJsonBodyText(
  document: DocumentLike,
  options: { method: string; pathname: string; bodyText: string },
): string {
  const containers = jsonContainerBodyProperties(document, options)
  if (containers.size === 0) return options.bodyText

  let body: unknown
  try {
    body = JSON.parse(options.bodyText)
  } catch {
    return options.bodyText
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return options.bodyText

  const record = body as Record<string, unknown>
  let changed = false
  for (const property of containers) {
    const value = record[property]
    if (typeof value !== 'string') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new BodyValueError({ property, detail: 'object or array' })
    }
    if (typeof parsed !== 'object' || parsed === null)
      throw new BodyValueError({ property, detail: 'object or array' })

    record[property] = parsed
    changed = true
  }

  return changed ? JSON.stringify(record) : options.bodyText
}
