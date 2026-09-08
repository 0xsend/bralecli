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

Maintainers can manually run **Update Dependencies** on `main` to obtain a patch
artifact. Review it, apply it on a branch with `git apply dependency-update.patch`,
and open a PR. The workflow does not push or merge dependency changes.
