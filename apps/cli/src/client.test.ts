import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TokenEndpointError, braleFetchSource, resetAuthCacheForTesting } from './client.js'

/** A request shaped the way incur's generated handlers build them. */
function generatedRequest(options: { path: string; method?: string; body?: unknown }): Request {
  const init: RequestInit = { method: options.method ?? 'GET' }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers = { 'content-type': 'application/json' }
  }
  return new Request(new URL(options.path, 'http://localhost').toString(), init)
}

function tokenResponse(payload: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ access_token: 'tok-1', expires_in: 3600, token_type: 'bearer', ...payload }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const isTokenRequest = (request: Request) => new URL(request.url).pathname === '/oauth2/token'

describe('braleFetchSource', () => {
  const fetchMock = vi.fn(async (request: Request) =>
    isTokenRequest(request) ? tokenResponse() : new Response('{}', { status: 200 }),
  )

  const tokenCalls = () =>
    fetchMock.mock.calls.map(([request]) => request).filter((request) => isTokenRequest(request))
  const apiCalls = () =>
    fetchMock.mock.calls.map(([request]) => request).filter((request) => !isTokenRequest(request))

  beforeEach(() => {
    resetAuthCacheForTesting()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('BRALE_CLIENT_ID', 'client-id')
    vi.stubEnv('BRALE_CLIENT_SECRET', 'client-secret')
    vi.stubEnv('BRALE_CLIENT_ID_REF', undefined)
    vi.stubEnv('BRALE_CLIENT_SECRET_REF', undefined)
    vi.stubEnv('BRALE_API_BASE_URL', undefined)
    vi.stubEnv('BRALE_AUTH_BASE_URL', undefined)
    fetchMock.mockClear()
    fetchMock.mockImplementation(async (request: Request) =>
      isTokenRequest(request) ? tokenResponse() : new Response('{}', { status: 200 }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetAuthCacheForTesting()
  })

  it('mints a client-credentials token and sends it as the Bearer header on the joined URL', async () => {
    await braleFetchSource().fetch(generatedRequest({ path: '/accounts' }))

    const [tokenRequest] = tokenCalls()
    expect(tokenRequest?.url).toBe('https://auth.brale.xyz/oauth2/token')
    expect(tokenRequest?.method).toBe('POST')
    expect(tokenRequest?.headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    )
    expect(await tokenRequest?.text()).toBe('grant_type=client_credentials')

    const [apiRequest] = apiCalls()
    expect(apiRequest?.url).toBe('https://api.brale.xyz/accounts')
    expect(apiRequest?.headers.get('Authorization')).toBe('Bearer tok-1')
  })

  it('reuses an unexpired token instead of minting per request', async () => {
    const source = braleFetchSource()
    await source.fetch(generatedRequest({ path: '/accounts' }))
    await source.fetch(generatedRequest({ path: '/transfer-types' }))

    expect(tokenCalls()).toHaveLength(1)
    expect(apiCalls()).toHaveLength(2)
  })

  it('shares one mint across concurrent cold-cache requests', async () => {
    const source = braleFetchSource()
    await Promise.all([
      source.fetch(generatedRequest({ path: '/accounts' })),
      source.fetch(generatedRequest({ path: '/transfer-types' })),
    ])

    expect(tokenCalls()).toHaveLength(1)
  })

  it('does not reuse a token whose remaining lifetime is inside the safety margin', async () => {
    // 30s of lifetime is less than the 60s margin: an in-flight request could
    // outlive it, so it must never be served from cache.
    fetchMock.mockImplementation(async (request: Request) =>
      isTokenRequest(request)
        ? tokenResponse({ expires_in: 30 })
        : new Response('{}', { status: 200 }),
    )
    const source = braleFetchSource()
    await source.fetch(generatedRequest({ path: '/accounts' }))
    await source.fetch(generatedRequest({ path: '/accounts' }))

    expect(tokenCalls()).toHaveLength(2)
  })

  it('reports a rejected client pair as a typed error naming the auth host', async () => {
    fetchMock.mockImplementation(async (request: Request) =>
      isTokenRequest(request)
        ? new Response('invalid_client', { status: 401 })
        : new Response('{}', { status: 200 }),
    )

    const error = (await Promise.resolve(
      braleFetchSource().fetch(generatedRequest({ path: '/accounts' })),
    ).catch((caught: unknown) => caught)) as TokenEndpointError

    expect(error).toBeInstanceOf(TokenEndpointError)
    expect(error.code).toBe('AUTH_HTTP_401')
    expect(error.message).toContain('auth.brale.xyz')
    expect(error.retryable).toBe(false)
  })

  it('recovers after a failed mint instead of caching the rejection', async () => {
    // The failure mode that matters in incur's long-lived serve modes
    // (`--mcp`): one 500 from the token endpoint must not poison every later
    // call in the process.
    fetchMock.mockImplementationOnce(async () => new Response('oops', { status: 500 }))

    const source = braleFetchSource()
    const first = (await Promise.resolve(
      source.fetch(generatedRequest({ path: '/accounts' })),
    ).catch((caught: unknown) => caught)) as { code?: string; retryable?: boolean }
    expect(first.code).toBe('AUTH_HTTP_500')
    expect(first.retryable).toBe(true)

    await source.fetch(generatedRequest({ path: '/accounts' }))
    expect(apiCalls().at(-1)?.headers.get('Authorization')).toBe('Bearer tok-1')
  })

  it('recovers after a failed credential resolution instead of caching the rejection', async () => {
    vi.stubEnv('BRALE_CLIENT_ID', undefined)
    const source = braleFetchSource()

    const first = (await Promise.resolve(
      source.fetch(generatedRequest({ path: '/accounts' })),
    ).catch((caught: unknown) => caught)) as { code?: string }
    expect(first.code).toBe('CREDENTIALS')

    // The operator exports the pair and retries the same long-lived process.
    vi.stubEnv('BRALE_CLIENT_ID', 'client-id')
    await source.fetch(generatedRequest({ path: '/accounts' }))
    expect(apiCalls()).toHaveLength(1)
  })

  it('rejects a token response with no usable access_token as a typed error', async () => {
    fetchMock.mockImplementation(async (request: Request) =>
      isTokenRequest(request)
        ? tokenResponse({ access_token: 'bad\ntoken' })
        : new Response('{}', { status: 200 }),
    )

    const error = (await Promise.resolve(
      braleFetchSource().fetch(generatedRequest({ path: '/accounts' })),
    ).catch((caught: unknown) => caught)) as { code?: string; message: string }
    expect(error.code).toBe('AUTH_MALFORMED_TOKEN')
    // The malformed token must not be echoed.
    expect(error.message).not.toContain('bad')
  })

  it('re-parses contract-declared container flags before the body leaves the process', async () => {
    // What incur's generated handler actually produces for
    // `create_transfer --source '{...}'`: the object flag survives as a
    // JSON *string*, which Brale rejects on every create.
    await braleFetchSource().fetch(
      generatedRequest({
        path: '/accounts/2VZvtmVc2j3gQ80CTlcuQXbGrwC/transfers',
        method: 'POST',
        body: {
          amount: '{"value":"10","currency":"USD"}',
          source: '{"value_type":"USD","transfer_type":"wire"}',
          destination: '{"value_type":"SBC","transfer_type":"base"}',
          note: 'invoice 42',
        },
      }),
    )

    const [sent] = apiCalls()
    const body = (await sent?.json()) as Record<string, unknown>
    expect(body.amount).toEqual({ value: '10', currency: 'USD' })
    expect(body.source).toEqual({ value_type: 'USD', transfer_type: 'wire' })
    expect(body.destination).toEqual({ value_type: 'SBC', transfer_type: 'base' })
    expect(body.note).toBe('invoice 42')
  })

  it('restores flattened pagination flags to Brale bracketed query parameters', async () => {
    await braleFetchSource().fetch(
      generatedRequest({ path: '/accounts?page_size=1&page_after=next-page' }),
    )

    const [sent] = apiCalls()
    const url = new URL(sent?.url ?? '')
    expect(url.searchParams.get('page[size]')).toBe('1')
    expect(url.searchParams.get('page[after]')).toBe('next-page')
    expect(url.searchParams.has('page_size')).toBe(false)
    expect(url.searchParams.has('page_after')).toBe(false)
  })

  it('reports a container flag that is not JSON as a typed error naming the flag', async () => {
    const error = (await Promise.resolve(
      braleFetchSource().fetch(
        generatedRequest({
          path: '/accounts/2VZvtmVc2j3gQ80CTlcuQXbGrwC/transfers',
          method: 'POST',
          body: { source: 'usdc' },
        }),
      ),
    ).catch((caught: unknown) => caught)) as { code?: string; message: string }

    expect(error.code).toBe('INVALID_JSON_FLAG')
    expect(error.message).toContain('--source')
  })

  it('constructs without credentials or a reachable Brale', () => {
    vi.stubEnv('BRALE_CLIENT_ID', undefined)
    vi.stubEnv('BRALE_CLIENT_SECRET', undefined)
    const source = braleFetchSource()
    expect(source.url).toBeInstanceOf(URL)
  })

  it('turns a malformed API base URL into a named error at request time, not import time', async () => {
    vi.stubEnv('BRALE_API_BASE_URL', 'not-a-url')

    // Construction — the path `--help` exercises — must survive.
    const source = braleFetchSource()
    expect(source.url).toBeInstanceOf(URL)

    const error = (await Promise.resolve(
      source.fetch(generatedRequest({ path: '/accounts' })),
    ).catch((caught: unknown) => caught)) as { code?: string; message: string }
    expect(error.code).toBe('INVALID_BASE_URL')
    expect(error.message).toContain('BRALE_API_BASE_URL')
  })

  it('turns a malformed auth base URL into a named error as well', async () => {
    vi.stubEnv('BRALE_AUTH_BASE_URL', 'not-a-url')

    const error = (await Promise.resolve(
      braleFetchSource().fetch(generatedRequest({ path: '/accounts' })),
    ).catch((caught: unknown) => caught)) as { code?: string; message: string }
    expect(error.code).toBe('INVALID_BASE_URL')
    expect(error.message).toContain('BRALE_AUTH_BASE_URL')
  })

  it('rejects a base URL whose scheme is not http(s)', async () => {
    // `localhost:8080` PARSES as a URL — scheme `localhost:`, path `8080` — so
    // the parse-failure branch never fires and the request would leave with a
    // nonsense target. It must fail with the same named error instead.
    vi.stubEnv('BRALE_API_BASE_URL', 'localhost:8080')

    const error = (await Promise.resolve(
      braleFetchSource().fetch(generatedRequest({ path: '/accounts' })),
    ).catch((caught: unknown) => caught)) as { code?: string; message: string }
    expect(error.code).toBe('INVALID_BASE_URL')
    expect(error.message).toContain('BRALE_API_BASE_URL')
  })
})
