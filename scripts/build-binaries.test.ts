import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compileBinaries } from './compile-binaries.mjs'

let root: string
let out: string
let compiler: string
const targets = ['darwin-arm64', 'darwin-x64-baseline', 'linux-arm64', 'linux-x64-baseline']

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brale-compiler-'))
  out = join(root, 'output')
  compiler = join(root, 'compiler.mjs')
  await mkdir(out)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixtureCompiler(body: string) {
  await writeFile(
    compiler,
    `#!${process.execPath}\nimport * as fs from 'node:fs';\nconst output = process.argv[process.argv.indexOf('--outfile') + 1];\n${body}\n`,
    { mode: 0o755 },
  )
}

function compile(selectedTargets = targets) {
  return compileBinaries({
    compiler,
    intermediate: join(root, 'bundle.js'),
    targets: selectedTargets,
    out,
  })
}

describe('standalone compiler output verification', () => {
  it('rejects a compiler that exits successfully without producing its executable', async () => {
    await fixtureCompiler('process.exit(0)')
    await expect(compile(['darwin-x64-baseline'])).rejects.toThrow('Missing compiled executable')
    expect(await readdir(out)).toEqual([])
  })

  it('runs the four compiler processes serially and validates every final executable', async () => {
    await fixtureCompiler(`
const lock = ${JSON.stringify(join(root, 'compiler.lock'))};
fs.writeFileSync(lock, '', { flag: 'wx' });
await new Promise(resolve => setTimeout(resolve, 50));
fs.writeFileSync(output, 'fixture executable', { mode: 0o755 });
fs.unlinkSync(lock);
`)
    await compile()
    expect((await readdir(out)).toSorted()).toEqual([
      'bralecli-darwin-arm64',
      'bralecli-darwin-x64',
      'bralecli-linux-arm64',
      'bralecli-linux-x64',
    ])
  })

  for (const [name, body, error] of [
    ['symlink', "fs.symlinkSync('untrusted', output)", 'regular'],
    ['empty file', "fs.writeFileSync(output, '', { mode: 0o755 })", 'nonempty'],
    ['non-executable file', "fs.writeFileSync(output, 'fixture', { mode: 0o644 })", 'executable'],
  ]) {
    it(`rejects a compiler that produces a ${name}`, async () => {
      await fixtureCompiler(body)
      await expect(compile(['darwin-arm64'])).rejects.toThrow(error)
    })
  }

  it('rejects stale output before a compiler can overwrite it', async () => {
    const filename = join(out, 'bralecli-darwin-arm64')
    await writeFile(filename, 'prior executable')
    await chmod(filename, 0o755)
    await fixtureCompiler("fs.writeFileSync(output, 'overwritten')")
    await expect(compile(['darwin-arm64'])).rejects.toThrow('already exists')
    expect(await readFile(filename, 'utf8')).toBe('prior executable')
  })

  it('rejects stale release metadata before compiling into an old output directory', async () => {
    await writeFile(join(out, 'build-info.json'), '{"version":"0.1.1"}')
    await fixtureCompiler("fs.writeFileSync(output, 'fixture', { mode: 0o755 })")
    await expect(compile(['darwin-arm64'])).rejects.toThrow('already exists')
    expect(await readdir(out)).toEqual(['build-info.json'])
  })

  it('rejects an unselected stale binary before a single-target build can relabel it', async () => {
    const stale = join(out, 'bralecli-linux-x64')
    await writeFile(stale, 'prior revision', { mode: 0o755 })
    await fixtureCompiler("fs.writeFileSync(output, 'new revision', { mode: 0o755 })")
    await expect(compile(['darwin-arm64'])).rejects.toThrow('already exists')
    expect(await readdir(out)).toEqual(['bralecli-linux-x64'])
    expect(await readFile(stale, 'utf8')).toBe('prior revision')
  })

  it('rejects a later compiler that removes an earlier executable', async () => {
    await fixtureCompiler(`
fs.writeFileSync(output, 'fixture', { mode: 0o755 });
if (output.endsWith('darwin-x64')) fs.unlinkSync(${JSON.stringify(join(out, 'bralecli-darwin-arm64'))});
`)
    await expect(compile(['darwin-arm64', 'darwin-x64-baseline'])).rejects.toThrow(
      'Missing compiled executable',
    )
  })
})
