import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { Cli, z } from 'incur'

// oxlint-disable-next-line no-underscore-dangle -- Replaced by the standalone binary build.
declare const __BRALE_AGENT_SKILL__: string | undefined

type Agent = 'claude' | 'codex'
type InstallStatus = 'installed' | 'unchanged' | 'updated'
type Target = { agent: Agent; path: string }
type Installation = Target & { status: InstallStatus }

/** Loads the bundled operational skill only when an installation is requested. */
export function loadAgentSkill(): string {
  if (typeof __BRALE_AGENT_SKILL__ !== 'undefined') return __BRALE_AGENT_SKILL__
  return readFileSync(new URL('../../../.agents/skills/bralecli/SKILL.md', import.meta.url), 'utf8')
}

function inspectTarget(target: Target, content: string, force: boolean): Installation {
  const entry = lstatSync(target.path, { throwIfNoEntry: false })
  // Shared skills may be linked between agents. Reading identical bytes needs
  // no write authority and must preserve the link and the source file's mtime.
  if (
    entry &&
    statSync(target.path, { throwIfNoEntry: false })?.isFile() &&
    readFileSync(target.path, 'utf8') === content
  ) {
    return { ...target, status: 'unchanged' }
  }

  const skillDirectory = dirname(target.path)
  const parents = [skillDirectory, dirname(skillDirectory), dirname(dirname(skillDirectory))]
  for (const parent of parents) {
    const parentEntry = lstatSync(parent, { throwIfNoEntry: false })
    if (parentEntry?.isSymbolicLink() && !force) {
      throw new Error(
        `Skill destination uses symbolic link ${parent}; inspect it, then use --force.`,
      )
    }
    if (parentEntry && !parentEntry.isDirectory() && !parentEntry.isSymbolicLink()) {
      throw new Error(`Skill destination parent is not a directory: ${parent}`)
    }
  }

  if (!entry) return { ...target, status: 'installed' }
  if (entry.isSymbolicLink()) {
    if (!force) {
      throw new Error(
        `Skill destination is a symbolic link: ${target.path}; inspect it, then use --force.`,
      )
    }
    return { ...target, status: 'updated' }
  }
  if (!entry.isFile()) throw new Error(`Skill destination is not a regular file: ${target.path}`)
  if (!force) {
    throw new Error(
      `Existing skill differs: ${target.path}; inspect it, then use --force to replace it.`,
    )
  }
  return { ...target, status: 'updated' }
}

function writeSkill(path: string, content: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = mkdtempSync(join(directory, '.bralecli-install-'))
  try {
    const staged = join(temporary, 'SKILL.md')
    writeFileSync(staged, content, { flag: 'wx' })
    renameSync(staged, path)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export const agents = Cli.create('agents', {
  description: 'Install curated Brale guidance for coding agents',
}).command('install', {
  description: 'Install the curated Brale skill in this project; use --global for all projects',
  mcp: false,
  options: z.object({
    agent: z.enum(['claude', 'codex', 'all']).default('all').describe('Agent to install for'),
    global: z.boolean().default(false).describe('Install in user skill directories'),
    force: z.boolean().default(false).describe('Replace a customized skill or use a symbolic link'),
  }),
  run(c) {
    const base = c.options.global ? homedir() : process.cwd()
    const claudeBase = c.options.global
      ? process.env.CLAUDE_CONFIG_DIR?.trim() || join(base, '.claude')
      : join(base, '.claude')
    const targets: Target[] = [
      { agent: 'codex', path: resolve(base, '.agents/skills/bralecli/SKILL.md') },
      { agent: 'claude', path: resolve(claudeBase, 'skills/bralecli/SKILL.md') },
    ].filter(
      (target): target is Target => c.options.agent === 'all' || target.agent === c.options.agent,
    )

    let content: string
    try {
      content = loadAgentSkill()
    } catch (error) {
      return c.error({
        code: 'AGENT_SKILL_LOAD_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    let plans: Installation[]
    try {
      plans = targets.map((target) => inspectTarget(target, content, c.options.force))
    } catch (error) {
      return c.error({
        code: 'AGENT_SKILL_CONFLICT',
        message: error instanceof Error ? error.message : String(error),
      })
    }

    const completed: Installation[] = []
    // Atomicity: each file is replaced atomically; two agent directories cannot share
    // a filesystem transaction. Permanent — report completed paths on an I/O failure.
    for (const plan of plans) {
      try {
        if (plan.status !== 'unchanged') writeSkill(plan.path, content)
      } catch (error) {
        return c.error({
          code: 'AGENT_SKILL_INSTALL_FAILED',
          message: `Could not install ${plan.path}. Completed: ${completed.map((item) => item.path).join(', ') || 'none'}. ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      completed.push(plan)
    }
    return { scope: c.options.global ? 'global' : 'project', skills: completed }
  },
})
