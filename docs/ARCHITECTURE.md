<!-- RX Group ownership: Created by RxGroup on 02.08.2026. Copyright (c) 2026 RX Group. All rights reserved. -->
# Architecture and delivery contract

## Runtime boundaries

`src/index.ts` owns MCP schemas, authorization gates, confirmation, rate limits, audit logging, and dispatch. `src/services/mail.ts` owns mail workflows. `src/protocol/smtp.ts` and `src/protocol/imap.ts` own protocol lifecycle and protocol-specific results.

There is one production `tools/call` path. The MCP request handler only tracks in-flight work and delegates to `dispatchTool`. Tests call the same dispatcher used by stdio.

## Send sequence

1. Resolve and connect the account's IMAP service. This setup may retry once because SMTP has not started.
2. Validate recipients, allowlists, confirmation, and rate limits.
3. Compile one canonical MIME message. Its `Message-ID` and bytes are retained.
4. Submit those exact bytes through SMTP once.
5. If SMTP returns acceptance, append the same bytes to the configured or IMAP special-use Sent folder.
6. Return a structured result. The server never retries `sendMail` after an error or an uncertain outcome.

## Delivery states

| Status | Meaning | Safe agent behavior |
|---|---|---|
| `sent_and_saved` | SMTP accepted all recipients and IMAP confirmed the Sent append | Do not resend |
| `partially_sent_and_saved` | SMTP accepted some recipients, rejected others, and IMAP confirmed the Sent append | Do not resend accepted recipients; inspect `rejected` |
| `smtp_accepted_sent_not_confirmed` | SMTP accepted recipients, but IMAP append failed | Do not retry SMTP; verify by `messageId` |
| `smtp_partially_accepted_sent_not_confirmed` | Partial SMTP acceptance and no confirmed Sent copy | Do not retry SMTP; inspect accepted/rejected and verify |
| `smtp_rejected` | SMTP returned no accepted recipients and at least one rejected recipient | Correct the cause before a new user-requested send |
| `smtp_connection_failed` | SMTP verification failed before `sendMail` | No message was attempted; repair connection first |
| `smtp_outcome_unknown` | `sendMail` failed after a MIME message was prepared; server acceptance is unknown | Never retry automatically; verify first |

Every result includes `smtpAccepted`, `accepted`, `rejected`, `sentFolderSaved`, `retrySafe`, and `nextAction`. `messageId`, `sentFolder`, and `sentFolderUid` are included when known.

## Verification limits

`verify_sent_message` is read-only and searches the resolved Sent folder by exact `Message-ID`. A match confirms an IMAP Sent copy. No match does not prove non-delivery: SMTP may have accepted the message while IMAP append failed. Verification never sends or retries.

## Concurrency and lifecycle

Account creation and SMTP connection use single-flight promises. A stale IMAP close callback can only remove the exact cached service that emitted it. SMTP send failures reset the transport for a later, distinct user request but never retry the failed send. Shutdown drains active MCP calls, disconnects mail services, and closes the MCP SDK server.
