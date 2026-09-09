/** Builtin-only contract shared by the fetcher and the trusted proposal writer. */
import { createHash } from 'node:crypto'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const specPath: string = fileURLToPath(
  new URL('../packages/brale/openapi/brale.json', import.meta.url),
)
export const pinPath: string = fileURLToPath(
  new URL('../packages/brale/src/spec.ts', import.meta.url),
)
export const maxDocumentBytes: number = 10 * 1024 * 1024

export type Revision = { hash: string; fetchedAt: string }
export type RefreshResult = Revision & { changed: boolean; previousHash: string }
type PinName = 'SPEC_SHA256' | 'SPEC_FETCHED_AT' | 'SPEC_SOURCE_URL'

export function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function constantPattern(name: PinName): RegExp {
  return new RegExp(
    `^(export const ${name}: string =\\s*)(['"])([^'"\\r\\n]+)\\2([ \\t]*;?[ \\t]*)$`,
    'gm',
  )
}

export function constantValue(source: string, name: PinName): string | undefined {
  const declarations = source.match(new RegExp(`^export const ${name}\\b`, 'gm'))
  const matches = [...source.matchAll(constantPattern(name))]
  return declarations?.length === 1 && matches.length === 1 ? matches[0]![3] : undefined
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value
}

export function pinnedRevision(source: string): Revision | undefined {
  const hash = constantValue(source, 'SPEC_SHA256')
  const fetchedAt = constantValue(source, 'SPEC_FETCHED_AT')
  return isHash(hash) && isDate(fetchedAt) ? { hash, fetchedAt } : undefined
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJson(body: Buffer, label: string): unknown {
  try {
    // Keep BOMs visible and reject invalid UTF-8; a revision hashes served bytes,
    // so neither decoder repair nor JSON reserialization may alter the document.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body))
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error })
  }
}

export function validateDocument(body: Buffer): void {
  if (body.byteLength > maxDocumentBytes) throw new Error('Response exceeds the 10 MiB size limit')
  const document = parseJson(body, 'Response')
  if (
    !isObject(document) ||
    typeof document.openapi !== 'string' ||
    !/^3\.\d+\.\d+$/.test(document.openapi) ||
    !isObject(document.info) ||
    typeof document.info.title !== 'string' ||
    !document.info.title ||
    typeof document.info.version !== 'string' ||
    !document.info.version ||
    !isObject(document.paths)
  ) {
    throw new Error(
      'Response is not an OpenAPI 3 document with info.title, info.version, and paths',
    )
  }
}

export function updatePin(source: string, revision: Revision): string {
  return source
    .replace(constantPattern('SPEC_SHA256'), `$1$2${revision.hash}$2$4`)
    .replace(constantPattern('SPEC_FETCHED_AT'), `$1$2${revision.fetchedAt}$2$4`)
}

export async function writeProposal(body: Buffer, source: string | undefined): Promise<void> {
  const staging = await mkdtemp(join(dirname(specPath), '.refresh-spec-'))
  try {
    await writeFile(join(staging, 'document'), body)
    if (source !== undefined) await writeFile(join(staging, 'pin'), source)
    // Atomicity: each rename is atomic; an interrupted pair fails the hash
    // precondition on retry. Permanent — Git publishes the pair as one commit.
    await rename(join(staging, 'document'), specPath)
    if (source !== undefined) await rename(join(staging, 'pin'), pinPath)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
