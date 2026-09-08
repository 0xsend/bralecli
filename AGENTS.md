# Working with bralecli

## Operating the CLI

Read [.agents/skills/bralecli/SKILL.md](.agents/skills/bralecli/SKILL.md) before
operating Brale. It covers discovery, credential references, account selection,
JSON flags, pagination, write authorization, and verification. The installed
CLI's `--help` and `--schema` are the command contract; do not invent flags.

For installation and examples, read [README.md](README.md). Install the curated
skill into another project with `bralecli agents install`, or across projects
with `bralecli agents install --global`. The installer updates skill files only;
it does not install repository development instructions into other projects.

## Changing this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) before editing. Use `nub ci` for a locked
dependency install. From a checkout, `apps/cli/src/bin.ts` invokes the CLI
directly without requiring a global install. Keep its `--no-env-file` shebang.

- `apps/cli/src/index.ts` composes the generated CLI and local integrations.
- `apps/cli/src/client.ts` and `credentials.ts` own OAuth and request adaptation.
- `packages/brale/` owns the vendored OpenAPI document and normalizers. Refresh
  the contract deliberately with `nub run spec:refresh`; never reformat the
  vendored JSON or edit generated output as a fix.
- `.agents/skills/bralecli/SKILL.md` is the shared skill source. The Claude skill
  links to it, and the standalone build embeds it. Keep guidance aligned with
  observable CLI behavior and [apps/cli/SPEC.md](apps/cli/SPEC.md).

Run `nub run check` and `nub run build` for changes; also run the contribution
checks in CONTRIBUTING.md. For behavior fixes, observe the regression test fail
before fixing it. Use isolated directories and synthetic credentials in tests;
agent setup and discovery must work without live credentials or network access.
Never test by moving real funds. Report the checks actually run and any gaps.

Preserve unrelated changes. Do not publish packages, releases, or repository
changes unless the user has authorized that outcome.
