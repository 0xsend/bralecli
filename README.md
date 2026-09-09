# bralecli

A CLI for the [Brale](https://brale.xyz) API. Manage accounts, look up addresses
and financial institutions, create deposits and withdrawals, and transfer
stablecoins from your terminal.

Commands are generated from the vendored Brale OpenAPI
document. Command names match its `operationId` values, so you can move between
the API contract and the CLI without learning a separate set of resource commands.

## Install

Download an archive and `SHA256SUMS` from the [GitHub release](https://github.com/0xsend/bralecli/releases).
Choose `darwin-arm64` for Apple Silicon, `darwin-x64` for Intel Macs,
`linux-arm64` for ARM Linux, or `linux-x64` for Intel/AMD Linux.
The Linux binaries use glibc. These executables include their runtime; Node and Nub are not required.

Verify the archive against `SHA256SUMS` (`shasum -a 256` on macOS or `sha256sum`
on Linux), then extract and install it. For example, on Apple Silicon:

```sh
tar -xzf bralecli-darwin-arm64.tar.gz
mkdir -p ~/.local/bin
install -m 755 bralecli ~/.local/bin/bralecli
bralecli --version
```

The macOS binaries are not notarized. The optional `op://` credential integration
still requires the 1Password CLI. Keep `~/.local/bin` on the shell's `PATH`.

To run from a source checkout instead, with `nub` installed:

```sh
nub install
nub run build
mkdir -p ~/.local/bin
ln -s "$(pwd)/apps/cli/src/bin.ts" ~/.local/bin/bralecli
```

The bin is directly executable — its shebang runs it through `nub` — so the
symlink is the whole install. Every example below assumes it; from a checkout
without one, `apps/cli/src/bin.ts` invoked directly is the same thing.
Ensure `~/.local/bin` is on your `PATH`.

## Set up Claude Code and Codex

After installing the CLI, run this from the project where your agent will use
Brale:

```sh
bralecli agents install
```

This installs the curated `bralecli` skill for **both Claude Code and Codex** in
the current project. It works offline from a standalone binary or a source
checkout, without Brale credentials or the agent applications installed.

To make it available across all your projects, or select just one agent:

```sh
bralecli agents install --global
bralecli agents install --agent claude
bralecli agents install --agent codex
```

| Agent       | Project installation               | Global installation                  |
| ----------- | ---------------------------------- | ------------------------------------ |
| Claude Code | `.claude/skills/bralecli/SKILL.md` | `~/.claude/skills/bralecli/SKILL.md` |
| Codex       | `.agents/skills/bralecli/SKILL.md` | `~/.agents/skills/bralecli/SKILL.md` |

Global Claude installs honor `CLAUDE_CONFIG_DIR`. These are the native skill
locations documented by [Claude Code](https://code.claude.com/docs/en/skills)
and [Codex](https://developers.openai.com/codex/skills). Installation reports the
actual paths; add `--format json` for machine-readable results. Existing
`AGENTS.md`, `CLAUDE.md`, and unrelated skills are preserved.

Start a new agent session after installation. Ask “Use bralecli to list my Brale
accounts,” or explicitly invoke `/bralecli` in Claude Code or `$bralecli` in
Codex. Configure [authentication](#authentication) before making API calls.
For a credential-free first task, ask “Use bralecli to inspect the transfer
command schema without making an API request.”

The skill covers command discovery, JSON arguments and output, credential
references, pagination, authorization for writes, and verification. It also
documents the current transfer idempotency limitation. Inspect the installed
CLI directly at any time:

```sh
bralecli --llms
bralecli create_transfer --schema --format json
```

After upgrading bralecli, rerun the same install command. Identical content is a
no-op. If the installed skill differs, review it, then add `--force` to replace
it with the upgraded version. The separate `skills add` command generates API
reference skills; `agents install` supplies the curated operating guidance.

Agents working in this repository also receive [AGENTS.md](AGENTS.md), imported
by [CLAUDE.md](CLAUDE.md), and the shared
[Brale skill](.agents/skills/bralecli/SKILL.md) without a separate install.

## Authentication

Use OAuth client credentials for your own Brale application. See Brale's
[quick start](https://docs.brale.xyz/overview/quick-start) for account and API
access setup.

`--help`, `--llms`, and completions need no credentials at all. A token is
minted (OAuth2 client-credentials against `auth.brale.xyz`) at the moment a
command first reaches Brale, cached in-process until shortly before it expires.

| Variable                  | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `BRALE_CLIENT_ID`         | The OAuth client id                                                    |
| `BRALE_CLIENT_ID_REF`     | An `op://vault/item/field` reference to the id, read via `op`          |
| `BRALE_CLIENT_SECRET`     | The OAuth client secret                                                |
| `BRALE_CLIENT_SECRET_REF` | An `op://vault/item/field` reference to the secret, read via `op`      |
| `BRALE_API_BASE_URL`      | Overrides the API host. Defaults to the spec's `https://api.brale.xyz` |
| `BRALE_AUTH_BASE_URL`     | Overrides the token host. Defaults to `https://auth.brale.xyz`         |

Direct values win over references, so a CI runner with injected secrets does
not need `op` installed.

If you use the 1Password CLI, configure references to credentials in your own
vault (replace the example vault, item, and field names):

```sh
export BRALE_CLIENT_ID_REF='op://your-vault/brale/client-id'
export BRALE_CLIENT_SECRET_REF='op://your-vault/brale/client-secret'
bralecli list_accounts
```

Alternatively, have your secret manager or CI environment inject
`BRALE_CLIENT_ID` and `BRALE_CLIENT_SECRET` into the process environment.

Neither credential is ever accepted as a command-line flag, and no such flag
exists. argv is readable by every process on the host, lands in shell history,
and is captured verbatim in CI logs and agent transcripts; a credential that
reaches any of those is burned. A secret _reference_ is not a secret, and is
safe to configure and commit.

`.env` files are ignored, deliberately. The runtime would otherwise
auto-discover `.env*` from the working directory, and running a prod command
from inside a project that keeps sandbox `BRALE_*` credentials in its `.env`
would silently swap them in — past even an explicit `env -u`. Credentials enter
only through the process environment or the `op://` references.

## Usage examples

Replace placeholders such as `<account-id>` and `<source-address-id>` with IDs
from your Brale account. An `address_id` is a Brale record ID, not a raw wallet
address. The examples use CUSD on Base; choose assets, chains, and payment rails
enabled for your account. Commands that create transfers submit requests to
the environment associated with your credentials.

**Current limitation:** Brale's [transfer guide](https://docs.brale.xyz/key-concepts/transfers)
requires an `Idempotency-Key` header for creation requests. The vendored spec
does not expose this header, and the CLI does not add it. The creation examples
below show the supported command syntax, but have not been verified against
the live API and may be rejected for a missing key. Use an API client that
supports this header for transfers requiring idempotency; do not blindly retry
a creation command after an uncertain result.

### Find accounts, addresses, and bank accounts

```sh
bralecli --help
bralecli list_accounts
bralecli get_account <account-id>
bralecli list_account_addresses <account-id>
bralecli list_account_financial_institutions <account-id>
bralecli create_transfer --help
```

### Deposit USD by wire to receive stablecoins

Create an on-ramp transfer for 10 USD to an existing Brale address:

```sh
bralecli create_transfer <account-id> \
  --amount '{"value":"10","currency":"USD"}' \
  --source '{"value_type":"USD","transfer_type":"wire"}' \
  --destination '{"value_type":"CUSD","transfer_type":"base","address_id":"<destination-address-id>"}'
```

Use the `wire_instructions` returned for this transfer to fund it from your
bank. Creating the request does not itself send a bank wire; the transfer
waits for funding. See Brale's [transfer guide](https://docs.brale.xyz/key-concepts/transfers)
for the funding lifecycle.

### Withdraw stablecoins to a bank account

Create an off-ramp transfer from CUSD on Base to USD via wire. Use the Brale
address ID of a registered bank account that supports wire payouts and a funded
source address eligible to initiate transfers through Brale:

```sh
bralecli create_transfer <account-id> \
  --amount '{"value":"10","currency":"USD"}' \
  --source '{"value_type":"CUSD","transfer_type":"base","address_id":"<source-address-id>"}' \
  --destination '{"value_type":"USD","transfer_type":"wire","address_id":"<bank-address-id>"}'
```

### Transfer stablecoins to another wallet

Use a funded source address eligible to initiate transfers through Brale and
a recipient address registered with Brale:

```sh
bralecli create_transfer <account-id> \
  --amount '{"value":"10","currency":"USD"}' \
  --source '{"value_type":"CUSD","transfer_type":"base","address_id":"<source-address-id>"}' \
  --destination '{"value_type":"CUSD","transfer_type":"base","address_id":"<destination-address-id>"}'
```

To register a new recipient wallet, inspect the required fields with
`bralecli create_external_address --help`.

### Track a deposit, withdrawal, or transfer

Save the transfer `id` returned by `create_transfer`, then retrieve its status:

```sh
bralecli get_transfer <account-id> <transfer-id>
bralecli list_transfers <account-id> --page_size 50
bralecli list_transfers <account-id> --page_size 50 --page_after <cursor>
```

Use a cursor from the list response for the next page. A successful creation
response does not mean settlement is complete: inspect `status` and, if the
transfer failed, `failure`.

## The generated API surface

Body properties the contract declares as objects — `amount`, `source`,
`destination`, and friends — are passed as one quoted JSON argument and
re-parsed against the vendored document before the request is sent; without
that, the flag text would survive into the body as a JSON _string_ and Brale
would reject every write.

Object-valued query parameters are exposed as bounded scalar flags. Brale's
`page` object becomes `--page_size`, `--page_after`, and `--page_before`; the
CLI restores the documented `page[size]` wire form. Use only one of
`--page_after` and `--page_before` for cursor pagination.

Path arguments are constrained before generation: Brale's `ID` schema declares
no pattern, and the generator interpolates path arguments verbatim, so an
unconstrained `get_transfer '../other'` would retarget the request after URL
normalization. `constrainPathParameters` turns that into a validation error.

One command is broken upstream: `create_update_link_token` (the addresses
variant) declares `fi_id` where its path says `{address_id}` in Brale's own
document, so the generated command cannot fill that segment. The defect is
pinned by a test in `packages/brale/src/spec.test.ts`; when Brale fixes the
document, the pin fails and both it and this caveat come out.

## The vendored spec

Brale serves its machine-readable contract from the API host itself,
unauthenticated — but unlinked: docs.brale.xyz renders it behind a bot
challenge and never names the source.

```
https://api.brale.xyz/openapi
```

That endpoint is unversioned and the document's `info.version` is a constant,
so upstream can change the contract with no bump, no changelog, and no signal.
The document is therefore committed to `packages/brale/openapi/`, pinned by
checksum, and refreshed deliberately:

```sh
nub run spec:refresh
```

which re-downloads it, reports whether it changed, and leaves the checksum in
`packages/brale/src/spec.ts` to be updated by hand as part of accepting the
diff. Tests pin the assumptions the generated surface is built on — every
operation has a unique `operationId`, every path parameter lives on the
operation — so a refresh that breaks one fails loudly rather than silently
renaming or de-arming commands.

The **Update Brale Spec** workflow checks this endpoint daily at 08:23 UTC and
can also be run manually on `main`. It compares raw bytes, including changes
that leave `info.version` unchanged. A changed document opens or updates one
draft PR on `automation/brale-spec`, including its checksum and fetch date.
The same upstream revision keeps its original proposal date. Package versions
are not bumped automatically.

The workflow uses `nub scripts/refresh-spec.ts --update-pin --format json` to
prepare the proposal. `--previous-pin <path>` reads an earlier proposal's pin
as text to preserve the date when its hash matches. The normal manual refresh
continues to leave pin updates for the maintainer. Invalid downloads fail before
writing the spec; compatibility failures are reported in the draft PR and run
logs. The bot owns its branch, so make follow-up fixes on a separate branch.

Activation and the maintainer CI handoff are described in
[CONTRIBUTING.md](CONTRIBUTING.md#daily-spec-updates).

## Development

```sh
nub run check   # typecheck, lint, format, test
nub run test
nub run build
```

## Layout

```
packages/brale/   the vendored spec and its normalizers
apps/cli/         the incur CLI that composes them with OAuth
```
