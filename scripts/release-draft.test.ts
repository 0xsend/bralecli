import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'

import { githubApi, inspectRelease, uploadDraft } from './release-draft.ts'

const version = '0.2.0'
const revision = 'a'.repeat(40)
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'brale-release-http-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const files = platforms.map((platform) => ({
    name: `bralecli-${platform}.tar.gz`,
    body: Buffer.from(platform),
  }))
  files.push({ name: 'build-info.json', body: Buffer.from(JSON.stringify({ revision, version })) })
  files.push({ name: 'SHA256SUMS', body: Buffer.from('fixture checksums') })
  await Promise.all(files.map((file) => writeFile(join(directory, file.name), file.body)))
  const assets: Record<string, unknown>[] = []
  let release: Record<string, unknown> | undefined
  const writes: { method: string; path: string; body: Buffer }[] = []
  let failUpload = false
  let tag: unknown
  let annotatedTag: unknown
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const url = new URL(request.url!, 'http://localhost')
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET') {
      if (url.pathname.includes('/git/ref/tags/')) {
        response.statusCode = tag === undefined ? 404 : 200
        response.end(JSON.stringify(tag ?? { message: 'Not Found' }))
        return
      }
      if (url.pathname.includes('/git/tags/')) {
        response.end(JSON.stringify(annotatedTag))
        return
      }
      response.end(
        JSON.stringify(url.pathname.endsWith('/releases') ? (release ? [release] : []) : release),
      )
      return
    }
    writes.push({ method: request.method!, path: url.pathname, body })
    if (url.pathname.endsWith('/releases')) {
      const data = JSON.parse(body.toString())
      release = {
        ...data,
        id: 123,
        html_url: 'https://github.com/0xsend/bralecli/releases/tag/v0.2.0',
        assets,
      }
      response.statusCode = 201
      response.end(JSON.stringify(release))
      return
    }
    if (failUpload) {
      response.statusCode = 503
      response.end('{}')
      return
    }
    const name = url.searchParams.get('name')!
    assets.push({
      id: assets.length + 1,
      name,
      state: 'uploaded',
      size: body.length,
      digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    })
    response.statusCode = 201
    response.end(JSON.stringify(assets.at(-1)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server')
  const endpoint = `http://127.0.0.1:${address.port}`
  return {
    api: githubApi('synthetic-test-token', { api: endpoint, uploads: endpoint }),
    directory,
    files,
    writes,
    assets,
    get release() {
      return release
    },
    set release(value) {
      release = value
    },
    set failUpload(value: boolean) {
      failUpload = value
    },
    set tag(value: unknown) {
      tag = value
    },
    set annotatedTag(value: unknown) {
      annotatedTag = value
    },
  }
}

it('creates only a draft, uploads the exact six files and preserves it on retry', async () => {
  const test = await fixture()
  expect(await inspectRelease(test.api, version)).toMatchObject({ prepare: true })
  await uploadDraft(test.api, {
    version,
    revision,
    directory: test.directory,
    notes: 'Reviewed release notes',
  })
  expect(test.release).toMatchObject({
    draft: true,
    tag_name: 'v0.2.0',
    target_commitish: revision,
  })
  expect(test.assets.map((asset) => asset.name).toSorted()).toEqual(
    test.files.map((file) => file.name).toSorted(),
  )
  expect(await inspectRelease(test.api, version)).toMatchObject({ prepare: false })
  const writes = test.writes.length
  await uploadDraft(test.api, {
    version,
    revision,
    directory: test.directory,
    notes: 'Reviewed release notes',
  })
  expect(test.writes).toHaveLength(writes)
  expect(test.writes.every((entry) => entry.method === 'POST')).toBe(true)
})

it('resumes an incomplete matching draft after a failed upload', async () => {
  const test = await fixture()
  test.failUpload = true
  await expect(
    uploadDraft(test.api, { version, revision, directory: test.directory, notes: 'Notes' }),
  ).rejects.toThrow('503')
  expect(test.release?.draft).toBe(true)
  expect(await inspectRelease(test.api, version)).toMatchObject({ prepare: true })
  test.failUpload = false
  await uploadDraft(test.api, { version, revision, directory: test.directory, notes: 'Notes' })
  expect(test.assets).toHaveLength(6)
  expect(test.writes.filter((entry) => entry.path.endsWith('/releases'))).toHaveLength(1)
})

it.each(['published', 'revision', 'digest', 'extra'])(
  'rejects a %s conflict before changing any asset',
  async (conflict) => {
    const test = await fixture()
    await uploadDraft(test.api, { version, revision, directory: test.directory, notes: 'Notes' })
    if (conflict === 'published') test.release!.draft = false
    if (conflict === 'revision') test.release!.target_commitish = 'b'.repeat(40)
    if (conflict === 'digest') test.assets[0]!.digest = `sha256:${'f'.repeat(64)}`
    if (conflict === 'extra')
      test.assets.push({
        name: 'unexpected.txt',
        digest: `sha256:${'f'.repeat(64)}`,
        state: 'uploaded',
        size: 1,
      })
    const before = test.writes.length
    await expect(
      uploadDraft(test.api, { version, revision, directory: test.directory, notes: 'Notes' }),
    ).rejects.toThrow()
    expect(test.writes).toHaveLength(before)
  },
)

it('rejects incomplete local artifacts before creating a draft', async () => {
  const test = await fixture()
  await rm(join(test.directory, 'SHA256SUMS'))
  await expect(
    uploadDraft(test.api, { version, revision, directory: test.directory, notes: 'Notes' }),
  ).rejects.toThrow()
  expect(test.writes).toHaveLength(0)
  expect(await readFile(join(test.directory, 'build-info.json'), 'utf8')).toContain(revision)
})

it.each(['commit', 'tag'])(
  'rejects an existing %s tag that identifies another source commit',
  async (type) => {
    const test = await fixture()
    test.tag = { object: { type, sha: 'b'.repeat(40) } }
    test.annotatedTag = { object: { type: 'commit', sha: 'c'.repeat(40) } }
    await expect(
      uploadDraft(test.api, { version, revision, directory: test.directory, notes: 'Notes' }),
    ).rejects.toThrow(/tag/i)
    expect(test.writes).toHaveLength(0)
  },
)

it.each(['commit', 'tag'])(
  'accepts an existing %s tag pointing at the exact source commit',
  async (type) => {
    const test = await fixture()
    test.tag = { object: { type, sha: type === 'commit' ? revision : 'b'.repeat(40) } }
    test.annotatedTag = { object: { type: 'commit', sha: revision } }
    await uploadDraft(test.api, { version, revision, directory: test.directory, notes: 'Notes' })
    expect(test.release?.draft).toBe(true)
    expect(test.assets).toHaveLength(6)
  },
)
