/**
 * Wiring OAuth into the generated request path, lazily.
 *
 * Lazily matters more than it looks. Minting a token at module load would make
 * `--help`, `--llms`, shell completion and every dry run demand live
 * credentials, which is both hostile and a good way to train operators to
 * export secrets into their shell permanently. Nothing here touches a
 * credential — or validates configuration — until a command actually needs to
 * reach Brale.
 */
import {
  BRALE_API_BASE_URL,
  BRALE_AUTH_BASE_URL,
  BRALE_TOKEN_PATH,
  BodyValueError,
  coerceJsonBodyText,
  restoreObjectQueryParameters,
  spec,
} from '@brale/brale'
import { Errors, Fetch } from 'incur'

import {
  API_BASE_URL_ENV,
  AUTH_BASE_URL_ENV,
  resolveBaseUrlOverride,
  resolveClientCredentials,
} from './credentials.js'

/**
 * Refresh this long before Brale's stated expiry so an in-flight request never
 * races a just-expired token.
 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000

const TOKEN_REQUEST_TIMEOUT_MS = 30_000

/** The API base URL every generated request goes to, unvalidated. */
export function apiBaseUrl(): string {
  return resolveBaseUrlOverride({ variable: API_BASE_URL_ENV }) ?? BRALE_API_BASE_URL
}

function authBaseUrl(): string {
  return resolveBaseUrlOverride({ variable: AUTH_BASE_URL_ENV }) ?? BRALE_AUTH_BASE_URL
}

/** A base URL as an http(s) URL, or a clean, named error — never a raw TypeError. */
function validatedUrl(raw: string, variable: string, fallback: string): URL {
  const invalid = () =>
    new Errors.IncurError({
      code: 'INVALID_BASE_URL',
      message: `${variable} is not an http(s) URL`,
      hint: `Unset ${variable}, or set it to a full URL, e.g. ${fallback}`,
    })

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid()
  }
  // `localhost:8080` PARSES — scheme `localhost:`, path `8080` — so a parse
  // check alone would let a nonsense target through to fetch.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid()
  return url
}

/**
 * A non-2xx response from the token endpoint. Carries a typed HTTP code and
 * names the host it hit, so an auth failure against the wrong environment is
 * self-diagnosing instead of an UNKNOWN with a bare path.
 */
export class TokenEndpointError extends Errors.IncurError {
  override readonly name = 'TokenEndpointError'

  constructor(options: { status: number; host: string; body: string }) {
    super({
      code: `AUTH_HTTP_${options.status}`,
      message: `Brale token endpoint at ${options.host} answered ${options.status}: ${options.body}`,
      retryable: options.status >= 500,
      hint:
        options.status === 401 || options.status === 403
          ? 'The client id/secret pair was rejected. Check the credentials match the host (production vs sandbox).'
          : undefined,
    })
  }
}

type CachedToken = { accessToken: string; expiresAt: number }

let cachedToken: CachedToken | undefined
/** In-flight mint, shared by concurrent callers; cleared once it settles. */
let tokenMint: Promise<string> | undefined

/** Drops all cached auth state so tests can drive failure and recovery. */
export function resetAuthCacheForTesting(): void {
  cachedToken = undefined
  tokenMint = undefined
}

async function mintAccessToken(): Promise<string> {
  const { clientId, clientSecret } = await resolveClientCredentials()
  const authUrl = validatedUrl(authBaseUrl(), AUTH_BASE_URL_ENV, BRALE_AUTH_BASE_URL)
  const endpoint = new URL(BRALE_TOKEN_PATH, authUrl)

  const response = await fetch(
    new Request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    }),
  )
  if (!response.ok) {
    throw new TokenEndpointError({
      status: response.status,
      host: endpoint.host,
      body: (await response.text()).slice(0, 300),
    })
  }

  const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown }
  const minted = typeof payload.access_token === 'string' ? payload.access_token : undefined
  if (!minted || !/^[!-~]+$/.test(minted)) {
    // The token goes straight into a header; a malformed one would otherwise
    // surface as a Headers TypeError echoing the credential verbatim.
    throw new Errors.IncurError({
      code: 'AUTH_MALFORMED_TOKEN',
      message: `Brale token endpoint at ${endpoint.host} returned no usable access_token`,
    })
  }

  const expiresInSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 0
  cachedToken = {
    accessToken: minted,
    expiresAt: Date.now() + Math.max(expiresInSeconds * 1000 - TOKEN_EXPIRY_MARGIN_MS, 0),
  }
  return minted
}

/**
 * A valid token, minted at most once per expiry window. Only a successful mint
 * is cached — a rejection would otherwise poison every later call in incur's
 * long-lived serve modes (`--mcp`), where "fix the credentials and retry" must
 * actually work. Concurrent callers on a cold token share one mint.
 */
async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.accessToken
  if (tokenMint) return tokenMint

  const mint = mintAccessToken().finally(() => {
    if (tokenMint === mint) tokenMint = undefined
  })
  tokenMint = mint
  return mint
}

/**
 * Returns the request with contract-declared container properties re-parsed
 * from their flag-string form. The generated commands receive every body
 * property as an argv string, and an object that survives as a JSON string is
 * a body Brale rejects on every write — including `create_transfer`.
 */
async function withCoercedBody(request: Request): Promise<Request> {
  if (request.body === null) return request

  // Read from a clone: a Request constructed from a consumed one throws, and
  // the untouched original is returned when there is nothing to repair.
  const bodyText = await request.clone().text()
  let coerced: string
  try {
    coerced = coerceJsonBodyText(spec, {
      method: request.method,
      pathname: new URL(request.url).pathname,
      bodyText,
    })
  } catch (error) {
    if (error instanceof BodyValueError) {
      throw new Errors.IncurError({
        code: 'INVALID_JSON_FLAG',
        message: error.message,
        cause: error,
      })
    }
    throw error
  }

  if (coerced === bodyText) return request
  // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- unreachable for GET/HEAD: guarded above by `request.body === null`.
  return new Request(request, { body: coerced })
}

/** Restores normalized CLI flag names to Brale's bracketed pagination form. */
function withRestoredQuery(request: Request): Request {
  const url = new URL(request.url)
  const changed = restoreObjectQueryParameters(spec, {
    method: request.method,
    pathname: url.pathname,
    searchParams: url.searchParams,
  })
  return changed ? new Request(url, request) : request
}

/**
 * A fetch source for the generated `api` commands: incur's own
 * `Fetch.fromRequest`, with a Bearer token minted lazily per expiry window and
 * generated bodies repaired against the spec.
 *
 * The `url` property is only used to resolve relative OpenAPI documents — ours
 * is vendored — so a malformed ${API_BASE_URL_ENV} falls back to the default
 * here rather than crashing `--help` at import; the named error surfaces from
 * `fetch`, on the first command that actually needs the value.
 */
export function braleFetchSource(): Fetch.RequestSource {
  let registrationUrl: URL
  try {
    registrationUrl = new URL(apiBaseUrl())
  } catch {
    registrationUrl = new URL(BRALE_API_BASE_URL)
  }

  return {
    url: registrationUrl,
    async fetch(request: Request): Promise<Response> {
      const target = validatedUrl(apiBaseUrl(), API_BASE_URL_ENV, BRALE_API_BASE_URL)
      const source = Fetch.fromRequest(target, {
        headers: { Authorization: `Bearer ${await accessToken()}` },
      })
      return await source.fetch(withRestoredQuery(await withCoercedBody(request)))
    },
  }
}
