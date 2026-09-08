import { describe, expect, it } from 'vitest'

import { cli } from './index.js'

async function help(args: string[]): Promise<string> {
  let output = ''
  await cli.serve([...args, '--help'], {
    stdout: (text) => {
      output += text
    },
    exit: (code) => {
      if (code !== 0) throw new Error(`CLI exited with ${code}`)
    },
  })
  return output
}

describe('direct command interface', () => {
  it('lists Brale operations at the root', async () => {
    const output = await help([])
    expect(output).toContain('list_accounts')
    expect(output).toContain('create_transfer')
    expect(output).not.toMatch(/^\s+api\s/m)
  })

  it.each(['list_accounts', 'get_account', 'create_transfer'])(
    'exposes %s without an api prefix',
    async (command) => {
      expect(await help([command])).toContain(`Usage: bralecli ${command}`)
    },
  )

  it.each(['completions', 'mcp', 'skills'])('preserves %s help', async (command) => {
    expect(await help([command])).toContain(`Usage: bralecli ${command}`)
  })
})
