# mail-mcp

Reliable IMAP/SMTP MCP server for Codex and other MCP-compatible agents.

This fork makes delivery state explicit. SMTP acceptance, Sent-folder persistence, and uncertain outcomes are reported separately so an agent cannot claim that a message was sent without evidence.

## Distribution status

The supported installation method is currently **from source**.

- No package is published under the `@1amsheldon` npm scope yet.
- No Homebrew formula is published for this fork.
- The package is marked private to prevent accidental publication through stale upstream release automation.

## Requirements

- Node.js 20 or 22
- An email account with IMAP and SMTP access
- An operating-system credential store supported by `cross-keychain`

## Install from source

```bash
git clone https://github.com/1amSheldon/mail-mcp.git
cd mail-mcp
npm ci
npm run build
npm test
npm audit
node dist/index.js --version
```

## Configure an account

Interactive setup stores account metadata in `~/.config/mail-mcp/accounts.json` and credentials in the operating-system keychain.

```bash
node dist/index.js accounts add
node dist/index.js accounts list
node dist/index.js accounts remove ACCOUNT_ID
```

Do not put passwords or OAuth secrets in the repository or MCP configuration.

Supported account fields include IMAP/SMTP hosts and ports, login or OAuth2 authentication, TLS, signature, recipient allowlist, ManageSieve port, and an optional `sentFolder` override.

## Codex setup

For several concurrent Codex tasks, run one loopback-only Streamable HTTP service. All tasks then share one process and one IMAP/SMTP connection pool instead of starting a Node.js process per task.

Generate a long random token, keep it outside `config.toml`, and start the service:

```powershell
$env:MAIL_MCP_BEARER_TOKEN = '<random-token>'
node dist/index.js --http --host 127.0.0.1 --port 8765 --confirm --audit-log --redact
```

Point Codex at the local endpoint:

```toml
[mcp_servers.mail]
url = "http://127.0.0.1:8765/mcp"
bearer_token_env_var = "MAIL_MCP_BEARER_TOKEN"
enabled = true
startup_timeout_sec = 15.0
tool_timeout_sec = 300.0
```

`GET http://127.0.0.1:8765/health` reports service health and the number of active MCP sessions without exposing mailbox or account data. The MCP endpoint requires the bearer token and is bound to localhost by default.

The stdio transport remains available for clients that cannot use Streamable HTTP. A Windows configuration looks like this:

```toml
[mcp_servers.mail]
command = "C:\\Program Files\\nodejs\\node.exe"
args = [
  "C:\\path\\to\\mail-mcp\\dist\\index.js",
  "--confirm",
  "--audit-log",
  "--redact"
]
cwd = "C:\\path\\to\\mail-mcp"
```

Restart Codex after changing `config.toml`. Validate the registered command without connecting to a mailbox:

```bash
npm run smoke:stdio
npm run smoke:http
npm run smoke:import
```

Both transport smokes perform MCP `initialize` and check the tool list without connecting to IMAP or SMTP. The HTTP smoke also verifies bearer authentication, session creation, and clean shutdown.

## Reliable delivery contract

Send, reply, and forward return structured JSON instead of a generic success sentence.

Important fields:

- `status`: the delivery state
- `smtpAccepted`: `true`, `false`, or `null` when the SMTP outcome is unknown
- `accepted` and `rejected`: SMTP recipient results
- `messageId`: correlation ID shared by SMTP and the Sent copy
- `sentFolderSaved`: whether IMAP confirmed persistence
- `sentFolderUid`: UID returned by IMAP append, when available
- `retrySafe`: the authoritative retry decision
- `nextAction`: guidance for the calling agent

Delivery states:

| Status | Meaning |
| --- | --- |
| `sent_and_saved` | SMTP accepted the message and IMAP confirmed the Sent copy |
| `partially_sent_and_saved` | Some recipients were rejected, accepted recipients were sent, and Sent was saved |
| `smtp_accepted_sent_not_confirmed` | SMTP accepted the message, but the Sent copy was not confirmed |
| `smtp_partially_accepted_sent_not_confirmed` | Partial SMTP acceptance, without confirmed Sent persistence |
| `smtp_rejected` | SMTP rejected all recipients |
| `smtp_connection_failed` | The SMTP connection failed before a confirmed delivery result |
| `smtp_outcome_unknown` | Delivery may have happened; do not retry automatically |

Never retry solely because the message is absent from Sent. Use `retrySafe` and verify by `messageId`.

## Verify a sent message

`verify_sent_message` is read-only. It resolves the configured or IMAP special-use Sent folder and searches for the exact `Message-ID`.

A no-match result is not proof that SMTP delivery failed. The Sent append may have failed after SMTP accepted the message.

## Tools

Read-only tools:

- `list_accounts`, `list_emails`, `search_emails`, `verify_sent_message`
- `read_email`, `get_thread`, `get_attachment`, `extract_attachment_text`
- `list_folders`, `mailbox_stats`, `extract_contacts`
- `list_templates`, `use_template`, `list_filters`, `get_filter`

Write tools:

- `send_email`, `reply_email`, `forward_email`, `create_draft`
- `move_email`, `modify_labels`, `batch_operations`, `delete_email`
- `mark_read`, `mark_unread`, `star`, `unstar`
- `register_oauth2_account`, `set_filter`, `delete_filter`

## Safety modes

```bash
node dist/index.js --read-only
node dist/index.js --allow-tools create_draft,move_email
node dist/index.js --confirm --audit-log --redact
```

- `--read-only` removes write tools.
- `--allow-tools` limits the exposed write surface.
- `--confirm` binds a short-lived confirmation token to one tool and its original arguments.
- `--audit-log` writes JSONL diagnostics to `~/.config/mail-mcp/audit.log`.
- `--redact` masks selected sensitive content before returning it to an agent.

## Validation

Safe local validation:

```bash
npm ci
npm run build
npm test
npm run smoke:stdio
npm run smoke:http
npm run smoke:import
npm audit
```

Network validation, without sending a message:

```bash
node dist/index.js --validate-accounts
```

`--validate-accounts` connects to configured IMAP and SMTP servers. Run it only when live account access is explicitly intended.

## Architecture and operations

- [Architecture and delivery states](docs/ARCHITECTURE.md)
- [Deployment, rollback, and diagnostics](docs/OPERATIONS.md)

## License

MIT. See [LICENSE](LICENSE) for retained copyright and license notices.
