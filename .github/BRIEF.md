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
- Observability: PR checks report named results; dependency patches have a run
  summary and artifact; unrun checks are labeled as such.

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
