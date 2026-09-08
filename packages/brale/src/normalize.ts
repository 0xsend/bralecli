/**
 * Makes Brale's OpenAPI document safe for a generator that interpolates path
 * parameters verbatim.
 *
 * Every path parameter in the document carries a `$ref` schema (`ID`) that
 * declares no `pattern` at all — so a generated command would accept
 * `../accounts/other` as an id and URL normalization would then retarget the
 * request at a different resource. Constraining the parameter schemas turns
 * that into a validation error before any request is built.
 */
import { resolveReference, type DocumentLike } from './references.js'

type ParameterLike = {
  $ref?: string
  description?: string
  name?: string
  in?: string
  required?: boolean
  schema?: Record<string, unknown>
}

type PathItem = Record<string, unknown> & {
  parameters?: ParameterLike[]
}

type Document = {
  paths?: Record<string, PathItem>
  components?: { parameters?: Record<string, ParameterLike>; [key: string]: unknown }
  [key: string]: unknown
}

/** HTTP methods an OpenAPI path item may carry. Anything else is a sibling field. */
const HTTP_METHODS: readonly string[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]

/**
 * The values a path parameter may take: no `/` or `\` (WHATWG URLs treat a
 * backslash in an https URL as a slash), no `?` or `#` (they end the path), and
 * no `%` (URL normalization decodes `%2e%2e` into a dot segment, so a percent
 * escape can smuggle what the literal characters cannot), and no literal `.`
 * or `..` segment (WHATWG URL resolution removes them from the path).
 *
 * Brale ids are KSUIDs; every legitimate value passes.
 */
export const PATH_PARAMETER_VALUE_PATTERN: string = '^(?!\\.{1,2}$)[^/\\\\?#%]+$'

/** Separator used to expose one object-valued query member as a scalar flag. */
const OBJECT_QUERY_FLAG_SEPARATOR = '_'

/** Decimal spelling of Brale's documented inclusive page-size range. */
const PAGE_SIZE_VALUE_PATTERN = '^(?:[1-9][0-9]{0,2}|1000)$'

function cliObjectQueryPropertySchema(
  parameterName: string,
  propertyName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (input.type !== 'integer') return input

  // incur's argv coercion replaces a constrained Zod number with an
  // unconstrained `z.coerce.number()`. Preserve the contract as a decimal
  // string instead; query values are strings on the wire in either case.
  if (
    parameterName !== 'page' ||
    propertyName !== 'size' ||
    input.minimum !== 1 ||
    input.maximum !== 1000
  )
    throw new Error(
      `Cannot flatten bounded integer query parameter ${parameterName}.${propertyName} without a value pattern`,
    )

  const schema: Record<string, unknown> = {
    ...input,
    type: 'string',
    pattern: PAGE_SIZE_VALUE_PATTERN,
    description: 'Page size as an integer from 1 through 1000',
  }
  delete schema.minimum
  delete schema.maximum
  delete schema.format
  return schema
}

function objectQueryProperties(
  document: Document,
  parameter: ParameterLike,
): Record<string, Record<string, unknown>> | undefined {
  if (parameter.$ref || parameter.in !== 'query' || !parameter.schema) return undefined
  const schema = resolveReference(document as DocumentLike, parameter.schema, 0)
  if (!schema || (schema.type !== 'object' && !schema.properties)) return undefined
  if (typeof schema.properties !== 'object' || schema.properties === null) return undefined
  return schema.properties as Record<string, Record<string, unknown>>
}

function flattenObjectQueryParameter(
  document: Document,
  parameter: ParameterLike,
  occupiedNames: Set<string>,
): ParameterLike[] {
  const properties = objectQueryProperties(document, parameter)
  if (!properties || !parameter.name || Object.keys(properties).length === 0) return [parameter]

  const schema = resolveReference(document as DocumentLike, parameter.schema!, 0)
  const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
  return Object.entries(properties).map(([propertyName, propertySchema]) => {
    const name = `${parameter.name}${OBJECT_QUERY_FLAG_SEPARATOR}${propertyName}`
    if (occupiedNames.has(name))
      throw new Error(
        `Cannot flatten query parameter ${parameter.name}: generated flag ${name} already exists`,
      )
    occupiedNames.add(name)
    return {
      name,
      in: 'query',
      required: parameter.required === true && required.has(propertyName),
      description:
        typeof propertySchema.description === 'string'
          ? propertySchema.description
          : `${parameter.description ?? parameter.name}: ${propertyName}`,
      schema: cliObjectQueryPropertySchema(parameter.name!, propertyName, propertySchema),
    }
  })
}

function flattenObjectQueryList(document: Document, parameters: ParameterLike[]): ParameterLike[] {
  const occupiedNames = new Set(parameters.flatMap((parameter) => parameter.name ?? []))
  return parameters.flatMap((parameter) =>
    flattenObjectQueryParameter(document, parameter, occupiedNames),
  )
}

/**
 * Returns a copy of `document` whose path parameters reject values that would
 * escape their path segment. The input is not mutated.
 *
 * A `$ref` schema is inlined first — a `pattern` written next to a `$ref` is a
 * sibling a dereferencer is entitled to drop. An author pattern is kept and
 * composed via a lookahead, since JSON Schema allows one `pattern` per schema:
 * the value must satisfy both.
 */
export function constrainPathParameters<document extends Document>(document: document): document {
  const source = structuredClone(document)

  const constrain = (parameter: ParameterLike) => {
    if (parameter.$ref || parameter.in !== 'path') return
    const resolved = parameter.schema
      ? resolveReference(source as DocumentLike, parameter.schema, 0)
      : undefined
    const schema: Record<string, unknown> = { ...(resolved ?? { type: 'string' }) }
    // The group is load-bearing: `(?=SAFE)A|B` parses as `((?=SAFE)A)|B`, so a
    // top-level alternation in the author pattern would escape the lookahead.
    schema.pattern =
      typeof schema.pattern === 'string' && schema.pattern.length > 0
        ? `(?=${PATH_PARAMETER_VALUE_PATTERN})(?:${schema.pattern})`
        : PATH_PARAMETER_VALUE_PATTERN
    parameter.schema = schema
  }

  for (const parameter of Object.values(source.components?.parameters ?? {})) constrain(parameter)

  for (const pathItem of Object.values(source.paths ?? {})) {
    for (const parameter of pathItem.parameters ?? []) constrain(parameter)
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!operation || typeof operation !== 'object') continue
      for (const parameter of (operation as { parameters?: ParameterLike[] }).parameters ?? [])
        constrain(parameter)
    }
  }

  return source
}

/**
 * Replaces object-valued query parameters with validated scalar members.
 *
 * incur cannot parse an object option from argv and stringifies a programmatic
 * object as `[object Object]`. Brale's only such parameter is `page`; exposing
 * its members as `--page_size`, `--page_after`, and `--page_before` keeps the
 * original member schemas (including bounds) in the generated CLI.
 */
export function flattenObjectQueryParameters<document extends Document>(
  document: document,
): document {
  const source = structuredClone(document)

  for (const pathItem of Object.values(source.paths ?? {})) {
    if (pathItem.parameters)
      pathItem.parameters = flattenObjectQueryList(source, pathItem.parameters)
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!operation || typeof operation !== 'object') continue
      const typed = operation as { parameters?: ParameterLike[] }
      if (typed.parameters) typed.parameters = flattenObjectQueryList(source, typed.parameters)
    }
  }

  return source
}

/** The vendored contract normalized for incur's generated CLI surface. */
export function prepareSpecForCli<document extends Document>(document: document): document {
  return flattenObjectQueryParameters(constrainPathParameters(document))
}

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
 * Restores scalar CLI query names to Brale's documented deep-object wire form.
 * Returns whether any parameter changed.
 */
export function restoreObjectQueryParameters(
  document: Document,
  options: { method: string; pathname: string; searchParams: URLSearchParams },
): boolean {
  const method = options.method.toLowerCase()
  let matched: PathItem | undefined
  let matchedTemplateCount = Number.POSITIVE_INFINITY
  for (const [templatePath, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathMatches(templatePath, options.pathname) || !pathItem[method]) continue
    const templateCount = templatePath.match(/\{/g)?.length ?? 0
    if (templateCount < matchedTemplateCount) {
      matched = pathItem
      matchedTemplateCount = templateCount
    }
  }
  if (!matched) return false

  const operation = matched[method] as { parameters?: ParameterLike[] }
  const parameters = [...(matched.parameters ?? []), ...(operation.parameters ?? [])]
  let changed = false
  for (const parameter of parameters) {
    const properties = objectQueryProperties(document, parameter)
    if (!properties || !parameter.name) continue
    for (const propertyName of Object.keys(properties)) {
      const cliName = `${parameter.name}${OBJECT_QUERY_FLAG_SEPARATOR}${propertyName}`
      const values = options.searchParams.getAll(cliName)
      if (values.length === 0) continue
      options.searchParams.delete(cliName)
      const wireName = `${parameter.name}[${propertyName}]`
      for (const value of values) options.searchParams.append(wireName, value)
      changed = true
    }
  }
  return changed
}
