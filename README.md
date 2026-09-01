# mail-mcp

[![npm](https://img.shields.io/npm/v/@1amsheldon/mail-mcp)](https://www.npmjs.com/package/@1amsheldon/mail-mcp)
[![CI](https://github.com/1amSheldon/mail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/1amSheldon/mail-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-111111.svg)](LICENSE)

An email MCP server for Codex, Claude Code, Claude Desktop, and other MCP clients. It connects to IMAP, SMTP, ManageSieve, Apple Mail, Microsoft Graph, Exchange Web Services, and Mailtrap without putting mail credentials in client configuration.

## Backends

| Backend | What it supports | Runtime requirement |
| --- | --- | --- |
| IMAP + SMTP | Cursor-based listing and search, stable message locators, raw RFC 822, folders, copy/move/trash/permanent delete, flags, threads, contacts, MIME drafts and sends, reply-all, attachments, delivery verification | Any provider exposing IMAP and SMTP |
| ManageSieve | List, read, create, update, and delete server-side filters | A ManageSieve endpoint on the IMAP account |
| Apple Mail | Accounts, mailboxes, messages, raw source, drafts, compose, reply, reply-all, forward, flags, move, trash, and rule management | macOS with Mail.app and Automation permission |
| Microsoft Graph | Read by ID, Internet Message-ID lookup, thread lookup, send, reply, inline attachments, and large attachment upload sessions | Pre-provisioned Microsoft OAuth2 credentials |
| Exchange Web Services | Search, read, and send through EWS with escaped XML payloads | EWS endpoint and pre-provisioned OAuth2 credentials |
| Mailtrap | Send, templates, sandboxes, logs, statistics, inbound streams, domains, suppressions, webhooks, contacts, lists, fields, imports, exports, and campaigns | Mailtrap API token |

Gmail, Google Workspace, Mail.ru, iCloud, Fastmail, Yahoo, Zoho, and other standards-based providers use the IMAP + SMTP backend. POP3 and JMAP are not implemented.

## Install

Requirements:

- Node.js 20.19 or newer
- an operating-system credential store supported by `cross-keychain`
- credentials for at least one backend

Add an account with the interactive backend wizard:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest accounts add
```

The wizard supports IMAP/SMTP, Apple Mail, Microsoft Graph, EWS, and Mailtrap. List or remove configured accounts with:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest accounts list
npx -y --prefer-online @1amsheldon/mail-mcp@latest accounts remove ACCOUNT_ID
```

Account definitions are stored in `~/.config/mail-mcp/accounts.json`. Passwords, OAuth2 credentials, and API tokens are stored in the operating-system credential store under `com.1amsheldon.mail-mcp`.

### Codex

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-codex
```

The installer updates only `[mcp_servers.mail]`, backs up an existing config, and installs the bundled `mail-mcp` skill in `~/.codex/skills/mail-mcp`.

On Windows, it installs one authenticated Streamable HTTP service at `http://127.0.0.1:8765/mcp`. Every Codex conversation shares the same process and cached per-account connections, so opening more conversations does not create more mail sessions. A supervised task starts it at sign-in, checks health, and applies later npm releases after a graceful restart.

On macOS and Linux, the installer writes an auto-updating stdio entry. To select stdio explicitly on any platform:

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-codex-stdio
```

Add `--read-only` to either installer command to expose only read tools. Restart Codex after installation.

### Claude Desktop

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-claude
```

The installer preserves other MCP servers, creates `claude_desktop_config.json.mail-mcp.bak` when replacing an existing file, and writes an `npx` command that checks for the latest release when Claude starts the server. Add `--read-only` for read-only access, then restart Claude Desktop.

### Claude Code

```bash
npx -y --prefer-online @1amsheldon/mail-mcp@latest --install-claude-code
```

The installer delegates configuration to the official [`claude mcp` CLI](https://code.claude.com/docs/en/mcp), registers `mail` at user scope, and installs the bundled workflow in `~/.claude/skills/mail-mcp`. Replacing an existing `mail` registration is transactional: the installer backs up `~/.claude.json` and restores it byte-for-byte if registration or skill installation fails. Native Windows uses the required `cmd /c npx` wrapper; macOS, Linux, and WSL use `npx` directly. Add `--read-only` for read-only access, then restart Claude Code.

### Other MCP clients

Run the server over stdio:

```text
npx -y --prefer-online @1amsheldon/mail-mcp@latest --confirm --audit-log --redact
```

Example Codex-compatible TOML:

```toml
[mcp_servers.mail]
command = "npx"
args = ["-y", "--prefer-online", "@1amsheldon/mail-mcp@latest", "--confirm", "--audit-log", "--redact"]
enabled = true
startup_timeout_sec = 30.0
tool_timeout_sec = 300.0
```

Do not put passwords, refresh tokens, client secrets, API tokens, or HTTP bearer tokens in MCP configuration.

## Agent workflow

The server publishes the `mail://agent-guide` resource and the `mail_agent_workflow` prompt. The Codex installer also installs the same workflow as a skill.

The important rules are short:

1. Call `list_accounts` and inspect backend capabilities before choosing an operation.
2. For IMAP/SMTP, call `listFolders` before assuming mailbox names. For Apple Mail, use `apple.listMailboxes`. Microsoft and Mailtrap expose provider resources instead of a universal folder list.
3. For IMAP/SMTP, start `listMessages` or `searchMessages` without a cursor, then pass `nextCursor` back unchanged. Use the matching provider-prefixed operation for other backends. Offset pagination is rejected.
4. Keep the returned locator. It binds the account, mailbox, UIDVALIDITY, and UID so mailbox changes cannot silently retarget an operation.
5. Read a message before replying, forwarding, moving, deleting, changing flags, or fetching attachments.
6. Prefer a draft when recipients or wording are not final.
7. Never retry `smtp_outcome_unknown` automatically. Use `verifySentMessage` with the returned Message-ID first.

IMAP cursor snapshots are capped at 10,000 UIDs and hydrate only the requested page. Page size is capped at 100.

## MCP surface

Version 2 exposes three tools instead of publishing a separate JSON schema for every operation:

| Tool | Purpose |
| --- | --- |
| `list_accounts` | Discover configured accounts, backends, and capabilities |
| `mail_query` | Read, search, inspect, and render mail data |
| `mail_mutate` | Draft, send, organize, delete, and configure mail |

This is one MCP server. Its 41 query operations and 50 mutation operations are routed through those two tools rather than registered as separate tools or servers. The serialized tool catalog drops from 39,637 bytes to 3,524 bytes while keeping the same backend operations. The workflow and operation index are available on demand through the `mail://agent-guide` MCP resource and the `mail_agent_workflow` prompt.

Both routers use the same envelope:

```json
{
  "accountId": "work",
  "operation": "listMessages",
  "input": {
    "folder": "INBOX",
    "limit": 25
  }
}
```

Use `mail_query` for `listMessages`, `searchMessages`, `readMessage`, `listFolders`, threads, attachments, statistics, contacts, templates, delivery verification, and filter reads. Use `mail_mutate` for sends, drafts, replies, forwarding, mailbox changes, labels, flags, Trash, permanent deletion, OAuth registration, and filter changes.

Provider operations use a prefix, for example `apple.listMessages`, `microsoft.searchMessages`, or `mailtrap.templates`. Mailtrap keeps its resource action inside `input`:

```json
{
  "accountId": "mailtrap",
  "operation": "mailtrap.templates",
  "input": { "operation": "list" }
}
```

`microsoft.searchMessages` is available through EWS. Microsoft Graph supports ID lookup, Internet Message-ID lookup, and thread lookup instead.

Moving to Trash and permanent deletion remain separate operations: `moveToTrash` and `permanentlyDelete`.

## Account configuration

The CLI writes secret-free JSON. Optional IMAP/SMTP fields include:

- `signature`: append a signature to sends and drafts.
- `allowedRecipients`: exact addresses or domains such as `@example.org`.
- `allowedAttachmentRoots`: real paths from which file attachments may be loaded. Base64 attachments do not use filesystem paths.
- `fromAliases`: approved From addresses.
- `smtpSecurity`: `tls`, `starttls`, or `plain`; plaintext SMTP is restricted to loopback hosts.
- `sentPolicy`: `auto`, `always`, or `never` for providers that save Sent mail themselves.
- `sentFolder`: explicit Sent-folder override.
- `manageSievePort`: enable server-side filter tools.

Apple Mail accounts also accept `allowedAttachmentRoots`. Path-based attachments are disabled until at least one root is configured, and symlinks cannot escape those roots.

Mail.app automation is useful for native rules and accounts that do not expose server credentials, but AppleScript scans can be slow on large mailboxes. Configure the same mailbox through the IMAP + SMTP backend when fast server-side listing and search are required; use the Apple Mail backend only for Mail.app-specific operations.

IMAP/SMTP OAuth2 uses pre-provisioned XOAUTH2 credentials and refreshes them at runtime. The package does not create provider applications or run browser consent flows.

For Gmail, the shortest personal setup is usually a Google app password with 2-Step Verification enabled:

| Setting | Value |
| --- | --- |
| IMAP host | `imap.gmail.com` |
| IMAP port | `993` |
| SMTP host | `smtp.gmail.com` |
| SMTP port | `465` for implicit TLS or `587` for STARTTLS |
| User | full Gmail or Workspace address |
| Password | app password, not the normal account password |

Managed Google environments may require OAuth2 instead.

## Guarded writes

```bash
mail-mcp --read-only
mail-mcp --allow-tools createDraft,moveMessage
mail-mcp --confirm --audit-log --redact
```

- `--read-only` removes `mail_mutate`.
- `--allow-tools` narrows `mail_mutate` to named operations. Version 1 internal names remain accepted as CLI selectors during upgrades, but they are not advertised as MCP tools.
- `--confirm` requires a short-lived confirmation ID bound to the exact tool arguments.
- `--audit-log` writes JSONL diagnostics to `~/.config/mail-mcp/audit.log`.
- `--redact` masks selected sensitive values before content reaches the client.

Nested audit fields are sanitized. Provider errors are reduced to safe codes and request metadata instead of returning raw response bodies or process stderr.

## Delivery states

SMTP acceptance and the Sent-folder copy are independent. Send, reply, and forward return structured results:

| Status | Meaning |
| --- | --- |
| `sent_and_saved` | SMTP accepted every recipient and IMAP confirmed the Sent copy |
| `partially_sent_and_saved` | SMTP accepted some recipients and IMAP confirmed the Sent copy |
| `smtp_accepted_sent_not_confirmed` | SMTP accepted the message, but the Sent copy was not confirmed |
| `smtp_partially_accepted_sent_not_confirmed` | Partial SMTP acceptance without a confirmed Sent copy |
| `smtp_rejected` | SMTP rejected every recipient |
| `smtp_connection_failed` | The connection failed before a confirmed delivery attempt |
| `smtp_outcome_unknown` | Delivery may have happened; do not retry automatically |

Use `retrySafe`, `messageId`, and the `verifySentMessage` query operation. Absence from Sent is not proof that SMTP delivery failed.

## Shared HTTP service

Manual loopback start:

```powershell
$env:MAIL_MCP_BEARER_TOKEN = '<random-token>'
npx -y --prefer-online @1amsheldon/mail-mcp@latest --http --host 127.0.0.1 --port 8765 --confirm --audit-log --redact
```

`GET /health` reports version, start time, and active session count. `POST /mcp` requires the bearer token. Keep the bind address on loopback unless an authenticated reverse proxy protects the server.

If the managed service restarts after sleep or an automatic update, requests carrying an older MCP session ID are recovered without requiring the chat to be reopened. Within each service process, the mail connection cache, pagination snapshots, rate limits, and pending write confirmations are shared by ordinary and recovered requests.

## Updates

Managed Codex and Claude installations run `@1amsheldon/mail-mcp@latest`. Updates replace package code only; account JSON and keychain credentials remain in their existing user directories.

Version 2 changes the MCP tool surface from individual operation names to `mail_query` and `mail_mutate`. Restart the MCP client after upgrading so it refreshes the tool list. Stored accounts and credentials do not need migration.

The Windows service checks npm every six hours. It stops accepting new requests, gives in-flight requests up to eight seconds to finish, and then restarts on the new package. Stdio clients update when the MCP process next starts.

If an older installation pins an exact version, run its installer command again.

## Develop

```bash
git clone https://github.com/1amSheldon/mail-mcp.git
cd mail-mcp
npm ci
npm run release:check
npm pack --dry-run
```

`release:check` builds the package, enforces English repository text, runs the complete test suite, exercises stdio and HTTP transports, checks importability, and runs `npm audit`.

The default suite uses protocol and provider mocks. It does not access a real mailbox, send mail, call Microsoft or Mailtrap, or automate Mail.app. `--validate-accounts` opens configured IMAP and SMTP connections without sending a message.

## Release

Publishing is handled by `.github/workflows/publish.yml`. Publish a GitHub Release whose tag is `v` followed by the exact version in `package.json`. GitHub Actions verifies the tag and publishes to npm through OIDC trusted publishing; the workflow contains no npm token.

## License

MIT. See [LICENSE](LICENSE).
