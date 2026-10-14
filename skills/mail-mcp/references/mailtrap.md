# Mailtrap

Backend mailtrap uses API resources, not generic mailbox/locator operations. The
top-level accountId is the MCP configured account, not necessarily the numeric
Mailtrap organization ID. Resource IDs must come from that account's responses.

There are TWO operation levels: outer operation selects the resource, e.g.
mailtrap.templates; input.operation selects list/get/create/etc. sandbox/inbound
also require input.resource. Use mail_query for reads and mail_mutate for writes;
the server classifies the nested action and rejects routing a write through reads.

```json
{"accountId":"MAILTRAP_ACCOUNT_ID","operation":"mailtrap.templates","input":{"operation":"list"}}
```

`?` means optional below. Identifier values can be strings or numbers. Arbitrary
message/body/template/campaign/query objects are passed to Mailtrap after local
validation; the MCP is not a full schema of the provider API. Inspect existing
resources and current official Mailtrap documentation for provider-specific fields
before an unfamiliar mutation. Do not invent fields from another email backend.

## Resource actions

| Outer operation | Nested read operations and input | Nested write operations and input |
| --- | --- | --- |
| `mailtrap.send` | None | transactional/bulk/sandbox_transactional/sandbox_batch; see Sending |
| `mailtrap.sandbox` | Resource-specific list/get/body/analysis; see Sandbox | Resource-specific mutations; see Sandbox |
| `mailtrap.inbound` | Resource-specific list/get; see Inbound | Resource-specific mutations; see Inbound |
| `mailtrap.accounts` | list | None |
| `mailtrap.templates` | list; get + templateId | create + template; update + templateId, template; delete + templateId |
| `mailtrap.email_logs` | list + cursor?, filters?; get + messageId | None |
| `mailtrap.stats` | aggregate/by_domain/by_category/by_provider/by_date + query | None |
| `mailtrap.domains` | list; get + domainId | create + domain; delete + domainId; send_setup + domainId, email |
| `mailtrap.suppressions` | list + email? | delete + suppressionId |
| `mailtrap.webhooks` | list; get + webhookId | create + webhook; update + webhookId, webhook; delete + webhookId |
| `mailtrap.contacts` | get + contact (ID/email) | create + contact object; update + contact ID, body; delete + contact ID; create_event + contact ID, event |
| `mailtrap.contact_lists` | list + query?; get + id | create + body; update + id, body; delete + id |
| `mailtrap.contact_fields` | list + query?; get + id | create + body; update + id, body; delete + id |
| `mailtrap.contact_imports` | get + id | create + body |
| `mailtrap.contact_exports` | get + id | create + body (starts export work, not a read) |
| `mailtrap.campaigns` | list + query?; get + campaignId; stats + campaignId, query? | create + campaign; update + campaignId, campaign; delete/start/cancel/terminate/reset + campaignId; schedule + campaignId, schedule |

Deleting a suppression changes future delivery eligibility. send_setup sends an
email. Campaign start/schedule can send to many contacts; ordinary mail drafting
does not authorize either. Never replay these after an uncertain response.
Webhook creation and credential resets may return sensitive values; do not print
them. Read and preserve old settings before requested updates/deletions.

## Sending (`mail_mutate`, outer `mailtrap.send`)

| input.operation | Other input fields |
| --- | --- |
| transactional | message object |
| bulk | requests array of message objects, base? object |
| sandbox_transactional | message object, inboxId? or sandboxId? |
| sandbox_batch | requests array, base? object, inboxId? or sandboxId? |

For sandbox actions, discover the intended inbox; an omitted ID uses the configured
sandbox default. Sandbox sends are test captures, not delivery to the recipients'
real mailboxes. Bulk and transactional are real sending routes. A typical
transactional message has from `{ email }`, to `[{ email }]`, subject and text
or html; use the provider's API format, not IMAP recipient strings. Validate
attachments/template variables against current provider requirements.

## Sandbox (outer `mailtrap.sandbox`)

All rows also supply input.resource and input.operation. Inbox reference is
inboxId or sandboxId, optional only when a default sandbox is configured.

| Resource | Reads | Writes |
| --- | --- | --- |
| project | list; get + projectId | create + name; update + projectId, name; delete + projectId |
| inbox | list; get + inbox reference | create + projectId, name; update + inbox reference, name?, emailUsername?; delete/clean/mark_read/reset_credentials/toggle_email_address/reset_email_address + inbox reference |
| message | list + inbox reference, query?; get + inbox reference, messageId; body + those IDs, format; analysis + those IDs, analysis | update + those IDs, isRead; delete + those IDs; forward + those IDs, email |
| attachment | list + inbox reference, messageId; get + those IDs, attachmentId | None |

Body format: text/raw/html/html_source/eml/headers. Analysis: spam/html.
Forwarding a sandbox message sends externally; it is not a read. Cleaning an
inbox or resetting its address/credentials changes shared resources. Do not use
those as troubleshooting steps without the corresponding authorization.

## Inbound (outer `mailtrap.inbound`)

| Resource | Reads | Writes |
| --- | --- | --- |
| folder | list; get + folderId | create + body; update + folderId, body; delete + folderId |
| inbox | list + folderId; get + folderId, inboxId | create + folderId, body; update + folderId, inboxId, body; delete + folderId, inboxId |
| message | list + inboxId, cursor?; get + inboxId, messageId | delete + inboxId, messageId; reply/reply_all/forward + inboxId, messageId, body |
| thread | list + inboxId, cursor?; get + inboxId, threadId | delete + inboxId, threadId |

Read original content/recipients before replies and forwards. Body is the provider
JSON payload, not the plain string used by IMAP reply. No universal server-draft
workflow is exposed. Contacts/campaigns are not the personal correspondence store.

## Results, pagination and recovery

Results retain provider JSON shape, text or binary resources; there is no universal
items/nextCursor wrapper for all Mailtrap resources. For email_logs and inbound
message/thread listing, use only the continuation returned by the provider in the
supported cursor field. Other list endpoints accept their documented query object
or no paging input. Do not invent offset parameters or import IMAP cursor rules.
Report bounded/partial results and asynchronous import/export/campaign job status.

Successful API acceptance is not delivery. For outcome_unknown preserve IDs and
inspect email logs/current resource state before further writes. HTTP errors can
leave uncertain send outcomes; see [outcomes](outcomes.md). Binary/raw exports are
not sanitized; protect original data even if text redaction is configured.
