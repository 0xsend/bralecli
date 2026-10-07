# bralecli

## 0.3.0

### Minor Changes

- Refresh the generated CLI for the Brale OpenAPI contract fetched on 2026-10-07
  (SHA-256: `40074bc91d6928b2b1d836fddba1d735f5f3511a59ee184f21b6085d6c9dc415`).
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
