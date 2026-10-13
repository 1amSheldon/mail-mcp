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
- c61d915: Briefcase uploads, attachment/text sources, metadata,
  downloads, revision windows/diffs/restoration, document actions and file ACLs.
- 0736120: calendar/task reads, bounded occurrence/free-busy/working
  hours queries, invitation iCalendar, creation with native recurrence and
  alarms.
- 06ed442: version-guarded calendar/task partial edits, MIME and
  attachment retention, recurrence exceptions, cancellation and replies. Native
  cancellation's non-atomic derived recipients are explicit and blocked for
  recipient-restricted accounts. Scheduled mail remains pending.
- 326db19: appointment search with bounded occurrence expansion and
  window-bound cursors, plus task search retaining undated items. Focused search
  and documentation tests (16) and TypeScript pass. Source inspection confirms
  ImportAppointments can skip bad components while returning the input invite
  count; implementation must expose accepted IDs and incomplete imports rather
  than interpreting that count as successfully imported items.
- 2c7426a: native ICS import reports saved IDs separately from parsed
  component counts and exposes partial/unknown results; blocked under recipient
  restrictions because opaque calendar data can carry email alarms. REST folder
  export preserves native series and optional inline attachments, supports bounded
  selection windows or all-time export, enforces byte limits and rejects invalid
  envelopes. Profile tests (221), TypeScript and English-only checks pass.
  Sources additionally inspected: ImportAppointments, IcsFormatter, Formatter,
  UserServletContext and DateUtil. ForwardCalendarItem sends additional organizer
  notifications and lacks version guards; recipient-restricted forwarding must
  not rely solely on the supplied To list.
- 8f0a1f0: native meeting forwarding with explicit instance selection
  and fail-closed restricted-recipient behavior; attendee counter proposals with
  inspected UID/organizer, explicit dates and native pre-send version checks.
  Focused edit/documentation tests (21) pass. Counter proposals do not alter the
  meeting or copy alarms/attachments. Inbox invitation reply/forward and decline
  of an incoming COUNTER message remain for the next increment.
- d7a2965: guarded inbox invitation participation replies, whole-mail
  forwarding, and organizer rejection of original incoming COUNTER details.
  Native inbox replies can persist alarms or restore calendar items; this is
  explicit in confirmations/skills and blocked under recipient restrictions.
  Source inspection also confirmed CreateTaskException exists; no corresponding
  ForwardTaskInvite/DeclineCounterTask handlers exist in the pinned source, so
  forwarding/counter rejection explicitly require appointment components.
- da6f63a: ordinary draft edits refuse native scheduled drafts rather
  than silently canceling them. Verified in SaveDraft and AutoSendDraftTask:
  SaveDraft defaults autoSendTime to zero, cancels the old task and optionally
  schedules a new one; the worker reads the current draft MIME at execution,
  sends it and deletes the draft. Native scheduling therefore cannot enforce a
  local recipient allowlist against later webmail edits. Implement explicit
  schedule/read/cancel operations for unrestricted accounts, share the durable
  send claim to prevent local manual-send races, preserve raw MIME on changes,
  and report cancellation as observed state rather than proof of non-delivery.
  Scheduling and delivery are distinct: read-back of autoSendTime does not prove
  the scheduler task exists or has delivered anything. No live mailbox writes.
- Current increment: scheduleDraft, getScheduledDraft and cancelScheduledDraft
  preserve raw MIME, use revision guards/read-back and share durable claims with
  immediate sending. Claims survive cancellation and uncertain writes; a new
  authorized send needs a new reviewed draft ID after reconciliation. Restricted
  accounts can cancel but cannot schedule mutable native drafts. Native scheduler
  state/delivery are not implied by draft metadata. All 242 focused Zimbra/router/
  documentation tests pass, including concurrent manual-vs-scheduled attempts.

Qualification so far: TypeScript passes; all 1,236 unit tests pass on Node 24,
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
