#!/usr/bin/env -S nub

/**
 * Refreshes exact upstream bytes for review. Pin updates are explicit so manual
 * refreshes retain their review step; automation can prepare a complete PR.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const specPath = fileURLToPath(new URL('../packages/brale/openapi/brale.json', import.meta.url))
const pinPath = fileURLToPath(new URL('../packages/brale/src/spec.ts', import.meta.url))
const fetchTimeoutMs = 30_000
const maxResponseBytes = 10 * 1024 * 1024

type Revision = { hash: string; fetchedAt: string }
type RefreshResult = Revision & { changed: boolean; previousHash: string }
type PinName = 'SPEC_SHA256' | 'SPEC_FETCHED_AT' | 'SPEC_SOURCE_URL'

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function constantPattern(name: PinName): RegExp {
  return new RegExp(
    `^(export const ${name}: string =\\s*)(['"])([^'"\\r\\n]+)\\2([ \\t]*;?[ \\t]*)$`,
    'gm',
  )
}

function constantValue(source: string, name: PinName): string | undefined {
  const declarations = source.match(new RegExp(`^export const ${name}\\b`, 'gm'))
  const matches = [...source.matchAll(constantPattern(name))]
  return declarations?.length === 1 && matches.length === 1 ? matches[0]![3] : undefined
}

function pinnedRevision(source: string): Revision | undefined {
  const hash = constantValue(source, 'SPEC_SHA256')
  const fetchedAt = constantValue(source, 'SPEC_FETCHED_AT')
  if (
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !fetchedAt ||
    !/^\d{4}-\d{2}-\d{2}$/.test(fetchedAt)
  ) {
    return undefined
  }
  const date = Date.parse(`${fetchedAt}T00:00:00Z`)
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== fetchedAt)
    return undefined
  return { hash, fetchedAt }
}

async function previousRevision(path: string): Promise<Revision | undefined> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  // The proposal is untrusted source text. Never import or evaluate it.
  return pinnedRevision(source)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateDocument(body: Buffer): void {
  let document: unknown
  try {
    // Keep BOMs visible to JSON.parse and reject invalid UTF-8; neither may be
    // silently repaired because the hash describes the bytes Brale served.
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body))
  } catch (error) {
    throw new Error('Response is not valid UTF-8 JSON', { cause: error })
  }
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

async function fetchDocument(sourceUrl: string): Promise<Buffer> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('Fetch exceeded the 30 second timeout')),
    fetchTimeoutMs,
  )
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal })
    if (!response.ok)
      throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText}`)
    if (!response.body) throw new Error('Fetch returned no response body')
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > maxResponseBytes) throw new Error('Response exceeds the 10 MiB limit')
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks, size)
    validateDocument(body)
    return body
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

function updatePin(source: string, revision: Revision): string {
  return source
    .replace(constantPattern('SPEC_SHA256'), `$1$2${revision.hash}$2$4`)
    .replace(constantPattern('SPEC_FETCHED_AT'), `$1$2${revision.fetchedAt}$2$4`)
}

async function writeProposal(body: Buffer, source: string | undefined): Promise<void> {
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'update-pin': { type: 'boolean', default: false },
      format: { type: 'string', default: 'text' },
      'previous-pin': { type: 'string' },
    },
  })
  if (values.format !== 'text' && values.format !== 'json')
    throw new Error('--format must be text or json')
  if (values['previous-pin'] && !values['update-pin'])
    throw new Error('--previous-pin requires --update-pin')
  const log = values.format === 'json' ? console.error : console.log
  const [current, source] = await Promise.all([readFile(specPath), readFile(pinPath, 'utf8')])
  const pin = pinnedRevision(source)
  const sourceUrl = constantValue(source, 'SPEC_SOURCE_URL')
  if (!pin || !sourceUrl) throw new Error('Invalid pin template in packages/brale/src/spec.ts')
  const previousHash = sha256(current)
  if (previousHash !== pin.hash) {
    const mismatch = `The vendored document (${previousHash}) already differs from the pin in spec.ts (${pin.hash}).`
    if (values['update-pin']) throw new Error(mismatch)
    console.warn(`Warning: ${mismatch}`)
  }
  const previous = values['previous-pin']
    ? await previousRevision(values['previous-pin'])
    : undefined
  log(`Fetching ${sourceUrl}`)
  const body = await fetchDocument(sourceUrl)
  const hash = sha256(body)
  const changed = hash !== previousHash
  const fetchedAt = !changed
    ? pin.fetchedAt
    : previous?.hash === hash
      ? previous.fetchedAt
      : new Date().toISOString().slice(0, 10)
  const result: RefreshResult = { changed, previousHash, hash, fetchedAt }
  if (changed) {
    await writeProposal(body, values['update-pin'] ? updatePin(source, result) : undefined)
    log(`The document changed.\n  was ${previousHash}\n  now ${hash}`)
    if (values['update-pin']) {
      log(`Updated SPEC_SHA256 and SPEC_FETCHED_AT (${fetchedAt}); review the diff before merging.`)
    } else {
      log('Next steps:')
      log('  1. git diff packages/brale/openapi/brale.json  — review what Brale changed')
      log(`  2. set SPEC_SHA256 in packages/brale/src/spec.ts to ${hash}`)
      log('  3. set SPEC_FETCHED_AT to today')
      log('  4. nub run test  — the spec tripwires will fail if the contract moved under the CLI')
    }
  } else {
    log(`No change. Still ${hash}.`)
  }
  if (values.format === 'json') console.log(JSON.stringify(result))
}

try {
  await main()
} catch (error) {
  console.error(`Spec refresh failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
