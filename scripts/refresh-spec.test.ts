import { execFile } from 'node:child_process'
import { hash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const originalBody = await readFile(
  new URL('../packages/brale/openapi/brale.json', import.meta.url),
)
const originalPin = await readFile(
  new URL('../packages/brale/src/spec.ts', import.meta.url),
  'utf8',
)
const script = await readFile(new URL('./refresh-spec.ts', import.meta.url))
// Whitespace is an upstream revision too, even when info.version stays the same.
const changedBody = Buffer.concat([originalBody, Buffer.from('\n')])
const originalHash = hash('sha256', originalBody)
const changedHash = hash('sha256', changedBody)
const originalDate = originalPin.match(/SPEC_FETCHED_AT: string = '([^']+)'/)![1]!

type Fixture = {
  root: string
  pinPath: string
  specPath: string
  pin: string
  respond: (handler: (response: ServerResponse) => void) => void
  run: (args?: string[]) => Promise<{ stdout: string; stderr: string }>
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'brale-spec-refresh-'))
  let respond = (response: ServerResponse) => response.end(changedBody)
  const server = createServer((_request, response) => respond(response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local HTTP server port')
  const sourceUrl = `http://127.0.0.1:${address.port}/openapi`
  const specPath = join(root, 'packages/brale/openapi/brale.json')
  const pinPath = join(root, 'packages/brale/src/spec.ts')
  const pin = originalPin.replace('https://api.brale.xyz/openapi', sourceUrl)
  try {
    await Promise.all([
      mkdir(join(root, 'scripts'), { recursive: true }),
      mkdir(join(root, 'packages/brale/openapi'), { recursive: true }),
      mkdir(join(root, 'packages/brale/src'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(root, 'scripts/refresh-spec.ts'), script),
      writeFile(join(root, 'package.json'), '{"type":"module"}'),
      writeFile(specPath, originalBody),
      writeFile(pinPath, pin),
    ])
    await run({
      root,
      pinPath,
      specPath,
      pin,
      respond: (handler) => {
        respond = handler
      },
      run: (args = []) =>
        execFileAsync(process.execPath, [join(root, 'scripts/refresh-spec.ts'), ...args], {
          cwd: root,
          env: {},
          timeout: 35_000,
        }),
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  }
}

async function expectOriginalFiles(fixture: Fixture): Promise<void> {
  expect(await readFile(fixture.specPath)).toEqual(originalBody)
  expect(await readFile(fixture.pinPath, 'utf8')).toBe(fixture.pin)
}

describe('spec refresh proposals (REQ-REPO-006/007)', () => {
  it.concurrent('updates exact bytes and pins, reports clean JSON, then leaves the same revision untouched', async () => {
    await withFixture(async (fixture) => {
      const first = await fixture.run(['--update-pin', '--format', 'json'])
      const result = JSON.parse(first.stdout)
      expect(result).toEqual({
        changed: true,
        previousHash: originalHash,
        hash: changedHash,
        fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      })
      expect(first.stderr).toContain('Fetching http://127.0.0.1:')
      expect(await readFile(fixture.specPath)).toEqual(changedBody)
      const updatedPin = fixture.pin
        .replace(originalHash, changedHash)
        .replace(
          `SPEC_FETCHED_AT: string = '${originalDate}'`,
          `SPEC_FETCHED_AT: string = '${result.fetchedAt}'`,
        )
      expect(await readFile(fixture.pinPath, 'utf8')).toBe(updatedPin)

      const second = JSON.parse((await fixture.run(['--update-pin', '--format', 'json'])).stdout)
      expect(second).toEqual({
        changed: false,
        previousHash: changedHash,
        hash: changedHash,
        fetchedAt: result.fetchedAt,
      })
      expect(await readFile(fixture.specPath)).toEqual(changedBody)
      expect(await readFile(fixture.pinPath, 'utf8')).toBe(updatedPin)
    })
  })

  it.concurrent('leaves the original date and all files untouched when upstream bytes match', async () => {
    await withFixture(async (fixture) => {
      fixture.respond((response) => response.end(originalBody))
      const result = JSON.parse((await fixture.run(['--update-pin', '--format', 'json'])).stdout)
      expect(result).toEqual({
        changed: false,
        previousHash: originalHash,
        hash: originalHash,
        fetchedAt: originalDate,
      })
      await expectOriginalFiles(fixture)
    })
  })

  it.concurrent('keeps manual pin review as the default and warns about a mismatched pin', async () => {
    await withFixture(async (fixture) => {
      const first = await fixture.run()
      expect(await readFile(fixture.specPath)).toEqual(changedBody)
      expect(await readFile(fixture.pinPath, 'utf8')).toBe(fixture.pin)
      expect(first.stdout).toContain('Next steps:')
      expect(first.stdout).toContain(
        `set SPEC_SHA256 in packages/brale/src/spec.ts to ${changedHash}`,
      )
      const second = await fixture.run()
      expect(second.stdout).toContain('No change.')
      expect(second.stderr).toContain('already differs from the pin')
    })
  })

  it.concurrent('reuses an unmerged proposal date without evaluating its source file', async () => {
    await withFixture(async (fixture) => {
      const previousPin = join(fixture.root, 'previous-pin.ts')
      await writeFile(
        previousPin,
        fixture.pin.replace(originalHash, changedHash).replace(originalDate, '2026-09-02') +
          '\nthrow new Error("Previous pin source must never execute")\n',
      )
      const args = ['--update-pin', '--format', 'json', '--previous-pin', previousPin]
      const first = await fixture.run(args)
      expect(JSON.parse(first.stdout).fetchedAt).toBe('2026-09-02')
      const proposedPin = await readFile(fixture.pinPath, 'utf8')
      await writeFile(fixture.specPath, originalBody)
      await writeFile(fixture.pinPath, fixture.pin)
      const repeated = await fixture.run(args)
      expect(JSON.parse(repeated.stdout).fetchedAt).toBe('2026-09-02')
      expect(await readFile(fixture.pinPath, 'utf8')).toBe(proposedPin)
    })
  })

  for (const previous of ['missing', 'different hash', 'invalid date']) {
    it.concurrent(`uses a new observation date when the previous proposal has ${previous}`, async () => {
      await withFixture(async (fixture) => {
        const previousPin = join(fixture.root, 'previous-pin.ts')
        if (previous !== 'missing') {
          await writeFile(
            previousPin,
            fixture.pin
              .replace(originalHash, previous === 'different hash' ? originalHash : changedHash)
              .replace(originalDate, previous === 'invalid date' ? '2026-02-31' : '2001-01-01'),
          )
        }
        const startedDate = new Date().toISOString().slice(0, 10)
        const result = JSON.parse(
          (await fixture.run(['--update-pin', '--format', 'json', '--previous-pin', previousPin]))
            .stdout,
        )
        const finishedDate = new Date().toISOString().slice(0, 10)
        expect([startedDate, finishedDate]).toContain(result.fetchedAt)
        expect(await readFile(fixture.specPath)).toEqual(changedBody)
      })
    })
  }

  it.concurrent('does not hide previous proposal file errors other than a missing file', async () => {
    await withFixture(async (fixture) => {
      await expect(fixture.run(['--update-pin', '--previous-pin', fixture.root])).rejects.toThrow()
      await expectOriginalFiles(fixture)
    })
  })

  it.concurrent('rejects a mismatched current pin before changing any files in bot mode', async () => {
    await withFixture(async (fixture) => {
      await writeFile(fixture.pinPath, fixture.pin.replace(originalHash, '0'.repeat(64)))
      await expect(fixture.run(['--update-pin'])).rejects.toMatchObject({
        stderr: expect.stringContaining('already differs from the pin'),
      })
      expect(await readFile(fixture.specPath)).toEqual(originalBody)
      expect(await readFile(fixture.pinPath, 'utf8')).toBe(
        fixture.pin.replace(originalHash, '0'.repeat(64)),
      )
    })
  })

  for (const mutation of ['missing hash', 'duplicate hash', 'computed hash', 'invalid date']) {
    it.concurrent(`rejects a current pin template with ${mutation} before writing`, async () => {
      await withFixture(async (fixture) => {
        const invalidPin = {
          'missing hash': fixture.pin.replace('export const SPEC_SHA256:', 'const REMOVED_SHA256:'),
          'duplicate hash':
            fixture.pin + `\nexport const SPEC_SHA256: string = '${originalHash}'\n`,
          'computed hash': fixture.pin.replace(`'${originalHash}'`, `'${originalHash}' + ''`),
          'invalid date': fixture.pin.replace(originalDate, '2026-02-31'),
        }[mutation]!
        await writeFile(fixture.pinPath, invalidPin)
        await expect(fixture.run(['--update-pin'])).rejects.toThrow()
        expect(await readFile(fixture.specPath)).toEqual(originalBody)
        expect(await readFile(fixture.pinPath, 'utf8')).toBe(invalidPin)
      })
    })
  }

  const invalidResponses = [
    { name: 'HTTP failure', status: 502, body: originalBody, error: 'HTTP 502' },
    {
      name: 'HTML error',
      status: 200,
      body: Buffer.from('<html>gateway failure</html>'),
      error: 'JSON',
    },
    {
      name: 'JSON without an OpenAPI contract',
      status: 200,
      body: Buffer.from('{}'),
      error: 'OpenAPI',
    },
    {
      name: 'UTF-8 BOM',
      status: 200,
      body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), originalBody]),
      error: 'JSON',
    },
    {
      name: 'body above the size cap',
      status: 200,
      body: Buffer.alloc(10 * 1024 * 1024 + 1, ' '),
      error: '10 MiB',
    },
  ]
  for (const { name, status, body, error } of invalidResponses) {
    it.concurrent(`rejects ${name} and leaves both files unchanged`, async () => {
      await withFixture(async (fixture) => {
        fixture.respond((response) => {
          response.writeHead(status)
          response.end(body)
        })
        await expect(fixture.run(['--update-pin', '--format', 'json'])).rejects.toMatchObject({
          stdout: '',
          stderr: expect.stringContaining(error),
        })
        await expectOriginalFiles(fixture)
      })
    })
  }

  it.concurrent('rejects unsupported arguments without fetching or changing files', async () => {
    await withFixture(async (fixture) => {
      let requests = 0
      fixture.respond((response) => {
        requests += 1
        response.end(changedBody)
      })
      await expect(fixture.run(['--format', 'yaml'])).rejects.toThrow()
      await expect(fixture.run(['--update-pni'])).rejects.toThrow()
      expect(requests).toBe(0)
      await expectOriginalFiles(fixture)
    })
  })
})
