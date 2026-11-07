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
 * The fetch source receives the same prepared contract and refuses any request
 * that no generated command could have built. incur routes argv naming no
 * command to it as a raw path, and that must fail locally rather than reach
 * Brale with a token and the caller's values in the query string.
 *
 * `security: false` because the token is injected as a per-request header,
 * never taken from argv. incur today synthesizes no flag for an `oauth2`
 * scheme, but this is declared intent, not an optimization: if a future incur
 * learns to, a credential flag is a credential leaked to shell history, `ps`,
 * and every agent transcript.
 */
import { readFileSync } from 'node:fs'

import { prepareSpecForCli, spec } from '@bralecli/brale'
import { Binary, Cli } from 'incur'

import { agents } from './agent-skills.js'
import { braleFetchSource } from './client.js'

/**
 * Release binaries embed their version. A checkout has none, and incur then
 * treats `--version` as a root request: the skill's first discovery step would
 * reach the fetch source instead of printing a version.
 */
function checkoutVersion(): string {
  const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  return (JSON.parse(manifest) as { version: string }).version
}

const contract = prepareSpecForCli(spec)

export const cli = Cli.create('bralecli', {
  description: 'CLI for the Brale API',
  fetch: braleFetchSource(contract),
  openapi: contract,
  openapiConfig: { security: false },
  version: Binary.version ?? checkoutVersion(),
}).command(agents)
