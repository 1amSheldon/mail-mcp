# Zimbra native scheduled delivery

| Operation | Input | Result/boundary |
| --- | --- | --- |
| `zimbra.getScheduledDraft` | `draftId` | Live draft schedule metadata, current `revision` and any durable local attempt. Not a scheduler-queue or delivery check. |
| `zimbra.scheduleDraft` | `draftId`, `expectedRevision`, `sendAt` | Saves exact current MIME with native autoSendTime and reads metadata back. Unrestricted accounts only; at least one minute in the future. |
| `zimbra.cancelScheduledDraft` | `draftId`, `expectedRevision` | Preserves MIME, clears autoSendTime and reads it back. Cannot recall a worker that already started sending. |

`expectedRevision` is the `ms` returned by `readMessage` or `revision` from
`getScheduledDraft`. `sendAt` is an ISO timestamp with an explicit UTC offset.
The client checks the revision before and after downloading the MIME and sends
a server modification guard with SaveDraft. Both operations preserve the raw
message, including attachments, Bcc, original-message linkage and identity.

## Workflow

1. Create or inspect a draft, including all recipients, content and attachments.
2. Read its current `ms` and ensure it has no existing native schedule.
3. Schedule it with the reviewed revision and explicit send time.
4. Use `getScheduledDraft` to inspect metadata, then `verifySentMessage` with
   the draft's RFC Message-ID after the due time. A Sent copy is not recipient
   delivery confirmation; an absent draft is not proof of delivery.
5. To cancel, read the current revision and call `cancelScheduledDraft`, then
   inspect both the draft and Sent. Cancellation near execution may be too late.

Native Zimbra scheduling stores a mutable draft. The worker reads its MIME when
it runs, sends it, then deletes the draft. Webmail edits can change recipients
and content after scheduling. Therefore any configured `allowedRecipients`
policy blocks native scheduling; it cannot be enforced by a disconnected local
MCP when the server worker runs. Canceling an existing schedule remains allowed
under that policy. Ordinary `updateDraft` refuses scheduled drafts because
SaveDraft without autoSendTime would silently cancel their schedule.

The schedule and immediate-send paths share one durable exclusive claim per
draft. Concurrent calls or a process restart cannot initiate both through the
same local journal. `schedule_saved` means the SaveDraft response and metadata
read-back succeeded, not that a scheduler task was independently verified.
`schedule_cleared` means zero/absent schedule metadata was observed after the
write, not that a previously started send was stopped. A server error, timeout
or failed read-back leaves `outcome_unknown`; do not automatically retry.

POSIX journal entries are directory-synced. On Windows, file contents are flushed
but Node cannot fsync directories, so OS-crash/power-loss persistence is not
guaranteed. After such an event, inspect the server draft and Sent even if the
local journal has no claim; do not infer that scheduling or sending never started.

The claim is retained after cancellation or failure. Repeated scheduling or
manual sending returns the historical claim instead of starting a new send.
For a separately authorized new send or revised schedule, first reconcile the
old attempt, then create and review a new draft with a new ID. Do not delete
journal files to bypass uncertainty. Claims only coordinate clients using the
same local journal; other computers and webmail remain independent.

`no_schedule_metadata` is an observation, not proof of non-delivery. A missing
or non-draft item returns a read error; inspect Sent and the durable attempt
instead of assuming it was canceled. No schedule operation automatically retries
a server write, sends immediately, or creates a local background scheduler.

Protocol evidence: Zimbra/zm-mailbox revision
`bb771f67c53ab99a202ef0a70e1768f2fa05209b`, user SOAP SaveDraft and
`store/src/java/com/zimbra/cs/mailbox/AutoSendDraftTask.java`. Mock transport and
concurrency tests validate client behavior; actual server scheduling still
requires a disposable-account acceptance test.
