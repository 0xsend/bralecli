# Contributing to bralecli

Thanks for helping improve bralecli! Bug reports, documentation fixes, and features
are welcome, including work assisted by coding agents.

Start with an issue for a substantial change so maintainers can help confirm the
intended behavior. For a small fix, a focused PR is enough. Use the issue forms to
describe a reproducible problem or an outcome with clear acceptance criteria.

## Making a change

Create a branch or fork, install dependencies with `nub ci`, and make the smallest
change that solves the problem. For a bug fix, include a regression check that
fails before the fix and passes afterward. Run the checks relevant to your change:

```sh
nub run check
nub run build
nub run knip
nub run jscpd
```

In the PR, explain what changed and why, and list the commands you actually ran
with their results. If a check was not run, say `NOT RUN` and explain why. For
agent-assisted work, review the diff yourself and share useful handoff context or
verification gaps. Model names, private prompts, and session transcripts are not
required.

Use fictional IDs, fixtures, and sanitized output. Do not submit credentials,
private customer data, or live transaction details. Tests do not require moving
funds or using production Brale credentials.

## How review and CI work

Repository CI is controlled by maintainers. Outside PRs do not automatically run
on this repository's runners. A maintainer reviews the changes before bringing
them onto a repository branch for CI; contributors can run the same checks
locally or in their own forks.

The default branch requires a code-owner review and passing checks. Updates after
review may require another approval. Agent-generated changes follow the same
review process as any other contribution.

CI runs project checks in disposable Docker containers. Dependency installation
skips lifecycle scripts in a separate container; checks run without outbound
networking, runner credentials, or host mounts. Local HTTP fixtures still work.
Use `node scripts/ci-sandbox.mjs compatibility` to run the complete compatibility
sequence, or pass an individual package script such as `test` or `build`. Docker
must be running. The runner snapshots tracked working-tree files; add new files
to Git before running it. Run `node --test scripts/ci-sandbox.test.mjs` to exercise
the isolation boundaries. These commands require the Node version in `.node-version`.

The `actions:check` audit runs in a separate credential-free container with network
access to fetch action manifests. The manual **Update Dependencies** workflow
uses host tools and does not have the CI container isolation. The sandbox runner
and its verifier (`scripts/ci-sandbox.test.mjs`) run on the host to control Docker;
they are trusted infrastructure. Changes to those files, workflows, or the
publisher's scripts require careful maintainer review: code that replaces these
definitions can remove their protections.

Maintainers can manually run **Update Dependencies** on `main` to obtain a patch
artifact. Review it, apply it on a branch with `git apply dependency-update.patch`,
and open a PR. The workflow does not push or merge dependency changes.

## Daily spec updates

**Update Brale Spec** checks upstream daily at 08:23 UTC (GitHub schedules may
be delayed) and supports manual runs on `main`. Preparation downloads the spec
without installing project dependencies and uploads its raw bytes and revision
metadata. A separate job checks compatibility in the CI container. The publisher
validates the immutable preparation artifact and reconstructs the pin from its
trusted main checkout, then opens or updates the draft PR on
`automation/brale-spec`. It never accepts executable source from the artifact.
When the contract changes, the trusted publisher also proposes a CLI version and
changelog entry. Formatting and known documentation annotations alone do not
trigger a release. Because an upstream contract change may be breaking, automatic
proposals increment the minor version before 1.0 and the major version thereafter.
Reviewers assess compatibility and can adjust the proposed bump before merging.
Failed compatibility checks remain visible in the PR and do not suppress it.

To activate the workflow after merging it to `main`:

1. In [Actions policies](https://github.com/0xsend/bralecli/settings/actions/rules/4145),
   add `schedule` to **Maintainer-controlled workflows**. Retain Maintain/Admin
   actors and the existing events. A maintainer must install or update the cron
   so the scheduled actor is permitted.
2. In [Actions settings](https://github.com/0xsend/bralecli/settings/actions),
   enable **Allow GitHub Actions to create and approve pull requests**. GitHub
   combines creation and approval in this setting; the bot never approves PRs.
   Keep default token permissions read-only. Only the publishing job requests
   contents and pull-request write access.
3. Manually run **Update Brale Spec** on `main` and inspect its summary. An
   unchanged upstream document needs no PR. A changed document produces a draft
   with the upstream hash and compatibility outcome.

The native `GITHUB_TOKEN` needs no additional secret. This repository's actor
policy blocks CI triggered by the bot. After reviewing the bot's changes, close
and reopen the draft PR as a maintainer to trigger pull-request CI. Confirm all
seven required checks appear on the current PR revision and pass before marking
it ready, requesting approval, or merging. Independent human review and branch
protections still apply.

Manual **CI** dispatch on `automation/brale-spec` remains useful for diagnostics.
In this repository's [live verification](.github/SPEC.md#decisions), a manual run
passed on the same commit while the PR's required checks remained missing.
Verify the checks attached to the PR itself.

The bot replaces its dedicated branch on later upstream changes. Make fixes on
a separate branch, and close an obsolete proposal if upstream reverts to the
vendored revision. Its version and changelog changes remain proposals until merged.

## Releases

Include a CLI version bump in `apps/cli/package.json` and an entry in
`apps/cli/CHANGELOG.md` when a client change needs to ship. Multiple changes may
share a version. Spec PRs propose these files automatically. Repository-only
changes do not require a release.

**Prepare Release** runs on maintainer pushes to `main`, including reviewed PR
merges, and supports manual dispatch on `main`. An already completed version is a
no-op. A pending version runs locked installs and project checks, then builds and
smoke-tests each executable on its native macOS/Linux and ARM64/x64 runner. These
jobs are read-only, skip install scripts, and use synthetic credentials; they run
on fresh hosted VMs rather than the CI Docker sandbox.

A separate writer downloads artifacts from that successful run, validates the
archive contents, source revision, version and checksums, then creates a draft
containing four archives, `SHA256SUMS` and `build-info.json`. It never executes
downloaded binaries or installs dependencies. Failed uploads leave a draft;
reruns resume matching assets and reject conflicts without replacing bytes.

Review the draft's source revision, changelog and all four build/smoke results.
Confirm all six assets are attached before publishing. Repository release
immutability locks the assets and tag when the draft is published. Corrections
ship under a new version. Automation never publishes a draft or approves/merges
a PR. Existing mutable releases are not changed by this workflow.

For local recovery, use a clean checkout of the exact intended source commit:

```sh
nub ci --ignore-scripts
bun --no-env-file scripts/build-binaries.mjs /absolute/binaries
# Run scripts/smoke-binary.py against each target on a compatible machine.
nub scripts/release-artifacts.ts package /absolute/binaries darwin-arm64 /absolute/package-darwin-arm64
# Repeat packaging for the other three platforms; collect their files in inputs.
gh auth token | nub scripts/release-draft.ts upload /absolute/inputs /absolute/new-verified-output
```

Packaging does not replace the required smoke tests. The upload command validates
the inputs and leaves the release as a draft. Pass tokens only through stdin;
never place them in command arguments or files.
