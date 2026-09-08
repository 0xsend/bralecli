import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadAgentSkill } from './agent-skills.js'
import { cli } from './index.js'

async function runCli(args: string[]): Promise<{ output: string; exitCode: number }> {
  let output = ''
  let exitCode = 0
  await cli.serve(args, {
    stdout: (text) => {
      output += text
    },
    exit: (code) => {
      exitCode = code
    },
  })
  return { output, exitCode }
}

describe('agent setup', () => {
  let root: string
  let project: string
  let home: string
  let codexSkill: string
  let claudeSkill: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bralecli-agents-'))
    project = join(root, 'project')
    home = join(root, 'home')
    mkdirSync(project)
    mkdirSync(home)
    codexSkill = join(project, '.agents/skills/bralecli/SKILL.md')
    claudeSkill = join(project, '.claude/skills/bralecli/SKILL.md')
    vi.spyOn(process, 'cwd').mockReturnValue(project)
    vi.stubEnv('HOME', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
    vi.stubEnv('BRALE_CLIENT_ID', undefined)
    vi.stubEnv('BRALE_CLIENT_SECRET', undefined)
    vi.stubEnv('BRALE_CLIENT_ID_REF', undefined)
    vi.stubEnv('BRALE_CLIENT_SECRET_REF', undefined)
    vi.stubGlobal('fetch', () => {
      throw new Error('Agent setup must not use the network')
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
  })

  it('exposes credential-free curated skill installation after binary installation', async () => {
    const result = await runCli(['agents', 'install', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Usage: bralecli agents install')
    expect(result.output).toContain('--agent')
    expect(result.output).toContain('--global')
  })

  it('installs both project skills without credentials and preserves project instructions and other skills', async () => {
    writeFileSync(join(project, 'AGENTS.md'), 'Existing Codex instructions\n')
    writeFileSync(join(project, 'CLAUDE.md'), 'Existing Claude instructions\n')
    const unrelated = join(project, '.agents/skills/other/SKILL.md')
    mkdirSync(dirname(unrelated), { recursive: true })
    writeFileSync(unrelated, 'Other skill\n')

    const result = await runCli(['agents', 'install', '--json'])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output)).toEqual({
      scope: 'project',
      skills: [
        { agent: 'codex', path: codexSkill, status: 'installed' },
        { agent: 'claude', path: claudeSkill, status: 'installed' },
      ],
    })
    expect(readFileSync(codexSkill, 'utf8')).toBe(loadAgentSkill())
    expect(readFileSync(claudeSkill, 'utf8')).toBe(loadAgentSkill())
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe('Existing Codex instructions\n')
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('Existing Claude instructions\n')
    expect(readFileSync(unrelated, 'utf8')).toBe('Other skill\n')
    expect(existsSync(join(home, '.agents'))).toBe(false)
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })

  it.each(['claude', 'codex'] as const)('installs only the selected %s skill', async (agent) => {
    const result = await runCli(['agents', 'install', '--agent', agent, '--json'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output).skills).toHaveLength(1)
    expect(existsSync(codexSkill)).toBe(agent === 'codex')
    expect(existsSync(claudeSkill)).toBe(agent === 'claude')
  })

  it('installs global skills only after explicit opt in, without agent autodetection', async () => {
    const result = await runCli(['agents', 'install', '--global', '--json'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output).scope).toBe('global')
    expect(readFileSync(join(home, '.agents/skills/bralecli/SKILL.md'), 'utf8')).toBe(
      loadAgentSkill(),
    )
    expect(readFileSync(join(home, '.claude/skills/bralecli/SKILL.md'), 'utf8')).toBe(
      loadAgentSkill(),
    )
    expect(existsSync(codexSkill)).toBe(false)
    expect(existsSync(claudeSkill)).toBe(false)
  })

  it('respects the trimmed global Claude configuration directory without affecting project setup', async () => {
    const customClaude = join(root, 'custom-claude')
    vi.stubEnv('CLAUDE_CONFIG_DIR', ` ${customClaude} `)
    const global = await runCli(['agents', 'install', '--agent', 'claude', '--global', '--json'])
    expect(global.exitCode).toBe(0)
    expect(readFileSync(join(customClaude, 'skills/bralecli/SKILL.md'), 'utf8')).toBe(
      loadAgentSkill(),
    )
    expect(existsSync(join(home, '.claude'))).toBe(false)

    const local = await runCli(['agents', 'install', '--agent', 'claude'])
    expect(local.exitCode).toBe(0)
    expect(readFileSync(claudeSkill, 'utf8')).toBe(loadAgentSkill())
  })

  it('treats a whitespace-only Claude configuration directory as unset', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '  ')
    const result = await runCli(['agents', 'install', '--agent', 'claude', '--global'])
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(home, '.claude/skills/bralecli/SKILL.md'), 'utf8')).toBe(
      loadAgentSkill(),
    )
  })

  it('leaves identical skills and their mtimes unchanged, including the source skill on checkout reruns', async () => {
    for (const path of [codexSkill, claudeSkill]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, loadAgentSkill())
      utimesSync(path, new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z'))
    }
    const before = [statSync(codexSkill).mtimeMs, statSync(claudeSkill).mtimeMs]

    const first = await runCli(['agents', 'install', '--json'])
    const second = await runCli(['agents', 'install', '--json'])
    for (const result of [first, second]) {
      expect(result.exitCode).toBe(0)
      expect(
        JSON.parse(result.output).skills.map((skill: { status: string }) => skill.status),
      ).toEqual(['unchanged', 'unchanged'])
    }
    expect([statSync(codexSkill).mtimeMs, statSync(claudeSkill).mtimeMs]).toEqual(before)
  })

  it('detects a conflict in either target before installing the other skill', async () => {
    mkdirSync(dirname(claudeSkill), { recursive: true })
    writeFileSync(claudeSkill, 'Customized Claude skill\n')

    const result = await runCli(['agents', 'install', '--json'])

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain(claudeSkill)
    expect(result.output).toContain('--force')
    expect(readFileSync(claudeSkill, 'utf8')).toBe('Customized Claude skill\n')
    expect(existsSync(codexSkill)).toBe(false)
  })

  it('replaces only the selected custom skill with explicit force', async () => {
    mkdirSync(dirname(codexSkill), { recursive: true })
    writeFileSync(codexSkill, 'Customized Codex skill\n')
    writeFileSync(join(dirname(codexSkill), 'notes.md'), 'User notes\n')

    const result = await runCli(['agents', 'install', '--agent', 'codex', '--force', '--json'])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output).skills[0].status).toBe('updated')
    expect(readFileSync(codexSkill, 'utf8')).toBe(loadAgentSkill())
    expect(readFileSync(join(dirname(codexSkill), 'notes.md'), 'utf8')).toBe('User notes\n')
    expect(existsSync(claudeSkill)).toBe(false)
  })

  it('refuses a skill file symlink, and explicit force replaces the link without changing its target', async () => {
    const custom = join(root, 'custom.md')
    writeFileSync(custom, 'User-owned target\n')
    mkdirSync(dirname(codexSkill), { recursive: true })
    symlinkSync(custom, codexSkill)

    const denied = await runCli(['agents', 'install', '--agent', 'codex', '--json'])
    expect(denied.exitCode).toBe(1)
    expect(denied.output).toContain('symbolic link')
    expect(lstatSync(codexSkill).isSymbolicLink()).toBe(true)

    const allowed = await runCli(['agents', 'install', '--agent', 'codex', '--force'])
    expect(allowed.exitCode).toBe(0)
    expect(lstatSync(codexSkill).isSymbolicLink()).toBe(false)
    expect(readFileSync(custom, 'utf8')).toBe('User-owned target\n')
    expect(readFileSync(codexSkill, 'utf8')).toBe(loadAgentSkill())
  })

  it.each(['file', 'directory'] as const)(
    'preserves an identical skill reached through a %s symlink without requiring force',
    async (kind) => {
      mkdirSync(dirname(codexSkill), { recursive: true })
      writeFileSync(codexSkill, loadAgentSkill())
      utimesSync(codexSkill, new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z'))
      mkdirSync(join(project, '.claude/skills'), { recursive: true })
      const link = kind === 'file' ? claudeSkill : dirname(claudeSkill)
      if (kind === 'file') mkdirSync(dirname(claudeSkill))
      symlinkSync(kind === 'file' ? codexSkill : dirname(codexSkill), link)
      const before = statSync(codexSkill).mtimeMs

      const result = await runCli(['agents', 'install', '--json'])

      expect(result.exitCode).toBe(0)
      expect(
        JSON.parse(result.output).skills.map((skill: { status: string }) => skill.status),
      ).toEqual(['unchanged', 'unchanged'])
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(statSync(codexSkill).mtimeMs).toBe(before)
      expect(readFileSync(claudeSkill, 'utf8')).toBe(loadAgentSkill())
    },
  )

  it('refuses to follow a destination directory symlink without explicit force', async () => {
    const linked = join(root, 'shared-skills')
    mkdirSync(linked)
    mkdirSync(join(project, '.agents'))
    symlinkSync(linked, join(project, '.agents/skills'))

    const result = await runCli(['agents', 'install', '--agent', 'codex', '--json'])

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('symbolic link')
    expect(existsSync(join(linked, 'bralecli'))).toBe(false)
  })

  it('reports an invalid destination before writing either skill', async () => {
    writeFileSync(join(project, '.claude'), 'Not a directory\n')
    const result = await runCli(['agents', 'install', '--json'])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('.claude')
    expect(existsSync(codexSkill)).toBe(false)
    expect(readFileSync(join(project, '.claude'), 'utf8')).toBe('Not a directory\n')
  })

  it('rejects unsupported agents before creating skill directories', async () => {
    const result = await runCli(['agents', 'install', '--agent', 'unsupported', '--json'])
    expect(result.exitCode).toBe(1)
    expect(existsSync(join(project, '.agents'))).toBe(false)
    expect(existsSync(join(project, '.claude'))).toBe(false)
  })
})
