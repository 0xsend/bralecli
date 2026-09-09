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
  Admin roles and the push, pull_request, workflow_dispatch, and schedule events through an
  active GitHub Actions policy. GitHub's built-in feature exemptions remain a
  platform limitation, not an authorization granted by this repository.
- REQ-REPO-003: Workflows default to read-only contents permissions, hosted runners,
  bounded timeouts, commit-pinned actions, and checkout without persisted credentials.
  Fork workflows receive no write tokens or secrets. Only the spec PR job receives
  contents and pull-requests write permissions; it does not install dependencies
  or execute project checks or the refreshed spec. Its builtin-only validator
  runs from the trusted main revision selected when the workflow started.
- REQ-REPO-004: The default branch requires a PR, one code-owner approval from
  someone other than the latest pusher, dismissal of stale approvals, resolved
  review threads, and all seven CI checks on up-to-date code. No bypass actors,
  force pushes, or branch deletion are allowed.
- REQ-REPO-005: Dependency updates are manually requested on main and produce a
  downloadable patch. Dependency automation does not push commits or create PRs.
  No automation approves or merges PRs.
- REQ-REPO-006: The spec updater runs daily at 08:23 UTC, or manually on main,
  in the canonical repository only. A bounded fetch compares the upstream raw
  bytes, preserving them exactly. Unchanged bytes produce no file/date changes;
  changed bytes update the vendored document, SHA-256, and fetch date. An explicit
  `--update-pin` option enables pin updates; the default refresh leaves pins for
  manual review. Invalid responses fail before writing files.
- REQ-REPO-007: One dedicated branch, `automation/brale-spec`, holds the latest
  spec proposal. A repeated upstream revision preserves its prior fetch date.
  Only the vendored document and pin file enter its PR. The updater reports
  compatibility checks and opens a draft even when those checks fail, so upstream
  changes remain visible. Fetch/preparation failures do not publish a proposal.
  Package versions and releases are separate maintainer decisions.
- REQ-REPO-008: Preparation installs no project dependencies and uploads only
  raw spec bytes and revision metadata. Compatibility runs in a separate job.
  The publisher downloads the preparation artifact by immutable ID, rejects
  unexpected files, symlinks, oversized/invalid data and inconsistent hashes,
  and reconstructs only SHA/date literals against its trusted pin source.
  Compatibility cannot replace the artifact or supply executable pin source.
- REQ-REPO-009: CI and spec compatibility execute project checks in fresh,
  bounded containers without runner credentials, host mounts or outbound network.
  A separate dependency-download container skips lifecycle scripts. Source comes
  from tracked working-tree files without Git metadata or local credentials.
  Untrusted logs cannot issue Actions workflow commands. Exit status determines
  success. The action-manifest audit requires a separate networked container.

## Invariants and non-goals

Workflow jobs never receive Brale credentials or move funds. External contributors
cannot initiate this repository's CI; workflows run independently in their own
forks are outside this repository's control. Maintainers inspect outside changes
before bringing them onto a repository branch for CI. There is no package
publication or deployment workflow. Repository visibility and licensing do not
change as part of these protections.

The isolation assumes reviewed workflow, runner and publisher definitions. The
Docker verifier (`scripts/ci-sandbox.test.mjs`) also executes on the host and is
trusted infrastructure. A maintainer who changes those definitions can remove
isolation; repository policy and independent review remain the external
enforcement boundary. Containers share the hosted runner's
kernel and are not a guarantee against container/runtime vulnerabilities. The
manual **Update Dependencies** workflow still uses host tools and is outside
REQ-REPO-009; maintainers review its main-branch inputs before running it.

## Acceptance and traceability

- [ ] REQ-REPO-001: YAML parsing and independent template review pass.
- [ ] REQ-REPO-002: Active Actions policy shows the two roles and four events.
- [ ] REQ-REPO-003/005: `nub run test` includes the repository policy tests; actionlint passes.
- [ ] REQ-REPO-004: Live ruleset matches `.github/rules/main.json` with no bypass actors.
- [ ] REQ-REPO-003/004: All seven required CI checks appear on the current PR
      revision and pass; token defaults are read-only.
- [ ] REQ-REPO-006/007: Refresh integration tests cover changed/unchanged bytes,
      repeated proposals, invalid responses, and pin integrity; workflow policy tests
      verify trigger, branch, artifact, and permission boundaries.
- [ ] REQ-REPO-004/006/007: A manual Actions run verifies the published workflow;
      native-token PR creation is enabled in repository settings. After reviewing
      the bot's changes, a maintainer closes and reopens the draft PR. Pull-request
      CI starts and all seven required checks appear on the current PR revision
      and pass before the PR is marked ready, submitted for approval, or merged.
- [ ] REQ-REPO-008: Artifact integration tests reject hostile files/metadata without
      changing trusted files; workflow tests prove separate jobs and artifact IDs.
- [ ] REQ-REPO-009: The Docker adversarial verifier proves credential/host isolation,
      blocked outbound access, working loopback, skipped lifecycle scripts and
      failure propagation. Compatibility passes inside the same container runner.

## Decisions

- 2026-09-08, ratified by request: daily spec checking and automated PR creation
  are authorized; PR approval and merging remain human decisions.
- 2026-09-08, provisional: native `GITHUB_TOKEN` avoids a new long-lived secret;
  preparation runs separately from the writer. Spec revision means raw bytes and
  their pin, because the upstream version string does not reliably change.
- 2026-09-09, ratified by request: isolate compatibility from proposal preparation,
  reconstruct the published pin from trusted source, and isolate CI project code
  from runner credentials and outbound network access.
- 2026-09-09, provisional: the action-manifest audit retains credential-free
  network access because it reads remote action definitions; the manual dependency
  patch workflow is a separate maintainer-operated surface.
- 2026-09-09, provisional: maintainers review bot changes, then close and reopen
  the draft PR to trigger pull-request CI. Manual dispatch remains diagnostic.
  In this repository's [PR #8](https://github.com/0xsend/bralecli/pull/8) verification,
  the [bot-triggered run](https://github.com/0xsend/bralecli/actions/runs/34307044158)
  was rejected by actor policy. A [maintainer dispatch](https://github.com/0xsend/bralecli/actions/runs/34307113519)
  passed all seven jobs on the same commit while required PR checks remained missing.
  The [maintainer reopen run](https://github.com/0xsend/bralecli/actions/runs/34307376855)
  attached all seven required checks to that PR revision, and all passed. Acceptance therefore
  requires the PR's own checks, not success on a separate run.

Risk: authorization and CI configuration. Applying repository rules is an
administrator operation; changes are reviewed before activation.
