import { describe, expect, it } from 'vitest'

import { BodyValueError, coerceJsonBodyText, jsonContainerBodyProperties } from './body.js'
import { spec } from './spec.js'

/** A concrete create_transfer pathname; the account id is the document's own ID example. */
const TRANSFERS = {
  method: 'POST',
  pathname: '/accounts/2VZvtmVc2j3gQ80CTlcuQXbGrwC/transfers',
}

describe('jsonContainerBodyProperties', () => {
  it('classifies the flagship create_transfer properties from the vendored document', () => {
    const containers = jsonContainerBodyProperties(spec, TRANSFERS)
    // The required container properties whose stringification breaks every create.
    expect(containers.has('amount')).toBe(true)
    expect(containers.has('source')).toBe(true)
    expect(containers.has('destination')).toBe(true)
    // Scalars must never be touched.
    expect(containers.has('note')).toBe(false)
  })

  it('resolves a request body that is itself a $ref', () => {
    // Brale never inlines a body schema: create_transfer's is a $ref to
    // CreateTransfer. A resolver that only read inline properties would
    // classify NOTHING and silently stop repairing every write.
    expect(jsonContainerBodyProperties(spec, TRANSFERS).size).toBeGreaterThan(0)
  })

  it('matches a templated path from a concrete pathname, preferring the literal route', () => {
    const document = {
      paths: {
        '/things/{thingID}': {
          put: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { properties: { nested: { type: 'object' } } },
                },
              },
            },
          },
        },
        '/things/special': {
          put: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { properties: { other: { type: 'object' } } },
                },
              },
            },
          },
        },
      },
    }
    expect(
      jsonContainerBodyProperties(document, { method: 'PUT', pathname: '/things/th_1' }),
    ).toEqual(new Set(['nested']))
    expect(
      jsonContainerBodyProperties(document, { method: 'PUT', pathname: '/things/special' }),
    ).toEqual(new Set(['other']))
  })

  it('returns an empty set for an unknown operation', () => {
    expect(
      jsonContainerBodyProperties(spec, { method: 'POST', pathname: '/not/a/real/path' }).size,
    ).toBe(0)
  })

  it('leaves a property alone when the contract also admits a string', () => {
    const document = {
      paths: {
        '/things': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    properties: {
                      flexible: { anyOf: [{ type: 'string' }, { type: 'object' }] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    expect(
      jsonContainerBodyProperties(document, { method: 'POST', pathname: '/things' }).has(
        'flexible',
      ),
    ).toBe(false)
  })

  it('survives a cyclic reference without recursing forever', () => {
    const document = {
      components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } },
      paths: {
        '/things': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { properties: { looped: { $ref: '#/components/schemas/Loop' } } },
                },
              },
            },
          },
        },
      },
    }
    expect(
      jsonContainerBodyProperties(document, { method: 'POST', pathname: '/things' }).has('looped'),
    ).toBe(false)
  })
})

describe('coerceJsonBodyText', () => {
  it('re-parses container properties that arrive as JSON strings', () => {
    const bodyText = JSON.stringify({
      amount: '{"value":"10","currency":"USD"}',
      source: '{"value_type":"USD","transfer_type":"wire"}',
      destination: '{"value_type":"SBC","transfer_type":"base"}',
      note: 'invoice 42',
    })

    const coerced = JSON.parse(coerceJsonBodyText(spec, { ...TRANSFERS, bodyText })) as Record<
      string,
      unknown
    >

    expect(coerced.amount).toEqual({ value: '10', currency: 'USD' })
    expect(coerced.source).toEqual({ value_type: 'USD', transfer_type: 'wire' })
    expect(coerced.destination).toEqual({ value_type: 'SBC', transfer_type: 'base' })
    expect(coerced.note).toBe('invoice 42')
  })

  it('passes an already-correct body through unchanged', () => {
    const bodyText = JSON.stringify({ source: { value_type: 'USD' } })
    expect(coerceJsonBodyText(spec, { ...TRANSFERS, bodyText })).toBe(bodyText)
  })

  it('passes a non-object raw body through unchanged', () => {
    expect(coerceJsonBodyText(spec, { ...TRANSFERS, bodyText: 'not json at all' })).toBe(
      'not json at all',
    )
  })

  it('rejects a container flag whose value is not JSON, naming the flag', () => {
    const bodyText = JSON.stringify({ source: 'usdc' })
    expect(() => coerceJsonBodyText(spec, { ...TRANSFERS, bodyText })).toThrow(BodyValueError)
    expect(() => coerceJsonBodyText(spec, { ...TRANSFERS, bodyText })).toThrow(/--source/)
  })
})
