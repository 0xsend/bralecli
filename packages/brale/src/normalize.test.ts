import { describe, expect, it } from 'vitest'

import { PATH_PARAMETER_VALUE_PATTERN, constrainPathParameters } from './normalize.js'
import { spec } from './spec.js'

describe('constrainPathParameters', () => {
  it('adds the value pattern to component and inline path parameters', () => {
    const result = constrainPathParameters({
      components: { parameters: { Id: { name: 'id', in: 'path', schema: { type: 'string' } } } },
      paths: {
        '/things/{id}': {
          parameters: [{ name: 'id', in: 'path' }],
          get: { parameters: [{ name: 'other', in: 'path', schema: { type: 'string' } }] },
        },
      },
    })

    const componentSchema = result.components?.parameters?.Id?.schema as { pattern?: string }
    expect(componentSchema.pattern).toBe(PATH_PARAMETER_VALUE_PATTERN)
    const sharedParameter = result.paths?.['/things/{id}']?.parameters?.[0] as {
      schema?: Record<string, unknown>
    }
    expect(sharedParameter.schema).toEqual({
      type: 'string',
      pattern: PATH_PARAMETER_VALUE_PATTERN,
    })
    const operation = result.paths?.['/things/{id}']?.get as {
      parameters: { schema: { pattern?: string } }[]
    }
    expect(operation.parameters[0]?.schema.pattern).toBe(PATH_PARAMETER_VALUE_PATTERN)
  })

  it('leaves query parameters alone and composes with an author pattern', () => {
    const result = constrainPathParameters({
      paths: {
        '/things': {
          get: {
            parameters: [
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
              { name: 'id', in: 'path', schema: { type: 'string', pattern: '^tr_' } },
            ],
          },
        },
      },
    })

    const operation = result.paths['/things']?.get as {
      parameters: { schema: { pattern?: string } }[]
    }
    expect(operation.parameters[0]?.schema.pattern).toBeUndefined()
    const composed = new RegExp(operation.parameters[1]?.schema.pattern ?? '')
    expect(composed.test('tr_abc')).toBe(true)
    expect(composed.test('tr_a/b')).toBe(false)
    expect(composed.test('cus_abc')).toBe(false)
  })

  it('constrains every alternative of an author pattern, not just the first', () => {
    // `(?=SAFE)A|B` parses as `((?=SAFE)A)|B`: without a group around the
    // author pattern, a second alternative bypasses the value pattern entirely.
    const result = constrainPathParameters({
      paths: {
        '/things/{id}': {
          get: {
            parameters: [
              { name: 'id', in: 'path', schema: { type: 'string', pattern: '^tr_.*$|^cus_.*$' } },
            ],
          },
        },
      },
    })

    const operation = result.paths['/things/{id}']?.get as {
      parameters: { schema: { pattern?: string } }[]
    }
    const composed = new RegExp(operation.parameters[0]?.schema.pattern ?? '')
    expect(composed.test('tr_abc')).toBe(true)
    expect(composed.test('cus_abc')).toBe(true)
    expect(composed.test('tr_a/b')).toBe(false)
    expect(composed.test('cus_a/b')).toBe(false)
  })

  it('inlines a $ref schema so the pattern survives dereferencing', () => {
    // The real failure shape: every Brale path parameter's schema is a `$ref`
    // to `ID`. A pattern written as a `$ref` SIBLING is dropped by
    // dereferencers, so the schema must be inlined with the constraint
    // composed in.
    const result = constrainPathParameters({
      components: {
        parameters: {
          ThingID: {
            name: 'thingID',
            in: 'path',
            schema: { $ref: '#/components/schemas/Id' } as Record<string, unknown>,
          },
        },
        schemas: { Id: { type: 'string', pattern: '[a-z0-9]*', maxLength: 42 } },
      },
      paths: {},
    })

    const constrained = result.components?.parameters?.ThingID as
      | { schema: Record<string, unknown> }
      | undefined
    const schema = constrained?.schema ?? {}
    expect(schema.$ref).toBeUndefined()
    expect(schema.maxLength).toBe(42)
    const composed = new RegExp(schema.pattern as string)
    expect(composed.test('abc123')).toBe(true)
    expect(composed.test('../things/x')).toBe(false)
  })

  it('does not mutate its input', () => {
    const input = { paths: { '/things/{id}': { parameters: [{ name: 'id', in: 'path' }] } } }
    constrainPathParameters(input)
    expect(input.paths['/things/{id}'].parameters[0]).toEqual({ name: 'id', in: 'path' })
  })

  it('rejects every traversal shape and accepts every real Brale id shape', () => {
    const pattern = new RegExp(PATH_PARAMETER_VALUE_PATTERN)
    // Brale ids are KSUIDs — the document's own ID example first.
    for (const good of ['2VZvtmVc2j3gQ80CTlcuQXbGrwC', 'SBC', 'usdc-base', 'a.b', '...'])
      expect(pattern.test(good)).toBe(true)
    for (const bad of [
      '.',
      '..',
      '../accounts/other',
      'a/b',
      'a\\b',
      '%2e%2e%2faccounts',
      'a?x=1',
      'a#f',
      '',
    ])
      expect(pattern.test(bad)).toBe(false)
  })
})

describe('the vendored Brale document, constrained', () => {
  it('gives every path parameter an inline schema carrying the value pattern', () => {
    const constrained = constrainPathParameters(
      spec as Parameters<typeof constrainPathParameters>[0],
    )
    const unconstrained: string[] = []

    for (const [path, item] of Object.entries(constrained.paths ?? {})) {
      for (const operation of Object.values(item)) {
        if (typeof operation !== 'object' || operation === null) continue
        const parameters = (
          operation as {
            parameters?: {
              in?: string
              name?: string
              schema?: { $ref?: string; pattern?: string }
            }[]
          }
        ).parameters
        for (const parameter of parameters ?? []) {
          if (parameter.in !== 'path') continue
          if (parameter.schema?.$ref !== undefined || parameter.schema?.pattern === undefined)
            unconstrained.push(`${path} -> {${parameter.name}}`)
        }
      }
    }

    expect(unconstrained).toEqual([])
  })
})
