# bralecli

## 0.4.0

### Minor Changes

- **Breaking:** the generated CLI no longer includes operations that the Brale
  OpenAPI document marks `deprecated: true`. The vendored contract currently
  marks none, so no command changes until a refresh includes one.

## 0.3.0

### Minor Changes

- Refresh the generated CLI for the Brale OpenAPI contract fetched on 2026-11-04
  (SHA-256: `3378b8f911e0681084b632620e58b329444acf97f5db49fe96615e4833b7384e`).
- Add `update_automation_destination` and `simulate_automation_deposit`.
- **Breaking:** `create_update_link_token` now targets financial institutions
  (`<account_id> <fi_id>`), replacing `create_update_link_token (2)`. The bank
  account address variant is now `create_address_update_link_token`
  (`<account_id> <address_id>`).

### Fixed

- The bank account address update-link-token command now accepts its
  `<address_id>` argument. Brale's earlier contract declared `fi_id` for that path,
  so the previous command could not fill it.

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
