# Contribution surface quality

Law for repository collaboration. Human-confirmed decisions and boundaries change
only with human confirmation; working progress is kept outside this brief.

## Bar

Contributors can explain useful changes without ceremony, and maintainers can
verify the changes and repository protections from concrete evidence.

## Dimensions and floors

- Clarity: templates ask for outcomes, reproduction, and actual validation;
  independent review finds no blocking ambiguity or mandatory private context.
- Security: repository policy tests and actionlint pass; live Actions and branch
  rules match the requirements in SPEC.md.
- Isolation: artifact integration tests reject executable/invalid proposals; the
  Docker verifier demonstrates inaccessible runner credentials and host files,
  denied outbound test traffic, skipped install scripts and accurate failures.
  Compatibility cannot mutate the artifact consumed by the publisher.
- Observability: all seven required checks appear on the current PR revision and
  report named results; dependency patches and spec proposals have a run summary
  and artifact; spec PRs show compatibility failures; unrun checks are labeled as such.
- Idempotency: refresh tests prove unchanged bytes preserve the document and date,
  including repeated proposals; one fixed bot branch prevents daily duplicate PRs.
- Release correctness: semantic spec fixtures distinguish contract changes from
  annotations. All four native jobs pass project checks and the standalone smoke
  harness. Artifact tests reject wrong identity, digest, file type, archive paths
  and incomplete platform sets before the writer can upload.
- Release recovery: HTTP integration tests prove draft-only creation, exact asset
  verification, resumption of matching uploads, conflict rejection and preservation
  of published releases. Published releases are never an automation output.

## Oracle

An independent reviewer checks workflow trust boundaries and contributor tone.
Deterministic policy tests and GitHub's settings/check results verify enforcement.
Review is bounded to two rounds, with security or correctness findings blocking.

## Never

Never require credentials or private transcripts. Never claim unrun checks passed.
Never give contributor code a write token or bypass required review to land it.

## Decisions and boundary

Human and agent-assisted contributions are welcome. The requested team-only CI
policy uses the existing Maintain/Admin roles; repository visibility stays private.
Activating authorization and branch rules requires the plan approval specified in
the operator's AGENTS.md. Merging a protected PR still requires an independent
human approval; the author cannot approve it.

2026-09-08, ratified by request: daily spec checking and bot PR creation are
authorized. The bot has no approval or merge step. Provisional implementation
decision: use the native token with a separate publisher job; retain maintainer
control over CI runs.

2026-09-09, ratified by request: separate preparation, compatibility and publishing;
validate data and rebuild the pin from trusted source; run CI project checks in
containers without runner credentials or outbound networking. Workflow changes
remain subject to maintainer review. Provisional scope: the networked action audit
and manual dependency patch workflow retain the exceptions documented in SPEC.md.

2026-09-09, provisional: after reviewing bot changes, a maintainer closes and
reopens the draft PR to trigger pull-request CI. Manual dispatch is diagnostic;
acceptance requires all seven checks attached to the current PR revision.
Evidence: [repository verification](SPEC.md#decisions).

2026-09-09, ratified by request: spec PRs propose version/changelog changes and
reviewed versions produce four-platform verified draft releases. Public
publication of v0.2.0 is authorized; future drafts require a maintainer to publish.
Release builds use fresh native hosted VMs with read-only repository tokens;
the separate draft writer never installs dependencies or executes artifacts.
