# Zimbra backend

Zimbra SOAP/REST is an optional backend alongside IMAP/SMTP. Keep the existing
IMAP account and its app password if needed. Create a separate account ID for SOAP;
never reuse an IMAP account ID or replace its stored password with a SOAP session.

## Setup and local authentication

Build this checkout, run `node dist/index.js accounts add`, and select backend 6.
Supply the mailbox email and an HTTPS endpoint such as
`https://mail.example.com/service/soap`. Admin SOAP endpoints are not accepted.

Then run:

```sh
node dist/index.js accounts login ZIMBRA_ACCOUNT_ID
```

The masked local prompt asks for the main account password. If the server requires
a second factor, it asks for the current authenticator code or a backup/scratch code.
Do not paste either credential into MCP tools, chat, command arguments or config.
An IMAP app password is not assumed to work for SOAP.

Only the completed auth token, expiry, endpoint and mailbox identity are stored in
the operating-system credential store. Passwords and OTPs are not persisted.
An incomplete 2FA token is never saved. A failed login leaves the previous session
untouched. Every operation loads the current session, so a successful new login
does not require restarting MCP. Revoked or expired tokens require another local
`accounts login`; writes are never retried automatically.

This first implementation supports native Zimbra password authentication with
TOTP or backup-code completion. It does not request email OTPs, provision 2FA,
disable 2FA, generate TOTP codes, register trusted devices, or implement SAML/SSO.
Server edition, third-party authentication extensions and account policy can
change compatibility. Authenticate against the actual deployment before rollout.

## Router operations

Use `accountId` and `operation` at the top level, and place the following fields
inside `input`. IDs are native Zimbra IDs returned by this same account, not IMAP
UIDs or IMAP locators. Unsupported fields are rejected before network I/O.

| Read operation | Input |
| --- | --- |
| `zimbra.sessionStatus` | `{}`; reports local token availability, not remote validity |
| `zimbra.searchMessages` | `query`, optional `limit` (1-100), `cursor` |
| `zimbra.readMessage` | `messageId`; does not change read status |
| `zimbra.getThread` | `conversationId`; conversation metadata, then read individual messages |
| `zimbra.listFolders` | `{}` |
| `zimbra.listTags` | `{}` |
| `zimbra.searchContacts` | `query`, optional `limit` (1-100), `cursor` |
| `zimbra.getContact` | `contactId` |
| `zimbra.getAttachment` | `messageId`, `partId`, optional `maxBytes` (default 5 MiB, maximum 25 MiB) |

Native search supports queries such as `in:inbox tag:urgent has:attachment`.
Search returns `items`, `nextCursor`, `total: null`, `partial` and a warning.
Reuse the same query and limit with the newest cursor. Cursors expire after five
minutes and are consumed only after successful reads. Zimbra uses native offset
paging internally, so mailbox changes can shift pages; no immutable snapshot is
promised. Message bodies are bounded and can be truncated by the provider.
SOAP responses are capped at 8 MiB. Attachments use the authenticated cookie over
HTTPS, not an auth token in the URL; redirects are rejected. Attachment bytes are
returned as an embedded MCP resource with application/octet-stream metadata.
Binary resources retain their exact bytes even when text redaction is enabled.

| Write operation | Input |
| --- | --- |
| `zimbra.createDraft` | `to` array, `subject`, `body`; optional `cc`, `bcc`, `isHtml`, `originalMessageId`, `replyType`, `attachOriginal`, `quoteOriginal` |
| `zimbra.updateDraft` | Same complete content as createDraft, plus `draftId`; full replacement, not a partial update |
| `zimbra.sendDraft` | `draftId`; sends the current server version with `did` and `sfd=1` |
| `zimbra.createTag` | `name`, optional numeric `color` (0-9) |
| `zimbra.deleteTag` | `tagId` |
| `zimbra.addTag` / `zimbra.removeTag` | `messageIds` array, `tagName` |
| `zimbra.moveMessages` | `messageIds` array, `folderId` |
| `zimbra.markRead` | `messageIds` array, `read` boolean |
| `zimbra.moveToTrash` | `messageIds` array |

For reply/forward drafts, supply `originalMessageId` and `replyType` together:
`r` means reply, `w` means forward. Reply drafts require the original RFC Message-ID
and pass it as `irt`. Recipients and subject are explicit; there is no automatic
reply-all recipient inference. `quoteOriginal: true` adds a bounded quote from
the fetched original. HTML source is converted to text and escaped before quoting.
`attachOriginal: true` attaches the original email as `message/rfc822`.
The default is no quote and no original attachment. No signature is inferred.

`updateDraft` replaces the whole content, so supply all intended recipients,
body and original-message options. Existing arbitrary attachments are not preserved
by this operation. Do not use it to edit a draft whose attachments must remain.
Uploading new local attachments is not implemented; edit them in webmail or use IMAP.

Inspect the current draft before sending. Webmail edits can change its content;
`sendDraft` intentionally sends the then-current version. Native send is disabled
for accounts with `allowedRecipients`, since the server does not expose an atomic
recipient check against concurrent draft edits. Use the existing IMAP/SMTP path
when recipient restrictions are required.

Read-only, write allowlists, confirmation challenges, audit logging and provider
content redaction apply through the existing routers. Login is a local CLI action,
not an MCP operation. `outcome_unknown` always means `retrySafe: false`; inspect
Drafts/Sent or the changed objects before any repeat. Some SaveDraft faults happen
after content was saved. A SendMsg acceptance is not proof of recipient delivery.

Calendars, free/busy, contact writes, arbitrary SOAP calls, scheduled sends and
trusted-device renewal are intentionally not exposed in this first backend.

## Validation boundary

Automated tests use protocol fixtures and injected transports. They verify MFA
challenge handling, session scoping/expiry, bounded responses, token redaction,
native request shapes, cursor recovery, uncertain writes, and router gates.
They do not establish compatibility with an untested production Zimbra version.
No real mail, draft, tag or contact must be changed merely to test setup.

Protocol references:

- https://github.com/Zimbra/zm-mailbox/blob/develop/store/docs/soap.txt
- https://github.com/Zimbra/zm-api-js-client
- https://github.com/maldua-suite/zimbra-maldua-2fa/issues/7

HTTP 401 requires local login. A generic HTTP 403 indicates access denial; check
account/proxy permissions instead of assuming session expiry. Explicit SOAP
authentication faults still require login. Rejected input and authentication
failures report retrySafe: true, meaning the operation can be submitted after
correction; no automatic retry is performed. Unknown write outcomes remain unsafe.
Conversation IDs may be negative for native virtual conversations.

Tag names are limited to 255 characters and cannot contain colons, slashes,
double quotes or control characters. Empty names and dot/dot-dot names are rejected
before network I/O for creation, tagging and untagging.
