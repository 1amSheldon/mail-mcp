# Zimbra SOAP

For delayed delivery and cancellation, see [native scheduling](zimbra-scheduling.md).

For server filters, see [incoming and outgoing rules](zimbra-rules.md).
For folder ACLs and shared resources, see [sharing and mountpoints](zimbra-sharing.md).
For files and revision history, see [Briefcase](zimbra-documents.md).
For meetings, tasks and availability, see [calendars](zimbra-calendar.md).

Use only when list_accounts reports backend `zimbra`. IMAP accounts on a Zimbra
host remain IMAP accounts. Do not revive a disabled legacy MCP or change its
credentials merely because an account name contains Zimbra.

## Authentication and IDs

Local provisioning: `npx -y @1amsheldon/mail-mcp@latest accounts add`, backend Zimbra,
then `npx -y @1amsheldon/mail-mcp@latest accounts login ACCOUNT_ID`. Endpoint must be HTTPS with path
/service/soap, without query/fragment or admin SOAP. Login prompts locally for
password and, if requested, TOTP or backup code. Never request these in chat,
tool parameters or command arguments. By default only the completed session is stored.
IMAP app passwords are not assumed to authenticate SOAP. SAML/SSO, email OTP,
and 2FA enrollment are not implemented.

For server-supported trusted devices, the user can run locally:
`npx -y @1amsheldon/mail-mcp@latest accounts login ACCOUNT_ID --trusted-device`.
This explicitly requests device registration (or reuses unexpired saved trust).
The server may still require a second factor or deny/omit trust. Only after a
usable trusted token, device ID and trust lifetime are returned does the CLI ask
whether to store the MAIN password in the OS credential store. Default is no.
Never answer that prompt or enable password storage on the user's behalf from a
mail task. OTP/backup codes are never saved. No trust/password enters accounts.json,
MCP inputs, logs or the local lock files. Trust is per device; never copy it.
Trusted-login storage requires a native OS keychain backend (or Linux Secret
Service). Secret Service may use `secret-tool` without a shell and pass secrets
through stdin. Backends passing passwords in process arguments, plus file and
null fallbacks, are refused; restore system credential storage availability
rather than putting the password into a config file.

If explicitly enabled, an expired session is replaced by password + trusted-device
authentication before the next network operation. This obtains a new session;
it does not extend an existing token or server policy. A local interprocess lock
serializes attempts and a durable blocked marker is saved before authentication.
Any failed/interrupted automatic attempt needs local login, including a transient
network failure; there is no background retry loop. Expired/revoked trust requires
local login and possibly 2FA. A rejected in-flight mail request is never replayed.
Successful authentication does not prove a previous write failed or permit resending.

`npx -y @1amsheldon/mail-mcp@latest accounts disable-auto-login ACCOUNT_ID` removes the stored
password while retaining the current session and trust. Ordinary login without
`--trusted-device` replaces the local record with a session-only record. Neither
action revokes server-side device trust; revoke it in webmail when required.
If a process dies while owning a login lock, the error identifies the lock file.
Inspect its recorded PID and close mail-mcp processes before removing only that
abandoned file. Locks contain process metadata only, never credentials. Do not
remove active locks or any durable send-state records.

Use a separate account ID from IMAP. Do not replace an IMAP password with a SOAP
session. Each operation loads the current session: successful login does not need
an MCP restart. auth_required/auth_failed require local reauthentication, not
automatic credential changes. `zimbra.sessionStatus` inspects local availability,
session/trust expiry and automatic-login state without attempting authentication.
With remote=true it performs GetInfo and may first run an explicitly enabled
automatic login. Missing server capability fields mean unknown, not enabled;
`trustedDevicesEnabled=false` during login means this route needs a policy change.

Native IDs must come from this account. Do not reuse IMAP UIDs/locators. Message,
folder, contact, tag and draft IDs are strings; conversation IDs may be negative.
Preserve the returned ID exactly, including any shared-mailbox prefix.

## Reads (`mail_query`)

| Operation | Input | Result/boundary |
| --- | --- | --- |
| `zimbra.sessionStatus` | `remote?` | Local state by default; remote=true also verifies current server access |
| `zimbra.getSendStatus` | `draftId` | Durable local attempt state; no network request |
| `zimbra.verifySentMessage` | RFC `messageId`, `limit?` (1-100, default 20) | Exact Message-ID verification in Sent; found/not_found/indeterminate |
| `zimbra.searchMessages` | `query`, `limit?`, `cursor?`, `inDumpster?` | Native query, compact items and continuation; dumpster defaults false and is bound to the cursor |
| `zimbra.readMessage` | `messageId` | Body, recipients, headers/attachment metadata; does not mark read |
| `zimbra.getRawMessage` | `messageId`, `maxBytes?` | Original RFC 822 bytes; default 10 MiB, maximum 50 MiB |
| `zimbra.getThread` | `conversationId` | Conversation metadata; read individual messages afterward |
| `zimbra.listFolders` | `{}` | Native folder tree |
| `zimbra.mailboxStats` | `{}` | Folder counts/size; missing values remain null, especially for mounted resources |
| `zimbra.listTags` | `{}` | Tags and IDs |
| `zimbra.searchContacts` | `query`, `limit?`, `cursor?` | Native address-book search |
| `zimbra.getContact` | `contactId`, `dereferenceMembers?`, `maxMembers?` | Contact/group details; member expansion defaults false, maxMembers 1-1000 (default 100) |
| `zimbra.getAttachment` | `messageId`, `partId`, `maxBytes?` | Embedded binary resource; default 5 MiB, maximum 25 MiB |
| `zimbra.extractAttachmentText` | `messageId`, `partId`, `maxBytes?`, `maxChars?`, `maxPages?` | PDF/text extraction; explicit partial result |

Search query is native Zimbra syntax, e.g. `in:inbox has:attachment`. Limit is
1-100 (default 50). Repeat identical query and limit with newest nextCursor.
Cursors expire after five minutes and are consumed after successful continuation.
Native offset paging can shift when mail changes; there is no immutable snapshot.
Results expose items, total:null, partial and warnings. Bodies can be truncated;
SOAP responses are bounded to 8 MiB. Part IDs come from attachment metadata.
No arbitrary URL download: attachments use authenticated HTTPS, reject redirects
and return original bytes even with text redaction enabled.

```json
{"accountId":"ZIMBRA_ACCOUNT_ID","operation":"zimbra.searchMessages","input":{"query":"in:inbox has:attachment","limit":20}}
```

## Writes (`mail_mutate`)

| Operation | Input |
| --- | --- |
| `zimbra.createDraft` | `to` array, `subject`, body fields; optional compose fields below |
| `zimbra.createReplyDraft`, `zimbra.createReplyAllDraft` | `messageId`, `body`; isHtml?, cc?, bcc?, attachments?, includeOriginalAttachments?, quoteOriginal?, from?, replyTo?, identityId?, signatureId?, includeSignature? |
| `zimbra.createForwardDraft` | Reply-draft fields plus explicit `to` array |
| `zimbra.updateDraft` | `draftId`, `changes`, `expectedRevision?`; legacy complete-content form also accepted |
| `zimbra.sendDraft` | `draftId`, `expectedRevision?` (the reviewed ms) |
| `zimbra.createTag` | `name`, `color?` integer 0-9 |
| `zimbra.deleteTag` | `tagId` |
| `zimbra.addTag`, `zimbra.removeTag` | `messageIds` array, `tagName` |
| `zimbra.moveMessages` | `messageIds` array, `folderId` |
| `zimbra.markRead` | `messageIds` array, `read` boolean |
| `zimbra.moveToTrash` | `messageIds` array |

Message arrays accept 1-100 IDs. Recipient arrays accept at most 100 addresses
each, to must not be empty. Body maximum 200,000 characters; subject maximum 998.
Unknown input fields are rejected. Read selected objects before changing them;
verify tags, folders and read state afterward. Do not assume a timeout rolled back.

For reply/forward supply originalMessageId and replyType together: r=reply,
w=forward. Reply drafts require the source RFC Message-ID. To/CC/BCC and subject
are explicit in createDraft. For inferred recipients use createReplyDraft or
createReplyAllDraft: Reply-To takes precedence over From, own account/registered
aliases and duplicates are removed, and original Bcc is never inferred. A reply
to a self-sent message uses its original To recipients. Explicit cc replaces
inferred CC; [] clears it. Inspect saved recipients and reply headers.
quoteOriginal=true adds a bounded quote; HTML source is converted to
text and escaped. attachOriginal=true attaches the original message as
message/rfc822, not a list of its original file attachments. Both default false.
The reply/forward helpers instead offer includeOriginalAttachments=true to retain
the original files alongside new attachments. This defaults false. All three
helpers save drafts only; none sends a message.

createDraft body fields are either body + isHtml, or textBody and/or htmlBody.
Do not mix these two input forms. Optional compose fields: cc/bcc arrays,
originalMessageId, replyType, attachOriginal, quoteOriginal, attachments, from,
replyTo, identityId, signatureId, includeSignature and references (RFC Message-ID
array). Reply helpers derive References from the source MIME. From must be the
account, a configured fromAliases entry, or the selected server identity's From.
Discover native identity/signature UUIDs through listIdentities/listSignatures.
Server permission checks still apply to an identity or alias.

includeSignature defaults true and inserts the configured local plain-text
signature, if any. signatureId selects a native signature and its HTML/text
formats; it is not an instruction to change account defaults. No remote signature
is guessed when an ID is omitted. Use includeSignature=false if the supplied body
already contains the signature. Referenced images in native HTML signatures are
not automatically downloaded; provide any needed inline CID files as attachments.

For updateDraft prefer `changes`: to/cc/bcc arrays, subject, textBody, htmlBody,
attachments, from, replyTo and identityId. Omitted fields and attachments survive.
An empty replyTo clears that header. Supplying attachments replaces
the list; [] removes them. Supplying one body format removes an omitted alternative:
send textBody and htmlBody together to keep both. The legacy form replaces recipients
and body; it also preserves attachments unless an explicit list is supplied.

Partial updates fetch raw MIME, preserve decoded HTML, CID links, attachment bytes,
reply headers and Message-ID, and save with a server change-sequence guard. MIME
boundaries and transfer encodings may change; this is not a byte-identical archive.
Signed/encrypted drafts and duplicate custom headers are rejected rather than
silently damaged. The draft must expose `ms`; optionally pass that value as
expectedRevision to bind the edit to the version already reviewed. On conflict,
re-read the draft and reconcile the user's changes; do not repeat a stale patch.

Attachments accept `{path}` on the MCP host or `{filename,contentBase64}`, with
optional contentType, contentDisposition (attachment/inline) and cid. At most 20
files, 25 MiB per file and 50 MiB composed MIME. Local paths require the account's
allowedAttachmentRoots; missing/empty roots disable paths, not base64. Paths and
symlinks are checked by the shared attachment preparation code. Do not broaden
roots to bypass a rejection. Upload uses the current Zimbra session and
`/service/upload`; it does not require an IMAP app password. Upload failure does
not trigger a draft save or automatic retry. Server size limits may be lower.

```json
{"accountId":"ZIMBRA_ACCOUNT_ID","operation":"zimbra.updateDraft","input":{"draftId":"123","changes":{"subject":"Revised subject"},"expectedRevision":"42"}}
```

Replace the example draft ID and revision with the selected draft's actual ID and ms.
Read the saved draft, and use getRawMessage to verify exact HTML and attachment
metadata when those must survive. Raw messages and files are binary resources,
not redaction-safe exports.

```json
{"accountId":"ZIMBRA_ACCOUNT_ID","operation":"zimbra.createDraft","input":{"to":["recipient@example.com"],"subject":"Re: Delivery date","body":"Approved reply text","originalMessageId":"123","replyType":"r","quoteOriginal":true}}
```

The example ID must be replaced with a read message's actual ID. sendDraft downloads
and validates the current raw MIME, checks its revision again, then sends that exact
snapshot through upload/SendMsg. Later webmail edits cannot change its recipients.
Inspect the draft and obtain send authorization first; expectedRevision binds the
send to a previously reviewed ms. To/CC/BCC all obey allowedRecipients. An empty
explicit allowlist disables sending; omitted allowlist imposes no local restriction.
Server-side routing, forwarding and delivery policies still apply.

Send attempts are durably claimed under `~/.config/mail-mcp/zimbra-send-state` before
SendMsg. Keep this directory when moving an installation. Repeating sendDraft for
the same draft returns its recorded state and does not send again, even after a
restart. A crashed or uncertain attempt stays outcome_unknown. A corrupt journal
blocks sending rather than guessing. getSendStatus is local evidence only;
not_recorded does not rule out a send from another installation or webmail.

After acceptance, the source draft is moved to Trash only under its unchanged
revision. Cleanup failure retains acceptance and must never trigger another send.
Inspect draftCleanup and the current server state. verifySentMessage checks a Sent
copy by RFC Message-ID, not subject; found does not prove recipient delivery and
not_found does not prove non-delivery. No automatic retry/reset of an uncertain
attempt is exposed. Review Sent and server delivery evidence before deciding on
any separately authorized new send. Native scheduled drafts must have their
schedule canceled before manual sending or ordinary draft editing. A generic
SaveDraft without autoSendTime cancels native scheduling, so updateDraft refuses
scheduled drafts instead of silently changing their delivery behavior.

On POSIX, journal directory entries are flushed before dispatch and after status
replacement. Windows flushes file contents but cannot flush directories through
Node; OS-crash/power-loss persistence is not guaranteed there. After such an event,
inspect Sent before initiating another send, even if a local claim is missing.

For outcome_unknown, inspect Drafts/Sent or affected objects before deciding on
recovery; never automatically repeat a write. Native scheduling is described above;
for calendars, tasks and availability, read [calendars](zimbra-calendar.md).

## Folders, contacts and user settings

For GAL, contact groups, identities, preference changes and out-of-office workflows,
read [Zimbra contacts and settings](zimbra-contacts-settings.md).

These are native Zimbra operations; prefix every operation below with `zimbra.`.
Discover IDs with listFolders, searchContacts and listSignatures. Account IDs used
by MCP are not Zimbra item IDs. Shared item IDs keep their owner UUID prefix.

Reads through `mail_query`:

| Operation | Input | Boundary |
| --- | --- | --- |
| `zimbra.getAccountInfo` | `{}` | Server version, mailbox information, visible account attributes/features, identities and signatures |
| `zimbra.getPreferences` | `names?` array of 1-100 zimbraPref names | Selected settings, or all returned preferences when omitted |
| `zimbra.listIdentities`, `zimbra.listSignatures` | `{}` | Native identities/signatures, not automatically applied to compose |
| `zimbra.getFolder` | `folderId` | Folder metadata and returned descendants |
| `zimbra.getMessageMetadata` | `messageIds` | Flags, folder, revision and other server metadata |

Writes through `mail_mutate`:

| Operation | Input | Effect |
| --- | --- | --- |
| `zimbra.createFolder` | `name`, `parentFolderId`, `view?`, `color?` | view: message (default), contact, appointment, task or document; name is one segment |
| `zimbra.renameFolder` | `folderId`, `name` | Rename one folder |
| `zimbra.moveFolder` | `folderId`, `parentFolderId` | Move its subtree |
| `zimbra.trashFolder` | `folderId` | Move folder to Trash; Zimbra may mark contents read and rename it |
| `zimbra.deleteFolder` | `folderId` | Delete folder, descendants and contents; requires explicit destructive intent |
| `zimbra.emptyFolder` | `folderId`, `recursive?` | Delete contents; recursive defaults false |
| `zimbra.markFolderRead` | `folderId` | Mark the folder contents read |
| `zimbra.setFolderColor` | `folderId`, `color` | Native palette index 0-127 |
| `zimbra.setFlagged` | `messageIds`, `flagged` | Set/clear stars without replacing other flags |
| `zimbra.copyMessages` | `messageIds`, `folderId` | Copy without moving originals; rediscover destination IDs |
| `zimbra.markSpam` | `messageId`, `spam` | Spam/not-spam action can move the message and train server filtering |
| `zimbra.deleteMessages` | `messageIds` | Delete, possibly into the server dumpster; not a guarantee of physical erasure |
| `zimbra.recoverMessages` | `messageIds`, `folderId` | Recover available dumpster items; depends on server retention and permissions |
| `zimbra.renameTag` | `tagId`, `name` | Rename existing tag |
| `zimbra.setTagColor` | `tagId`, `color` | Native palette index 0-127 |
| `zimbra.createContact` | `fields`, `folderId?` | Create a native contact; default Contacts folder if omitted |
| `zimbra.updateContact` | `contactId`, `fields` | Patch supplied fields; omitted fields survive; empty string removes a field |
| `zimbra.moveContacts` | `contactIds`, `folderId` | Move contacts |
| `zimbra.trashContacts`, `zimbra.deleteContacts` | `contactIds` | Trash or delete, respectively |
| `zimbra.createSignature` | `name`, `contents` | May become default if the account has no default signature |
| `zimbra.updateSignature` | `signatureId`, `name?`, `contents?` | Change supplied attributes; at least one change required |
| `zimbra.deleteSignature` | `signatureId` | Delete selected signature |

To recover deleted mail, search with `inDumpster: true` and inspect the returned
candidate metadata/content before selecting IDs. Keep that flag on every cursor
page. Dumpster availability depends on server retention and permissions; an empty
result does not prove physical erasure. After explicit recovery authorization,
call `recoverMessages` with those IDs and the destination folder, then search the
destination normally and verify the recovered content (IDs can change). Do not
assume ordinary `readMessage` can read a dumpster ID, or repeat a recovery after
an uncertain write without checking both scopes.

Arrays of message/contact IDs accept 1-100 entries. Contact fields are a map, e.g.
`{"firstName":"Alex","email":"alex@example.test","company":"Supplier"}`;
at most 100 fields, 20,000 characters each. Signatures use server UUIDs and
`contents: [{"type":"text/plain","content":"Alex"}]`; one entry per format,
text/plain and/or text/html, at most 200,000 characters per entry. Read back the
signature before assuming how the server preserves its other format.

Before deletion, inspect folder descendants and contents or selected contacts.
Never turn an ambiguous "remove" into permanent deletion. SOAP action responses
may echo requested IDs even when constraints prevented an item from changing:
re-query affected objects; an echoed ID list is not per-item success evidence.

extractAttachmentText accepts only returned message/part IDs, downloads at most
maxBytes (default 5 MiB, ceiling 25 MiB), and supports PDF or text/*. maxChars is
1-200,000 (default 100,000); maxPages is 1-100 (default 25). partial reports either
page or character truncation. Text uses a declared charset when available, UTF-8
otherwise; invalid encoding is an error. No XLSX/DOCX parsing or OCR is implied.
