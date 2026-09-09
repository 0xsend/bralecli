import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const image =
  'node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e'
const nodeVersion = '24.20.0'
const commands = new Map([
  ...['test', 'typecheck', 'build', 'lint', 'format:check', 'knip', 'jscpd', 'actions:check'].map(
    (command) => [command, [command]],
  ),
  ['compatibility', ['check', 'build', 'knip', 'jscpd']],
])
const sourceLimitBytes = 100 * 1024 * 1024
const outputLimitBytes = 20 * 1024 * 1024
const signal = new AbortController()
for (const name of ['SIGINT', 'SIGTERM'])
  process.once(name, () => signal.abort(new Error(`Sandbox cancelled by ${name}`)))

async function execute(
  command,
  args,
  { phase, cwd, input, capture = false, timeoutMs = 60_000, cleanup = false } = {},
) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: cleanup ? undefined : signal.signal,
    })
    let output = ''
    let outputBytes = 0
    let failure
    const timeout = setTimeout(() => {
      failure = new Error(`${phase ?? command} exceeded ${timeoutMs / 1000} seconds`)
      child.kill('SIGKILL')
    }, timeoutMs)
    const inputStream = input ? createReadStream(input) : undefined
    inputStream?.on('error', (error) => {
      failure = error
      child.kill('SIGKILL')
    })
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        failure = error
        child.kill('SIGKILL')
      }
    })
    if (inputStream) inputStream.pipe(child.stdin)
    else child.stdin.end()
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on('data', (chunk) => {
        outputBytes += chunk.length
        if (outputBytes > outputLimitBytes) {
          failure = new Error(`${phase ?? command} exceeded the 20 MiB output limit`)
          child.kill('SIGKILL')
        } else if (capture) output += chunk.toString('utf8')
        else destination.write(chunk)
      })
    }
    child.on('error', (error) => {
      failure = error
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      inputStream?.destroy()
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new Error(
            `${phase ?? command} failed with exit code ${code}${output ? `: ${output.trim()}` : ''}`,
          ),
        )
      else resolveResult(output)
    })
  })
}

function included(path) {
  return !path
    .split('/')
    .some(
      (part) =>
        ['.git', '.hunk', '.direnv', 'node_modules', '.npmrc', 'fnox.toml'].includes(part) ||
        part.startsWith('.env'),
    )
}

function dependencyInput(path) {
  return (
    path === 'nub.lock' ||
    path === '.node-version' ||
    path.split('/').at(-1) === 'package.json' ||
    /^patches\/[^/]+\.patch$/.test(path)
  )
}

function auditInput(path) {
  return (
    path === 'scripts/check-actions.ts' ||
    path.startsWith('.github/workflows/') ||
    path.startsWith('.github/actions/')
  )
}

async function snapshot(repository, directory, auditOnly) {
  const paths = (
    await execute('git', ['ls-files', '--cached', '-z'], { cwd: repository, capture: true })
  )
    .split('\0')
    .filter(Boolean)
  if (paths.length > 10_000) throw new Error('Source snapshot exceeds 10,000 tracked files')
  const source = join(directory, 'source')
  const dependencies = join(directory, 'dependencies')
  await mkdir(source)
  await mkdir(dependencies)
  let bytes = 0
  const digest = createHash('sha256')
  // Keep reads serial so the source-size bound also bounds live memory and file
  // descriptors; the two small destination writes are part of that operation.
  /* oxlint-disable no-await-in-loop */
  for (const path of [...new Set(paths)].toSorted()) {
    if (!included(path)) continue
    if (
      isAbsolute(path) ||
      path.split('/').some((part) => part === '..' || part === '.' || part === '')
    )
      throw new Error(`Invalid tracked path: ${path}`)
    if (auditOnly && !dependencyInput(path) && !auditInput(path)) continue
    const from = join(repository, path)
    // Check parent directories before reading: a modified tracked directory must
    // not turn a source snapshot into a read outside the checkout.
    if ((await realpath(dirname(from))) !== dirname(from))
      throw new Error(`Tracked path has a symlink parent: ${path}`)
    let stat
    try {
      stat = await lstat(from)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const destinations = [
      join(source, path),
      ...(dependencyInput(path) ? [join(dependencies, path)] : []),
    ]
    for (const destination of destinations) await mkdir(dirname(destination), { recursive: true })
    digest.update(`${path}\0${stat.mode}\0`)
    if (stat.isSymbolicLink()) {
      if (dependencyInput(path)) throw new Error(`Dependency input must be a regular file: ${path}`)
      const target = await readlink(from)
      const resolved = relative(repository, resolve(dirname(from), target))
      if (
        isAbsolute(target) ||
        resolved.startsWith('../') ||
        resolved === '..' ||
        !included(resolved)
      )
        throw new Error(`Tracked symlink escapes source snapshot: ${path}`)
      digest.update(target)
      for (const destination of destinations) await symlink(target, destination)
    } else if (stat.isFile()) {
      bytes += stat.size
      if (bytes > sourceLimitBytes) throw new Error('Source snapshot exceeds 100 MiB')
      const body = await readFile(from)
      digest.update(body)
      for (const destination of destinations)
        await writeFile(destination, body, { mode: stat.mode & 0o777 })
    } else throw new Error(`Tracked input must be a file or internal symlink: ${path}`)
  }
  const version = (await readFile(join(dependencies, '.node-version'), 'utf8')).trim()
  if (version !== nodeVersion)
    throw new Error(
      `Sandbox image requires .node-version ${nodeVersion}; found ${version}. Update the reviewed image digest with the Node version.`,
    )
  for (const [name, path] of [
    ['source', source],
    ['dependencies', dependencies],
  ]) {
    await execute('tar', ['-C', path, '-cf', join(directory, `${name}.tar`), '.'], {
      phase: `${name} archive`,
    })
  }
  /* oxlint-enable no-await-in-loop */
  return { digest: digest.digest('hex'), files: paths.length, bytes }
}

async function removeContainer(name) {
  try {
    await execute('docker', ['rm', '--force', name], {
      phase: 'container cleanup',
      capture: true,
      timeoutMs: 30_000,
      cleanup: true,
    })
  } catch (error) {
    if (!error.message.includes('No such container')) throw error
  }
}

function containerArgs(volume, name, command, network, detached = false) {
  return [
    'run',
    '--name',
    name,
    '--init',
    detached ? '--detach' : '--interactive',
    '--read-only',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--network',
    network,
    '--cpus',
    '2',
    '--memory',
    '4g',
    '--memory-swap',
    '4g',
    '--pids-limit',
    '512',
    '--log-driver',
    'json-file',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=1',
    '--tmpfs',
    // nub materializes its native transformer in HOME's cache. It needs an
    // executable mapping, still confined to this disposable container.
    '/tmp:rw,nosuid,nodev,exec,size=1g,mode=1777',
    '--mount',
    `type=volume,source=${volume},target=/sandbox,volume-nocopy`,
    '--workdir',
    '/sandbox',
    '--env',
    'HOME=/tmp/home',
    '--env',
    'CI=true',
    '--env',
    'PATH=/sandbox/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    // Docker client proxy defaults may contain credentials. Override every form
    // rather than allowing client configuration to inject them into the job.
    ...[
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'FTP_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'ftp_proxy',
      'all_proxy',
      'no_proxy',
    ].flatMap((variable) => ['--env', `${variable}=`]),
    image,
    'sh',
    '-euc',
    command,
  ]
}

async function container(
  volume,
  phase,
  command,
  { input, network = 'none', timeoutMs = 120_000 } = {},
) {
  const name = `${volume}-${phase}`
  console.log(JSON.stringify({ phase, network, status: 'running' }))
  try {
    await execute('docker', containerArgs(volume, name, command, network), {
      phase,
      input,
      timeoutMs,
    })
  } finally {
    // Removing the container also kills any background processes before the
    // next phase receives source files or loses its network connection.
    await removeContainer(name)
  }
}

async function main() {
  const [command, ...extra] = process.argv.slice(2)
  const checks = commands.get(command)
  if (!checks || extra.length)
    throw new Error(`Unsupported sandbox command: ${command ?? '(missing)'}`)
  const repository = await realpath(
    (await execute('git', ['rev-parse', '--show-toplevel'], { capture: true })).trim(),
  )
  const directory = await mkdtemp(join(tmpdir(), 'brale-ci-source-'))
  const volume = `brale-ci-${randomUUID()}`
  let volumeCreated = false
  try {
    const source = await snapshot(repository, directory, command === 'actions:check')
    console.log(JSON.stringify({ command, image, source, volume, status: 'prepared' }))
    await execute('docker', ['pull', image], { phase: 'image pull', timeoutMs: 180_000 })
    await execute(
      'docker',
      [
        'volume',
        'create',
        '--driver',
        'local',
        '--opt',
        'type=tmpfs',
        '--opt',
        'device=tmpfs',
        '--opt',
        'o=size=2g,uid=1000,gid=1000,mode=0700',
        volume,
      ],
      { phase: 'volume create', capture: true },
    )
    volumeCreated = true
    // A tmpfs volume is erased when its last mount closes. A trusted keeper
    // preserves it between isolated phases and has its own finite lifetime.
    await execute('docker', containerArgs(volume, `${volume}-keeper`, 'sleep 1200', 'none', true), {
      phase: 'volume keeper',
      capture: true,
    })
    await container(volume, 'dependency-inputs', 'mkdir source tools; tar -xf - -C source', {
      input: join(directory, 'dependencies.tar'),
    })
    // Hermeticity: registry access is necessary to download locked dependencies.
    // Permanent: only manifests/lock/patches enter this credential-free phase;
    // all root and dependency lifecycle scripts are explicitly disabled.
    await container(
      volume,
      'install',
      'mkdir -p /tmp/home; npm install --prefix /sandbox/tools --ignore-scripts --no-audit --no-fund @nubjs/nub@0.5.0; cd source; nub ci --ignore-scripts',
      { network: 'bridge', timeoutMs: 300_000 },
    )
    await container(volume, 'source-inputs', 'tar -xf - -C source', {
      input: join(directory, 'source.tar'),
    })
    // The action-manifest audit needs public GitHub manifests. Its source copy
    // contains only dependency inputs, the checker and workflow/action files.
    await container(
      volume,
      'execution',
      `mkdir -p /tmp/home; cd source; ${checks.map((check) => `nub run ${check}`).join(' && ')}`,
      { network: command === 'actions:check' ? 'bridge' : 'none', timeoutMs: 600_000 },
    )
    console.log(JSON.stringify({ command, source: source.digest, status: 'passed' }))
  } finally {
    if (volumeCreated) await removeContainer(`${volume}-keeper`)
    if (volumeCreated)
      await execute('docker', ['volume', 'rm', volume], {
        phase: 'volume cleanup',
        capture: true,
        timeoutMs: 30_000,
        cleanup: true,
      })
    await rm(directory, { recursive: true, force: true })
  }
}

// Project output is untrusted even when the process has no token: disable the
// runner's stdout command parser with a nonce the container never receives.
const stopToken = randomUUID()
if (process.env.GITHUB_ACTIONS === 'true') console.log(`::stop-commands::${stopToken}`)
try {
  await main()
} catch (error) {
  console.error(`CI sandbox failed: ${error.message}`)
  process.exitCode = 1
} finally {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${stopToken}::`)
}
