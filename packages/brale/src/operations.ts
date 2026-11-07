/** Resolving a concrete request back to the contract operation it addresses. */
import type { DocumentLike } from './references.js'

/** The operation a request addresses, with the path template and item that declare it. */
export type OperationMatch = {
  templatePath: string
  pathItem: Record<string, unknown>
  operation: Record<string, unknown>
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
 * The operation the document declares for this method and pathname, or
 * `undefined` when it declares none. Ambiguous pathnames resolve to the
 * candidate with the fewest templated segments, mirroring how routers prefer
 * literal routes.
 */
export function findOperation(
  document: DocumentLike,
  options: { method: string; pathname: string },
): OperationMatch | undefined {
  const method = options.method.toLowerCase()
  let matched: OperationMatch | undefined
  let matchedTemplateCount = Number.POSITIVE_INFINITY
  for (const [templatePath, pathItem] of Object.entries(document.paths ?? {})) {
    const operation = pathItem[method]
    if (!operation || typeof operation !== 'object') continue
    if (!pathMatches(templatePath, options.pathname)) continue
    const templateCount = templatePath.match(/\{/g)?.length ?? 0
    if (templateCount < matchedTemplateCount) {
      matched = { templatePath, pathItem, operation: operation as Record<string, unknown> }
      matchedTemplateCount = templateCount
    }
  }
  return matched
}
