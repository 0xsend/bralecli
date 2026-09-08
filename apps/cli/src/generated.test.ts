import { prepareSpecForCli, spec } from '@brale/brale'
import { Openapi } from 'incur'
import { describe, expect, it } from 'vitest'

/**
 * The integration claims the normalizer and the command config exist to make
 * true: that incur, reading Brale's document, produces commands that address a
 * resource safely.
 *
 * Asserted through incur's real generator rather than a hand-built fixture,
 * because the failure guarded against is a disagreement between two real
 * components — an incur upgrade that changes operation-mode naming or starts
 * anchoring path arguments itself should show up here, not in production.
 */

const config = { security: false } as const

type Leaf = {
  args?: { shape?: object; safeParse?: (input: unknown) => { success: boolean } }
  options?: { shape?: object; safeParse?: (input: unknown) => { success: boolean } }
}

async function generate(document: unknown): Promise<Map<string, Leaf>> {
  return (await Openapi.generateCommands(document as never, () => new Response(null), {
    config,
  })) as unknown as Map<string, Leaf>
}

/** The document's own ID example — a KSUID, the shape every real Brale id has. */
const KSUID = '2VZvtmVc2j3gQ80CTlcuQXbGrwC'

describe('commands generated from the Brale document', () => {
  it('names commands by operationId, matching the Brale docs verbatim', async () => {
    const commands = await generate(prepareSpecForCli(spec))
    for (const name of ['list_accounts', 'get_transfer', 'create_transfer', 'get_automation'])
      expect(commands.has(name), name).toBe(true)
  })

  it('takes path parameters as positional args in path order', async () => {
    // Order matters: these are positional arguments, and a swap would send
    // each id into the other's segment while every containment check passes.
    const commands = await generate(prepareSpecForCli(spec))
    expect(Object.keys(commands.get('get_transfer')?.args?.shape ?? {})).toEqual([
      'account_id',
      'transfer_id',
    ])
  })

  it('exposes create_transfer body properties as flags', async () => {
    const commands = await generate(prepareSpecForCli(spec))
    const options = Object.keys(commands.get('create_transfer')?.options?.shape ?? {})
    expect(options).toEqual(expect.arrayContaining(['amount', 'source', 'destination', 'note']))
  })

  it('exposes object-valued pagination as validated scalar flags', async () => {
    // incur cannot parse an object option from argv, and its request builder
    // would stringify one as `[object Object]` even if it could. The CLI shape
    // must therefore expose the contract's page members individually.
    const commands = await generate(prepareSpecForCli(spec))
    const schema = commands.get('list_accounts')?.options
    const options = Object.keys(schema?.shape ?? {})
    expect(options).toEqual(expect.arrayContaining(['page_size', 'page_after', 'page_before']))
    expect(options).not.toContain('page')
    if (!schema?.safeParse) throw new Error('generated command has no options schema')
    expect(schema.safeParse({ page_size: '1' }).success).toBe(true)
    expect(schema.safeParse({ page_size: '1000' }).success).toBe(true)
    expect(schema.safeParse({ page_size: '0' }).success).toBe(false)
    expect(schema.safeParse({ page_size: '1001' }).success).toBe(false)
  })

  it('accepts a traversal id when the raw document is used', async () => {
    // The bug, demonstrated rather than asserted: the ID schema carries no
    // pattern, incur interpolates path arguments into the URL template
    // verbatim, and URL normalization then applies `../` — so a raw-document
    // command would let `get_transfer` address a different resource.
    const commands = await generate(spec)
    const args = commands.get('get_transfer')?.args
    if (!args?.safeParse) throw new Error('generated command has no args schema')
    expect(args.safeParse({ account_id: KSUID, transfer_id: '../other' }).success).toBe(true)
  })

  it('rejects every traversal shape once the document is constrained', async () => {
    const commands = await generate(prepareSpecForCli(spec))
    const accountArgs = commands.get('get_account')?.args
    const transferArgs = commands.get('get_transfer')?.args
    if (!accountArgs?.safeParse || !transferArgs?.safeParse)
      throw new Error('generated command has no args schema')

    expect(accountArgs.safeParse({ account_id: KSUID }).success).toBe(true)
    expect(transferArgs.safeParse({ account_id: KSUID, transfer_id: KSUID }).success).toBe(true)
    for (const hostile of ['.', '..', '../accounts/other', 'a/b', 'a\\b', '%2e%2e%2faccounts']) {
      expect(accountArgs.safeParse({ account_id: hostile }).success, hostile).toBe(false)
      expect(
        transferArgs.safeParse({ account_id: KSUID, transfer_id: hostile }).success,
        hostile,
      ).toBe(false)
    }
  })

  it('generates no credential flag on any command', async () => {
    // `security: false` in the command config is what this pins. incur today
    // synthesizes no flag for an oauth2 scheme even without it, so this is the
    // tripwire that keeps a future incur from quietly adding one.
    const commands = await generate(prepareSpecForCli(spec))
    for (const [name, leaf] of commands) {
      const options = Object.keys(leaf.options?.shape ?? {})
      expect(options, name).not.toContain('authorization')
    }
  })
})
