import { execFile } from 'node:child_process'
import { hash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync, gzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./release-artifacts.ts', import.meta.url))
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const revision = '0123456789abcdef0123456789abcdef01234567'
const version = '0.2.0'
const build = { revision, version, bun: '1.3.3' }
let root: string
let binaries: string
let downloaded: string
let output: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brale-release-artifacts-'))
  binaries = join(root, 'binaries')
  downloaded = join(root, 'downloaded')
  output = join(root, 'release')
  await mkdir(binaries)
  await mkdir(downloaded)
  await writeFile(join(binaries, 'build-info.json'), JSON.stringify(build))
  await Promise.all(
    platforms.map((platform) =>
      writeFile(join(binaries, `bralecli-${platform}`), `fixture ${platform}\n`, {
        mode: 0o755,
      }),
    ),
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function run(...args: string[]) {
  return execute(process.execPath, [script, ...args], {
    cwd: root,
    env: {},
    timeout: 15_000,
  })
}

async function assemble() {
  await Promise.all(
    platforms.map(async (platform) => {
      const packaged = join(root, platform)
      await run('package', binaries, platform, packaged)
      await Promise.all(
        (await readdir(packaged)).map((name) =>
          copyFile(join(packaged, name), join(downloaded, name)),
        ),
      )
    }),
  )
}

async function rejectVerification(message: string) {
  await expect(run('verify', downloaded, revision, version, output)).rejects.toMatchObject({
    stderr: expect.stringContaining(message),
  })
  await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('release archive boundary', () => {
  it('packages deterministic portable executable archives and verifies all four identities without executing binaries', async () => {
    await assemble()
    const again = join(root, 'again')
    await run('package', binaries, 'darwin-arm64', again)
    const archiveName = 'bralecli-darwin-arm64.tar.gz'
    expect(await readFile(join(again, archiveName))).toEqual(
      await readFile(join(downloaded, archiveName)),
    )
    const unpacked = join(root, 'unpacked')
    await mkdir(unpacked)
    await execute('/usr/bin/tar', ['-xzf', join(downloaded, archiveName), '-C', unpacked], {
      timeout: 5_000,
    })
    expect(await readdir(unpacked)).toEqual(['bralecli'])
    expect(await readFile(join(unpacked, 'bralecli'), 'utf8')).toBe('fixture darwin-arm64\n')
    expect((await stat(join(unpacked, 'bralecli'))).mode & 0o777).toBe(0o755)
    await run('verify', downloaded, revision, version, output)
    expect((await readdir(output)).toSorted()).toEqual([
      'SHA256SUMS',
      'bralecli-darwin-arm64.tar.gz',
      'bralecli-darwin-x64.tar.gz',
      'bralecli-linux-arm64.tar.gz',
      'bralecli-linux-x64.tar.gz',
      'build-info.json',
    ])
    const aggregate = JSON.parse(await readFile(join(output, 'build-info.json'), 'utf8'))
    expect(aggregate).toMatchObject(build)
    expect(aggregate.artifacts.map((artifact: { platform: string }) => artifact.platform)).toEqual(
      platforms,
    )
    const sums = await readFile(join(output, 'SHA256SUMS'), 'utf8')
    await Promise.all(
      ['build-info.json', ...platforms.map((platform) => `bralecli-${platform}.tar.gz`)].map(
        async (name) => {
          expect(sums).toContain(`${hash('sha256', await readFile(join(output, name)))}  ${name}\n`)
        },
      ),
    )
  })

  it('rejects unknown platform before publishing package output', async () => {
    await expect(run('package', binaries, '../../other', output)).rejects.toMatchObject({
      stderr: expect.stringContaining('platform'),
    })
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never overwrites an existing output directory', async () => {
    await mkdir(output)
    await writeFile(join(output, 'sentinel'), 'preserve')
    await expect(run('package', binaries, 'darwin-arm64', output)).rejects.toMatchObject({
      stderr: expect.stringContaining('already exists'),
    })
    expect(await readFile(join(output, 'sentinel'), 'utf8')).toBe('preserve')
  })

  it('requires executable regular bounded input binaries', async () => {
    const binary = join(binaries, 'bralecli-darwin-arm64')
    await chmod(binary, 0o644)
    await expect(run('package', binaries, 'darwin-arm64', output)).rejects.toMatchObject({
      stderr: expect.stringContaining('executable'),
    })
    await chmod(binary, 0o755)
    await truncate(binary, 256 * 1024 * 1024 + 1)
    await expect(run('package', binaries, 'darwin-arm64', output)).rejects.toMatchObject({
      stderr: expect.stringContaining('size limit'),
    })
  })

  for (const mutation of ['missing', 'extra', 'symlink', 'directory', 'oversized'] as const) {
    it(`rejects ${mutation} downloaded archive entries without publishing partial output`, async () => {
      await assemble()
      const name = join(downloaded, 'bralecli-linux-x64.tar.gz')
      if (mutation === 'missing') await rm(name)
      if (mutation === 'extra') await writeFile(join(downloaded, 'extra.sh'), 'malicious')
      if (mutation === 'symlink') {
        await rm(name)
        await symlink(join(binaries, 'bralecli-linux-x64'), name)
      }
      if (mutation === 'directory') {
        await rm(name)
        await mkdir(name)
      }
      if (mutation === 'oversized') await truncate(name, 128 * 1024 * 1024 + 1)
      await rejectVerification(
        mutation === 'missing' || mutation === 'extra'
          ? 'exactly'
          : mutation === 'oversized'
            ? 'size limit'
            : 'regular file',
      )
    })
  }

  for (const [field, value] of [
    ['revision', '0'.repeat(40)],
    ['version', '0.3.0'],
    ['bun', '1.3.4'],
    ['platform', 'linux-x64'],
    ['archive', '../malicious'],
    ['sha256', '0'.repeat(64)],
    ['unexpected', true],
  ]) {
    it(`rejects mismatched or invalid metadata ${field}`, async () => {
      await assemble()
      const name = join(downloaded, 'build-info-darwin-arm64.json')
      const metadata = JSON.parse(await readFile(name, 'utf8'))
      await writeFile(name, JSON.stringify({ ...metadata, [field as string]: value }))
      await rejectVerification('metadata')
    })
  }

  for (const attack of [
    'traversal',
    'symlink',
    'extra entry',
    'invalid gzip',
    'oversized expansion',
  ] as const) {
    it(`rejects ${attack} even when archive checksum is updated`, async () => {
      await assemble()
      const name = join(downloaded, 'bralecli-darwin-arm64.tar.gz')
      let archive = await readFile(name)
      const tar = gunzipSync(archive)
      if (attack === 'traversal') tar.write('../evil', 0)
      if (attack === 'symlink') tar.write('2', 156)
      if (attack === 'extra entry') tar[1024] = 1
      if (attack === 'invalid gzip') archive = Buffer.from('invalid gzip')
      else if (attack === 'oversized expansion')
        archive = gzipSync(Buffer.alloc(256 * 1024 * 1024 + 2049))
      else archive = gzipSync(tar)
      await writeFile(name, archive)
      const metadataName = join(downloaded, 'build-info-darwin-arm64.json')
      const metadata = JSON.parse(await readFile(metadataName, 'utf8'))
      await writeFile(
        metadataName,
        JSON.stringify({ ...metadata, sha256: hash('sha256', archive) }),
      )
      await rejectVerification('archive')
    }, 20_000)
  }

  it('rejects a symlink download directory', async () => {
    await assemble()
    const linked = join(root, 'linked')
    await symlink(downloaded, linked)
    downloaded = linked
    await rejectVerification('directory')
  })
})
