/** Local `#/...` reference resolution shared by the document normalizers. */

export type SchemaLike = Record<string, unknown>

export type DocumentLike = {
  paths?: Record<string, Record<string, unknown>>
  components?: Record<string, unknown>
}

/**
 * `$ref` chains in the Bridge document are at most a few links; anything
 * deeper is a cycle, and resolution stops rather than recursing forever.
 */
export const REFERENCE_DEPTH_LIMIT = 16

/** Follows a local `#/...` reference to the schema it names, or returns the input. */
export function resolveReference(
  document: DocumentLike,
  schema: SchemaLike,
  depth: number,
): SchemaLike | undefined {
  if (depth > REFERENCE_DEPTH_LIMIT) return undefined
  const reference = schema.$ref
  if (typeof reference !== 'string') return schema
  if (!reference.startsWith('#/')) return undefined

  let target: unknown = document
  for (const segment of reference.slice(2).split('/')) {
    if (typeof target !== 'object' || target === null) return undefined
    target = (target as Record<string, unknown>)[segment]
  }
  if (typeof target !== 'object' || target === null) return undefined
  return resolveReference(document, target as SchemaLike, depth + 1)
}
