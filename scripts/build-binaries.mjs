// Run after nub ci: bun --no-env-file scripts/build-binaries.mjs /absolute/output/directory
// Bun 1.3.3 embeds the runtime; the checkout remains unchanged.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

if (Bun.version !== '1.3.3') throw new Error('This release recipe requires Bun 1.3.3')
const root = process.cwd()
const out = process.argv[2]
if (!out?.startsWith('/')) throw new Error('Pass an absolute output directory')
const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root })
if (head.exitCode !== 0) throw new Error('Cannot identify source revision')
const revision = head.stdout.toString().trim()
const { version } = JSON.parse(await readFile(resolve(root, 'apps/cli/package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable package version')
const status = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=no'])
if (status.exitCode !== 0 || status.stdout.length) throw new Error('Tracked source must be clean')
await mkdir(out, { recursive: true })
const intermediate = resolve(out, 'bralecli.bundle.js')
const result = await Bun.build({
  entrypoints: [resolve(root, 'apps/cli/src/bin.ts')],
  outdir: out,
  naming: 'bralecli.bundle.js',
  target: 'bun',
  conditions: ['@bralecli/source'],
  env: 'disable',
  define: {
    __INCUR_BINARY_VERSION__: JSON.stringify(version),
    __BRALE_AGENT_SKILL__: JSON.stringify(
      await readFile(resolve(root, '.agents/skills/bralecli/SKILL.md'), 'utf8'),
    ),
  },
  plugins: [
    {
      name: 'embed-vendored-brale-spec',
      setup(build) {
        build.onLoad({ filter: /\/incur\/dist\/Mcp\.js$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8')
          const call = "importModule('@modelcontextprotocol/server/stdio')"
          if (source.split(call).length !== 2) throw new Error('Unexpected MCP loader source')
          return {
            contents: source.replace(call, "import('@modelcontextprotocol/server/stdio')"),
            loader: 'js',
          }
        })
        build.onLoad({ filter: /\/packages\/brale\/src\/spec\.ts$/ }, async ({ path }) => {
          let source = await readFile(path, 'utf8')
          const replacements = [
            [
              "import { createRequire } from 'node:module'",
              "import bundledSpec from '../openapi/brale.json'",
            ],
            ['const require = createRequire(import.meta.url)', ''],
            [
              "require('../openapi/brale.json') as OpenApiDocument",
              'bundledSpec as OpenApiDocument',
            ],
          ]
          for (const [before, after] of replacements) {
            if (source.split(before).length !== 2) throw new Error('Unexpected spec loader source')
            source = source.replace(before, after)
          }
          return { contents: source, loader: 'ts' }
        })
      },
    },
  ],
})
if (!result.success) throw new AggregateError(result.logs, 'Bundle failed')
const platforms = ['darwin-arm64', 'darwin-x64-baseline', 'linux-arm64', 'linux-x64-baseline']
await Promise.all(
  platforms.map(async (platform) => {
    const filename = `bralecli-${platform.replace('-baseline', '')}`
    const child = Bun.spawn(
      [
        'bun',
        'build',
        intermediate,
        '--compile',
        `--target=bun-${platform}`,
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--env=disable',
        '--outfile',
        resolve(out, filename),
      ],
      { stdout: 'inherit', stderr: 'inherit' },
    )
    const timeout = setTimeout(() => child.kill(), 300_000)
    const code = await child.exited
    clearTimeout(timeout)
    if (code !== 0) throw new Error(`Compile failed: ${platform}`)
  }),
)
await writeFile(
  resolve(out, 'build-info.json'),
  JSON.stringify({ revision, version, bun: Bun.version }, null, 2) + '\n',
)
console.log(`Built four targets from ${revision}`)
