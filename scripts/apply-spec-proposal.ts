#!/usr/bin/env -S node

/** Validates untrusted data, then reconstructs pins from the trusted checkout. */
import { constants } from 'node:fs'
import { lstat, open, opendir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  isDate,
  isHash,
  isObject,
  maxDocumentBytes,
  parseJson,
  pinPath,
  pinnedRevision,
  sha256,
  specPath,
  updatePin,
  validateDocument,
  writeProposal,
  type RefreshResult,
} from './spec-proposal.ts'

const maxMetadataBytes = 4096

async function validateDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error('Proposal directory cannot be a symlink')
  if (!stat.isDirectory()) throw new Error('Proposal path must be a directory')
  const expected = new Set(['brale.json', 'revision.json'])
  // Stop at the first unexpected entry, bounding inspection to three entries.
  for await (const entry of await opendir(path, { bufferSize: 3 })) {
    if (!expected.delete(entry.name))
      throw new Error('Proposal must contain exactly brale.json and revision.json')
    if (!entry.isFile()) throw new Error('Proposal entries must be regular files, never symlinks')
  }
  if (expected.size) throw new Error('Proposal must contain exactly brale.json and revision.json')
}

async function readProposalFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Proposal entries must be regular files')
    if (stat.size > limit)
      throw new Error(`Proposal file exceeds its ${limit} byte size limit: ${path}`)
    // Bound the stream too, since the file can grow after stat().
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length
      if (size > limit)
        throw new Error(`Proposal file exceeds its ${limit} byte size limit: ${path}`)
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  } finally {
    await file.close()
  }
}

function parseRevision(body: Buffer): RefreshResult {
  const value = parseJson(body, 'Revision metadata')
  const fields = ['changed', 'previousHash', 'hash', 'fetchedAt']
  if (
    !isObject(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !(key in value))
  ) {
    throw new Error(
      'Revision metadata must contain exactly changed, previousHash, hash, and fetchedAt',
    )
  }
  if (value.changed !== true) throw new Error('Revision changed must be true')
  if (!isHash(value.previousHash) || !isHash(value.hash))
    throw new Error('Revision hash fields must be lowercase SHA-256 values')
  if (!isDate(value.fetchedAt))
    throw new Error('Revision fetchedAt must be a valid YYYY-MM-DD date')
  return {
    changed: true,
    previousHash: value.previousHash,
    hash: value.hash,
    fetchedAt: value.fetchedAt,
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'proposal-dir': { type: 'string' } } })
  const directory = values['proposal-dir']
  if (!directory) throw new Error('--proposal-dir is required')
  await validateDirectory(directory)
  const [body, metadata, current, source] = await Promise.all([
    readProposalFile(join(directory, 'brale.json'), maxDocumentBytes),
    readProposalFile(join(directory, 'revision.json'), maxMetadataBytes),
    readFile(specPath),
    readFile(pinPath, 'utf8'),
  ])
  validateDocument(body)
  const revision = parseRevision(metadata)
  const pin = pinnedRevision(source)
  if (!pin) throw new Error('Invalid trusted pin template in packages/brale/src/spec.ts')
  const currentHash = sha256(current)
  if (pin.hash !== currentHash)
    throw new Error('The base pin does not match the checked-out vendored document')
  if (revision.previousHash !== currentHash)
    throw new Error('Revision previousHash does not match the checked-out base')
  if (revision.hash !== sha256(body))
    throw new Error('Proposal document does not match its declared hash')
  if (revision.hash === currentHash) throw new Error('Proposal document is unchanged')
  await writeProposal(body, updatePin(source, revision))
  console.log(JSON.stringify(revision))
}

try {
  await main()
} catch (error) {
  console.error(`Spec proposal rejected: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
