import { Cli, Parser, Schema, z } from 'incur'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetAuthCacheForTesting } from './client.js'
import { cli } from './index.js'

const account = '2VZvtmVc2j3gQ80CTlcuQXbGrwC'
const amount = { value: '10', currency: 'USD' }
const source = { value_type: 'USD', transfer_type: 'wire' }
const destination = { value_type: 'CUSD', transfer_type: 'base' }

async function transfer(overrides: Record<string, string> = {}) {
  let output = ''
  let exitCode = 0
  const values = {
    amount: JSON.stringify(amount),
    source: JSON.stringify(source),
    destination: JSON.stringify(destination),
    ...overrides,
  }
  await cli.serve(
    [
      'create_transfer',
      account,
      ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]),
    ],
    {
      stdout: (text) => {
        output += text
      },
      exit: (code) => {
        exitCode = code
      },
    },
  )
  return { output, exitCode }
}

describe('JSON flags through the real command parser', () => {
  const requests: Request[] = []
  beforeEach(() => {
    requests.length = 0
    resetAuthCacheForTesting()
    vi.stubEnv('BRALE_CLIENT_ID', 'fixture-client')
    vi.stubEnv('BRALE_CLIENT_SECRET', 'fixture-secret')
    vi.stubEnv('BRALE_CLIENT_ID_REF', undefined)
    vi.stubEnv('BRALE_CLIENT_SECRET_REF', undefined)
    vi.stubEnv('BRALE_API_BASE_URL', undefined)
    vi.stubEnv('BRALE_AUTH_BASE_URL', undefined)
    vi.stubGlobal('fetch', async (request: Request) => {
      requests.push(request)
      return Response.json(
        new URL(request.url).pathname === '/oauth2/token'
          ? { access_token: 'fixture-token', expires_in: 3600 }
          : { id: 'fixture-transfer' },
      )
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetAuthCacheForTesting()
  })

  it('validates and sends structured transfer flags as JSON objects', async () => {
    const result = await transfer({ note: '{keep this literal}' })
    expect(result.exitCode, result.output).toBe(0)
    expect(requests).toHaveLength(2)
    const request = requests[1]!
    expect(request.method).toBe('POST')
    expect(new URL(request.url).pathname).toBe(`/accounts/${account}/transfers`)
    expect(await request.json()).toEqual({
      amount,
      source,
      destination,
      note: '{keep this literal}',
    })
  })

  it.each([
    ['malformed JSON', '{broken'],
    ['null', 'null'],
    ['wrong container', '[]'],
    ['invalid nested value', JSON.stringify({ value: { nested: true }, currency: 'USD' })],
    ['missing required property', JSON.stringify({ currency: 'USD' })],
  ])('rejects %s before auth or API requests', async (_label, value) => {
    const result = await transfer({ amount: value })
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('VALIDATION_ERROR')
    expect(requests).toHaveLength(0)
  })
})

describe('container parser compatibility', () => {
  const object = z.object({ value: z.string() })
  const options = z.object({
    objects: z.array(object),
    labels: z.array(z.string()),
    object: object.optional(),
  })

  it('decodes JSON arrays and repeated object flags while preserving literal string arrays', () => {
    const result = Parser.parse(
      [
        '--objects',
        '[{"value":"first"}]',
        '--objects',
        '{"value":"second"}',
        '--labels',
        '[literal]',
        '--labels',
        '{literal}',
      ],
      { options },
    )
    expect(result.options).toEqual({
      objects: [{ value: 'first' }, { value: 'second' }],
      labels: ['[literal]', '{literal}'],
    })
  })

  it('rejects invalid array members through the original nested schema', () => {
    expect(() =>
      Parser.parse(['--objects', '[{"value":3}]', '--labels', 'ok'], { options }),
    ).toThrow()
  })

  it('preserves object schemas for MCP introspection and programmatic object inputs', async () => {
    const fixture = Cli.create('fixture').command('check', {
      options: z.object({ object }),
      run: (context) => context.options,
    })
    const response = await fixture.fetch(
      new Request('http://localhost/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ object: { value: 'native' } }),
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('native')
    const schema = Schema.toJsonSchema(object)
    expect(schema.type).toBe('object')
    expect(schema.properties).toEqual({ value: { type: 'string' } })
    expect(schema.required).toEqual(['value'])
  })
})
