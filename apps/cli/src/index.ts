/**
 * bralecli — a CLI for the Brale API.
 *
 * The generated command surface is the product: every operation in the vendored
 * OpenAPI document, typed, named by its `operationId` (Brale declares one on
 * every operation, so commands match the docs verbatim: `create_transfer`,
 * `list_accounts`). Application-specific reconciliation belongs to the
 * consuming application; this CLI exposes the Brale API contract.
 *
 * `constrainPathParameters` is not cosmetic: the generator interpolates path
 * arguments verbatim, and every path parameter in Brale's document is a
 * `$ref` to an `ID` schema that declares no pattern at all — so without the
 * constraint, `get_transfer '../other'` retargets the request after URL
 * normalization.
 *
 * The same preparation flattens object-valued query parameters into scalar
 * flags. incur cannot parse an object from argv and would stringify a
 * programmatic object as `[object Object]`; the client restores Brale's
 * bracketed deep-object names immediately before sending the request.
 *
 * `security: false` because the token is injected as a per-request header,
 * never taken from argv. incur today synthesizes no flag for an `oauth2`
 * scheme, but this is declared intent, not an optimization: if a future incur
 * learns to, a credential flag is a credential leaked to shell history, `ps`,
 * and every agent transcript.
 */
import { prepareSpecForCli, spec } from '@bralecli/brale'
import { Cli } from 'incur'

import { braleFetchSource } from './client.js'

export const cli = Cli.create('bralecli', {
  description: 'CLI for the Brale API',
  fetch: braleFetchSource(),
  openapi: prepareSpecForCli(spec),
  openapiConfig: { security: false },
})
