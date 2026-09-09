import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'

function compile(compiler, intermediate, target, output) {
  return new Promise((accept, reject) => {
    const child = spawn(
      compiler,
      [
        'build',
        intermediate,
        '--compile',
        `--target=bun-${target}`,
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--env=disable',
        '--outfile',
        output,
      ],
      { stdio: 'inherit' },
    )
    const timeout = setTimeout(() => child.kill('SIGKILL'), 300_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) accept()
      else reject(new Error(`Compile failed: ${target} (exit ${code}, signal ${signal})`))
    })
  })
}

export async function compileBinaries({ compiler, intermediate, targets, out }) {
  if (targets.length < 1 || targets.length > 4)
    throw new Error('Expected one to four compile targets')
  const outputs = targets.map((target) =>
    resolve(out, `bralecli-${target.replace('-baseline', '')}`),
  )
  const existingOutputs = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(
    (platform) => resolve(out, `bralecli-${platform}`),
  )
  await Promise.all(
    [...existingOutputs, resolve(out, 'build-info.json')].map(async (path) => {
      try {
        await lstat(path)
        throw new Error(`Compile output already exists: ${path}`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }),
  )
  // Concurrent Bun 1.3.3 compilers have reported success while losing a Darwin output.
  for (const [index, target] of targets.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await compile(compiler, intermediate, target, outputs[index])
  }
  await Promise.all(
    outputs.map(async (path) => {
      let stat
      try {
        stat = await lstat(path)
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause
        throw new Error(`Missing compiled executable: ${path}`, { cause })
      }
      if (!stat.isFile()) throw new Error(`Expected a regular compiled executable: ${path}`)
      if (stat.size === 0) throw new Error(`Expected a nonempty compiled executable: ${path}`)
      if (!(stat.mode & 0o111)) throw new Error(`Expected an executable output: ${path}`)
    }),
  )
}
