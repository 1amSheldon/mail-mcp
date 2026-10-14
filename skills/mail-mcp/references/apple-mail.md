# Apple Mail

Backend apple-mail requires macOS, Mail.app and granted Automation permissions.
The MCP account selects a native account by configured UUID/name. The runtime
supplies its canonical selector; omit input.account unless it matches that account.
Message IDs and mailbox paths are native, not IMAP locators. Returned IDs are strings.

## Reads (`mail_query`)

| Operation | Input |
| --- | --- |
| `apple.listAccounts` | `{}`; native account discovery, not a mailbox read |
| `apple.listMailboxes` | `mailbox?` |
| `apple.listMessages` | `mailbox?`, `limit?`, `cursor?` |
| `apple.searchMessages` | Page fields plus query?, from?, subject?, body?, unread?, flagged?, hasAttachments?, since?, before? |
| `apple.readMessage` | `messageId`, `mailbox?` |
| `apple.getRawSource` | `messageId`, `mailbox?`; returns rawSource |
| `apple.listRules` | `mailbox?`; returns scope and rules |

Page limit 1-100, default 50. Use cursor continuation with identical filters.
The provider materializes an in-memory snapshot with a 10,000-item safety ceiling;
do not treat it as unlimited live search. Start narrower when the ceiling is reached.
Do not pass offsets or internal maxItems. Read bodies before acting on summaries.

## Writes (`mail_mutate`)

| Operation | Input | Effect |
| --- | --- | --- |
| `apple.compose` | `to` array, `subject`, `body`; from?, cc?, bcc?, attachments? | Sends; not a draft-preparation operation |
| `apple.createDraft` | Compose fields plus `open?` | Saves draft, optionally opens UI |
| `apple.reply`, `apple.replyAll` | `messageId`, `mailbox?`, `body`, `attachments?`, `send?` | send defaults true; explicitly false to prepare |
| `apple.forward` | Reply fields plus `to` array, `cc?`, `bcc?` | send defaults true |
| `apple.updateMessage` | `messageId`, `mailbox?`, `read?`, `flagged?`, `flagColor?` | Changes message state, not draft body |
| `apple.moveMessage` | `messageId`, `mailbox?`, `destination` | Re-query destination after move |
| `apple.trashMessage` | `messageId`, `mailbox?` | Trashes selected message |
| `apple.createMailbox` | `path` | Creates native mailbox |
| `apple.renameMailbox` | `path`, `newName` | Renames mailbox |
| `apple.deleteMailbox` | `path` | Destructive mailbox removal |
| `apple.createRule` | `rule` | Adds application-global rule |
| `apple.updateRule` | `name`, `rule` partial object | Updates uniquely named rule |
| `apple.deleteRule` | `name` | Deletes uniquely named rule |

Attachments are `{ path, name? }` on the macOS host; there is no IMAP-style
contentBase64 input here. File attachments are disabled until allowedAttachmentRoots
is configured; real-path checks prevent symlink escapes. Sender must belong to the
selected native account. Native compose uses body text; do not assume isHtml support.

Rules require local allowGlobalRules=true. This grants access across ALL Mail.app
accounts: the chosen account does not constrain matching messages. Do not enable
this flag merely to satisfy a task. Resolve duplicate names in Mail.app before
updating/deleting. Read and preserve the previous rule before modification.

Rule shape: `{ name, enabled, match: "all"|"any", conditions, actions }`.
Each condition: `{ field, operator, value }`, field from/to/cc/subject/content,
operator contains/notContains/equals/beginsWith/endsWith. Actions: markRead?,
markFlagged?, delete?, moveTo?, copyTo?, forwardTo?. A forwarding rule has an
ongoing external sending consequence; drafting mail does not authorize it.

Successful mutations return `{ ok: true, operation, id? }`. Inspect Mail.app/current
state afterward; success is not proof of delivery. For outcome_unknown, inspect
Outbox and Sent and do not resend automatically. There is no public apple.sendDraft
or draft-body update operation; do not apply IMAP draftId contracts to this backend.
