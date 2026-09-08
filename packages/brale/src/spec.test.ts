import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  BRALE_API_BASE_URL,
  BRALE_AUTH_BASE_URL,
  BRALE_TOKEN_PATH,
  SPEC_SHA256,
  spec,
} from './spec.js'

const specPath = fileURLToPath(new URL('../openapi/brale.json', import.meta.url))

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

type OperationLike = {
  operationId?: string
  parameters?: { name?: string; in?: string; schema?: { $ref?: string } }[]
}

function operations(): { method: string; path: string; operation: OperationLike }[] {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => item[method]).map((method) => ({
      method,
      path,
      operation: item[method] as OperationLike,
    })),
  )
}

describe('the vendored spec', () => {
  it('matches its recorded checksum', () => {
    // Brale serves this document from an unversioned endpoint with a constant
    // info.version. The pin is what makes a refresh a reviewable event instead
    // of a silent one.
    const actual = createHash('sha256').update(readFileSync(specPath)).digest('hex')
    expect(actual).toBe(SPEC_SHA256)
  })

  it('advertises the base URL the client uses', () => {
    expect(spec.servers?.map((server) => server.url)).toContain(BRALE_API_BASE_URL)
  })

  it('authenticates with the client-credentials flow at the token URL the client mints from', () => {
    // BRALE_AUTH_BASE_URL is not read from the document (the auth origin lives
    // only inside this tokenUrl), so this is the one place a moved token host
    // would surface before every command starts failing auth.
    const schemes = (
      spec.components as
        | {
            securitySchemes?: Record<
              string,
              { type?: string; flows?: { clientCredentials?: { tokenUrl?: string } } }
            >
          }
        | undefined
    )?.securitySchemes
    expect(schemes?.oauth?.type).toBe('oauth2')
    expect(schemes?.oauth?.flows?.clientCredentials?.tokenUrl).toBe(
      `${BRALE_AUTH_BASE_URL}${BRALE_TOKEN_PATH}`,
    )
  })
})

describe('the assumptions the generated surface is built on', () => {
  it('declares a unique operationId on every operation', () => {
    // Commands are generated in operation mode, named by operationId. A missing
    // one silently falls back to a method_path mangle, and a duplicate silently
    // OVERWRITES the earlier command in the map — either way an existing
    // command disappears or changes name with no other signal.
    const ids = operations().map(
      ({ method, path, operation }) => operation.operationId ?? `MISSING: ${method} ${path}`,
    )
    expect(ids.filter((id) => id.startsWith('MISSING:'))).toEqual([])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares every path parameter on the operation, not the path item', () => {
    // The reason bridgexyzctl's hoistPathParameters was NOT ported: incur reads
    // only operation-level parameters, and Brale declares them all there. If a
    // refresh moves any onto the path item, its ids silently vanish from the
    // generated command — this failing is the cue to port the hoist.
    const orphaned = Object.entries(spec.paths).filter(
      ([, item]) => (item as { parameters?: unknown[] }).parameters !== undefined,
    )
    expect(orphaned).toEqual([])

    const unresolved: string[] = []
    for (const { method, path, operation } of operations()) {
      const segments = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
      const names = new Set(
        (operation.parameters ?? [])
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name),
      )
      for (const segment of segments)
        if (!names.has(String(segment)))
          unresolved.push(`${method.toUpperCase()} ${path} -> {${segment}}`)
    }
    // One KNOWN upstream defect, pinned rather than allowlisted by shape:
    // Brale's addresses/update-link-token operation is a copy of the
    // financial-institutions one (its sibling even carries the deduped
    // operationId `create_update_link_token (2)`) and declares `fi_id`
    // where its path says `{address_id}`. The generated command cannot fill
    // that segment; nothing on this side can repair it without guessing
    // semantics. When Brale fixes the document, this assertion fails and the
    // pin — plus the README caveat — comes out.
    expect(unresolved).toEqual([
      'POST /accounts/{account_id}/addresses/{address_id}/update-link-token -> {address_id}',
    ])
  })

  it('leaves every path parameter unconstrained at the source', () => {
    // The reason constrainPathParameters exists: the ID schema carries no
    // pattern, so the raw document accepts a traversal value. If Brale starts
    // anchoring ids itself, this fails and the normalizer can be reconsidered.
    const schemas = (
      spec.components as { schemas?: Record<string, { pattern?: string }> } | undefined
    )?.schemas
    expect(schemas?.ID).toBeDefined()
    expect(schemas?.ID?.pattern).toBeUndefined()
  })
})
