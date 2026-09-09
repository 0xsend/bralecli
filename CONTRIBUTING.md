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

The native `GITHUB_TOKEN` needs no additional secret. Bot-created PR workflow
runs may need approval, and the repository's actor policy can restrict them.
Approve pending runs if GitHub offers that option; otherwise manually dispatch
**CI** on `automation/brale-spec` as a maintainer. Confirm all required checks
pass on the current PR revision before merging. Independent human review and
branch protections still apply.

The bot replaces its dedicated branch on later upstream changes. Make fixes on
a separate branch, and close an obsolete proposal if upstream reverts to the
vendored revision. The updater does not bump package versions or publish a release.
