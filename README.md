# mail-mcp

An MCP server for email accounts that expose IMAP and SMTP. It runs over stdio or an authenticated loopback HTTP endpoint.

The server treats SMTP delivery and the Sent-folder copy as separate events. Its result states distinguish acceptance, partial recipient rejection, failed persistence, and an unknown SMTP outcome where an automatic retry could send the same message twice.

## Install and connect to Codex

Requirements: Node.js 20.19 or newer, an IMAP/SMTP account, and an operating-system credential store supported by `cross-keychain`.

Add the email account:

```bash
npx -y @1amsheldon/mail-mcp@latest accounts add
```

Then add a pinned server entry to `~/.codex/config.toml`:

```bash
npx -y @1amsheldon/mail-mcp@latest --install-codex
```

The installer enables confirmation tokens, audit logging, and response redaction. It replaces only `[mcp_servers.mail]`, saves the previous file as `config.toml.mail-mcp.bak`, and pins the package version it was run from. Restart Codex after it finishes.

To expose read-only tools instead:

```bash
npx -y @1amsheldon/mail-mcp@latest --install-codex --read-only
```

To update later, rerun the `@latest --install-codex` command. Account settings and credentials stay in place.

## Other install paths

Global command:

```bash
npm install --global @1amsheldon/mail-mcp
mail-mcp accounts add
mail-mcp --install-codex
```

Codex CLI, without the built-in installer:

```bash
codex mcp add mail -- npx -y @1amsheldon/mail-mcp@latest --confirm --audit-log --redact
codex mcp list
```

Equivalent manual config:

```toml
[mcp_servers.mail]
command = "npx"
args = ["-y", "@1amsheldon/mail-mcp@latest", "--confirm", "--audit-log", "--redact"]
enabled = true
startup_timeout_sec = 30.0
tool_timeout_sec = 300.0
```

Do not put passwords, OAuth secrets, or bearer tokens in the repository or MCP configuration.

## Account commands

Account metadata is stored in `~/.config/mail-mcp/accounts.json`. Credentials go to the operating-system keychain.

```bash
mail-mcp accounts add
mail-mcp accounts list
mail-mcp accounts remove ACCOUNT_ID
```

The account wizard accepts IMAP/SMTP hosts and ports, password or OAuth2 authentication, TLS, a signature, a recipient allowlist, a ManageSieve port, and an optional `sentFolder` override.

## What this fork changes

- Routes all 30 advertised tools through one tested dispatcher.
- Reuses one MIME message and its exact `Message-ID` for SMTP and the Sent copy.
- Never retries automatically after an uncertain SMTP outcome.
- Verifies Sent-folder persistence by exact `Message-ID` without modifying the mailbox.
- Runs one shared loopback HTTP process with bearer authentication and bounded sessions.
- Applies read-only mode, tool allowlists, confirmation tokens, audit logging, and response redaction at the MCP boundary.

## Reliable delivery contract

Send, reply, and forward return structured JSON.

| Field | Meaning |
| --- | --- |
| `status` | Delivery state listed below |
| `smtpAccepted` | `true`, `false`, or `null` when the outcome is unknown |
| `accepted`, `rejected` | Per-recipient SMTP result |
| `messageId` | Correlation ID shared by SMTP and the Sent copy |
| `sentFolderSaved` | Whether IMAP confirmed persistence |
| `sentFolderUid` | UID returned by IMAP append, when available |
| `retrySafe` | Whether another send attempt is safe |
| `nextAction` | Next check for the caller |

| Status | Meaning |
| --- | --- |
| `sent_and_saved` | SMTP accepted the message and IMAP confirmed the Sent copy |
| `partially_sent_and_saved` | Some recipients were rejected; accepted recipients were sent and Sent was saved |
| `smtp_accepted_sent_not_confirmed` | SMTP accepted the message, but the Sent copy was not confirmed |
| `smtp_partially_accepted_sent_not_confirmed` | Partial SMTP acceptance without confirmed Sent persistence |
| `smtp_rejected` | SMTP rejected every recipient |
| `smtp_connection_failed` | The connection failed before a confirmed delivery result |
| `smtp_outcome_unknown` | Delivery may have happened; do not retry automatically |

Absence from Sent is not proof that SMTP delivery failed. Check `retrySafe` and verify with `messageId`.

## Tools

Read-only:

- `list_accounts`, `list_emails`, `search_emails`, `verify_sent_message`
- `read_email`, `get_thread`, `get_attachment`, `extract_attachment_text`
- `list_folders`, `mailbox_stats`, `extract_contacts`
- `list_templates`, `use_template`, `list_filters`, `get_filter`

Writes:

- `send_email`, `reply_email`, `forward_email`, `create_draft`
- `move_email`, `modify_labels`, `batch_operations`, `delete_email`
- `mark_read`, `mark_unread`, `star`, `unstar`
- `register_oauth2_account`, `set_filter`, `delete_filter`

## Safety modes

```bash
mail-mcp --read-only
mail-mcp --allow-tools create_draft,move_email
mail-mcp --confirm --audit-log --redact
```

- `--read-only` removes write tools.
- `--allow-tools` exposes only the named write tools.
- `--confirm` binds a short-lived confirmation token to one tool and its original arguments.
- `--audit-log` appends JSONL diagnostics to `~/.config/mail-mcp/audit.log`.
- `--redact` masks selected sensitive content before it reaches the MCP client.

## Shared HTTP service

For several concurrent MCP clients, one loopback-only Streamable HTTP process can share the connection pool.

```powershell
$env:MAIL_MCP_BEARER_TOKEN = '<random-token>'
npx -y @1amsheldon/mail-mcp@latest --http --host 127.0.0.1 --port 8765 --confirm --audit-log --redact
```

Codex config:

```toml
[mcp_servers.mail]
url = "http://127.0.0.1:8765/mcp"
bearer_token_env_var = "MAIL_MCP_BEARER_TOKEN"
enabled = true
startup_timeout_sec = 15.0
tool_timeout_sec = 300.0
```

`GET http://127.0.0.1:8765/health` reports process health and active MCP session count. It does not expose account or mailbox data. The MCP endpoint requires the bearer token and binds to localhost by default.

## Build from source

```bash
git clone https://github.com/1amSheldon/mail-mcp.git
cd mail-mcp
npm ci
npm run release:check
```

Safe smoke tests perform MCP initialization and inspect the tool list without connecting to IMAP or SMTP:

```bash
npm run smoke:stdio
npm run smoke:http
npm run smoke:import
```

Live account validation connects to configured IMAP and SMTP servers but does not send a message:

```bash
mail-mcp --validate-accounts
```

## Documentation

- [Architecture and delivery states](docs/ARCHITECTURE.md)
- [Deployment, rollback, and diagnostics](docs/OPERATIONS.md)
- [Publishing a release](docs/RELEASING.md)

## License

MIT. See [LICENSE](LICENSE) for retained copyright and license notices.

Originally based on [honest-magic/mail-mcp](https://github.com/honest-magic/mail-mcp). Fork-specific behavior is documented here.
