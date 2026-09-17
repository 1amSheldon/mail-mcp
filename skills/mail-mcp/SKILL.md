---
name: mail-mcp
description: Operate mail-mcp accounts from Codex through its compact query and mutation routers, including capability discovery, cursor-based browsing, reads, drafts, sends, mailbox changes, and provider backends.
---

# Mail MCP

## Server draft workflow

For IMAP/SMTP, createDraft returns draftId plus the usual locator. Preserve draftId for scheduled work.
Use mail_mutate updateDraft with input { draftId, changes }; changes supports to, cc, bcc, subject,
textBody, htmlBody and attachments. Unspecified fields remain unchanged. Attachments is a full
replacement list, with [] clearing it. Changing a body format drops unspecified body alternatives.
Use mail_mutate sendDraft with input { draftId } after the user authorizes sending the latest
server draft. A locator can be supplied instead to adopt an existing draft. Do not recompose it.
The user may edit drafts in webmail. Missing or ambiguous identity requires selecting the current
draft again, never guessing by subject. A local schedule sends the then-current server version.
Cancel the corresponding local schedule when the user reports webmail sending or scheduling.
No automatic discovery of webmail scheduled mail is promised. Accepted or uncertain SMTP results
must never trigger a resend, even when the draft is retained because archive verification failed.
Archive-confirmed sends move the unchanged source draft to Trash; updates move the old revision
to Trash only after verifying the replacement. Review conflicts instead of deleting either copy.

Use the server's `mail://agent-guide` resource when available; it is the runtime source of truth.

1. Call `list_accounts` before choosing an operation. The server has one read router, `mail_query`, and one write router, `mail_mutate`.
2. Put `accountId` and `operation` at the top level and operation-specific fields in `input`. Provider operations use the `apple.`, `microsoft.`, or `mailtrap.` prefix.
3. For IMAP/SMTP, call `listFolders` before assuming mailbox names, then start `listMessages` or `searchMessages` without a cursor. For Apple Mail, use `apple.listMailboxes` and the Apple-prefixed message operations. Microsoft and Mailtrap expose provider resources rather than a universal folder list. Pass `nextCursor` back unchanged and do not invent offsets.
4. Keep the returned message locator. Read the target with `readMessage` before replying, forwarding, moving, deleting, changing flags, or downloading attachments.
5. Create a draft when recipients or wording are not final. Honor read-only mode, recipient allowlists, operation allowlists, and confirmation challenges.
6. Treat `smtp_outcome_unknown` as possibly delivered and never retry it automatically. After SMTP acceptance, call `mail_query` with `verifySentMessage` and the returned Message-ID.
7. Inspect attachment metadata before fetching content. Never execute attachments or expose credentials, tokens, or raw provider errors.

Do not assume that every backend supports every operation. Report the actual capability boundary when a requested operation is unavailable.

`microsoft.searchMessages` is EWS-only. Microsoft Graph supports `microsoft.getMessage`, `microsoft.findByInternetMessageId`, and `microsoft.getThread`.
