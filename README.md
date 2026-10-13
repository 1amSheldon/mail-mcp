# mail-mcp

[![CI](https://github.com/starychenko/mail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/starychenko/mail-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-111111.svg)](LICENSE)

An email MCP server for Codex, Claude Code, Claude Desktop, and other MCP clients. It connects to IMAP, SMTP, ManageSieve, Apple Mail, Microsoft Graph, Exchange Web Services, and Mailtrap without putting mail credentials in client configuration.

See [production hardening qualification](PRODUCTION-READINESS.md) for the audit closure map, compatibility changes, resource limits and live acceptance checks.

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

## Zimbra SOAP and 2FA

The optional `zimbra` backend adds native search, tags, address-book reads,
conversation metadata, server reply/forward drafts and native draft sending.
Authenticate locally with `node dist/index.js accounts login ACCOUNT_ID`;
only the completed session is stored, not the password or OTP. Expired or revoked
sessions require local reauthentication. Existing IMAP/SMTP app-password accounts
remain separate. See [Zimbra setup, operations and limitations](docs/ZIMBRA.md).

## Install

This is the `starychenko/mail-mcp` fork, version `3.0.1-fork.1`. It is distributed as a reviewed local build, not through the upstream npm package. Keep the checkout at a stable path.

```bash
git clone https://github.com/starychenko/mail-mcp.git
cd mail-mcp
npm ci
npm run build
node dist/index.js --version
```

Requirements:

- Node.js 20.19 or newer
- an operating-system credential store supported by `cross-keychain`
- credentials for at least one backend

Add an account with the interactive backend wizard:

```bash
node dist/index.js accounts add
```

The wizard supports IMAP/SMTP, Apple Mail, Microsoft Graph, EWS, and Mailtrap. List or remove configured accounts with:

```bash
node dist/index.js accounts list
node dist/index.js accounts remove ACCOUNT_ID
```

Apple Mail rules are global to Mail.app and may affect every native account. Rule reads and mutations are disabled by default. An administrator may explicitly set `allowGlobalRules: true` on an Apple Mail account in the local account configuration to grant this broader access. The account selector then identifies access and destination mailboxes; it does not restrict which messages a rule matches. Rule listings report `scope: "application-global"`, and mutation confirmations name the global scope. Duplicate rule names must be resolved in Mail.app before updating or deleting them through MCP.

Account definitions are stored in `~/.config/mail-mcp/accounts.json`. Passwords, OAuth2 credentials, and API tokens are stored in the operating-system credential store under `com.1amsheldon.mail-mcp`.

### Codex

```bash
node dist/index.js --install-codex
```

The installer updates only `[mcp_servers.mail]`, backs up an existing config, and installs the bundled `mail-mcp` skill only when absent in `~/.codex/skills/mail-mcp`.

On Windows, it installs one authenticated Streamable HTTP service at `http://127.0.0.1:8765/mcp`. Every Codex conversation shares the same process and cached per-account connections, so opening more conversations does not create more mail sessions. A supervised task starts it at sign-in, checks health, and runs this local build. Updates are manual.

On macOS and Linux, the installer writes a stdio entry referencing this local checkout. To select stdio explicitly on any platform:

```bash
node dist/index.js --install-codex-stdio
```

Add `--read-only` to either installer command to expose only read tools. Restart Codex after installation.

### Claude Desktop

```bash
node dist/index.js --install-claude
```

The installer preserves other MCP servers, creates `claude_desktop_config.json.mail-mcp.bak` when replacing an existing file, and writes an `npx` command that runs this local fork when Claude starts the server. Add `--read-only` for read-only access, then restart Claude Desktop.

### Claude Code

```bash
node dist/index.js --install-claude-code
```

The installer delegates configuration to the official [`claude mcp` CLI](https://code.claude.com/docs/en/mcp), registers `mail` at user scope, and installs the bundled workflow in `~/.claude/skills/mail-mcp`. Replacing an existing `mail` registration is transactional: the installer backs up `~/.claude.json` and restores it byte-for-byte if registration or skill installation fails. Native Windows uses the required `cmd /c npx` wrapper; macOS, Linux, and WSL use `npx` directly. Add `--read-only` for read-only access, then restart Claude Code.

### Other MCP clients

Run the server over stdio:

```text
node dist/index.js --confirm --audit-log --redact
```

Example Codex-compatible TOML:

```toml
[mcp_servers.mail]
command = "node"
args = ["/absolute/path/to/mail-mcp/dist/index.js", "--confirm", "--audit-log", "--redact"]
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

IMAP listing/search scan bounded UID windows and hydrate only the requested page. Page size is capped at 500; total is unknown. Follow nextCursor even when a sparse search returns an empty page.

### Keyword search

Use `mail_query` with `searchMessages` for IMAP accounts:

```json
{
  "accountId": "work",
  "operation": "searchMessages",
  "input": {
    "folder": "INBOX",
    "keywordsAny": ["invoice", "payment overdue"],
    "excludeKeywords": ["newsletter"],
    "keywordScope": "all",
    "unread": true,
    "since": "2026-09-01",
    "limit": 20,
    "headerOnly": true
  }
}
```

- `keywordsAll`: every word or phrase must match.
- `keywordsAny`: at least one word or phrase must match.
- `excludeKeywords`: none may match.
- `keywordScope`: `body` (default), `subject`, or `all` (headers and body).
- `unread` and `flagged`: filter message state; `false` selects read or unflagged messages.

Combine these with `from`, `to`, `cc`, `subject`, `messageId`, `since`, and `before`. Different filter groups are combined with AND. Array elements are literal substrings, not regular expressions or an AI relevance score. Each list accepts up to 20 terms of up to 256 characters. Matching and language behavior depend on the IMAP provider. The existing `keywords` string searches a literal phrase in the body.

Search runs on the mail server and fetches only the requested result page. Use `headerOnly: true` to avoid body snippets. To continue, repeat the same filters with `cursor` set to `nextCursor`; changing filters requires a new search. Apple Mail and Microsoft use their provider-specific search operations.

## MCP surface

The server exposes three tools instead of publishing a separate JSON schema for every operation:

| Tool | Purpose |
| --- | --- |
| `list_accounts` | Discover configured accounts, backends, and capabilities |
| `mail_query` | Read, search, inspect, and render mail data |
| `mail_mutate` | Draft, send, organize, delete, and configure mail |

Operations are routed through those two tools rather than registered as separate tools or servers. Detailed input rules are loaded on demand through the `mail://agent-guide` resource and the `mail_agent_workflow` prompt, keeping the initial tool catalog small.

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

Microsoft lookup/search results use `{ messages, partial }`. Graph Internet Message-ID lookup follows all validated pages up to 100 pages or 10,000 messages; failures or limits return `partial: true` with a warning. EWS search returns one page (default 50, maximum 1,000). When `nextOffset` is present, pass it as `offset` with the same search options to continue until `partial: false`. EWS offsets refer to a live mailbox, not a snapshot; concurrent changes can affect paging. Missing paging metadata is reported as incomplete.

`microsoft.getMessage` returns the full text or HTML body with its content type, sender, recipients, dates and attachment metadata. Search and thread operations return compact summaries. Attachment bytes are not embedded in message reads. Returned HTML is email content and must be treated as untrusted by clients; the server's configured text redaction also applies to provider message bodies.

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

IMAP `useTLS: true` uses implicit TLS (normally port 993). `useTLS: false` requires a successful STARTTLS upgrade (normally port 143); servers without STARTTLS are rejected before authentication. Plaintext IMAP authentication is not supported.

IMAP listing previews fetch at most 4 KiB of each MIME body. Full parsed-message reads are limited to 32 MiB before parsing. Attachment downloads fetch the selected MIME part with a decoded-byte limit (up to 50 MiB); missing part metadata uses a bounded 32 MiB full-message fallback. Oversized messages are rejected rather than silently truncated. Parsed-body caches have a 64 MiB payload budget per account, at most 100 entries, and a five-minute expiry that releases entries without another read.

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
- `--redact` masks selected sensitive text values before content reaches the client. Raw RFC 822 and binary attachment downloads remain byte-for-byte originals and are not sanitized.

Nested audit fields are sanitized. Provider errors are reduced to safe codes and request metadata instead of returning raw response bodies or process stderr.

## Delivery states

### Server drafts

For IMAP/SMTP accounts, `createDraft` returns a stable `draftId`. Keep it to edit or send the same draft later:

This fork also exposes `createReplyDraft` and `createReplyAllDraft`. Call either through
`mail_mutate` with `{ accountId, operation, input: { locator, body } }` after reading the source.
They save to Drafts without sending and derive `In-Reply-To`, the `References` chain, the subject
and recipients from that source. A missing source Message-ID is an error. Optional input fields:
`isHtml`, `cc`, `bcc`, `includeSignature`, `includeOriginalAttachments`, and `attachments`.
Explicit `cc` replaces inferred CC; `""` clears it. Use `updateDraft` to edit To/CC further.
Reply-all removes the account, aliases and duplicate recipients. The body is saved as supplied,
without automatically quoting the original. Inspect the returned draft, keep its `draftId`, and
call `sendDraft` only when sending is authorized. Existing read-only, allowlist, confirmation,
recipient and attachment restrictions apply.

`replyAll` also accepts new attachments through the MCP router. Set
`includeOriginalAttachments: true` to retain the source attachments alongside new ones.
Attachments use `{ path }` or `{ filename, contentBase64 }`; normal size and path limits apply.
The `reply` and `replyAll` operations send after confirmation; they do not create drafts.

```json
{"accountId":"work","operation":"updateDraft","input":{"draftId":"returned-id","changes":{"subject":"Revised subject","textBody":"Ready for review."}}}
```

```json
{"accountId":"work","operation":"sendDraft","input":{"draftId":"returned-id"}}
```

Both calls use `mail_mutate`. Supply `locator` instead of `draftId` to use an existing server draft. Updates accept `to`, `cc`, `bcc`, `subject`, `textBody`, `htmlBody`, and `attachments`. Omitted fields stay unchanged. An attachment list replaces the old list; `[]` clears it. Changing a body format removes unspecified alternatives so old HTML cannot override new plain text.

Sending reads the latest server content, preserves MIME bodies and reply headers, and excludes Bcc headers from the transmitted message while keeping those recipients in the SMTP envelope. The unchanged draft moves to Trash only after full recipient acceptance and a confirmed Sent copy. Partial or uncertain delivery retains the draft and must not trigger an automatic resend.

Delivery records in `~/.config/mail-mcp/draft-state` prevent repeated calls from resending a recorded attempt, including after a restart. Keep this directory when moving an installation. This protection applies to this installation, not independent sends from webmail or another computer. Do not schedule the same draft in both places.

Interrupted replacements and stale process locks require inspection; the service does not guess which copy to delete or resend. IMAP cannot atomically compare and replace a draft, so avoid editing it in webmail during an update or send. If webmail replaces both its UID and Message-ID, select the current draft again.

### SMTP results

SMTP acceptance and the Sent-folder copy are independent. Send, reply, and forward return structured results:

| Status | Meaning |
| --- | --- |
| `sent_and_saved` | SMTP accepted every recipient and IMAP confirmed the Sent copy |
| `partially_sent_and_saved` | SMTP accepted some recipients and IMAP confirmed the Sent copy |
| `smtp_accepted_sent_not_confirmed` | SMTP accepted the message, but the Sent copy was not confirmed |
| `smtp_partially_accepted_sent_not_confirmed` | Partial SMTP acceptance without a confirmed Sent copy |
| `smtp_rejected` | SMTP rejected every recipient |
| `smtp_connection_failed` | The connection failed before a confirmed delivery attempt |
| `smtp_preflight_failed` | Local validation or MIME composition failed; no SMTP message was attempted |
| `smtp_outcome_unknown` | Delivery may have happened; do not retry automatically |

Use `retrySafe`, `messageId`, and the `verifySentMessage` query operation. Absence from Sent is not proof that SMTP delivery failed.

## Shared HTTP service

Manual loopback start:

```powershell
$env:MAIL_MCP_BEARER_TOKEN = '<random-token>'
node dist/index.js --http --host 127.0.0.1 --port 8765 --confirm --audit-log --redact
```

`GET /health` reports version, start time, and active session count. `POST /mcp` requires the bearer token. Keep the bind address on loopback unless an authenticated reverse proxy protects the server.

If the managed service restarts after sleep or an automatic update, requests carrying an older MCP session ID are recovered without requiring the chat to be reopened. Within each service process, the mail connection cache, pagination snapshots, rate limits, and pending write confirmations are shared by ordinary and recovered requests.

## Updates

Fork installers keep the local source path; they never switch to the upstream npm package. The upstream registry update monitor is disabled. To update, review and check out the desired fork commit, run `npm ci` and `npm run build`, then rerun the relevant installer and restart the client/service. Credentials remain in their existing store.

Codex preserves existing customized skills and linked/junction-managed skills. Use `--skip-skill` to skip skill installation entirely. Update shared skills in their own source repository. The installer rollback does not write skipped skills.

`getThread` now returns `{ items, folders, partial, warning }` with message locators. Listing/search use descending UID windows rather than full-folder snapshots: `total` is `null`, newly arriving higher UIDs are excluded from continuation pages, and deleted messages may disappear. Follow `nextCursor` even after an empty page. Restart clients to refresh these contracts.

## Connection diagnostics

```bash
node dist/index.js --validate-accounts
```

Checks configured IMAP connections and SMTP hosts without sending mail. Prints a result for each connection and a total of passed, failed, and skipped probes. Exits with code `1` if a probe fails or no IMAP accounts are configured; otherwise exits with `0`. This command does not validate Apple Mail, Microsoft API, or Mailtrap accounts.

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

### Local Windows build


After building and testing, `node dist/index.js --install-codex-local` runs that checkout as the shared Windows service. This disables npm refresh and runtime auto-update for that installation. Rebuild and rerun the installer to update it. `--install-codex` also keeps this fork; it does not select upstream. Account definitions and credentials are reused.

`npm run backup:windows-service` backs up the task, service files, and Codex configuration under the local mail-mcp configuration directory. Keep these backups private. `npm run probe:draft-workflow -- --check` checks the draft operation catalog and lists folders without writing mail. It requires `MAIL_MCP_ACCOUNT_ID` and `MAIL_MCP_BEARER_TOKEN`. The separate `--prepare` mode creates and updates a test draft and must be explicitly requested; it never sends.

## Release

This fork is marked private in package.json to prevent accidental npm publication. The upstream npm publishing workflow is disabled for this repository. Delivery is a local build from a reviewed commit.

## License

MIT. See [LICENSE](LICENSE).

## Review hardening contracts

- `getThread` accepts `threadId`, `folder` (default INBOX) or an explicit `folders` array (at most 10, e.g. INBOX and the discovered Sent path). It walks reference ancestors and uses Gmail `threadId` when supported. Results always report `partial: true`: deleted, unreferenced or out-of-scope mail cannot be ruled out.
- Draft creation returns `status: saved` or `append_outcome_unknown`, `retrySafe: false`, Message-ID and recovery instructions. Do not create another copy after an ambiguous APPEND or a local post-save failure. Find the saved draft by its Message-ID.
- ManageSieve currently uses implicit TLS and verifies certificates. For a private CA, configure Node's `NODE_EXTRA_CA_CERTS` before launch or supply the client CA option. STARTTLS-only endpoints are not supported by this client; authentication is never sent in plaintext.
