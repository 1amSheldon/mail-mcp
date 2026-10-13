# Zimbra disposable-account acceptance

This is an opt-in procedure, not an instruction to modify a corporate mailbox.
Use a disposable account and consenting test recipients on the actual target
Zimbra version. Record server version/edition, proxy/authentication extensions,
account feature flags, tested commit and timestamps. Authenticate locally; never
record passwords, tokens, OTPs, guest secrets or real customer mail in evidence.

## Preparation

- Build the reviewed commit with a supported Node runtime and run release:check.
- Create a distinct Zimbra test account configuration. Use an isolated journal
  location/profile when running a test harness; preserve attempt records.
- Use disposable folders, contacts, documents and calendar UIDs prefixed with a
  unique run identifier. Keep a record of IDs created by the test, not guessed IDs.
- Prepare consenting internal/external recipients and a second test user for
  sharing, invitations and webmail concurrency. Confirm the exact authorized
  outbound effects before enabling notifications, alarms, rules or scheduling.
- Snapshot existing settings/rules if the account is not empty. Restore only the
  values changed by this test after comparing for concurrent modifications.

## Acceptance matrix

| Workflow | Observable evidence required |
| --- | --- |
| Login/session | Password and required TOTP/backup-code login complete locally; remote session check works; expiry/revocation requires reauthentication without losing unrelated credentials |
| Read/search | Real native IDs, negative conversation IDs where applicable, read status unchanged, multi-page search, expired cursor recovery, explicit partial body/size limits |
| MIME compose | Unicode names, plain and HTML alternatives, Bcc, inline CID image, regular PDF/binary file and allowed local path round-trip in a webmail draft and raw bytes |
| Draft patch | Subject-only edit preserves recipients/body/attachments; explicit body/attachment replacement does what was requested; stale revision fails; signed/encrypted content is not silently rewritten |
| Replies | Reply/reply-all excludes own aliases, honors Reply-To, does not copy Bcc recipients, preserves RFC references; forward includes requested original attachments |
| Immediate send | One authorized message reaches each test recipient; Sent copy verified by RFC Message-ID; restart/repeat does not send again; concurrent webmail edit is retained rather than removed by cleanup |
| Uncertain send | In an isolated proxy/harness, lose the response after dispatch; preserve the journal and reconcile Sent/recipient receipts before any new authorized send |
| Scheduling | Schedule several minutes ahead, read metadata, observe actual delivery after closing MCP; cancel a separate future draft and verify both metadata and lack of receipt after its due time; record that this does not prove cancellation in every near-deadline race |
| Recipient policy | Disallowed To/Cc/Bcc are rejected; native mutable scheduling/opaque imports and unsafe derived-recipient paths are refused; allowed typed operations work |
| Organization | Create/rename/move folders, copy/move messages, flags/tags/spam, Trash and authorized recovery; verify destination IDs/content and actual counts |
| Contacts/GAL | Create/edit/group members/import/tag/delete disposable contacts; GAL paging/autocomplete preserves server partial/unsupported states |
| Settings | Signatures, identities, supported preferences and out-of-office read back; automatic recipients respect policy; restore approved originals |
| Rules | Create/enable/edit/remove test incoming/outgoing rules while retaining unknown existing constructs; read-back digest changes; bounded apply affects only selected test messages |
| Sharing | Grant/revoke test user access, discover shares, mount/unmount; confirm second-user access and revocation; remove local mountpoint without deleting remote content |
| Briefcase | Upload/download byte equality, metadata updates, revisions/diff, historical restore as new revision, move/copy/tags/watch/locks, file ACL access/revocation |
| Calendar/time | Timed UTC, named timezone over a DST boundary and all-day exclusive end display correctly; recurring rules, exclusions and exceptions match expected occurrences |
| Calendar edits | Partial edits preserve native metadata/MIME attachments; stale versions fail; notification intent and exception-reset behavior match the inspected scope |
| Invitations | Create/send, reply via calendar ID and Inbox mail ID, forward occurrence/series, counter proposal and organizer decline; inspect actual recipient mail and calendar state |
| Tasks/alarms | Undated/due tasks, progress/completion/reopening, recurrence, snooze/dismiss; verify display/audio/email alarms only within authorized test scope |
| ICS | Export disposable calendar/task folder, including inline attachments; trial import into another disposable folder; compare UID/recurrence/exceptions/timezone/alarm/content; verify partial-import reporting with a controlled rejected component |
| Errors/limits | Access denied, invalid IDs, oversized responses, expired auth and transport loss are distinguished; no uncertain write is automatically retried |

## Evidence and cleanup

For each row record passed, failed, unsupported by this server, or not tested.
Keep sanitized request operation/IDs, relevant response metadata, byte hashes,
webmail observations and actual recipient receipts where delivery is being tested.
An HTTP/SOAP success, green unit suite or Sent copy alone cannot establish every
row. Features disabled by edition/policy remain explicitly unqualified.

Cancel pending test schedules and email alarms, deactivate test forwarding rules
and out-of-office, revoke test grants, and remove only the recorded disposable
objects after checking they were not reused. Preserve journal records and evidence
for uncertain deliveries. Never clean up unrelated mailbox data. Production
deployment and any corporate live write need separate authorization.
