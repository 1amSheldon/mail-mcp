# Changelog

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
