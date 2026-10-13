# Changelog

## 3.3.0 - 2026-10-14

- Send the trusted-device SOAP userAgent element, permit explicit local login to
  replace unusable prior state, and bound journal directory synchronization to a
  preexisting durable root instead of requiring access to unrelated ancestors.
- Fix Zimbra current-time filter attributes and replacing a rule before itself.
- Flush POSIX send-journal directory entries before dispatch and after replacement;
  document the Windows OS-crash/power-loss durability boundary.
- Verify Zimbra credential deletion before removing account configuration, clear
  legacy saved-password fallbacks on login/disable, and correct capability guidance.
- Add explicit local Zimbra trusted-device registration/reuse and optional
  OS-protected password storage for on-demand automatic login after session expiry.
- Serialize login attempts across local processes, persist failure/crash blocking,
  keep local status inspection free of authentication, and never replay mail writes.
- Add a local command to disable automatic login, retain legacy session support,
  and document trust expiry, server policy, crash recovery and downgrade boundaries.

## 3.2.0 - 2026-10-13

- Expand Zimbra user-mailbox integration with MIME uploads, reply/reply-all/forward,
  partial draft edits, immutable send snapshots, durable attempt recovery and
  native scheduled-delivery management.
- Add contacts/groups/GAL, identities/signatures/preferences/out-of-office,
  incoming/outgoing filters, sharing/mountpoints and Briefcase revision workflows.
- Add calendars/tasks, recurrence/exceptions, free/busy/working hours, invitation
  responses/forwarding/counter proposals, reminders and ICS import/export.
- Enforce recipient restrictions across supported side effects; refuse native
  paths whose mutable or server-derived recipients cannot be checked reliably.
- Document exact operation contracts, concurrency/partial-result limitations and
  disposable-account acceptance. Mock/source qualification does not claim live
  corporate compatibility, outbound delivery or deployment.

## 3.1.0 - 2026-10-13

### Agent workflow and documentation

- Publish the portable mail-mcp skill inside this repository and release package, with seven references covering IMAP/SMTP, Zimbra, Apple Mail, Microsoft, Mailtrap, outcomes/recovery and production acceptance.
- Document all 102 distinct public operation selectors, including backend-specific input shapes, partial results, reply drafts, attachment preservation and uncertain send outcomes.
- Generate the runtime `mail://agent-guide` resource and `mail_agent_workflow` prompt from the portable skill. Build fails if the generated guide is stale.
- Document exact HTML/MIME editing, native Zimbra draft replacement limits, technical confirmation, partial SMTP acceptance and scheduling boundaries.

### Skill installation

- Include all referenced Markdown files in new Codex and Claude Code skill installations and packaged builds.
- Preserve existing custom skills and junctions by default. Explicit replacement backs up affected files; rollback preserves later user edits.
- Add operation/status coverage, example/link checks and reference installation/rollback tests.

### Project identity

- Maintain releases as `@starychenko/mail-mcp` with stable version numbers, starting at v3.1.0.
- Credit the originating 1amSheldon/mail-mcp project and original contributors. Preserve the MIT license, Git history and GitHub fork relationship with its existing pull requests.
- Keep upstream npm auto-update disabled and existing credential-store identifiers unchanged. This release does not migrate accounts or alter mail protocol behavior.

### Verification boundary

The release is qualified through automated unit/integration tests, transport/import/installed-command smoke checks and package inspection. Live mailbox/provider credentials, real outbound delivery and deployment to individual workstations require separate environment-specific verification. External IMAP integration tests are skipped when their fixture is not configured; documentation readiness is not a claim of live delivery certification.
