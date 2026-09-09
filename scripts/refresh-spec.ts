#!/usr/bin/env -S nub

/**
 * Refreshes exact upstream bytes for review. Pin updates are explicit so manual
 * refreshes retain their review step; automation can prepare a complete PR.
 */
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import {
  constantValue,
  maxDocumentBytes,
  pinPath,
  pinnedRevision,
  sha256,
  specPath,
  updatePin,
  validateDocument,
  writeProposal,
  type RefreshResult,
  type Revision,
} from './spec-proposal.ts'

const fetchTimeoutMs = 30_000

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
      if (size > maxDocumentBytes) throw new Error('Response exceeds the 10 MiB limit')
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
