# mail-mcp

`mail-mcp` connects MCP clients to email accounts over IMAP and SMTP. It works with Gmail, Google Workspace, Mail.ru, iCloud, Fastmail, and other providers that expose standard mail protocols.

The server supports stdio and authenticated Streamable HTTP. Credentials stay in the operating-system credential store, not in the repository or MCP configuration.

## Quick start with Codex

Requirements:

- Node.js 20.19 or newer
- an IMAP/SMTP account
- an operating-system credential store supported by `cross-keychain`

Add an account:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest accounts add
```

Check the connection without sending mail:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --validate-accounts
```

Install it in Codex:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-codex
```

On Windows, this command installs one shared HTTP service, starts it, verifies `/health`, and points Codex at `http://127.0.0.1:8765/mcp`. It creates or reuses `MAIL_MCP_BEARER_TOKEN` in the user environment and writes only the variable name to Codex config. The scheduled task starts at logon, checks health every five minutes, and suppresses duplicate instances. All Codex conversations use the same process and shared mail connections.

The installer changes only `[mcp_servers.mail]` and saves the previous file as `config.toml.mail-mcp.bak`. Restart Codex after installation so it reads the user-level bearer token.

On macOS and Linux, `--install-codex` currently writes the stdio configuration. To select stdio explicitly on any platform:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-codex-stdio
```

For read-only access:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-codex --read-only
```

## Install in Claude Desktop

After adding an account, run:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-claude
```

The installer writes an automatically updating `npx` command to the Claude Desktop config, preserves other MCP servers, and creates `claude_desktop_config.json.mail-mcp.bak` before replacing an existing file. Restart Claude Desktop after installation.

Use `--install-claude --read-only` to expose only read tools.

## Automatic updates

The managed Windows service checks npm every six hours. When a newer version exists, the HTTP server stops accepting new MCP requests, gives in-flight requests up to eight seconds to finish, and exits. The supervisor then restarts `@1amsheldon/mail-mcp@latest` from a dedicated npm prefix. An older global installation or project-local binary cannot override the selected release.

Stdio entries created by the Codex and Claude Desktop installers also use the dedicated prefix with npm's `--prefer-online` option. They check the registry whenever the client starts the server.

Accounts, signatures, allowlists, and provider settings stay in `~/.config/mail-mcp/accounts.json`. Passwords and OAuth2 credentials stay in the operating-system credential store. Package updates do not rewrite either location.

If an older installer wrote an exact version, run the relevant installer again:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-codex
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-claude
```

The Windows HTTP service applies future releases without creating one mail process per conversation. Stdio clients apply them on client restart.

## Gmail and Google Workspace

For a personal Google account, the shortest setup uses a [Google app password](https://support.google.com/accounts/answer/185833). App passwords require 2-Step Verification and are not available for every managed or Advanced Protection account.

Use these values in `accounts add`:

| Setting | Value |
| --- | --- |
| IMAP host | `imap.gmail.com` |
| IMAP port | `993` |
| Email address | full Gmail or Workspace address |
| Auth type | `login` |
| TLS | `y` |
| SMTP host | `smtp.gmail.com` |
| SMTP port | `465` or `587` |
| Password | Google app password, not the normal account password |

Port 465 uses implicit TLS. Port 587 upgrades the connection with STARTTLS.

Google recommends OAuth2 for public or centrally managed applications. The runtime supports [XOAUTH2 for Gmail IMAP and SMTP](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol) and can refresh pre-provisioned credentials, but this package does not run a Google consent flow or create an OAuth client for you.

## Other providers

Run the same account wizard with the provider's IMAP host, SMTP host, ports, and authentication method. Account metadata is stored in:

```text
~/.config/mail-mcp/accounts.json
```

Passwords and OAuth2 token sets are stored under the `com.1amsheldon.mail-mcp` service in the system credential store.

```bash
mail-mcp accounts list
mail-mcp accounts remove ACCOUNT_ID
```

Optional account fields in `accounts.json`:

- `signature` adds a signature to sends and drafts.
- `allowedRecipients` accepts exact addresses or domain entries such as `@example.org`.
- `sentFolder` overrides Sent-folder discovery for providers with non-standard folder names.
- `manageSievePort` enables server-side filter tools when the provider supports ManageSieve.

## Use with another MCP client

Install globally:

```bash
npm install --global @1amsheldon/mail-mcp
mail-mcp accounts add
mail-mcp --validate-accounts
```

Or configure the client to run:

```text
npx -y --prefer-online @1amsheldon/mail-mcp@latest --confirm --audit-log --redact
```

Manual stdio configuration:

```toml
[mcp_servers.mail]
command = "npx"
args = ["-y", "--prefer-online", "@1amsheldon/mail-mcp@latest", "--confirm", "--audit-log", "--redact"]
enabled = true
startup_timeout_sec = 30.0
tool_timeout_sec = 300.0
```

Do not put passwords, refresh tokens, client secrets, or HTTP bearer tokens in MCP configuration.

## Tools

Read-only tools:

- `list_accounts`, `list_emails`, `search_emails`, `read_email`, `get_thread`
- `get_attachment`, `extract_attachment_text`
- `list_folders`, `mailbox_stats`, `extract_contacts`
- `verify_sent_message`
- `list_templates`, `use_template`, `list_filters`, `get_filter`

Write tools:

- `send_email`, `reply_email`, `forward_email`, `create_draft`
- `move_email`, `modify_labels`, `batch_operations`, `delete_email`
- `mark_read`, `mark_unread`, `star`, `unstar`
- `register_oauth2_account`, `set_filter`, `delete_filter`

PDF attachments are parsed with `pdf-parse` v2. Text extraction does not perform OCR; scanned image-only PDFs may return little or no text.

## Guard write operations

```bash
mail-mcp --read-only
mail-mcp --allow-tools create_draft,move_email
mail-mcp --confirm --audit-log --redact
```

- `--read-only` removes write tools.
- `--allow-tools` exposes only the named write tools.
- `--confirm` requires a short-lived token tied to the original tool arguments.
- `--audit-log` writes JSONL diagnostics to `~/.config/mail-mcp/audit.log`.
- `--redact` masks selected sensitive patterns before content reaches the MCP client.

## Delivery results

SMTP acceptance and the Sent-folder copy are separate events. Send, reply, and forward return structured JSON so callers do not guess whether retrying is safe.

| Status | Meaning |
| --- | --- |
| `sent_and_saved` | SMTP accepted every recipient and IMAP confirmed the Sent copy |
| `partially_sent_and_saved` | SMTP accepted some recipients and IMAP confirmed the Sent copy |
| `smtp_accepted_sent_not_confirmed` | SMTP accepted the message, but the Sent copy was not confirmed |
| `smtp_partially_accepted_sent_not_confirmed` | Partial SMTP acceptance without a confirmed Sent copy |
| `smtp_rejected` | SMTP rejected every recipient |
| `smtp_connection_failed` | The connection failed before a confirmed delivery attempt |
| `smtp_outcome_unknown` | Delivery may have happened; do not retry automatically |

Use `retrySafe`, `messageId`, and `verify_sent_message`. Absence from Sent is not proof that SMTP delivery failed.

## Shared local HTTP service

On Windows, use `--install-codex` to install and supervise the shared service. For manual use with another local MCP client, run the authenticated Streamable HTTP transport on loopback:

```powershell
$env:MAIL_MCP_BEARER_TOKEN = '<random-token>'
npx -y --prefer-online @1amsheldon/mail-mcp@latest --http --host 127.0.0.1 --port 8765 --confirm --audit-log --redact
```

`GET /health` reports the service version, start time, and active session count. `POST /mcp` requires the bearer token. Keep the bind address on loopback unless a separate authenticated reverse proxy protects the server.

## Develop and verify

```bash
git clone https://github.com/1amSheldon/mail-mcp.git
cd mail-mcp
npm ci
npm run release:check
npm pack --dry-run
```

The default tests and smoke checks do not connect to a mailbox or send mail. `--validate-accounts` opens IMAP and SMTP connections but does not send a message.

Publishing is handled by `.github/workflows/publish.yml`. Publishing a GitHub Release whose tag matches `v` plus the version in `package.json` runs the full release gate and publishes to npm through OIDC trusted publishing. The workflow has no npm token or long-lived publishing credential.

## Common problems

- Gmail `535` or `Invalid credentials`: use the full email address and an app password, not the normal account password.
- `Transport closed`: check Node.js, run the exact configured command with `--version`, then reinstall the Codex entry.
- `pdfParser is not a function`: upgrade to the latest release.
- `smtp_outcome_unknown`: do not retry automatically; verify the returned `messageId` first.

## License

MIT. See [LICENSE](LICENSE).

Originally based on [honest-magic/mail-mcp](https://github.com/honest-magic/mail-mcp).
