import { execFile } from 'node:child_process'
import { hash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const baseDocument = await readFile(
  new URL('../packages/brale/openapi/brale.json', import.meta.url),
)
const baseSource = await readFile(new URL('../packages/brale/src/spec.ts', import.meta.url), 'utf8')
const proposedDocument = Buffer.concat([baseDocument, Buffer.from('\n')])
const proposal = {
  changed: true,
  previousHash: hash('sha256', baseDocument),
  hash: hash('sha256', proposedDocument),
  fetchedAt: '2026-09-02',
}
const proposedSource = baseSource
  .replace(proposal.previousHash, proposal.hash)
  .replace(/(SPEC_FETCHED_AT: string = ')[^']+/, '$12026-09-02')

let root: string
let proposalDirectory: string
let documentPath: string
let sourcePath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brale-spec-apply-'))
  proposalDirectory = join(root, 'proposal')
  documentPath = join(root, 'packages/brale/openapi/brale.json')
  sourcePath = join(root, 'packages/brale/src/spec.ts')
  await Promise.all(
    ['scripts', 'packages/brale/openapi', 'packages/brale/src', 'proposal'].map((path) =>
      mkdir(join(root, path), { recursive: true }),
    ),
  )
  await Promise.all([
    ...['apply-spec-proposal.ts', 'spec-proposal.ts'].map((name) =>
      copyFile(new URL(`./${name}`, import.meta.url), join(root, 'scripts', name)),
    ),
    writeFile(join(root, 'package.json'), '{"type":"module"}'),
    writeFile(documentPath, baseDocument),
    writeFile(sourcePath, baseSource),
    writeFile(join(proposalDirectory, 'brale.json'), proposedDocument),
    writeFile(join(proposalDirectory, 'revision.json'), JSON.stringify(proposal)),
  ])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function apply(directory = proposalDirectory): Promise<{ stdout: string; stderr: string }> {
  return execute(
    process.execPath,
    [join(root, 'scripts/apply-spec-proposal.ts'), '--proposal-dir', directory],
    { cwd: root, env: {}, timeout: 5_000 },
  )
}

async function rejectsUnchanged(message: string): Promise<void> {
  const before = await Promise.all([readFile(documentPath), readFile(sourcePath)])
  await expect(apply()).rejects.toMatchObject({
    stdout: '',
    stderr: expect.stringContaining(message),
  })
  expect(await Promise.all([readFile(documentPath), readFile(sourcePath)])).toEqual(before)
}

describe('trusted application of data-only spec proposals', () => {
  it('writes exact document bytes and reconstructs only the two trusted pin values without executing source', async () => {
    const sentinel = '\nthrow new Error("Pin source must never execute")\n'
    await writeFile(sourcePath, baseSource + sentinel)
    const result = await apply()
    expect(JSON.parse(result.stdout)).toEqual(proposal)
    expect(await readFile(documentPath)).toEqual(proposedDocument)
    expect(await readFile(sourcePath, 'utf8')).toBe(proposedSource + sentinel)
    await rejectsUnchanged('previousHash')
  })

  for (const entry of ['spec.ts', '.hidden', 'nested/file']) {
    it(`rejects an unexpected artifact entry ${entry} before writing`, async () => {
      if (entry.includes('/')) await mkdir(join(proposalDirectory, 'nested'))
      await writeFile(join(proposalDirectory, entry), 'throw new Error("untrusted code")')
      await rejectsUnchanged('exactly brale.json and revision.json')
    })
  }

  for (const name of ['brale.json', 'revision.json']) {
    it(`rejects missing ${name} before writing`, async () => {
      await rm(join(proposalDirectory, name))
      await rejectsUnchanged('exactly brale.json and revision.json')
    })

    it(`rejects a symlink for ${name} before writing`, async () => {
      const target = join(root, `outside-${name}`)
      await copyFile(join(proposalDirectory, name), target)
      await rm(join(proposalDirectory, name))
      await symlink(target, join(proposalDirectory, name))
      await rejectsUnchanged('regular files')
    })

    it(`rejects a directory in place of ${name} before writing`, async () => {
      await rm(join(proposalDirectory, name))
      await mkdir(join(proposalDirectory, name))
      await rejectsUnchanged('regular files')
    })
  }

  it('rejects a symlink proposal directory before writing', async () => {
    const link = join(root, 'proposal-link')
    await symlink(proposalDirectory, link)
    proposalDirectory = link
    await rejectsUnchanged('directory cannot be a symlink')
  })

  const malformedMetadata = [
    { name: 'invalid JSON', body: '{', error: 'JSON' },
    { name: 'array', body: '[]', error: 'metadata' },
    {
      name: 'unknown field',
      body: JSON.stringify({ ...proposal, source: 'untrusted code' }),
      error: 'metadata',
    },
    {
      name: 'missing field',
      body: JSON.stringify({ ...proposal, hash: undefined }),
      error: 'metadata',
    },
    {
      name: 'changed false',
      body: JSON.stringify({ ...proposal, changed: false }),
      error: 'changed must be true',
    },
    {
      name: 'string changed',
      body: JSON.stringify({ ...proposal, changed: 'true' }),
      error: 'changed must be true',
    },
    {
      name: 'invalid hash',
      body: JSON.stringify({ ...proposal, hash: 'not-a-hash' }),
      error: 'hash',
    },
    {
      name: 'invalid previous hash',
      body: JSON.stringify({ ...proposal, previousHash: 'bad-base' }),
      error: 'hash',
    },
    {
      name: 'invalid calendar date',
      body: JSON.stringify({ ...proposal, fetchedAt: '2026-02-31' }),
      error: 'date',
    },
    {
      name: 'non-string date',
      body: JSON.stringify({ ...proposal, fetchedAt: 20260902 }),
      error: 'date',
    },
    { name: 'oversized metadata', body: ' '.repeat(4097), error: 'size limit' },
  ]
  for (const { name, body, error } of malformedMetadata) {
    it(`rejects metadata with ${name} before writing`, async () => {
      await writeFile(join(proposalDirectory, 'revision.json'), body)
      await rejectsUnchanged(error)
    })
  }

  const invalidDocuments = [
    { name: 'non-JSON response', body: Buffer.from('<html>error</html>'), error: 'JSON' },
    { name: 'missing OpenAPI structure', body: Buffer.from('{}'), error: 'OpenAPI' },
    {
      name: 'UTF-8 BOM',
      body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), baseDocument]),
      error: 'JSON',
    },
    {
      name: 'over the size bound',
      body: Buffer.alloc(10 * 1024 * 1024 + 1, ' '),
      error: 'size limit',
    },
  ]
  for (const { name, body, error } of invalidDocuments) {
    it(`rejects an artifact document ${name} before writing`, async () => {
      await writeFile(join(proposalDirectory, 'brale.json'), body)
      await rejectsUnchanged(error)
    })
  }

  it('rejects a proposal for a different base revision before writing', async () => {
    await writeFile(
      join(proposalDirectory, 'revision.json'),
      JSON.stringify({
        ...proposal,
        previousHash: '0'.repeat(64),
      }),
    )
    await rejectsUnchanged('previousHash')
  })

  it('rejects a proposal whose document does not match its declared hash', async () => {
    await writeFile(
      join(proposalDirectory, 'revision.json'),
      JSON.stringify({
        ...proposal,
        hash: '0'.repeat(64),
      }),
    )
    await rejectsUnchanged('does not match')
  })

  it('rejects a proposal that declares a change but has unchanged bytes', async () => {
    await writeFile(join(proposalDirectory, 'brale.json'), baseDocument)
    await writeFile(
      join(proposalDirectory, 'revision.json'),
      JSON.stringify({
        ...proposal,
        hash: proposal.previousHash,
      }),
    )
    await rejectsUnchanged('unchanged')
  })

  it('rejects a checkout whose pin disagrees with its vendored document', async () => {
    await writeFile(sourcePath, baseSource.replace(proposal.previousHash, '0'.repeat(64)))
    await rejectsUnchanged('base pin')
  })

  it('rejects a malformed trusted pin template before writing', async () => {
    await writeFile(sourcePath, baseSource.replace('export const SPEC_SHA256:', 'const REMOVED:'))
    await rejectsUnchanged('pin template')
  })
})
