/**
 * Resolving the Brale OAuth client credentials.
 *
 * Neither half is ever a command-line flag, and the CLI never offers one. argv
 * is world-readable on a shared host, lands in shell history, and is captured
 * verbatim in agent transcripts and CI logs — a credential that reaches any of
 * those is burned. Only two paths exist per value: an environment variable, or
 * a 1Password secret reference resolved through the `op` CLI and held in
 * process memory for the life of the command.
 *
 * A secret REFERENCE (`op://vault/item/field`) is not itself a secret and is
 * safe to configure, commit, and print. The values are not, and never leave
 * this module except inside the Basic header of the token request.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { Errors } from 'incur'

const execFileAsync = promisify(execFile)

/** Environment variable holding the OAuth client id directly. */
export const CLIENT_ID_ENV = 'BRALE_CLIENT_ID'

/** Environment variable holding an `op://` reference to the client id. */
export const CLIENT_ID_REF_ENV = 'BRALE_CLIENT_ID_REF'

/** Environment variable holding the OAuth client secret directly. */
export const CLIENT_SECRET_ENV = 'BRALE_CLIENT_SECRET'

/** Environment variable holding an `op://` reference to the client secret. */
export const CLIENT_SECRET_REF_ENV = 'BRALE_CLIENT_SECRET_REF'

/** Environment variable overriding the API base URL. */
export const API_BASE_URL_ENV = 'BRALE_API_BASE_URL'

/** Environment variable overriding the OAuth token host. */
export const AUTH_BASE_URL_ENV = 'BRALE_AUTH_BASE_URL'

/**
 * Typed so `serve()` reports it as `CREDENTIALS` rather than `UNKNOWN`: a
 * script wrapping this CLI must be able to tell "sign in and retry" apart from
 * a network failure without parsing prose.
 */
export class CredentialError extends Errors.IncurError {
  override readonly name = 'CredentialError'

  constructor(message: string) {
    super({ code: 'CREDENTIALS', message, retryable: false })
  }
}

/**
 * Printable ASCII with no whitespace — every real OAuth client value, and
 * nothing that corrupts the Basic credential pair. The check exists because a
 * value with a stray newline (a multiline 1Password field, a paste accident)
 * must fail HERE, where the message names the source and never the value. The
 * client id additionally rejects `:`, which Basic auth reserves as the
 * id/secret separator.
 */
const HEADER_SAFE_VALUE = /^[!-~]+$/

function assertHeaderSafe(value: string, source: string): string {
  if (!HEADER_SAFE_VALUE.test(value)) {
    throw new CredentialError(
      `the value from ${source} contains whitespace, newlines, or non-ASCII characters and cannot be used as an OAuth credential. The value itself was not printed.`,
    )
  }
  return value
}

export type ResolveOptions = {
  env?: NodeJS.ProcessEnv
  /** Injected by tests so resolution can be driven without a real `op` binary. */
  readSecret?: (reference: string) => Promise<string>
}

/** Reads a secret reference with the 1Password CLI. */
async function readWithOp(reference: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('op', ['read', '--no-newline', reference])
    return stdout
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // `op` writes the reference, never the value, on failure — safe to surface.
    throw new CredentialError(`could not read ${reference} with the 1Password CLI: ${detail}`)
  }
}

async function resolveValue(options: {
  env: NodeJS.ProcessEnv
  readSecret: (reference: string) => Promise<string>
  directEnv: string
  referenceEnv: string
}): Promise<string> {
  const direct = options.env[options.directEnv]
  if (direct) return assertHeaderSafe(direct, options.directEnv)

  const reference = options.env[options.referenceEnv]
  if (reference) {
    const value = await options.readSecret(reference)
    if (!value) throw new CredentialError(`${reference} resolved to an empty value`)
    return assertHeaderSafe(value, reference)
  }

  throw new CredentialError(
    `no Brale OAuth credentials. Set ${options.directEnv}, or set ${options.referenceEnv} to an op:// reference and sign in with \`op signin\`.`,
  )
}

export type ClientCredentials = {
  clientId: string
  clientSecret: string
}

/**
 * Returns the OAuth client pair, preferring explicit environment values over
 * 1Password references so a CI runner with injected secrets does not need
 * `op` installed.
 */
export async function resolveClientCredentials(
  options: ResolveOptions = {},
): Promise<ClientCredentials> {
  const env = options.env ?? process.env
  const readSecret = options.readSecret ?? readWithOp

  const clientId = await resolveValue({
    env,
    readSecret,
    directEnv: CLIENT_ID_ENV,
    referenceEnv: CLIENT_ID_REF_ENV,
  })
  if (clientId.includes(':')) {
    throw new CredentialError(
      `the client id from ${CLIENT_ID_ENV}/${CLIENT_ID_REF_ENV} contains ':', which Basic auth reserves as the id/secret separator. The value itself was not printed.`,
    )
  }

  const clientSecret = await resolveValue({
    env,
    readSecret,
    directEnv: CLIENT_SECRET_ENV,
    referenceEnv: CLIENT_SECRET_REF_ENV,
  })

  return { clientId, clientSecret }
}

/** Returns a base-URL override, letting an operator point the CLI at a non-production host. */
export function resolveBaseUrlOverride(options: {
  env?: NodeJS.ProcessEnv
  variable: string
}): string | undefined {
  const env = options.env ?? process.env
  return env[options.variable] || undefined
}
