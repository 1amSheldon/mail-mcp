# Zimbra integration delivery

Baseline: 3.1.0, a752fe4. Target: a complete user-mailbox integration, not the
administrator API. No deployment or changes to corporate mail are part of this PR.

## Acceptance matrix

- [ ] Mail: local/base64 uploads, MIME originals, attachment extraction, inline
  images, reply/reply-all/forward drafts, signatures, identities and Reply-To.
- [ ] Draft integrity: partial updates preserve omitted content and attachments;
  concurrency conflicts are explicit; send recovery survives process restart;
  recipient restrictions cannot be bypassed by webmail races or scheduling.
- [ ] Organization: folders, copy, flags, spam, deletion/recovery, tags, counts.
- [ ] Contacts: create/update/delete, groups, GAL lookup and autocomplete.
- [ ] Rules: read and safely replace incoming/outgoing rules, activation, preserve
  unsupported server rule constructs, recipient policy for forwarding actions.
- [ ] Preferences: read/update supported user settings, signatures, identities,
  out-of-office, supported server capability discovery.
- [ ] Collaboration: sharing and mountpoints, calendars, invitations, recurrence,
  free/busy, tasks, reminders and native scheduled sending.
- [ ] Briefcase: folders, document upload/download, revisions and document actions.
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

## Delivery sequence

1. Typed native operations and mailbox organization/contact foundations.
2. MIME uploads, safe composing/updating, send journal and reconciliation.
3. Rules, settings and collaboration APIs.
4. Portable skill workflows and comprehensive regression qualification.
5. Push PR, independent code and workflow reviews, resolve actionable findings.

This checklist records remaining scope. An intermediate commit does not constitute
completion of the integration.
