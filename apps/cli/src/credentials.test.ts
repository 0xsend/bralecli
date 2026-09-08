import { describe, expect, it, vi } from 'vitest'

import {
  CLIENT_ID_ENV,
  CLIENT_ID_REF_ENV,
  CLIENT_SECRET_ENV,
  CLIENT_SECRET_REF_ENV,
  CredentialError,
  resolveClientCredentials,
} from './credentials.js'

const DIRECT = { [CLIENT_ID_ENV]: 'client-id', [CLIENT_SECRET_ENV]: 'client-secret' }

describe('resolveClientCredentials', () => {
  it('prefers directly supplied environment values', async () => {
    const readSecret = vi.fn(async () => 'from-op')
    const pair = await resolveClientCredentials({ env: { ...DIRECT }, readSecret })
    expect(pair).toEqual({ clientId: 'client-id', clientSecret: 'client-secret' })
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('falls back to 1Password references per value', async () => {
    const readSecret = vi.fn(async (reference: string) =>
      reference.endsWith('id') ? 'op-id' : 'op-secret',
    )
    const pair = await resolveClientCredentials({
      env: {
        [CLIENT_ID_REF_ENV]: 'op://vault/item/id',
        [CLIENT_SECRET_REF_ENV]: 'op://vault/item/secret',
      },
      readSecret,
    })
    expect(pair).toEqual({ clientId: 'op-id', clientSecret: 'op-secret' })
    expect(readSecret).toHaveBeenCalledWith('op://vault/item/id')
    expect(readSecret).toHaveBeenCalledWith('op://vault/item/secret')
  })

  it('rejects an empty resolved secret rather than minting with a blank half', async () => {
    await expect(
      resolveClientCredentials({
        env: { [CLIENT_ID_ENV]: 'client-id', [CLIENT_SECRET_REF_ENV]: 'op://vault/item/secret' },
        readSecret: async () => '',
      }),
    ).rejects.toBeInstanceOf(CredentialError)
  })

  it('explains both options when nothing is configured', async () => {
    const error = (await resolveClientCredentials({ env: {} }).catch(
      (caught: unknown) => caught,
    )) as Error
    expect(error).toBeInstanceOf(CredentialError)
    expect(error.message).toContain(CLIENT_ID_ENV)
    expect(error.message).toContain(CLIENT_ID_REF_ENV)
  })

  it('rejects a secret with an interior newline before it can reach a Headers constructor', async () => {
    // `op read --no-newline` strips only the trailing newline; a multiline
    // 1Password field keeps its interior ones, and undici's Headers TypeError
    // echoes the whole invalid value into the terminal. The rejection has to
    // happen here, where the message can name the source instead.
    const secret = 'sec\nret-value'
    const error = (await resolveClientCredentials({
      env: { [CLIENT_ID_ENV]: 'client-id', [CLIENT_SECRET_REF_ENV]: 'op://vault/item/secret' },
      readSecret: async () => secret,
    }).catch((caught: unknown) => caught)) as Error

    expect(error).toBeInstanceOf(CredentialError)
    expect(error.message).toContain('op://vault/item/secret')
    expect(error.message).not.toContain(secret)
    expect(error.message).not.toContain('sec\n')
  })

  it('rejects a direct environment value with spaces, naming the variable', async () => {
    const error = (await resolveClientCredentials({
      env: { ...DIRECT, [CLIENT_ID_ENV]: 'id with spaces' },
    }).catch((caught: unknown) => caught)) as Error

    expect(error).toBeInstanceOf(CredentialError)
    expect(error.message).toContain(CLIENT_ID_ENV)
    expect(error.message).not.toContain('id with spaces')
  })

  it('rejects a client id containing the Basic-auth separator, without echoing it', async () => {
    // `id:secret` is joined with `:` before base64 encoding; a colon inside the
    // id silently shifts everything after it into the secret and the pair
    // authenticates as garbage. Better a named error here than a 401 there.
    const error = (await resolveClientCredentials({
      env: { ...DIRECT, [CLIENT_ID_ENV]: 'client:id' },
    }).catch((caught: unknown) => caught)) as Error

    expect(error).toBeInstanceOf(CredentialError)
    expect(error.message).toContain(':')
    expect(error.message).not.toContain('client:id')
  })

  it('carries a machine-readable code for scripts to branch on', async () => {
    const error = (await resolveClientCredentials({ env: {} }).catch(
      (caught: unknown) => caught,
    )) as { code?: string }
    expect(error.code).toBe('CREDENTIALS')
  })
})
