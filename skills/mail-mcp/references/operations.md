# Operations and production acceptance

This is an operational reference, not permission to reconfigure a running service.
This project is distributed as a reviewed local build or GitHub release package;
the upstream npm package is a separate distribution. Updating a skill does not update MCP code or an
already running process. Package version alone is insufficient: record the commit,
entrypoint, transport, host and execution user when diagnosing a deployment.

## Installation boundaries

From the intended checkout: npm ci, npm run build, node dist/index.js --version.
Use a Node version supported by package.json and the installed tooling. Keep the
checkout at a stable path. Accounts are defined in ~/.config/mail-mcp/accounts.json;
secrets live in the operating-system credential store, not MCP client config.

--install-codex defaults to a shared authenticated local HTTP service on Windows;
--install-codex-stdio selects stdio. macOS/Linux default to stdio. Claude Code and
Claude Desktop have their own installers. Preserve existing config and unrelated
MCPs. Do not register a second server just because a configured name differs from
mail. Auto-update from upstream is disabled; updates are reviewed local builds.

The installer preserves existing/linked skills by default. A skill managed through
a junction must be updated in its source repository; never replace the link with
a second copy. New bundled installs include the referenced Markdown files. An old
chat may retain old schemas; verify the actual runtime before prescribing a restart.
Managed HTTP recovers stale MCP sessions after service restart, but in-memory cursors
and confirmation tokens are not durable. Fresh discovery may be necessary.

## Diagnose in order

1. Identify the user's intended server/account. Read list_accounts and available
   operations; inspect mail://agent-guide for that process.
2. For a permitted read, discover folders/resources and run a bounded search/read.
   Record the account/backend and actual session. Do not infer access from metadata.
3. Distinguish unavailable operation, unsupported backend, read-only/allowlist,
   expired session, credential-store access, network and provider rejection.
4. For writes, first establish authorization and current object identity. Follow
   the backend and outcome references; never bypass a server gate.
5. After a relevant authorized repair, repeat the original failing scenario in
   the same environment. Passing local tests is not proof of remote operation.

Raw MIME/binary downloads are not sanitized by text redaction. Path attachments
refer to the server host; path attachments require configured roots for IMAP and Apple.
Global Apple rules can span accounts. OAuth provisioning, suppression deletion,
campaign scheduling and account credential changes need their own intended scope.

## Acceptance evidence

For documentation changes, run generation/drift checks, link and contract tests,
skill validation, build and relevant packaging/installer tests. Install into an
isolated temporary home and verify that every referenced file is present. Check
that existing and linked skills survive and rollback does not erase user files.

For a production deployment, separately verify the real host and account:

| Area | Observable evidence |
| --- | --- |
| Runtime | Intended commit/entrypoint and transport; tools and guide from that process |
| Read | Folder/resource discovery, bounded search, full message read, partial-result handling |
| Draft | Authorized test draft saved, read back, correct recipients/headers/body/attachments |
| Update | Approved changes survive readback; omitted IMAP/Zimbra fields and attachments preserved; stale Zimbra revisions rejected |
| Send | Only with explicit send authorization and intended recipient; inspect acceptance, rejection and archive evidence |
| Recovery | Use isolated fixtures for timeout/duplicate/conflict scenarios, not destructive experiments in production |
| Cleanup | Only authorized test artifacts removed; draft state, existing mail and unrelated config preserved |

If writes or a provider are not tested, say so. Documentation readiness and
mock/fixture tests do not certify live delivery, credentials, provider policy or
all-device installation. Do not label the entire MCP production-validated from
a successful build or read-only smoke test.

## Maintaining these instructions

The bundled SKILL.md and references are the portable source. Runtime guide text is
generated from them; do not hand-edit the generated module. Update the corresponding
backend reference when its public routing/validation/result contract changes, then
regenerate and run contract tests. Keep corporate procedures and dated deployment
history in the shared work-skills repository, never in the public package.
