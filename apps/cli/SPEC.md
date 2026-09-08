# Agent onboarding

Agents need Brale-specific operating guidance in addition to generated command
schemas. The CLI distributes one curated skill to Claude Code and Codex after
CLI installation, including when the CLI is a standalone executable.

## Model and requirements

The canonical document is `.agents/skills/bralecli/SKILL.md` at the repository
root. Source execution reads it; standalone builds embed its bytes. Installation
maps a scope (current project or user) and selection (Claude, Codex, or both) to
skill destinations, then reports each destination and its resulting status.

- REQ-AGENT-001: `bralecli agents install` installs the curated skill for both
  agents in the current project without credentials, network, or agent binaries.
  `--agent claude|codex|all` selects the recipients; `--global` selects user scope.
- REQ-AGENT-002: Codex destinations are `.agents/skills/bralecli/SKILL.md` under
  the project or home directory. Claude destinations are
  `.claude/skills/bralecli/SKILL.md` under the project or home directory; global
  installs honor `CLAUDE_CONFIG_DIR` when set. Paths follow the harnesses'
  documented discovery locations.
- REQ-AGENT-003: Identical skill content is unchanged on reinstallation.
  Conflicting content requires `--force`; all selected destinations are checked
  for conflicts before writing. Existing repository instructions and other
  skills are preserved. Each skill file is replaced atomically; multi-file I/O
  failure may leave completed files installed and is reported as an error.
- REQ-AGENT-004: A standalone executable installs the same skill without a source
  checkout or supporting runtime on PATH. Installation results identify paths
  and installed, updated, or unchanged status; invalid input and conflicts fail
  with actionable errors.
- REQ-AGENT-005: README agent setup follows CLI installation immediately. Root
  AGENTS.md routes to the shared operating skill and development checks;
  CLAUDE.md imports AGENTS.md. The skill teaches discovery, configured credential
  use, explicit JSON output, pagination, scoped writes, and result verification,
  including current API limitations.

## Invariants and non-goals

Setup never resolves credentials or calls Brale. Skills do not grant permission
to move funds. The CLI's API command names, auth behavior, and transfer behavior
remain outside this change. Generated `skills add` remains available as an
optional API reference. Installation does not edit AGENTS.md or CLAUDE.md in a
consumer's project and does not register MCP servers.

## Acceptance and verification

- [x] Isolated install tests cover both scopes, selection, preservation,
      conflicts, forced updates, repeated installs, and invalid options.
- [x] Offline standalone smoke verifies exact installed content with an empty
      PATH, synthetic HOME, and no checkout or Brale credentials.
- [x] Fresh participant follows README setup and uses the skill for discovery
      and representative read/write planning tasks without any live API calls.
- [x] Repository check, build, knip, and jscpd pass.

REQ-AGENT-001 through REQ-AGENT-004 map to `src/agent-skills.test.ts` and
`../../scripts/smoke-binary.py`. REQ-AGENT-005 maps to the independent task
evaluation specified in BRIEF.md.

## Decisions

Provisional, 2026-09-08: a dedicated curated-skill installer is used because
incur's generated installer only includes authored skills from filesystem globs,
requires Claude autodetection, and replaces conflicting skills. These behaviors
do not satisfy standalone delivery and preservation. Project scope is the
default because it bounds the effect of an installation command.
