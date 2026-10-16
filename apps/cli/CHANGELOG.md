# bralecli

## 0.3.0

### Minor Changes

- Refresh the generated CLI for the Brale OpenAPI contract fetched on 2026-10-16
  (SHA-256: `c62d5096c0178e8fabb69004971cd39c14877807707cea9955dcce9f1e28934c`).
- Propose a conservative pre-1.0 minor release because upstream contract changes may be breaking.
  Maintainers review the contract diff and may adjust this version and release note before merging.

## 0.2.0

### Added

- Install the curated Brale operating skill for Claude Code and Codex with
  `bralecli agents install`, including project/global scopes, agent selection,
  conflict detection and explicit replacement.
- Embed the curated skill in standalone macOS and Linux executables.

### Updated

- Refresh the embedded Brale OpenAPI contract, including business address fields
  and the document upload contract's reverse-side image field.
- Prepare future releases from reviewed spec version proposals, with four-platform
  builds, standalone smoke checks, checksums and draft-only uploads.

## 0.1.1

### Fixed

- Restore JSON object and array flags before request validation.
- Provide standalone macOS and Linux executables for ARM64 and x64.

## 0.1.0

### Minor Changes

- Initial release of the generated Brale API CLI, including lazy OAuth credentials,
  contract-pinned request normalization, and guarded
  pagination and path handling.

### Patch Changes

- Updated dependencies
  - @bralecli/brale@0.1.0
