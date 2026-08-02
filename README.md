# mail-mcp

MCP server for IMAP/SMTP email access — works with Claude and other MCP clients.

## Requirements

- Node.js >=18
- macOS, Windows, or Linux (credentials stored in the OS keychain via [cross-keychain](https://www.npmjs.com/package/cross-keychain))

## Installation

| Method | Install command | Best for | Auto-updates? |
|--------|----------------|----------|---------------|
| npx (no install) | `npx @honest-magic/mail-mcp` | Trying it out, always-latest | Yes -- on each run |
| Global npm | `npm install -g @honest-magic/mail-mcp` | Daily use, offline-friendly | No -- run `npm update -g` |
| Homebrew | `brew tap honest-magic/tap && brew install mail-mcp` | macOS users who prefer brew | Formula updated on publish -- run `brew upgrade` |

### Run without installing (recommended)

```bash
npx @honest-magic/mail-mcp
```

### Global install

```bash
npm install -g @honest-magic/mail-mcp
mail-mcp
```

### Homebrew

```bash
brew tap honest-magic/tap
brew install mail-mcp
```

## Updating

### npx (run without installing)

npx always fetches the latest published version. No update step needed.

### Global npm install

```bash
npm update -g @honest-magic/mail-mcp
```

### Homebrew

The Homebrew formula is updated automatically when a new version is published to npm.

```bash
brew upgrade mail-mcp
```

### Version pinning

To run a specific version instead of latest:

```bash
npx @honest-magic/mail-mcp@1.1.0
```

See the [Releases page](https://github.com/honest-magic/mail-mcp/releases) for version history.

## Configuration

### 1. Add an account (interactive)

```bash
npx @honest-magic/mail-mcp accounts add
```

This prompts for IMAP/SMTP settings, stores the account in `~/.config/mail-mcp/accounts.json`, and saves the password in macOS Keychain.

### Manage accounts

```bash
mail-mcp accounts list       # show configured accounts
mail-mcp accounts remove ID  # remove an account and its keychain entry
```

### Manual setup

Alternatively, create `~/.config/mail-mcp/accounts.json` by hand:

```json
[
  {
    "id": "work",
    "name": "Work Email",
    "host": "imap.example.com",
    "port": 993,
    "smtpHost": "smtp.example.com",
    "smtpPort": 587,
    "user": "you@example.com",
    "authType": "login",
    "useTLS": true
  }
]
```

Then store the password in the OS keychain. The easiest way is `mail-mcp accounts add`, which handles this automatically. On macOS you can also use:

```bash
security add-generic-password \
  -s ch.honest-magic.config.mail-server \
  -a <account-id> \
  -w <password-or-app-password>
```

### Account fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier used by MCP tools |
| `name` | string | yes | Human-readable label |
| `host` | string | yes | IMAP hostname |
| `port` | number | yes | IMAP port (993 for TLS, 143 for STARTTLS) |
| `smtpHost` | string | no | SMTP hostname (omit for read-only use) |
| `smtpPort` | number | no | SMTP port (587 for STARTTLS, 465 for TLS) |
| `user` | string | yes | Login username / email address |
| `authType` | string | yes | `login` or `oauth2` |
| `useTLS` | boolean | yes | `true` for implicit TLS on IMAP; `false` for STARTTLS |

**OAuth2** — after starting the server, call the `register_oauth2_account` MCP tool:

```json
{
  "tool": "register_oauth2_account",
  "arguments": {
    "accountId": "work",
    "clientId": "<oauth2-client-id>",
    "clientSecret": "<oauth2-client-secret>",
    "refreshToken": "<oauth2-refresh-token>",
    "tokenEndpoint": "https://oauth2.googleapis.com/token"
  }
}
```

The credentials are stored in Keychain under the same service name. Token refresh is handled automatically.

### 3. Add to your MCP client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mail": {
      "command": "npx",
      "args": ["-y", "@honest-magic/mail-mcp"]
    }
  }
}
```

**Generic MCP client**:

```json
{
  "mcpServers": {
    "mail": {
      "command": "mail-mcp"
    }
  }
}
```

Use `"command": "mail-mcp"` if installed globally, or `"command": "npx", "args": ["-y", "@honest-magic/mail-mcp"]` otherwise.

## Available Tools

| Tool | Description |
|------|-------------|
| `list_accounts` | List all configured email accounts |
| `list_emails` | List recent emails from a folder with metadata and snippets |
| `search_emails` | Search emails by sender, subject, date range, or keywords |
| `read_email` | Fetch the full content of an email as Markdown |
| `send_email` | Send a new email via SMTP |
| `create_draft` | Save a draft to the Drafts folder without sending |
| `list_folders` | List all available folders and labels in a mailbox |
| `move_email` | Move a message to another folder (Archive, Trash, Spam, etc.) |
| `modify_labels` | Add or remove IMAP flags / provider labels on a message |
| `get_thread` | Fetch all messages in a conversation thread |
| `get_attachment` | Download attachment content via MCP Resource URI |
| `extract_attachment_text` | Extract plain text from PDF and document attachments |
| `register_oauth2_account` | Store OAuth2 tokens in Keychain for an account |
| `batch_operations` | Apply move, delete, or label actions to multiple emails at once |

## Read-Only Mode

Start the server with `--read-only` to disable all write operations:

```bash
npx @honest-magic/mail-mcp --read-only
```

In read-only mode:
- Write tools (`send_email`, `create_draft`, `move_email`, `modify_labels`, `batch_operations`, `register_oauth2_account`) are removed from the tool list entirely and return a descriptive error if called directly.
- SMTP authentication is skipped — only IMAP connects.
- The active mode is advertised to the MCP client at handshake via `InitializeResult.instructions`.

Claude Desktop read-only config:

```json
{
  "mcpServers": {
    "mail-readonly": {
      "command": "npx",
      "args": ["-y", "@honest-magic/mail-mcp", "--read-only"]
    }
  }
}
```

## License

MIT
