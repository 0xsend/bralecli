/** Trusted, builtin-only GitHub adapter. Public publication is deliberately absent. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const repository = '0xsend/bralecli'
const releasePath = `/repos/${repository}/releases`
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const fileNames = [
  ...platforms.map((platform) => `bralecli-${platform}.tar.gz`),
  'build-info.json',
  'SHA256SUMS',
]
type Api = (
  method: 'GET' | 'POST',
  path: string,
  body?: Buffer | Record<string, unknown>,
  upload?: boolean,
) => Promise<unknown>
type Asset = { name: string; size: number; digest: string; state: string }
type Release = {
  id: number
  tag_name: string
  draft: boolean
  target_commitish: string
  html_url: string
  assets: Asset[]
}
type Upload = { name: string; body: Buffer; digest: string }

// Requests are ordered for pagination and retry reconciliation; file and stream
// reads are serial to keep the documented memory bounds independent of fan-out.
/* oxlint-disable no-await-in-loop */

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function githubApi(
  token: string,
  endpoints: { api: string; uploads: string } = {
    api: 'https://api.github.com',
    uploads: 'https://uploads.github.com',
  },
): Api {
  if (!token || /\s/.test(token)) throw new Error('A GitHub token must be provided on stdin')
  return async (method, path, body, upload = false) => {
    const response = await fetch(`${upload ? endpoints.uploads : endpoints.api}${path}`, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': upload ? 'application/octet-stream' : 'application/json',
      },
      ...(body === undefined
        ? {}
        : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }),
      signal: AbortSignal.timeout(upload ? 120_000 : 30_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (method === 'GET' && response.status === 404) return undefined
      throw new Error(`GitHub ${method} ${path} failed: HTTP ${response.status}`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing GitHub response body')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 2 * 1024 * 1024) throw new Error('GitHub response exceeds 2 MiB')
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel()
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
}

function parseRelease(value: unknown): Release {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) <= 0 ||
    typeof value.tag_name !== 'string' ||
    typeof value.draft !== 'boolean' ||
    typeof value.target_commitish !== 'string' ||
    typeof value.html_url !== 'string' ||
    !Array.isArray(value.assets) ||
    value.assets.length > 100
  )
    throw new Error('Invalid GitHub release metadata')
  for (const asset of value.assets) {
    if (
      !object(asset) ||
      typeof asset.name !== 'string' ||
      typeof asset.state !== 'string' ||
      typeof asset.size !== 'number' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      (asset.digest !== null && typeof asset.digest !== 'string')
    )
      throw new Error('Invalid GitHub asset metadata')
  }
  return value as unknown as Release
}

async function findRelease(api: Api, version: string): Promise<Release | undefined> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable release version')
  // Tag lookup omits drafts. List authenticated releases, with a fail-closed cap.
  for (let page = 1; page <= 20; page++) {
    const result = await api('GET', `${releasePath}?per_page=100&page=${page}`)
    if (!Array.isArray(result)) throw new Error('Expected GitHub release list')
    const matching = result.filter((value) => object(value) && value.tag_name === `v${version}`)
    if (matching.length > 1) throw new Error('Multiple releases share the requested version')
    if (matching.length) return parseRelease(matching[0])
    if (result.length < 100) return undefined
  }
  throw new Error('Release search exceeds 2,000 releases')
}

async function verifyTag(api: Api, version: string, revision: string): Promise<void> {
  let tag = await api('GET', `/repos/${repository}/git/ref/tags/v${version}`)
  // GitHub creates an absent tag only when a draft is published. Existing tags
  // override target_commitish, so resolve them independently of release metadata.
  if (tag === undefined) return
  for (let depth = 0; depth < 8; depth++) {
    if (
      !object(tag) ||
      !object(tag.object) ||
      typeof tag.object.sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(tag.object.sha)
    )
      throw new Error('Invalid release tag metadata')
    if (tag.object.type === 'commit') {
      if (tag.object.sha !== revision)
        throw new Error('Release tag points to a different source commit')
      return
    }
    if (tag.object.type !== 'tag') throw new Error('Release tag does not identify a commit')
    tag = await api('GET', `/repos/${repository}/git/tags/${tag.object.sha}`)
  }
  throw new Error('Release tag exceeds eight levels of indirection')
}

export async function inspectRelease(
  api: Api,
  version: string,
): Promise<{ prepare: boolean; url?: string }> {
  const release = await findRelease(api, version)
  if (!release) return { prepare: true }
  const complete =
    release.assets.length === fileNames.length &&
    fileNames.every((name) =>
      release.assets.some(
        (asset) =>
          asset.name === name &&
          asset.state === 'uploaded' &&
          /^sha256:[a-f0-9]{64}$/.test(asset.digest),
      ),
    )
  return { prepare: release.draft && !complete, url: release.html_url }
}

async function localUploads(directory: string): Promise<Upload[]> {
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error('Release directory cannot be a symlink')
  const entries = await readdir(directory)
  if (entries.length !== fileNames.length || entries.some((name) => !fileNames.includes(name)))
    throw new Error('Release output must contain exactly the six expected assets')
  const uploads: Upload[] = []
  for (const name of fileNames) {
    const path = join(directory, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
      throw new Error(`Invalid release output: ${name}`)
    const body = await readFile(path)
    if (body.length !== stat.size) throw new Error(`Release output changed while reading: ${name}`)
    uploads.push({
      name,
      body,
      digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    })
  }
  return uploads
}

function reconcile(release: Release, uploads: Upload[]): Upload[] {
  const remaining = new Map(uploads.map((upload) => [upload.name, upload]))
  for (const asset of release.assets) {
    const upload = remaining.get(asset.name)
    if (
      !upload ||
      asset.state !== 'uploaded' ||
      asset.digest !== upload.digest ||
      asset.size !== upload.body.length
    )
      throw new Error(`Existing release asset conflicts: ${asset.name}`)
    remaining.delete(asset.name)
  }
  return [...remaining.values()]
}

export async function uploadDraft(
  api: Api,
  input: {
    version: string
    revision: string
    directory: string
    notes: string
  },
): Promise<{ url: string; draft: true; assets: number }> {
  if (!/^[a-f0-9]{40}$/.test(input.revision)) throw new Error('Expected an exact source commit')
  const uploads = await localUploads(input.directory)
  let release = await findRelease(api, input.version)
  if (release && (!release.draft || release.target_commitish !== input.revision))
    throw new Error('Existing release is published or belongs to a different source revision')
  await verifyTag(api, input.version, input.revision)
  if (!release) {
    release = parseRelease(
      await api('POST', releasePath, {
        tag_name: `v${input.version}`,
        target_commitish: input.revision,
        name: `bralecli v${input.version}`,
        body: input.notes,
        draft: true,
        prerelease: false,
      }),
    )
  }
  for (const upload of reconcile(release, uploads)) {
    await api(
      'POST',
      `${releasePath}/${release.id}/assets?name=${encodeURIComponent(upload.name)}`,
      upload.body,
      true,
    )
  }
  const verified = parseRelease(await api('GET', `${releasePath}/${release.id}`))
  await verifyTag(api, input.version, input.revision)
  if (
    !verified.draft ||
    verified.target_commitish !== input.revision ||
    reconcile(verified, uploads).length
  )
    throw new Error('Draft verification failed after uploading')
  return { url: verified.html_url, draft: true, assets: verified.assets.length }
}

async function main(): Promise<void> {
  const [command, inputDirectory, outputDirectory, ...extra] = process.argv.slice(2)
  if (
    extra.length ||
    !['inspect', 'upload'].includes(command ?? '') ||
    (command === 'inspect' && inputDirectory !== undefined) ||
    (command === 'upload' && (!inputDirectory || !outputDirectory))
  )
    throw new Error(
      'Usage: release-draft.ts inspect | upload <artifacts-dir> <new-verified-dir> (GitHub token on stdin)',
    )
  const tokenChunks: Buffer[] = []
  let tokenSize = 0
  for await (const chunk of process.stdin) {
    tokenSize += chunk.length
    if (tokenSize > 4096) throw new Error('Token input exceeds limit')
    tokenChunks.push(chunk)
  }
  const api = githubApi(Buffer.concat(tokenChunks).toString('utf8').trim())
  const manifest = JSON.parse(await readFile('apps/cli/package.json', 'utf8')) as {
    version: string
  }
  const version = manifest.version
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim()
  if (command === 'inspect') {
    console.log(JSON.stringify({ version, revision, ...(await inspectRelease(api, version)) }))
    return
  }
  const { verifyArtifacts } = await import('./release-artifacts.ts')
  await verifyArtifacts(inputDirectory!, revision, version, outputDirectory!)
  const changelog = await readFile('apps/cli/CHANGELOG.md', 'utf8')
  const section = changelog.split(`\n## ${version}\n`)
  if (section.length !== 2) throw new Error(`Missing unique changelog entry for ${version}`)
  const notes =
    section[1]!.split('\n## ')[0]!.trim() +
    '\n\nDownload the archive matching your operating system and processor. Verify it against SHA256SUMS before installation. build-info.json records the source revision and archive digests.\n'
  console.log(
    JSON.stringify(
      await uploadDraft(api, { version, revision, directory: outputDirectory!, notes }),
    ),
  )
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Release preparation failed')
    process.exitCode = 1
  })
}
