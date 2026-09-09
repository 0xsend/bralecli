import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('./ci-sandbox.mjs', import.meta.url))

test('rejects commands outside the fixed CI interface before using Docker', () => {
  const result = spawnSync(process.execPath, [runner, 'release'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unsupported sandbox command: release/)
})

test('rejects tracked symlinks and replaced parent directories that escape the checkout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'brale-sandbox-path-verifier-'))
  const repository = join(directory, 'repository')
  try {
    mkdirSync(repository)
    writeFileSync(join(directory, 'outside'), 'synthetic-outside-input')
    symlinkSync('../outside', join(repository, 'escaped'))
    execFileSync('git', ['init', '--quiet'], { cwd: repository })
    execFileSync('git', ['add', 'escaped'], { cwd: repository })
    const escaped = spawnSync(process.execPath, [runner, 'test'], {
      cwd: repository,
      encoding: 'utf8',
    })
    assert.equal(escaped.status, 1)
    assert.match(escaped.stderr, /Tracked symlink escapes source snapshot: escaped/)
    execFileSync('git', ['rm', '--cached', 'escaped'], { cwd: repository })
    mkdirSync(join(repository, 'parent'))
    writeFileSync(join(repository, 'parent', 'outside'), 'original-tracked-file')
    execFileSync('git', ['add', 'parent/outside'], { cwd: repository })
    rmSync(join(repository, 'parent'), { recursive: true })
    symlinkSync('..', join(repository, 'parent'))
    const parent = spawnSync(process.execPath, [runner, 'test'], {
      cwd: repository,
      encoding: 'utf8',
    })
    assert.equal(parent.status, 1)
    assert.match(parent.stderr, /Tracked path has a symlink parent: parent\/outside/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test(
  'real Docker execution withholds host authority and preserves only the source snapshot',
  {
    timeout: 240_000,
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'brale-sandbox-verifier-'))
    try {
      const sentinel = join(directory, 'host-sentinel')
      writeFileSync(sentinel, 'host-original')
      writeFileSync(join(directory, '.env'), 'synthetic-tracked-secret')
      writeFileSync(join(directory, '.node-version'), '24.20.0\n')
      writeFileSync(join(directory, 'tracked.txt'), 'before-change')
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'brale-sandbox-verifier',
          private: true,
          scripts: {
            postinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'bad')\"",
            test: 'node probe.mjs',
            lint: 'node -e "process.exit(23)"',
          },
        }),
      )
      writeFileSync(
        join(directory, 'probe.mjs'),
        `
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { connect } from 'node:net'
for (const name of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_OUTPUT', 'RUNNER_TEMP', 'SANDBOX_HOST_CANARY']) {
  assert.equal(process.env[name], undefined, name + ' must be absent')
}
for (const path of ['.git/config', '.env', 'host-sentinel', 'lifecycle-ran', '/var/run/docker.sock', ${JSON.stringify(sentinel)}]) {
  assert.throws(() => readFileSync(path), undefined, path + ' must be absent')
}
assert.throws(() => writeFileSync(${JSON.stringify(sentinel)}, 'modified'))
assert.equal(readFileSync('tracked.txt', 'utf8'), 'working-tree-change')
writeFileSync('tracked.txt', 'container-change')
assert.notEqual(process.getuid(), 0)
assert.match(readFileSync('/proc/self/status', 'utf8'), /^CapEff:\\s+0+$/m)
assert.match(readFileSync('/proc/self/status', 'utf8'), /^NoNewPrivs:\\s+1$/m)
assert.deepEqual(Object.keys(networkInterfaces()), ['lo'])
await new Promise((resolve, reject) => {
  const socket = connect({ host: '198.51.100.1', port: 443 })
  socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('outbound attempt did not fail promptly')) })
  socket.once('connect', () => { socket.destroy(); reject(new Error('outbound network was reachable')) })
  socket.once('error', (error) => error.code === 'ENETUNREACH' ? resolve() : reject(error))
})
const server = createServer((_request, response) => response.end('loopback-ok'))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const response = await fetch('http://127.0.0.1:' + server.address().port)
  assert.equal(await response.text(), 'loopback-ok')
} finally {
  await new Promise(resolve => server.close(resolve))
}
console.log('sandbox authority, network, lifecycle and writable snapshot verified')
console.log('::error::synthetic verifier annotation')
`,
      )
      // Captured from nub 0.5.0 installing this dependency-free fixture.
      writeFileSync(
        join(directory, 'nub.lock'),
        "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\npackages: {}\n\nsnapshots: {}\n",
      )
      execFileSync('git', ['init', '--quiet'], { cwd: directory })
      execFileSync(
        'git',
        ['add', 'package.json', 'nub.lock', '.node-version', '.env', 'tracked.txt', 'probe.mjs'],
        { cwd: directory },
      )
      writeFileSync(join(directory, 'tracked.txt'), 'working-tree-change')
      const result = spawnSync(process.execPath, [runner, 'test'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 180_000,
        env: {
          ...process.env,
          GITHUB_TOKEN: 'synthetic-verifier-token',
          ACTIONS_RUNTIME_TOKEN: 'synthetic-verifier-runtime-token',
          GITHUB_OUTPUT: sentinel,
          RUNNER_TEMP: directory,
          SANDBOX_HOST_CANARY: 'synthetic-host-canary',
          GITHUB_ACTIONS: 'true',
        },
      })
      assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ''))
      assert.match(
        result.stdout,
        /sandbox authority, network, lifecycle and writable snapshot verified/,
      )
      const stop = result.stdout.match(/^::stop-commands::([a-f0-9-]+)$/m)
      assert.ok(stop, 'untrusted output must disable workflow command parsing')
      assert.ok(
        result.stdout.indexOf(stop[0]) <
          result.stdout.indexOf('::error::synthetic verifier annotation'),
      )
      assert.ok(
        result.stdout.indexOf(`::${stop[1]}::`) >
          result.stdout.indexOf('::error::synthetic verifier annotation'),
      )
      assert.equal(readFileSync(sentinel, 'utf8'), 'host-original')
      assert.equal(readFileSync(join(directory, 'tracked.txt'), 'utf8'), 'working-tree-change')

      const failure = spawnSync(process.execPath, [runner, 'lint'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 180_000,
      })
      assert.equal(failure.status, 1, failure.stdout + failure.stderr)
      assert.match(failure.stderr, /execution failed with exit code 23/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
