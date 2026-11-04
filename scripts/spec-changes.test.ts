import { describe, expect, it } from 'vitest'

import { summarizeSpecChanges } from './spec-changes.ts'

const ok = { description: 'OK' }
const base = {
  openapi: '3.1.0',
  info: { title: 'Brale', version: '1' },
  paths: {
    '/accounts': {
      get: { operationId: 'listAccounts', responses: { '200': ok } },
      post: { operationId: 'createAccount', responses: { '201': ok } },
    },
    '/accounts/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true }],
      get: { operationId: 'getAccount', responses: { '200': ok } },
      delete: { operationId: 'deleteAccount', responses: { '204': ok } },
    },
  },
  components: {
    schemas: {
      Account: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
      Legacy: { type: 'object' },
    },
  },
}

function summarize(next: unknown, proposedVersion?: string): string {
  return summarizeSpecChanges({ previous: base, next, proposedVersion })
}

function changed(mutate: (document: typeof base) => void): typeof base {
  const document = structuredClone(base)
  mutate(document)
  return document
}

describe('reviewer summary of an OpenAPI proposal', () => {
  it('lists added, removed, and changed operations with the fields that changed', () => {
    const next = changed((document) => {
      const paths = document.paths as Record<string, Record<string, unknown>>
      delete paths['/accounts']!.post
      paths['/accounts']!.get = {
        operationId: 'listAccounts',
        parameters: [{ name: 'limit', in: 'query' }],
        responses: { '200': { description: 'Accounts' }, '401': ok },
      }
      paths['/transfers'] = { post: { operationId: 'createTransfer', responses: { '201': ok } } }
    })
    const summary = summarize(next, '0.3.0')
    expect(summary).toContain(
      'Semantic contract change: **yes**, so this proposes version `0.3.0`.',
    )
    expect(summary).toContain('**Operations**: 1 added, 1 removed, 1 changed')
    expect(summary).toContain('- Added `POST /transfers`')
    expect(summary).toContain('- Removed `POST /accounts`')
    expect(summary).toContain(
      '- Changed `GET /accounts`: +`parameters`, `responses` (+`401`, ~`200`)',
    )
  })

  it('marks every operation under a path whose shared parameters changed', () => {
    const next = changed((document) => {
      const item = document.paths['/accounts/{id}'] as Record<string, unknown>
      item.parameters = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
    })
    const summary = summarize(next)
    expect(summary).toContain('**Operations**: 2 changed')
    expect(summary).toContain('- Changed `DELETE /accounts/{id}`: `path parameters`')
    expect(summary).toContain('- Changed `GET /accounts/{id}`: `path parameters`')
  })

  it('lists component changes down to schema property names', () => {
    const next = changed((document) => {
      const schemas = document.components.schemas as Record<string, unknown>
      delete schemas.Legacy
      schemas.Account = {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string' } },
      }
      schemas.Transfer = { type: 'object' }
    })
    const summary = summarize(next)
    expect(summary).toContain('**Components `schemas`**: 1 added, 1 removed, 1 changed')
    expect(summary).toContain('- Added `Transfer`')
    expect(summary).toContain('- Removed `Legacy`')
    expect(summary).toContain(
      '- Changed `Account`: +`required`, `properties` (+`email`, −`name`, ~`id`)',
    )
  })

  it('reports annotation-only and byte-only proposals honestly', () => {
    const described = changed((document) => {
      document.info = { ...document.info, description: 'New docs' } as typeof document.info
    })
    const summary = summarize(described)
    expect(summary).toContain('Semantic contract change: **no**.')
    expect(summary).toContain('**Document**: 1 changed')
    expect(summary).toContain('- Changed `info`: +`description`')
    expect(summarize(structuredClone(base))).toContain('No structural differences')
  })

  it('quotes hostile upstream names inside code spans that cannot be escaped', () => {
    const name =
      '/x`<img src=x onerror=alert(1)>` @everyone [link](https://evil.example)\n# Approved‮'
    const next = changed((document) => {
      ;(document.paths as Record<string, unknown>)[name] = { get: { responses: {} } }
    })
    const line = summarize(next)
      .split('\n')
      .find((text) => text.startsWith('- Added'))!
    expect(line).toBe(
      '- Added `GET /x�<img src=x onerror=alert(1)>� @everyone [link](https://evil.example)�# Approved�`',
    )
    expect(line.match(/`/g)).toHaveLength(2)
  })

  it('bounds the list per section and the summary as a whole', () => {
    const many = changed((document) => {
      const schemas = document.components.schemas as Record<string, unknown>
      for (let index = 0; index < 30; index++)
        schemas[`Added${String(index).padStart(2, '0')}`] = {}
    })
    const summary = summarize(many)
    expect(summary).toContain('- Added `Added24`')
    expect(summary).not.toContain('`Added25`')
    expect(summary).toContain('- …and 5 more')

    const huge = changed((document) => {
      for (let section = 0; section < 400; section++) {
        const items: Record<string, unknown> = {}
        for (let index = 0; index < 25; index++) items[`${'N'.repeat(100)}${index}`] = {}
        ;(document.components as Record<string, unknown>)[`kind${section}`] = items
      }
    })
    const bounded = summarize(huge)
    expect(bounded.length).toBeLessThanOrEqual(40_200)
    expect(bounded).toContain('_Summary truncated at its size limit')
  })
})
