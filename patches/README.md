# Dependency patches

`incur@0.5.1.patch` decodes JSON container flag values before the existing Zod
schema validates them. Without it, `create_transfer --amount '{"value":"10","currency":"USD"}'`
fails in argv validation before reaching the fetch adapter. Both the published
JavaScript and TypeScript source are patched so source execution and bundled
binaries agree.

Already-valid strings and repeatable string flags retain their original behavior.
Malformed JSON and invalid nested values fail the original validation. Object
schemas and programmatic object inputs are unchanged, including MCP introspection.

The exact incur version prevents a dependency update from silently dropping this
fix. Remove the patch and version pin together once an upstream release passes
`apps/cli/src/json-flags.test.ts` without it. `nub ci` applies the patch using the
manifest declaration and lockfile hash; no postinstall mutation is needed.
