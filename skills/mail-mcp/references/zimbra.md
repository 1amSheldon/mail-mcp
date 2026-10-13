# Zimbra SOAP

Use only when list_accounts reports backend `zimbra`. IMAP accounts on a Zimbra
host remain IMAP accounts. Do not revive a disabled legacy MCP or change its
credentials merely because an account name contains Zimbra.

## Authentication and IDs

Local provisioning: `node dist/index.js accounts add`, backend Zimbra, then
`node dist/index.js accounts login ACCOUNT_ID`. Endpoint must be HTTPS with path
/service/soap, without query/fragment or admin SOAP. Login prompts locally for
password and, if requested, TOTP or backup code. Never request these in chat,
tool parameters or command arguments. Only the completed session is stored.
IMAP app passwords are not assumed to authenticate SOAP. SAML/SSO, email OTP,
2FA enrollment and trusted-device registration are not implemented.

Use a separate account ID from IMAP. Do not replace an IMAP password with a SOAP
session. Each operation loads the current session: successful login does not need
an MCP restart. auth_required/auth_failed require local reauthentication, not
automatic credential changes. `zimbra.sessionStatus` checks cached availability,
not remote validity. Test a permitted read to establish actual access.

Native IDs must come from this account. Do not reuse IMAP UIDs/locators. Message,
folder, contact, tag and draft IDs are strings; conversation IDs may be negative.
Preserve the returned ID exactly, including any shared-mailbox prefix.

## Reads (`mail_query`)

| Operation | Input | Result/boundary |
| --- | --- | --- |
| `zimbra.sessionStatus` | `{}` | Local session state only |
| `zimbra.searchMessages` | `query`, `limit?`, `cursor?` | Native query, compact items and continuation |
| `zimbra.readMessage` | `messageId` | Body, recipients, headers/attachment metadata; does not mark read |
| `zimbra.getThread` | `conversationId` | Conversation metadata; read individual messages afterward |
| `zimbra.listFolders` | `{}` | Native folder tree |
| `zimbra.listTags` | `{}` | Tags and IDs |
| `zimbra.searchContacts` | `query`, `limit?`, `cursor?` | Native address-book search |
| `zimbra.getContact` | `contactId` | Contact details |
| `zimbra.getAttachment` | `messageId`, `partId`, `maxBytes?` | Embedded binary resource; default 5 MiB, maximum 25 MiB |

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
| `zimbra.createDraft` | `to` array, `subject`, `body`; optional cc/bcc arrays, isHtml, originalMessageId, replyType, attachOriginal, quoteOriginal |
| `zimbra.updateDraft` | The same COMPLETE content plus `draftId`; no nested changes object |
| `zimbra.sendDraft` | `draftId` |
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
are explicit; there is no inferred reply-all. Compute them from the read source,
check own addresses and duplicates, then inspect the saved draft. No automatic
signature. quoteOriginal=true adds a bounded quote; HTML source is converted to
text and escaped. attachOriginal=true attaches the original message as
message/rfc822, not a list of its original file attachments. Both default false.

updateDraft is a FULL replacement, unlike IMAP updateDraft. Omitted content and
arbitrary existing attachments are not preserved. Do not use it on a draft whose
attachments must survive. New local attachment upload is not implemented; use
webmail or a separately selected IMAP account, preserving identity and authorization.

```json
{"accountId":"ZIMBRA_ACCOUNT_ID","operation":"zimbra.createDraft","input":{"to":["recipient@example.com"],"subject":"Re: Delivery date","body":"Approved reply text","originalMessageId":"123","replyType":"r","quoteOriginal":true}}
```

The example ID must be replaced with a read message's actual ID. sendDraft sends
the current server revision; inspect it and obtain send authorization. If the account
has allowedRecipients configured, native send is disabled: concurrent webmail edits
cannot be checked atomically. Do not bypass this by changing account policy.

For outcome_unknown, inspect Drafts/Sent or affected objects before deciding on
recovery; never automatically repeat a write. Native scheduling, calendars,
contact writes, mailbox management and permanent deletion are not exposed.
