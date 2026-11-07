import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { cli } from './index.js'

/**
 * A spec refresh can remove a command, for example when Brale deprecates its
 * operation. Guidance that still names it sends operators and agents to a
 * command that no longer exists, so the documents must follow the CLI.
 */
const DOCUMENTS = ['README.md', '.agents/skills/bralecli/SKILL.md'] as const

/** Commands a document runs: fenced lines and inline code that start with `bralecli`. */
function documentedCommands(markdown: string): Set<string> {
  const commands = new Set<string>()
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    const matches = fenced
      ? [/^\s*(?:\$\s+)?bralecli\s+([a-z][a-z0-9_]*)/.exec(line)]
      : line.matchAll(/`bralecli\s+([a-z][a-z0-9_]*)/g)
    for (const match of matches) if (match?.[1]) commands.add(match[1])
  }
  return commands
}

async function availableCommands(): Promise<Set<string>> {
  let output = ''
  await cli.serve(['--llms', '--format', 'json'], {
    stdout: (text) => {
      output += text
    },
    exit: (code) => {
      if (code !== 0) throw new Error(`CLI exited with ${code}`)
    },
  })
  const manifest = JSON.parse(output) as { commands: { name: string }[] }
  return new Set(manifest.commands.map(({ name }) => name.split(' ')[0] ?? name))
}

describe('the documented command lines', () => {
  it.each(DOCUMENTS)('%s runs only commands the CLI has', async (document) => {
    const markdown = readFileSync(new URL(`../../../${document}`, import.meta.url), 'utf8')
    const documented = documentedCommands(markdown)
    // Guards the extractor itself: matching nothing would pass vacuously.
    expect(documented).toContain('list_accounts')

    const available = await availableCommands()
    expect([...documented].filter((command) => !available.has(command))).toEqual([])
  })
})
