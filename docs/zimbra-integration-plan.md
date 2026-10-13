# Zimbra integration delivery

Baseline: 3.1.0, a752fe4. Target: a complete user-mailbox integration, not the
administrator API. No deployment or changes to corporate mail are part of this PR.

## Acceptance matrix

- [x] Mail: local/base64 uploads, MIME originals, attachment extraction, inline
  images, reply/reply-all/forward drafts, signatures, identities and Reply-To.
- [ ] Draft integrity: partial updates preserve omitted content and attachments;
  concurrency conflicts are explicit; send recovery survives process restart;
  recipient restrictions cannot be bypassed by webmail races or scheduling.
- [x] Organization: folders, copy, flags, spam, deletion/recovery, tags, counts.
- [x] Contacts: create/update/delete, groups, GAL lookup and autocomplete.
- [x] Rules: read and safely replace incoming/outgoing rules, activation, preserve
  unsupported server rule constructs, recipient policy for forwarding actions.
- [x] Preferences: read/update supported user settings, signatures, identities,
  out-of-office, supported server capability discovery.
- [ ] Collaboration: sharing and mountpoints, calendars, invitations, recurrence,
  free/busy, tasks, reminders and native scheduled sending.
- [x] Briefcase: folders, document upload/download, revisions and document actions.
- [ ] Operations: authentication lifetime, remote session checks, bounded paging,
  explicit partial results, consistent errors and no automatic uncertain writes.
- [ ] Skills: exact discoverable input contracts, realistic end-to-end workflows,
  verification, recovery, side effects and version-dependent limitations.
- [ ] Qualification: focused tests, full release gates, review agents, fixes, PR.

## Sources and verification

Use Zimbra's maintained `zm-mailbox` SOAP, calendar, document, REST and upload
contracts, plus request DTOs when prose is ambiguous. Pin source revisions in the
final documentation. Mock transport tests establish payload/error behavior; they
do not establish compatibility with the corporate server. Record unverified live
flows explicitly and provide an opt-in disposable-account acceptance procedure.

Protocol reference revision: Zimbra/zm-mailbox
`bb771f67c53ab99a202ef0a70e1768f2fa05209b` (develop, inspected 2026-10-13).
GetMsg's `MsgSpec.wantModSeq` must be requested to obtain the `ms` used by safe
draft updates. See `store/src/java/com/zimbra/cs/service/mail/GetMsg.java` and
`soap/src/java/com/zimbra/soap/mail/type/MsgSpec.java` at that revision.

## Completed increments

- c1c18bd: typed folder/contact/signature operations and schema-derived routing.
- c574244: MIME uploads, raw reads and conflict-guarded partial draft updates.
- a7ea7b6: request server modification sequences for guarded edits.
- ff633c3: immutable send snapshots, exact recipient checks, durable attempt
  claims, restart/concurrency tests and Sent-copy verification.
- 4b6d5af: reply/reply-all/forward drafts, native identities and
  signatures, both body formats, attachment text extraction, stats and copy.

- 0fe06f2: contact groups, GAL paging, autocomplete, identities, native
  preferences and out-of-office with recipient-policy enforcement.
- 3d9b4cb: revisioned incoming/outgoing filter reads, typed nested
  conditions/actions, targeted/list replacement retaining unknown constructs,
  bounded apply, forwarding policy and actual read-back. Server lacks atomic CAS;
  this limitation is explicit in results and skill guidance.
- ddbb15c: folder ACLs, native share discovery/notification, mountpoints and
  reminders. Internal grants require directory IDs to prevent guest fallback.
- Current increment: Briefcase uploads, attachment/text sources, metadata,
  downloads, revision windows/diffs/restoration, document actions and file ACLs.
  Calendars/tasks and scheduled mail are still pending.

Qualification so far: TypeScript passes; all 1,215 unit tests pass on Node 24,
including actual MIME/PDF parsing and mock-transport workflows. Live corporate
writes remain untested.
The complete acceptance matrix above is still pending; do not treat these
increments as release qualification.

## Delivery sequence

1. Typed native operations and mailbox organization/contact foundations.
2. MIME uploads, safe composing/updating, send journal and reconciliation.
3. Rules, settings and collaboration APIs.
4. Portable skill workflows and comprehensive regression qualification.
5. Push PR, independent code and workflow reviews, resolve actionable findings.

This checklist records remaining scope. An intermediate commit does not constitute
completion of the integration.
