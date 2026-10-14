# Outcomes, verification and recovery

Read the full tool result, including isError, status, warnings, partial,
retrySafe and nextAction. A successful MCP call is not necessarily a completed
write: the first confirmation call only issues a challenge. A retained draft is
not proof that it was never sent. Do not infer retry safety from generic transport
errors or HTTP status alone.

## Technical confirmation

With --confirm, call the write with its intended accountId/operation/input. The
first result returns confirmationRequired, description, confirmationId and expiry.
For an already authorized action, repeat the exact envelope with confirmationId
at TOP LEVEL, not in input. Five-minute, single-use tokens bind exact arguments.
Changing recipients, text, operation or account requires a fresh challenge.
An expired/consumed token can be reissued for the same still-authorized action,
but first distinguish a rejected challenge from an uncertain executed write.
Do not replay a write whose execution result was lost merely to get a new token.

```json
{"accountId":"ACCOUNT_ID","operation":"sendDraft","input":{"draftId":"RETURNED_DRAFT_ID"},"confirmationId":"RETURNED_CONFIRMATION_ID"}
```

This is the second call only. User authorization and the technical token are
separate. Do not ask again for unchanged, already authorized work just because
the server has a challenge, and do not treat the challenge as permission to send.

## SMTP results

| Status | Meaning | Next action |
| --- | --- | --- |
| sent_and_saved | SMTP accepted and a Sent copy was saved | Verify Message-ID when needed; never resend |
| partially_sent_and_saved | Only accepted recipients were submitted; Sent copy exists | Report accepted/rejected separately; never replay all recipients |
| smtp_accepted_sent_not_confirmed | SMTP accepted, IMAP archive unconfirmed | Verify Sent; do not resend |
| smtp_partially_accepted_sent_not_confirmed | Partial recipient acceptance and unconfirmed archive | Inspect both recipient arrays and Sent; no full replay |
| sent_provider_managed | Provider manages Sent; manual append skipped | Inspect provider Sent; no duplicate append/send |
| partially_sent_provider_managed | Same, with rejected recipients | Report recipient split and inspect provider state |
| sent_without_saved_copy | Configured policy omits manual Sent copy | Absence from Sent is expected, not send failure |
| partially_sent_without_saved_copy | Same, with rejected recipients | Report split; do not replay accepted recipients |
| smtp_connection_failed | Connection failed before submission | Inspect error; correct cause within scope before a justified retry |
| smtp_preflight_failed | Message rejected before SMTP submission | Correct input/configuration only within authorization |
| smtp_rejected | Definite SMTP rejection, no accepted delivery reported | Inspect retrySafe/nextAction and rejection; do not loop unchanged |
| smtp_outcome_unknown | Submission may have been accepted | Preserve Message-ID, inspect Sent/logs, never retry automatically |

Always inspect smtpAccepted, accepted, rejected, messageId, sentFolderSaved,
retrySafe and nextAction together. Accepted means SMTP acceptance, not inbox
placement, reading or end-recipient delivery. If some recipients were rejected,
report that explicitly. A later send limited to rejected recipients is a separate
decision after resolving the cause and confirming that it remains within intent.

verifySentMessage scans at most ten pages. found_in_sent proves an IMAP copy,
not recipient delivery. indeterminate means a continuation remains: call
searchMessages with the same messageId, returned sentFolder as folder, the
returned nextCursor as cursor and the same page limit (the original count).
Keep scanning empty pages with continuation. not_found_in_sent, even after a
complete search, is not proof of non-delivery and does not authorize a resend.

## Draft creation, updates and cleanup

IMAP creation returns saved or append_outcome_unknown, always retrySafe=false.
Definite APPEND rejection and pre-APPEND failures raise errors. If saving succeeded
but tracking failed, draftId/locator can be absent: retain Message-ID and find the
existing draft. An uncertain result is not permission to create a replacement.

IMAP updates verify a replacement before moving the unchanged old revision to
Trash. Pending cleanup or conflicting revisions require inspection of both copies;
do not delete one merely because it looks older. After archive-confirmed send,
the unchanged source draft can move to Trash. draftCleanup can be retained,
moved_to_trash or retained_cleanup_failed. Cleanup failure does not undo SMTP.

Local draft-state records prevent repeating recorded send attempts for that
installation. Preserve ~/.config/mail-mcp/draft-state during a migration; treat
it as operational data, not disposable cache. It does not coordinate independent
sends from other computers or webmail. Do not clear records to force a retry.

Legacy draft-state records without mailbox identity block sending. Preserve them
and follow the README migration using the retained pre-upgrade accounts snapshot;
deleting delivery records to clear an error can duplicate mail. Migration preserves
completed, interrupted and uncertain send claims.

Zimbra partial draft updates preserve omitted content and attachments and use
server modification guards. Its send/schedule journal is stored separately at
`~/.config/mail-mcp/zimbra-send-state`; preserve it across migrations and never
clear uncertain attempts to force another send. Microsoft may return
an intermediate draftId during a failed upload/send; operation=createDraft and
deliveryAttempted=false means delivery was not attempted, but duplicate draft
creation is still unsafe without inspection. Apple/Mailtrap have separate native
outcomes; never apply an IMAP draftId to them.

## Partial reads and organization

Cursor expiry/restart: begin a fresh bounded read with the same intended filters,
deduplicate by stable identity, and disclose that the mailbox may have changed.
Stale locator/UIDVALIDITY or missing/ambiguous draft: rediscover and select the
current target; never patch a locator or guess by subject.

For batchMessages inspect processed, succeeded, failed and items. Verify the new
state of failed/uncertain targets before retrying only justified failures; do not
repeat successes. Timeouts during move/copy/tag/delete can mean the write happened.
Verify destination/current state rather than blindly repeating. Permanent deletion
and mailbox deletion need the user's intended irreversible scope, not a generic
request to tidy mail. Do not broaden permissions after an access-denied error.

## Scheduling

Zimbra has [native scheduling](zimbra-scheduling.md), with mutable server drafts,
durable local claims and explicit cancellation limits. It does not depend on a
local scheduler. Do not apply the IMAP host-scheduler instructions below to it.

The MCP has no generic IMAP scheduled-send operation. A local scheduler belongs to
the host/client and must actually exist and be configured when the user requests it.
Record accountId, stable draftId, timezone, exact time, scheduler job ID and intent
to send the then-current server draft. Do not freeze a copied body unless requested.
Verify the created job and cancel it if the user reports sending or scheduling the
same draft in webmail. Webmail schedules are not automatically discovered.
Do not schedule on two devices. Do not promise execution while the required host,
session or credentials are unavailable. Report a scheduled job separately from
an executed send. Mailtrap campaign scheduling is a different provider operation.

## Failures and reporting

auth_required/CREDENTIALS_MISSING: identify the actual host, account and Windows
user/session. Discovery success does not prove keychain access. A failure through
SSH does not prove failure in the business desktop session. Use approved local
reauthentication; do not transfer secrets or change ACLs as a workaround.

Rate limits: use an explicit retry delay if supplied, bound read retries, and stop
on repeated unchanged failures. Retry a mutation only after determining it was
not applied; retrySafe is technical evidence, not expanded user authorization.
Unknown outcomes require reconciliation even after a process restart.

Report completed and unverified parts separately. Preserve useful non-secret
message/request/draft IDs; do not paste entire private messages, tokens, raw errors
or binary contents into diagnostic reports.
