#!/usr/bin/env -S nub

/**
 * Re-downloads the Brale OpenAPI document and reports whether it changed.
 *
 * Brale serves the document from an unversioned endpoint, so this is the only
 * notice we get that the contract moved. Running it produces either "no
 * change" or a diff to review — and the checksum in `spec.ts` must be updated
 * by hand, deliberately, as part of accepting that diff. Automating the pin
 * update would defeat the point of having one.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { SPEC_SHA256, SPEC_SOURCE_URL } from '../packages/brale/src/spec.ts'

const specPath = fileURLToPath(new URL('../packages/brale/openapi/brale.json', import.meta.url))

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

async function main(): Promise<void> {
  console.log(`Fetching ${SPEC_SOURCE_URL}`)

  const response = await fetch(SPEC_SOURCE_URL)
  if (!response.ok) {
    console.error(`Fetch failed with ${response.status} ${response.statusText}`)
    process.exit(1)
  }

  // The served BYTES, not `text()`: a re-decode strips BOMs and replaces
  // invalid sequences, which would pin a checksum matching nothing Brale ever
  // served — unverifiable against a plain `curl | sha256sum`.
  const body = Buffer.from(await response.arrayBuffer())

  // Parsed before it is written: a truncated or HTML error body must not land
  // in the tree looking like a legitimate contract change. A BOM fails here
  // too, deliberately — fail closed rather than silently re-encode.
  try {
    JSON.parse(body.toString('utf8'))
  } catch (error) {
    console.error(`Response is not valid JSON: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }

  const current = await readFile(specPath)
  const currentHash = sha256(current)
  const nextHash = sha256(body)

  if (currentHash !== SPEC_SHA256) {
    console.warn(
      `Warning: the vendored document (${currentHash}) already differs from the pin in spec.ts (${SPEC_SHA256}).`,
    )
  }

  if (nextHash === currentHash) {
    console.log(`No change. Still ${nextHash}.`)
    return
  }

  await writeFile(specPath, body)

  console.log('')
  console.log('The document changed.')
  console.log(`  was ${currentHash}`)
  console.log(`  now ${nextHash}`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. git diff packages/brale/openapi/brale.json  — review what Brale changed')
  console.log(`  2. set SPEC_SHA256 in packages/brale/src/spec.ts to ${nextHash}`)
  console.log('  3. set SPEC_FETCHED_AT to today')
  console.log(
    '  4. nub run test  — the spec tripwires will fail if the contract moved under the CLI',
  )
}

await main()
