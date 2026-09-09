import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { planSpecRelease } from './spec-release.ts'

const base = JSON.parse(
  await readFile(new URL('../packages/brale/openapi/brale.json', import.meta.url), 'utf8'),
)
const packageSource = '{\n  "name": "bralecli",\n  "version": "0.2.7",\n  "private": true\n}\n'
const changelogSource = '# bralecli\n\n## 0.2.7\n\n- Existing release.\n'
const revision = { hash: 'a'.repeat(64), fetchedAt: '2026-09-08' }
const path = '/accounts/{account_id}/financial-institutions/{fi_id}/status'

function plan(document: unknown, previousDocument: unknown = base, version = '0.2.7') {
  return planSpecRelease({
    previousDocument: Buffer.from(JSON.stringify(previousDocument)),
    document: Buffer.from(JSON.stringify(document)),
    packageSource: packageSource.replace('0.2.7', version),
    changelogSource,
    revision,
  })
}

describe('reviewable spec release proposals', () => {
  it('ignores formatting, object order, and OpenAPI documentation annotations', () => {
    const document = structuredClone(base)
    document.info.description = 'Reworded overview'
    document.paths[path].get.summary = 'Clearer command summary'
    document.paths[path].get.parameters[0].description = 'Clearer parameter text'
    document.paths[path].get.responses['200'].description = 'Clearer response text'
    document.paths[path].get.responses['200'].content['application/json'].examples = {
      sample: { value: { status: 'active' } },
    }
    document.components.schemas.UpdateExternalAddressRequest.properties.name.example = 'Example'
    document.components.schemas.UpdateExternalAddressRequest.description = 'Description'
    document.components.examples = { sample: { value: { status: 'active' } } }
    expect(plan(document)).toEqual({ kind: 'none' })
    expect(
      planSpecRelease({
        previousDocument: Buffer.from(JSON.stringify(base)),
        document: Buffer.from(
          JSON.stringify(Object.fromEntries(Object.entries(base).toReversed()), null, 2),
        ),
        packageSource,
        changelogSource,
        revision,
      }),
    ).toEqual({ kind: 'none' })
  })

  it.each(['description', 'summary', 'example', 'examples'])(
    'retains schema property and component names called %s',
    (name) => {
      const document = structuredClone(base)
      document.components.schemas.UpdateExternalAddressRequest.properties[name] = { type: 'string' }
      expect(plan(document).kind).toBe('release')
      const changed = structuredClone(document)
      changed.components.schemas.UpdateExternalAddressRequest.properties[name].type = 'integer'
      expect(plan(changed, document).kind).toBe('release')
      document.components.schemas[name] = { type: 'integer' }
      expect(plan(document).kind).toBe('release')
    },
  )

  it.each(['default', 'const', 'enum', 'x-runtime-policy', 'constructor', '__proto__'])(
    'retains arbitrary values under %s',
    (key) => {
      const document = structuredClone(base)
      document.components.schemas.UpdateExternalAddressRequest = {
        ...document.components.schemas.UpdateExternalAddressRequest,
        [key]: key === 'enum' ? [{ description: 'wire' }] : { description: 'wire' },
      }
      const changed = structuredClone(document)
      changed.components.schemas.UpdateExternalAddressRequest = {
        ...changed.components.schemas.UpdateExternalAddressRequest,
        [key]: key === 'enum' ? [{ description: 'ach' }] : { description: 'ach' },
      }
      expect(plan(changed, document).kind).toBe('release')
    },
  )

  it.each(['operation', 'constraint', 'schema-format', 'security'])(
    'proposes a conservative 0.x minor for a changed %s',
    (change) => {
      const document = structuredClone(base)
      if (change === 'operation')
        document.paths[path].get.operationId = 'read_financial_institution_status'
      if (change === 'constraint')
        document.components.schemas.UpdateExternalAddressRequest.additionalProperties = true
      if (change === 'schema-format')
        document.components.schemas.UpdateExternalAddressRequest.properties.name.format = 'uuid'
      if (change === 'security') document.paths[path].get.security[0].oauth.push('accounts:read')
      const result = plan(document)
      expect(result).toMatchObject({ kind: 'release', previousVersion: '0.2.7', version: '0.3.0' })
      if (result.kind !== 'release') throw new Error('Expected a release proposal')
      expect(JSON.parse(result.packageSource)).toEqual({
        name: 'bralecli',
        version: '0.3.0',
        private: true,
      })
      expect(result.changelogSource).toContain('## 0.3.0\n')
      expect(result.changelogSource).toContain('### Minor Changes\n')
      expect(result.changelogSource).toContain(revision.hash)
      expect(result.changelogSource).toContain('2026-09-08')
      expect(result.changelogSource).toContain('## 0.2.7\n\n- Existing release.\n')
      expect(plan(document)).toEqual(result)
    },
  )

  it('proposes a major after 1.0 instead of claiming a contract change is nonbreaking', () => {
    const document = structuredClone(base)
    delete document.paths[path]
    expect(plan(document, base, '2.8.9')).toMatchObject({ kind: 'release', version: '3.0.0' })
  })

  it.each(['latest', '0.2.7-rc.1', '9007199254740991.0.0'])(
    'rejects unsafe or unsupported version %s',
    (version) => {
      const document = structuredClone(base)
      delete document.paths[path]
      expect(() => plan(document, base, version)).toThrow('version')
    },
  )

  it('rejects excessive JSON depth with a bounded diagnostic', () => {
    let nested: unknown = { type: 'string' }
    for (let depth = 0; depth < 140; depth++) nested = { items: nested }
    const document = structuredClone(base)
    document.components.schemas.Deep = nested
    expect(() => plan(document)).toThrow('depth limit')
  })

  it('rejects excessively broad JSON within the document byte limit', () => {
    const document = structuredClone(base)
    document.components.schemas.Wide = { enum: Array.from({ length: 1_000_000 }, () => 0) }
    expect(() => plan(document)).toThrow('node limit')
  })
})
