import { hash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, opendir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const
type Platform = (typeof platforms)[number]
type Build = { revision: string; version: string; bun: '1.3.3' }
type Artifact = { platform: Platform; archive: string; sha256: string }
type Release = Build & { artifacts: Artifact[] }
const binaryLimit = 256 * 1024 * 1024
const archiveLimit = 128 * 1024 * 1024
const metadataLimit = 4096
const revisionPattern = /^[a-f0-9]{40}$/
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function platformValue(value: string): Platform {
  if (!platforms.includes(value as Platform)) throw new Error(`Unsupported platform: ${value}`)
  return value as Platform
}

function objectWithKeys(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid build metadata object')
  }
  if (Object.keys(value).toSorted().join(',') !== keys.toSorted().join(',')) {
    throw new Error('Invalid build metadata fields')
  }
  return value as Record<string, unknown>
}

function buildValue(value: Record<string, unknown>): Build {
  if (typeof value.revision !== 'string' || !revisionPattern.test(value.revision)) {
    throw new Error('Invalid build metadata revision')
  }
  if (typeof value.version !== 'string' || !versionPattern.test(value.version)) {
    throw new Error('Invalid build metadata version')
  }
  if (value.bun !== '1.3.3') throw new Error('Invalid build metadata Bun version')
  return { revision: value.revision, version: value.version, bun: value.bun }
}

async function regularDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${path}`)
  }
}

async function boundedFile(path: string, limit: number, executable = false): Promise<Buffer> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const current = await file.stat()
    if (!current.isFile()) throw new Error(`Expected a regular file: ${path}`)
    if (current.size < 1 || current.size > limit)
      throw new Error(`File exceeds size limit: ${path}`)
    if (executable && !(current.mode & 0o111)) throw new Error(`Expected an executable: ${path}`)
    const bytes = Buffer.alloc(current.size + 1)
    let position = 0
    while (position < bytes.length) {
      // Each read determines the offset for the next bounded read.
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await file.read(bytes, position, bytes.length - position, position)
      if (!bytesRead) break
      position += bytesRead
    }
    if (position !== current.size) throw new Error(`File changed while reading: ${path}`)
    return bytes.subarray(0, position)
  } finally {
    await file.close()
  }
}

async function metadata(path: string): Promise<unknown> {
  const bytes = await boundedFile(path, metadataLimit)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw new Error(`Invalid metadata JSON: ${path}`, { cause })
  }
}

function archiveName(platform: Platform): string {
  return `bralecli-${platform}.tar.gz`
}

// One canonical ustar entry avoids executing tar or interpreting arbitrary archive
// extensions in the writer job. uid, gid and mtime are fixed for repeatable bytes.
function tarHeader(size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write('bralecli', 0)
  header.write('0000755\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write('0000000\0', 329)
  header.write('0000000\0', 337)
  const checksum = header.reduce((sum, value) => sum + value, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  return header
}

function packageArchive(binary: Buffer): Buffer {
  const padding = Buffer.alloc(((512 - (binary.length % 512)) % 512) + 1024)
  const archive = gzipSync(Buffer.concat([tarHeader(binary.length), binary, padding]))
  if (archive.length > archiveLimit) throw new Error('Packaged archive exceeds size limit')
  return archive
}

function validateArchive(archive: Buffer): void {
  let tar: Buffer
  try {
    tar = gunzipSync(archive, { maxOutputLength: binaryLimit + 2048 })
  } catch (cause) {
    throw new Error('Invalid or oversized release archive', { cause })
  }
  const sizeText = tar.toString('ascii', 124, 136)
  if (!/^[0-7]{11}\0$/.test(sizeText)) throw new Error('Invalid archive entry size')
  const size = Number.parseInt(sizeText, 8)
  if (size < 1 || size > binaryLimit) throw new Error('Invalid archive binary size')
  const expectedLength = 512 + Math.ceil(size / 512) * 512 + 1024
  if (tar.length !== expectedLength || !tar.subarray(0, 512).equals(tarHeader(size))) {
    throw new Error('Invalid archive: expected only the canonical executable bralecli entry')
  }
  if (tar.subarray(512 + size).some((byte) => byte !== 0)) {
    throw new Error('Invalid archive: extra entries or trailing data')
  }
}

async function newDirectory<T>(
  output: string,
  populate: (stage: string) => Promise<T>,
): Promise<T> {
  const target = resolve(output)
  try {
    await lstat(target)
    throw new Error(`Output directory already exists: ${target}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const stage = await mkdtemp(join(dirname(target), `.${basename(target)}-`))
  try {
    const result = await populate(stage)
    await rename(stage, target)
    return result
  } finally {
    await rm(stage, { force: true, recursive: true })
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

export async function packageArtifacts(
  binaryDirectory: string,
  target: string,
  output: string,
): Promise<Build & Artifact> {
  const platform = platformValue(target)
  await regularDirectory(binaryDirectory)
  const build = buildValue(
    objectWithKeys(await metadata(join(binaryDirectory, 'build-info.json')), [
      'revision',
      'version',
      'bun',
    ]),
  )
  const binary = await boundedFile(join(binaryDirectory, `bralecli-${platform}`), binaryLimit, true)
  const archive = packageArchive(binary)
  const artifact = {
    ...build,
    platform,
    archive: archiveName(platform),
    sha256: hash('sha256', archive),
  }
  return newDirectory(output, async (stage) => {
    await writeFile(join(stage, artifact.archive), archive, { flag: 'wx', mode: 0o644 })
    await writeFile(join(stage, `build-info-${platform}.json`), json(artifact), {
      flag: 'wx',
      mode: 0o644,
    })
    return artifact
  })
}

/** Validates data-only job artifacts and atomically creates the six release assets. */
export async function verifyArtifacts(
  input: string,
  revision: string,
  version: string,
  output: string,
): Promise<Release> {
  const expected = buildValue({ revision, version, bun: '1.3.3' })
  await regularDirectory(input)
  const filenames = new Set(
    platforms.flatMap((platform) => [archiveName(platform), `build-info-${platform}.json`]),
  )
  let count = 0
  for await (const entry of await opendir(input, { bufferSize: 9 })) {
    if (!filenames.has(entry.name) || ++count > filenames.size) {
      throw new Error(
        'Artifact directory must contain exactly four archives and four metadata files',
      )
    }
  }
  if (count !== filenames.size) {
    throw new Error('Artifact directory must contain exactly four archives and four metadata files')
  }
  return newDirectory(output, async (stage) => {
    const artifacts: Artifact[] = []
    // Process one archive at a time to bound memory independently of the target count.
    /* eslint-disable no-await-in-loop */
    for (const platform of platforms) {
      const value = objectWithKeys(await metadata(join(input, `build-info-${platform}.json`)), [
        'revision',
        'version',
        'bun',
        'platform',
        'archive',
        'sha256',
      ])
      const build = buildValue(value)
      if (
        build.revision !== revision ||
        build.version !== version ||
        value.platform !== platform ||
        value.archive !== archiveName(platform)
      ) {
        throw new Error(`Build metadata identity does not match the requested release: ${platform}`)
      }
      const archive = await boundedFile(join(input, archiveName(platform)), archiveLimit)
      const sha256 = hash('sha256', archive)
      if (value.sha256 !== sha256)
        throw new Error(`Archive checksum does not match metadata: ${platform}`)
      validateArchive(archive)
      await writeFile(join(stage, archiveName(platform)), archive, { flag: 'wx', mode: 0o644 })
      artifacts.push({ platform, archive: archiveName(platform), sha256 })
    }
    /* eslint-enable no-await-in-loop */
    const release = { ...expected, artifacts }
    const manifest = json(release)
    const sums =
      artifacts.map(({ sha256, archive }) => `${sha256}  ${archive}\n`).join('') +
      `${hash('sha256', manifest)}  build-info.json\n`
    await writeFile(join(stage, 'build-info.json'), manifest, { flag: 'wx', mode: 0o644 })
    await writeFile(join(stage, 'SHA256SUMS'), sums, { flag: 'wx', mode: 0o644 })
    return release
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2)
  const [first, second, third, fourth] = args
  const usage =
    'Usage: release-artifacts.ts package <binary-dir> <platform> <output-dir> | verify <input-dir> <revision> <version> <output-dir>'
  try {
    if (first === undefined || second === undefined || third === undefined) throw new Error(usage)
    if (command === 'package' && args.length === 3) {
      console.log(
        json({
          status: 'packaged',
          ...(await packageArtifacts(first, second, third)),
        }).trimEnd(),
      )
    } else if (command === 'verify' && args.length === 4 && fourth !== undefined) {
      console.log(
        json({
          status: 'verified',
          ...(await verifyArtifacts(first, second, third, fourth)),
        }).trimEnd(),
      )
    } else {
      throw new Error(usage)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
