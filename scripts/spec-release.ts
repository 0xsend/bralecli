/** Pure, builtin-only release planning for already validated OpenAPI proposals. */
import { createHash } from 'node:crypto'

import { isObject, parseJson, type Revision } from './spec-proposal.ts'

type ObjectContext =
  | 'document'
  | 'info'
  | 'components'
  | 'schema'
  | 'pathItem'
  | 'operation'
  | 'parameter'
  | 'header'
  | 'response'
  | 'requestBody'
  | 'mediaType'
  | 'encoding'
  | 'securityScheme'
  | 'server'
  | 'serverVariable'
  | 'tag'
  | 'link'
  | 'callback'
type Context = ObjectContext | `map:${ObjectContext}` | 'data'
type Rule = { omit: readonly string[]; children?: Record<string, Context> }
type ReleasePlan =
  | { kind: 'none' }
  | {
      kind: 'release'
      previousVersion: string
      version: string
      packageSource: string
      changelogSource: string
    }

const rules: Record<ObjectContext, Rule> = {
  document: {
    omit: ['externalDocs'],
    children: {
      info: 'info',
      paths: 'map:pathItem',
      webhooks: 'map:pathItem',
      components: 'components',
      servers: 'server',
      tags: 'tag',
    },
  },
  info: { omit: ['description', 'summary'] },
  components: {
    omit: ['examples'],
    children: {
      schemas: 'map:schema',
      responses: 'map:response',
      parameters: 'map:parameter',
      requestBodies: 'map:requestBody',
      headers: 'map:header',
      securitySchemes: 'map:securityScheme',
      links: 'map:link',
      callbacks: 'map:callback',
      pathItems: 'map:pathItem',
    },
  },
  schema: {
    omit: ['description', 'title', 'example', 'examples', '$comment', 'externalDocs'],
    children: {
      properties: 'map:schema',
      patternProperties: 'map:schema',
      $defs: 'map:schema',
      definitions: 'map:schema',
      dependentSchemas: 'map:schema',
      items: 'schema',
      prefixItems: 'schema',
      additionalItems: 'schema',
      contains: 'schema',
      additionalProperties: 'schema',
      unevaluatedProperties: 'schema',
      unevaluatedItems: 'schema',
      propertyNames: 'schema',
      allOf: 'schema',
      anyOf: 'schema',
      oneOf: 'schema',
      not: 'schema',
    },
  },
  pathItem: {
    omit: ['description', 'summary'],
    children: {
      get: 'operation',
      put: 'operation',
      post: 'operation',
      delete: 'operation',
      options: 'operation',
      head: 'operation',
      patch: 'operation',
      trace: 'operation',
      parameters: 'parameter',
      servers: 'server',
    },
  },
  operation: {
    omit: ['description', 'summary', 'externalDocs'],
    children: {
      parameters: 'parameter',
      requestBody: 'requestBody',
      responses: 'map:response',
      callbacks: 'map:callback',
      servers: 'server',
    },
  },
  parameter: {
    omit: ['description', 'summary', 'example', 'examples'],
    children: { schema: 'schema', content: 'map:mediaType' },
  },
  header: {
    omit: ['description', 'summary', 'example', 'examples'],
    children: { schema: 'schema', content: 'map:mediaType' },
  },
  response: {
    omit: ['description', 'summary'],
    children: { headers: 'map:header', content: 'map:mediaType', links: 'map:link' },
  },
  requestBody: { omit: ['description', 'summary'], children: { content: 'map:mediaType' } },
  mediaType: {
    omit: ['example', 'examples'],
    children: { schema: 'schema', encoding: 'map:encoding' },
  },
  encoding: { omit: [], children: { headers: 'map:header' } },
  securityScheme: { omit: ['description', 'summary'] },
  server: { omit: ['description'], children: { variables: 'map:serverVariable' } },
  serverVariable: { omit: ['description'] },
  tag: { omit: ['description', 'externalDocs'] },
  link: { omit: ['description', 'summary'], children: { server: 'server' } },
  callback: { omit: [] },
}

function ruleFor(context: Context): Rule | undefined {
  return context === 'data' || context.startsWith('map:')
    ? undefined
    : rules[context as ObjectContext]
}

function childContext(context: Context, key: string): Context {
  if (context.startsWith('map:')) return context.slice(4) as ObjectContext
  if (context === 'callback') return 'pathItem'
  if (context === 'schema' && ['if', 'then', 'else'].includes(key)) return 'schema'
  const children = ruleFor(context)?.children
  return children && Object.hasOwn(children, key) ? children[key]! : 'data'
}

function contractHash(body: Buffer): string {
  const digest = createHash('sha256')
  let nodes = 0
  function visit(value: unknown, context: Context, depth: number): void {
    if (depth > 128) throw new Error('OpenAPI comparison exceeds its 128 level depth limit')
    if (++nodes > 1_000_000) throw new Error('OpenAPI comparison exceeds its node limit')
    if (Array.isArray(value)) {
      digest.update('[')
      for (const item of value) {
        visit(item, context, depth + 1)
        digest.update(',')
      }
      digest.update(']')
    } else if (isObject(value)) {
      digest.update('{')
      for (const key of Object.keys(value).toSorted()) {
        // Only OpenAPI annotations are ignored. Map keys and arbitrary payload
        // data (defaults, enums, security scopes, extensions) remain significant.
        if (ruleFor(context)?.omit.includes(key)) continue
        digest.update(JSON.stringify(key)).update(':')
        visit(value[key], childContext(context, key), depth + 1)
        digest.update(',')
      }
      digest.update('}')
    } else {
      digest.update(JSON.stringify(value))
    }
  }
  visit(parseJson(body, 'OpenAPI document'), 'document', 0)
  return digest.digest('hex')
}

export function planSpecRelease(input: {
  previousDocument: Buffer
  document: Buffer
  packageSource: string
  changelogSource: string
  revision: Revision
}): ReleasePlan {
  if (contractHash(input.previousDocument) === contractHash(input.document)) return { kind: 'none' }
  const manifest = parseJson(Buffer.from(input.packageSource), 'CLI package manifest')
  if (!isObject(manifest) || manifest.name !== 'bralecli' || typeof manifest.version !== 'string')
    throw new Error('Trusted CLI manifest must declare bralecli and a version')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(manifest.version)
  if (!match) throw new Error('CLI version must be a stable major.minor.patch version')
  const [major, minor, patch] = match.slice(1).map(Number)
  if (
    ![major, minor, patch].every(
      (part) => Number.isSafeInteger(part) && part! < Number.MAX_SAFE_INTEGER,
    )
  )
    throw new Error('CLI version exceeds safe integer bounds')
  const version = major === 0 ? `0.${minor! + 1}.0` : `${major! + 1}.0.0`
  if (!input.changelogSource.startsWith('# bralecli\n'))
    throw new Error('Trusted CLI changelog must start with # bralecli')
  if (input.changelogSource.includes(`\n## ${version}\n`))
    throw new Error(`CLI changelog already contains proposed version ${version}`)
  const entry = `\n## ${version}\n\n### ${major === 0 ? 'Minor' : 'Major'} Changes\n\n- Refresh the generated CLI for the Brale OpenAPI contract fetched on ${input.revision.fetchedAt}\n  (SHA-256: \`${input.revision.hash}\`).\n- Propose a conservative ${major === 0 ? 'pre-1.0 minor' : 'major'} release because upstream contract changes may be breaking.\n  Maintainers review the contract diff and may adjust this version and release note before merging.\n`
  return {
    kind: 'release',
    previousVersion: manifest.version,
    version,
    packageSource: `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
    changelogSource: `# bralecli\n${entry}${input.changelogSource.slice('# bralecli\n'.length)}`,
  }
}
