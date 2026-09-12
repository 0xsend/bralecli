/**
 * The Brale OpenAPI document, vendored.
 *
 * Brale serves a machine-readable contract from the API host itself —
 * unauthenticated, but unlinked from the docs site (docs.brale.xyz renders it
 * behind a bot challenge and never names the source). The endpoint carries no
 * version in its URL and the document's `info.version` is a constant, so
 * upstream can change the contract with no bump and no signal.
 *
 * The document is therefore committed rather than fetched. A vendored copy
 * makes the contract a reviewable artifact: manual refreshes and the daily
 * spec-update PR show exactly what Brale changed, which is the only notice we get.
 * Fetching at startup would trade that for a CLI whose command surface
 * silently changes shape between two runs.
 */
import { createRequire } from 'node:module'

/**
 * Minimal structural view of an OpenAPI document. Deliberately not the full
 * type: this package only needs to hand the parsed document to a consumer.
 */
export type OpenApiDocument = {
  openapi: string
  info: { title: string; version: string }
  servers?: { url: string; description?: string }[]
  paths: Record<string, Record<string, unknown>>
  components?: Record<string, unknown>
}

/** Where the vendored document came from. Refreshing reads this, not a doc page. */
export const SPEC_SOURCE_URL: string = 'https://api.brale.xyz/openapi'

/**
 * SHA-256 of the vendored document, recorded when it was fetched. `spec:refresh`
 * compares against this so a no-op refresh is visibly a no-op.
 */
export const SPEC_SHA256: string =
  '42a95c325802ce123946a53a28cb47e5006941cb6ef300f2eb2cf2c63889dfd2'

/** When `SPEC_SHA256` was observed at `SPEC_SOURCE_URL`. */
export const SPEC_FETCHED_AT: string = '2026-09-12'

/** The single server the document advertises, and the only API host this CLI talks to. */
export const BRALE_API_BASE_URL: string = 'https://api.brale.xyz'

/**
 * OAuth2 token endpoint. Not in the document (the spec declares the flow but
 * hosts token minting on a separate origin); mirrored from Brale's
 * authentication docs and the production integration.
 */
export const BRALE_AUTH_BASE_URL: string = 'https://auth.brale.xyz'

/** Path of the client-credentials token endpoint under the auth origin. */
export const BRALE_TOKEN_PATH: string = '/oauth2/token'

/**
 * Read through `createRequire` rather than a static `import ... with { type:
 * 'json' }`: a static import makes tsc infer a literal type for the whole
 * document, which costs typecheck time and memory for a value nothing
 * benefits from having narrowed.
 */
const require = createRequire(import.meta.url)

/** The vendored Brale OpenAPI document. */
export const spec: OpenApiDocument = require('../openapi/brale.json') as OpenApiDocument
