import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetAuthCacheForTesting } from './client.js'
import { cli } from './index.js'

async function help(args: string[]): Promise<string> {
  let output = ''
  await cli.serve([...args, '--help'], {
    stdout: (text) => {
      output += text
    },
    exit: (code) => {
      if (code !== 0) throw new Error(`CLI exited with ${code}`)
    },
  })
  return output
}

/** Runs argv the way a shell would, keeping the exit code instead of exiting. */
async function run(args: string[]): Promise<{ code: number; output: string }> {
  let output = ''
  let code = 0
  await cli.serve(args, {
    stdout: (text) => {
      output += text
    },
    exit: (exitCode) => {
      code = exitCode
    },
  })
  return { code, output }
}

describe('direct command interface', () => {
  it('lists Brale operations at the root', async () => {
    const output = await help([])
    expect(output).toContain('list_accounts')
    expect(output).toContain('create_transfer')
    expect(output).not.toMatch(/^\s+api\s/m)
  })

  it.each(['list_accounts', 'get_account', 'create_transfer'])(
    'exposes %s without an api prefix',
    async (command) => {
      expect(await help([command])).toContain(`Usage: bralecli ${command}`)
    },
  )

  it.each(['completions', 'mcp', 'skills'])('preserves %s help', async (command) => {
    expect(await help([command])).toContain(`Usage: bralecli ${command}`)
  })
})

describe('argv that names no command', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('BRALE_CLIENT_ID', 'client-id')
    vi.stubEnv('BRALE_CLIENT_SECRET', 'client-secret')
    fetchMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('fails locally instead of sending the words to Brale as a path', async () => {
    // What a script calling a retired command runs into: incur routes the words
    // and flags to the fetch source as `GET /retired_command/acct-1?...`.
    const { code, output } = await run([
      'retired_command',
      'acct-1',
      '--account_number',
      '000123456789',
      '--format',
      'json',
    ])

    expect(code).toBe(1)
    expect(output).toContain('UNKNOWN_OPERATION')
    expect(output).not.toContain('000123456789')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('a generated command', () => {
  const KSUID = '2VZvtmVc2j3gQ80CTlcuQXbGrwC'
  const fetchMock = vi.fn(async (request: Request) =>
    new URL(request.url).pathname === '/oauth2/token'
      ? Response.json({ access_token: 'tok-1', expires_in: 3600, token_type: 'bearer' })
      : Response.json({ id: KSUID }),
  )

  beforeEach(() => {
    resetAuthCacheForTesting()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('BRALE_CLIENT_ID', 'client-id')
    vi.stubEnv('BRALE_CLIENT_SECRET', 'client-secret')
    fetchMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetAuthCacheForTesting()
  })

  it('still reaches Brale through the contract guard', async () => {
    const { code } = await run(['get_account', KSUID, '--format', 'json'])

    expect(code).toBe(0)
    const sent = fetchMock.mock.calls
      .map(([request]) => new URL(request.url))
      .filter((url) => url.pathname !== '/oauth2/token')
    expect(sent.map((url) => url.href)).toEqual([`https://api.brale.xyz/accounts/${KSUID}`])
  })
})
