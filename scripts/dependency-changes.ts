#!/usr/bin/env -S node

/** Summarizes a dependency update (Node, npm packages, Nix inputs) for patch reviewers. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

import { BoundedLines, code } from './markdown.ts'
import { isObject } from './spec-proposal.ts'

export type DependencySnapshot = { nodeVersion: string; lockfile: string; flakeLock: string }
type Direct = { workspace: string; name: string; specifier: string; version: string }
type FlakeInput = { owner?: string; repo?: string; source: string; rev: string; date: string }

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies']
const summaryBudget = 60_000

function fields(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {}
}

/** pnpm-format lockfiles append peer context, as in `3.2.7(@types/node@26.4.1)`. */
function bareVersion(version: string): string {
  return version.replace(/\(.*$/s, '')
}

function directDependencies(lockfile: unknown): Map<string, Direct> {
  const result = new Map<string, Direct>()
  for (const [workspace, importer] of Object.entries(fields(fields(lockfile).importers))) {
    for (const field of dependencyFields) {
      for (const [name, entry] of Object.entries(fields(fields(importer)[field]))) {
        const { specifier, version } = fields(entry)
        if (typeof specifier !== 'string' || typeof version !== 'string') continue
        result.set(`${workspace}\0${name}`, {
          workspace,
          name,
          specifier,
          version: bareVersion(version),
        })
      }
    }
  }
  return result
}

function lockedPackages(lockfile: unknown): Map<string, string[]> {
  const result = new Map<string, Set<string>>()
  for (const key of Object.keys(fields(fields(lockfile).packages))) {
    const bare = bareVersion(key)
    const at = bare.lastIndexOf('@')
    if (at <= 0) continue
    const name = bare.slice(0, at)
    result.set(name, (result.get(name) ?? new Set()).add(bare.slice(at + 1)))
  }
  return new Map([...result].map(([name, versions]) => [name, [...versions].toSorted()]))
}

function flakeInputs(flakeLock: string): Map<string, FlakeInput> {
  const result = new Map<string, FlakeInput>()
  for (const [name, node] of Object.entries(fields(fields(JSON.parse(flakeLock)).nodes))) {
    const locked = fields(fields(node).locked)
    const rev = typeof locked.rev === 'string' ? locked.rev : locked.narHash
    if (typeof rev !== 'string') continue
    const github =
      locked.type === 'github' &&
      typeof locked.owner === 'string' &&
      typeof locked.repo === 'string'
    result.set(name, {
      ...(github ? { owner: locked.owner as string, repo: locked.repo as string } : {}),
      source: github ? `${locked.owner}/${locked.repo}` : String(locked.url ?? locked.type ?? ''),
      rev,
      date:
        typeof locked.lastModified === 'number'
          ? new Date(locked.lastModified * 1000).toISOString().slice(0, 10)
          : '',
    })
  }
  return result
}

function transition(before: string | undefined, after: string | undefined): string {
  if (before === after) return before === undefined ? '' : code(before)
  if (before === undefined) return `added ${code(after!)}`
  if (after === undefined) return `removed ${code(before)}`
  return `${code(before)} → ${code(after)}`
}

function isSafeSlug(value: string | undefined): boolean {
  return value !== undefined && /^[\w.-]+$/.test(value)
}

function codeList(list: string[]): string {
  return list.map((version) => code(version)).join(', ')
}

function revision(before: FlakeInput | undefined, after: FlakeInput | undefined): string {
  const text = transition(before?.rev.slice(0, 12), after?.rev.slice(0, 12))
  const sameRepo =
    before?.source === after?.source && isSafeSlug(after?.owner) && isSafeSlug(after?.repo)
  const revs = [before?.rev, after?.rev].every((rev) => rev && /^[0-9a-f]{7,40}$/.test(rev))
  return sameRepo && revs
    ? `[${text}](https://github.com/${after!.owner}/${after!.repo}/compare/${before!.rev}...${after!.rev})`
    : text
}

function union<T>(before: Map<string, T>, after: Map<string, T>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].toSorted()
}

export function summarizeDependencyChanges(
  before: DependencySnapshot,
  after: DependencySnapshot,
): string {
  const out = new BoundedLines(
    summaryBudget,
    '_Summary truncated at its size limit; review the patch for the remaining changes._',
  )
  out.push('## Dependency changes', '')
  let changed = false

  const node = [before.nodeVersion.trim(), after.nodeVersion.trim()] as const
  if (node[0] !== node[1]) {
    changed = true
    out.push(`Node.js (${code('.node-version')}): ${transition(...node)}`, '')
  }

  const [oldLock, newLock] = [parse(before.lockfile) as unknown, parse(after.lockfile) as unknown]
  const direct = [directDependencies(oldLock), directDependencies(newLock)] as const
  const directRows = union(...direct).flatMap((key) => {
    const [a, b] = [direct[0].get(key), direct[1].get(key)]
    if (a?.specifier === b?.specifier && a?.version === b?.version) return []
    const { workspace, name } = (b ?? a)!
    return [
      `| ${code(workspace)} | ${code(name)} | ${transition(a?.specifier, b?.specifier)} | ${transition(a?.version, b?.version)} |`,
    ]
  })
  if (directRows.length) {
    changed = true
    out.push(
      '### Direct dependencies',
      '',
      '| Workspace | Package | Specifier | Resolved |',
      '| --- | --- | --- | --- |',
      ...directRows,
      '',
    )
  }

  const flake = [flakeInputs(before.flakeLock), flakeInputs(after.flakeLock)] as const
  const flakeRows = union(...flake).flatMap((name) => {
    const [a, b] = [flake[0].get(name), flake[1].get(name)]
    if (a?.rev === b?.rev) return []
    const dates = transition(a?.date || undefined, b?.date || undefined)
    return [`| ${code(name)} | ${code((b ?? a)!.source)} | ${revision(a, b)} | ${dates} |`]
  })
  if (flakeRows.length) {
    changed = true
    out.push(
      '### Nix flake inputs',
      '',
      '| Input | Source | Revision | Last modified |',
      '| --- | --- | --- | --- |',
      ...flakeRows,
      '',
    )
  }

  // Last, because a truncated <details> block would swallow anything after it.
  const locked = [lockedPackages(oldLock), lockedPackages(newLock)] as const
  const groups = { updated: [] as string[], added: [] as string[], removed: [] as string[] }
  for (const name of union(...locked)) {
    const [a, b] = [locked[0].get(name) ?? [], locked[1].get(name) ?? []]
    if (a.join('\0') === b.join('\0')) continue
    if (!a.length) groups.added.push(`- Added ${code(name)} ${codeList(b)}`)
    else if (!b.length) groups.removed.push(`- Removed ${code(name)} ${codeList(a)}`)
    else groups.updated.push(`- ${code(name)}: ${codeList(a)} → ${codeList(b)}`)
  }
  const lockedChanges = [...groups.updated, ...groups.added, ...groups.removed]
  if (lockedChanges.length) {
    changed = true
    out.push(
      '### All locked packages',
      '',
      `${groups.updated.length} updated, ${groups.added.length} added, ${groups.removed.length} removed, including transitive dependencies.`,
      '',
      '<details><summary>Package list</summary>',
      '',
      ...lockedChanges,
      '',
      '</details>',
    )
  }

  if (!changed) out.push('No dependency changes.')
  return out.toString()
}

function snapshot(read: (path: string) => string): DependencySnapshot {
  return {
    nodeVersion: read('.node-version'),
    lockfile: read('nub.lock'),
    flakeLock: read('flake.lock'),
  }
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const before = snapshot((path) =>
    execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  )
  const after = snapshot((path) => readFileSync(join(root, path), 'utf8'))
  process.stdout.write(summarizeDependencyChanges(before, after))
}

if (import.meta.main) main()
