<!-- RX Group ownership: Created by RxGroup on 02.08.2026. Copyright (c) 2026 RX Group. All rights reserved. -->
# Operations, diagnostics, and rollback

## Safe validation

The following sequence performs no IMAP or SMTP operation:

```powershell
npm ci
npm test
npm run build
npm run smoke:stdio
npm run smoke:http
node --check dist/index.js
```

`smoke:stdio` starts a fresh server, completes MCP `initialize` and `tools/list`, checks for `send_email` and `verify_sent_message`, closes stdin, and requires a clean process exit. Pass the installed entrypoint and runtime arguments to test the exact Codex command:

```powershell
node scripts/smoke-stdio.mjs C:\path\to\mail-mcp\dist\index.js --confirm --audit-log --redact
```

Do not run `--validate-accounts` in a network-isolated or read-only audit. It opens IMAP and SMTP connections, though it does not send mail. Integration tests require explicit test accounts and are not part of the default suite.

## Diagnosing `Transport closed`

1. Confirm the MCP client command, arguments, and working directory point to the intended build.
2. Run `node --check` on the configured entrypoint.
3. Run the exact-command stdio smoke above twice. A failure before `initialize` is startup/configuration; a failure after stdin closes is lifecycle cleanup.
4. Inspect stderr for startup errors. MCP protocol output must remain on stdout; diagnostics belong on stderr.
5. Check audit JSONL for the tool name, account ID, duration, and error. Do not publish account files, credentials, tokens, or unredacted message content.
6. For an uncertain send, use `messageId` with `verify_sent_message`. Do not infer delivery from a generic transport error and do not resend automatically.

## Deployment to Codex

Build in the source repository, validate it, then deploy the complete package atomically: `dist`, `package.json`, `package-lock.json`, and runtime dependencies must belong to the same revision. Keep Codex configuration on a stable install path rather than a temporary worktree. After deployment, run the exact configured command through `smoke:stdio` before restarting Codex.

For a shared HTTP deployment, bind only to `127.0.0.1`, put the bearer token in the named environment variable rather than `config.toml`, and configure Codex with `url` plus `bearer_token_env_var`. Verify `/health`, then complete an authenticated MCP `initialize` and `tools/list` with `smoke:http`. The service should be started once per Windows user session; Codex tasks must not spawn their own copies.

## Rollback

1. Preserve the previous installed directory or archive before replacing it.
2. Restore the previous complete package directory; do not mix old `node_modules` with a new lockfile.
3. Restore the previous MCP `command`, `args`, and `cwd`, or the previous HTTP `url` and token environment variable, if they changed.
4. Run `node --check`, `--version`, `--help`, and exact-command `smoke:stdio` against the restored path.
5. Restart Codex only after the rollback smoke passes.

Rollback changes local code and MCP configuration only. It must not modify mailbox data or attempt a compensating email send.
