# IMAP/SMTP

For backend `imap-smtp`, including legacy accounts with no backend. Fields below
go in `input`; `?` means optional. Names are public router operations. Use the
top-level accountId. See [outcomes](outcomes.md) before sends or uncertain recovery.

## Reads (`mail_query`)

| Operation | Input | Result/boundary |
| --- | --- | --- |
| `listFolders` | `{}` | Paths and special-use metadata; discover Sent/Drafts/Trash |
| `listMessages` | `folder?`, `limit?`, `cursor?`, `headerOnly?` | `items`, `nextCursor`, `total: null`; locators on items |
| `searchMessages` | Page fields above plus filters below | Server-side substring search |
| `readMessage` | `locator` | Formatted text; body can be truncated at 200,000 characters |
| `getRawMessage` | `locator`, `maxBytes?` | Metadata plus embedded base64 `message/rfc822`; default 10 MiB, ceiling 50 MiB |
| `getThread` | `threadId`, `folder?`, `folders?` | `{ items, folders, partial, warning }`, with item locators |
| `verifySentMessage` | `messageId`, `sentFolder?`, `count?` | Found/not found/indeterminate; count default 10, cap 100 |
| `getAttachment` | `locator`, `filename` | Metadata and embedded binary resource, not a local path |
| `extractAttachmentText` | `locator`, `filename` | PDF or text/* extraction; no XLSX/DOCX/OCR promise |
| `mailboxStats` | `folders?` array | Text table; errors/unknown counts are not zero |
| `extractContacts` | `folder?`, `count?` | Sampled correspondents, not an address book; default 100, cap 500 |
| `listTemplates` | `{}` | Local templates; optional top-level accountId filters them |
| `renderTemplate` | `templateId`, `variables?` string map, `to?`, `cc?`, `bcc?` | Content only; no draft or send |
| `listFilters` | `{}` | ManageSieve scripts and active marker |
| `getFilter` | `name` | Complete Sieve script |

Search filters: `from`, `to`, `cc`, `subject`, `messageId`, `since`, `before`,
`keywords`, `keywordsAll`, `keywordsAny`, `excludeKeywords`, `keywordScope`,
`unread`, `flagged`. Dates use YYYY-MM-DD: since inclusive, before exclusive.
Keyword arrays contain at most 20 literal terms/phrases, at most 256 characters
each. All/any/excluded groups combine with AND. Scope is body (default), subject
or all. `keywords` is one literal body phrase. No regex or semantic interpretation.
Search folders separately; do not download entire mailboxes for local filtering.

Use limit 20-50 normally; maximum 500. `headerOnly: true` skips snippets.
Bounded descending UID windows can produce empty pages with `nextCursor`.
Continue identical filters and retain the newest cursor; old cursors are consumed
after success and expire after five minutes. New higher UIDs are excluded from a
continuation; deletions can remove results. A fresh search includes new mail.

`threadId` is a returned Gmail thread ID or an original RFC Message-ID exposed by
readMessage, not a locator or subject. Do not fabricate IDs. Pass explicit discovered
`folders` (1-10), including Sent, for cross-folder threads. Reconstruction is bounded
to 500 messages and 100 searches and currently always returns partial=true, since
deleted or unreferenced messages cannot be ruled out. Read relevant individual items.

```json
{"accountId":"ACCOUNT_ID","operation":"searchMessages","input":{"folder":"INBOX","keywordsAny":["invoice","payment overdue"],"excludeKeywords":["newsletter"],"keywordScope":"all","unread":true,"since":"2026-10-01","before":"2026-11-01","limit":20,"headerOnly":true}}
```

Some legacy operations accept `uid` plus `folder` (move uses `sourceFolder`).
Prefer locators, which bind account/folder/UIDVALIDITY/UID. After moving, renaming
a mailbox or a UIDVALIDITY change, rediscover. Do not rebuild or retarget locators.

## Compose (`mail_mutate`)

| Operation | Input | Behavior |
| --- | --- | --- |
| `createDraft` | `to`, `subject`, body fields; optional compose fields below | New server draft; no inferred reply threading |
| `sendMessage` | Same compose fields | Sends after any configured confirmation |
| `createReplyDraft` | `locator`, `body`; `isHtml?`, `cc?`, `bcc?`, `includeSignature?`, `includeOriginalAttachments?`, `attachments?` | Infers reply headers/recipients, saves without sending |
| `createReplyAllDraft` | Same reply-draft fields | Excludes account/aliases, deduplicates recipients |
| `updateDraft` | Exactly one of `draftId` / `locator`, plus `changes` | Updates latest server revision, verifies replacement |
| `sendDraft` | Exactly one of `draftId` / `locator` | Sends current server draft without recomposing |
| `reply` | `locator`, `body`; `isHtml?`, `cc?`, `bcc?`, `includeSignature?`, `attachments?` | Sends a reply |
| `replyAll` | `locator`, `body`; `isHtml?`, `bcc?`, `includeSignature?`, `includeOriginalAttachments?`, `attachments?` | Sends to inferred recipients; no CC override here |
| `forward` | `locator`, `to`; `body?`, `isHtml?`, `cc?`, `bcc?`, `includeSignature?`, `includeOriginalAttachments?`, `attachments?` | Sends; original attachments are opt-in |

Compose recipients to/cc/bcc are strings (not provider address arrays). Body is
`body` with `isHtml` (default false), or `textBody` and/or `htmlBody`. Body fields
must be strings. Optional compose fields: cc, bcc, from (account/allowed alias),
replyTo, includeSignature (default true), attachments. Arbitrary headers/threading
are not forwarded by this router. replyTo is an address, not In-Reply-To. Adding
Re: to the subject does not create a threaded reply.

Reply drafts require source Message-ID and derive subject, In-Reply-To, References
and recipients. Missing Message-ID is an error, not permission to create a separate
message. Explicit cc replaces inferred CC; `""` clears it. Further To/CC changes
use updateDraft after inspection. Quoted history is not added automatically.
Set includeSignature=false when the approved signature was already added manually.

`changes` accepts to, cc, bcc, subject, textBody, htmlBody, attachments. Omitted
fields survive. Attachments replaces the entire list; [] clears it. Changing one
body format removes an unspecified alternative, so send both when both must remain.
Preserve inline CIDs. The user can edit in webmail between calls: review identity
conflicts instead of guessing by subject or discarding either version.

For an edit that must preserve exact HTML/signature/inline images, first fetch the
current draft through getRawMessage and parse its MIME parts with a mail parser.
readMessage is a reading view: it converts HTML to Markdown, rewrites cid: links,
omits inline data images and may redact/truncate content. Do not use that view as
the HTML source. Edit the decoded HTML part, preserve its original cid: references,
and send htmlBody plus an updated textBody if both formats should remain. Omit
attachments from changes to preserve the existing attachments; do not pass [] or
reconstruct them from the displayed filenames. After update, read the returned
locator and inspect raw MIME again for headers, both body formats and attachment
metadata. If exact MIME cannot be read/parsed, report the limitation instead of
claiming the signature or inline images were preserved.

Attachments: `{ "path": "<absolute-server-path>" }` or
`{ "filename": "note.txt", "contentBase64": "aGVsbG8=" }`; optional contentType,
contentDisposition (attachment/inline), cid, and filename for file attachments.
Maximum 20 attachments and 25 MiB per attachment; provider message-size limits
can be lower once MIME/base64 overhead is included. Paths refer to
the MCP host. Configured allowedAttachmentRoots restrict real paths including
symlinks. Missing roots or [] disable path attachments in the SMTP service;
base64 remains available within size limits. Do not broaden roots to make a send work.

Preserve draftId/locator/messageId when returned. Saved drafts can lack tracking
after secondary failure: locate by Message-ID before another write. Never recreate
an uncertain APPEND. Inspect the saved headers, recipients, body and attachments.

```json
{"accountId":"ACCOUNT_ID","operation":"createReplyAllDraft","input":{"locator":"RETURNED_LOCATOR","body":"Approved reply text","includeSignature":false,"includeOriginalAttachments":false}}
```

## Organization and setup (`mail_mutate`)

| Operation | Input | Verification/boundary |
| --- | --- | --- |
| `copyMessage` | `locator`, `targetFolder` | Use destinationLocator when returned; otherwise rediscover |
| `moveMessage` | `locator`, `targetFolder` | Re-query destination; response supplies no new locator |
| `moveToTrash` | `locator` | Moves to Trash |
| `permanentlyDelete` | `locator` | Irreversible; only for explicit permanent deletion intent |
| `markRead`, `markUnread`, `star`, `unstar` | `locator` | Re-query flags |
| `modifyLabels` | `locator`, `addLabels?`, `removeLabels?` string arrays | IMAP keywords, not Zimbra tags |
| `batchMessages` | `locators` array, `action`, action fields below | Inspect processed/succeeded/failed and each item |
| `createMailbox` | `path` | Re-list mailboxes |
| `renameMailbox` | `path`, `newPath` | Rediscover paths/locators |
| `deleteMailbox` | `path` | Inspect contents and intended scope first |
| `setFilter` | `name`, `content` | Replaces whole named Sieve script; preserve previous content |
| `deleteFilter` | `name` | Changes future filtering; re-list scripts |
| `registerOAuth2` | `clientId`, `clientSecret`, `refreshToken`, `tokenEndpoint` | Existing account credential administration, not normal mail work |

Batch action: move/copy requires targetFolder; delete moves to Trash; label uses
addLabels/removeLabels. Legacy uids plus folder also work. Read targets, freeze
the selected IDs, then inspect per-item outcomes. Batch is not atomic; do not
replay successful items after partial failure.

ManageSieve needs a supported endpoint and login credentials; OAuth2 is unsupported.
This client uses implicit TLS with certificate verification; STARTTLS-only endpoints
are unsupported. Configure a trusted private CA locally when required, not disabled TLS.
setFilter performs PUTSCRIPT, not SETACTIVE. There is no exposed activation command;
saving a new script is not proof that filtering is active.

registerOAuth2 accepts secret-bearing fields, but do not solicit or paste secrets
into chat/tool history. Use approved local provisioning. Failed mail reads do not
authorize credential/configuration changes.
