# Microsoft Graph and Exchange Web Services

Discover backend microsoft-graph or ews. Both use microsoft.* names, but supported
operations differ. Credentials are pre-provisioned OAuth2 in the local credential
store; do not request tokens in chat. No generic Microsoft listFolders/listMessages
or IMAP-style createDraft/updateDraft/sendDraft is exposed.

## Reads (`mail_query`)

| Operation | Backend | Input and result |
| --- | --- | --- |
| `microsoft.getMessage` | Graph/EWS | `{ messageId }`; detailed body, recipients, dates, attachment metadata |
| `microsoft.findByInternetMessageId` | Graph only | `{ internetMessageId }`; `{ messages, partial }` lookup |
| `microsoft.getThread` | Graph only | `{ anchor }`; pass a returned Graph message summary with id and available conversationId/internetMessageId |
| `microsoft.searchMessages` | EWS only | query?, folderId?, distinguishedFolderId?, maxResults?, offset?; returns messages, partial, nextOffset?, totalItems?, warning? |

For EWS, messageId is the returned itemId. maxResults is 1-1000, default 50.
Start without offset. Continue only with returned nextOffset and unchanged options.
Never infer absence from partial=true. Graph follows bounded provider pagination
internally (thread ceiling 100 pages/10,000 messages); there is no exposed arbitrary
Graph cursor/offset operation. Report its partial result rather than inventing one.
Search/thread results are summaries; read target bodies. Attachment bytes are not
embedded in getMessage and no separate Microsoft attachment download is exposed.

```json
{"accountId":"EWS_ACCOUNT_ID","operation":"microsoft.searchMessages","input":{"query":"invoice","distinguishedFolderId":"inbox","maxResults":20}}
```

## Writes (`mail_mutate`)

| Operation | Backend | Input |
| --- | --- | --- |
| `microsoft.sendMessage` | Graph/EWS | `{ message, saveToSentItems? }` |
| `microsoft.reply` | Graph only | `{ messageId, message }` |

Message shape: `{ subject, body, to: [address], bodyType?: "HTML"|"Text",
cc?: [address], bcc?: [address], replyTo?: [address], attachments?: [...] }`.
bodyType defaults Text. This is nested under input.message, not the IMAP flat shape.
Attachments: `{ name, content, contentType?, contentId?, isInline? }`;
JSON content is strict base64 or an array of byte values. No local path field.
Graph uses upload sessions for large attachments (simple threshold 3 MiB,
individual maximum 150 MiB); tenant/provider limits may be lower.

These operations send, even when Graph internally creates an intermediate draft
to upload attachments. No public server-draft workflow is exposed. Do not claim
a reviewable draft was saved merely because an intermediate draftId is returned.
No EWS reply/reply-all operation is supported by this router.

Result `{ provider, status: "accepted", requestId?, draftId? }` means provider
acceptance, not recipient delivery. Preserve IDs. For outcome_unknown, do not
retry automatically; inspect provider state/logs. A Graph createDraft failure may
report `operation: "createDraft", deliveryAttempted: false`: inspect Drafts before
creating another copy. It does not mean a send occurred. HTML remains untrusted.
