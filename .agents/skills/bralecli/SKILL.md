---
name: bralecli
description: Use when operating the Brale API with bralecli to inspect accounts, addresses, balances, financial institutions, transfers, tokenization, automations, or webhooks.
---

# Brale CLI

Use the installed `bralecli`. Discover the installed version's command surface
before constructing a request; operation names match the vendored OpenAPI
`operationId`, with no `api` prefix.

## Discover without credentials

```sh
bralecli --version
bralecli --llms
bralecli list_accounts --schema --format json
bralecli create_transfer --help
```

Use `<command> --schema --format json` for argument order, required options, and
nested body schemas. Use `--llms-full` only when the full command reference is
needed. Discovery does not call Brale. There is no dry-run mode for API writes;
`--help` and `--schema` describe syntax, not permissions, available funds, or
whether a transfer will succeed.

## Credentials and target

Use credentials already configured by the operator. For 1Password, the CLI
resolves `BRALE_CLIENT_ID_REF` and `BRALE_CLIENT_SECRET_REF` (`op://` references)
internally. Alternatively, a secret manager can inject `BRALE_CLIENT_ID` and
`BRALE_CLIENT_SECRET` before the agent starts. Direct values take precedence over
references. `.env` files are deliberately ignored.

Do not fetch or print credential values, paste them into commands, dump the
environment, or write them to project files. Credential flags do not exist.
If authentication is missing or rejected, report the error and the required
configuration names; let the operator configure access without sharing values.

The API defaults to `https://api.brale.xyz` and authentication defaults to
`https://auth.brale.xyz`. `BRALE_API_BASE_URL` and `BRALE_AUTH_BASE_URL` override
those hosts. Establish the intended environment and account from the user's
request and configuration before a write; do not guess a sandbox host or change
hosts to work around an authentication error.

## Inspect and paginate

Prefer explicit `--format json` for machine parsing. A nonzero exit or an error
response is a failed request, not an empty result. Normal API output is the
response data; `--full-output` adds the CLI envelope. Do not assume every command
returns the same `data` wrapper; inspect the actual response.

```sh
bralecli list_accounts --page_size 50 --format json
bralecli get_account <account-id> --format json
bralecli list_account_addresses <account-id> --format json
bralecli list_account_financial_institutions <account-id> --format json
bralecli list_transfers <account-id> --page_size 50 --format json
bralecli list_transfers <account-id> --page_size 50 --page_after <cursor> --format json
bralecli get_transfer <account-id> <transfer-id> --format json
```

Replace placeholders with IDs and cursors returned by Brale. `address_id` is a
Brale record ID, not a raw wallet address. Path IDs are positional in schema
order. Page sizes are 1–1000; use only one of `--page_after` or `--page_before`.
Follow the response's pagination information until exhausted or the task's
explicit page budget is reached. Report incomplete pagination instead of
claiming a resource does not exist after one page. Detect repeated cursors.

## Prepare a change

For a write, resolve the exact account, source and destination records, amount,
currency, chain or bank rail, and effect. Match these to the authorization
already given by the user; ask only for missing authorization or material target
details. Inspect current state before changing an existing resource.

Object and array flags take one shell-quoted JSON value, not dotted flags or a
JSON string inside JSON. For example, `--amount '{"value":"10","currency":"USD"}'`
is one object-valued argument. Check the command's schema for the other required
fields. Keep monetary values as the strings required by the schema; do not
silently round them or infer asset and network names.

`create_*`, `update_*`, `patch_*`, `delete_*`, `register_*`, `enable_balance`, and
`replay_webhook_event` have effects. Looking up syntax is safe; executing an API
command is not a preview. Creating a transfer can initiate funds movement.

**Transfer limitation:** the current CLI does not expose or send the
`Idempotency-Key` header required by Brale's transfer creation guide. Do not
invent `--idempotency-key`, `--header`, or `--dry-run` flags. Explain this gap and
use an operator-approved API client supporting that header when it is required.
Do not treat a syntactically valid creation command as a verified live workflow.

## Verify and recover

After an authorized write, retain the returned resource ID and query the matching
`get_*` command. Transfer creation acceptance is not settlement: inspect
`status` and `failure`, and report the state actually observed. For `get_transfer`,
`complete`, `canceled`, and `failed` are terminal; `pending`, `processing`, and
`compliance review` are not. Other resources may use different states. If
monitoring is requested, use a deadline and bounded backoff; stop at a terminal
state or the deadline and report any still-pending state.

After a timeout or ambiguous write response, reconcile using read commands and
known IDs before deciding what happened. Do not automatically repeat a create,
mint, burn, replay, or other non-idempotent write, even if an error is labeled
retryable. If the outcome cannot be identified, report it as unknown.

The vendored address variant of `create_update_link_token` has a mismatched path
parameter (`fi_id` versus `{address_id}`); do not rely on that operation until the
installed version's contract fixes it. Report this limitation instead of
guessing a replacement positional argument.
