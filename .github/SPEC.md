# Repository contribution and automation policy

The repository welcomes human and agent-assisted contributions while reserving
workflow execution and merges for maintainers. Contributors submit issues and
pull requests; GitHub evaluates repository rules before running automation or
updating the default branch.

## Requirements

- REQ-REPO-001: Issue forms collect reproducible bugs or feature outcomes and
  acceptance criteria. The PR template asks for actual validation and optional
  handoff notes without requiring private agent transcripts.
- REQ-REPO-002: Repository workflow execution is restricted to the Maintain and
  Admin roles and the push, pull_request, and workflow_dispatch events through an
  active GitHub Actions policy. GitHub's built-in feature exemptions remain a
  platform limitation, not an authorization granted by this repository.
- REQ-REPO-003: Workflows use read-only contents permissions, hosted runners,
  bounded timeouts, commit-pinned actions, and checkout without persisted credentials.
  Fork workflows receive no write tokens or secrets.
- REQ-REPO-004: The default branch requires a PR, one code-owner approval from
  someone other than the latest pusher, dismissal of stale approvals, resolved
  review threads, and all seven CI checks on up-to-date code. No bypass actors,
  force pushes, or branch deletion are allowed.
- REQ-REPO-005: Dependency updates are manually requested on main and produce a
  downloadable patch. Automation does not push commits, create PRs, or approve PRs.

## Invariants and non-goals

Workflow jobs never receive Brale credentials or move funds. External contributors
cannot initiate this repository's CI; workflows run independently in their own
forks are outside this repository's control. Maintainers inspect outside changes
before bringing them onto a repository branch for CI. There is no package
publication or deployment workflow. Repository visibility and licensing do not
change as part of these protections.

## Acceptance and traceability

- [ ] REQ-REPO-001: YAML parsing and independent template review pass.
- [ ] REQ-REPO-002: Active Actions policy shows exactly the two roles and three events.
- [ ] REQ-REPO-003/005: `nub run test` includes the repository policy tests; actionlint passes.
- [ ] REQ-REPO-004: Live ruleset matches `.github/rules/main.json` with no bypass actors.
- [ ] REQ-REPO-003/004: GitHub CI passes on the proposed commit; token defaults are read-only.

Risk: authorization and CI configuration. Applying repository rules is an
administrator operation; changes are reviewed before activation.
