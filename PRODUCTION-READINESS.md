# Production hardening qualification

Audit baseline: `82fd21c2792430ab4acc59d098b9a510e6edb3c8` (`3.0.1-fork.1`).
Qualification date: 2026-10-13. This document records code-level hardening and
the boundary of its verification. It is not a claim that every provider has
been exercised against a live production mailbox.

## Audit closure map

Each F-number has a separate implementation commit whose subject contains it.

| Finding | Change | Regression evidence |
| --- | --- | --- |
| F01 | Reject non-string MIME bodies; disable Nodemailer file/URL sources | Router and real MIME composer tests |
| F02 | Require STARTTLS when implicit IMAP TLS is disabled | Local TCP server refuses STARTTLS; no authentication sent |
| F03 | Recheck UIDVALIDITY after acquiring mutation/body locks | Race fixtures for located operations and raw reads |
| F04 | Revalidate account configuration before cached-client reuse and after connection | Removed accounts and tightened policies |
| F05 | Fetch and decode at most 4 KiB for previews | Base64, quoted-printable and multipart preview fixtures |
| F06 | Bound MIME reads, download only the selected attachment, cap cached payloads | Stream byte limit, huge neighboring part, cache expiry/eviction |
| F07 | Clear pending draft state after a definite APPEND rejection | Rejected-then-successful update; ambiguous result remains blocked |
| F08 | Separate MIME preflight failure from uncertain SMTP delivery | Zero SMTP sends for composition failure; post-DATA uncertainty retained |
| F09 | Recheck OAuth token on SMTP connections and force renewal when rejected | Token provider renewal, expiry and concurrent refresh tests |
| F10 | Preserve array-valued References in replies | Actual mailparser output with a three-message chain |
| F11 | Escape quoted text and headers in HTML forwards | Markup and address escaping with authored HTML retained |
| F12 | Keep Gmail thread lookup on the numeric thread strategy across folders | Three folders and forty RFC references cause three Gmail searches |
| F13 | Return structured save outcome from the legacy createDraft wrapper | Confirmed save and uncertain APPEND results |
| F14 | Return full Microsoft message bodies and metadata; parse EWS XML structurally | HTML, CDATA, default namespace, numeric entities and DTD rejection |
| F15 | Remove invalid Graph filter/orderby combination; sort gathered pages | Complete and partial conversation results sorted across pages |
| F16 | Follow bounded Graph Message-ID pages; expose EWS continuation/incompleteness | Multiple pages, loops, remote errors and foreign next links |
| F17 | Expose uncertain Mailtrap sends with retrySafe=false | Timeout, transport failure, 5xx, invalid JSON and byte limits |
| F18 | Require configured permission for application-global Apple Mail rules | Default denial before adapter creation; explicit global result scope |
| F19 | Respect TOML multiline strings and verify unrelated settings are unchanged | Both multiline quote forms, comments, escaped keys, BOM and CRLF |
| F20 | Suppress secret echo and terminal history | Real readline with simulated TTY input, Up arrow and cancellation |
| F21 | Reserve recovered-request capacity before awaiting body bytes | Two competing requests rejected while one slow body occupies the slot |
| F22 | Parse ManageSieve quoted/literal strings by bytes | Escaped names, UTF-8 byte fragmentation, ACTIVE flags and quoted content |
| F23 | Reject backslash HTTP targets before URL normalization | Raw HTTP request targets for health and MCP routes |

Additional confirmed risks were corrected in separate commits: OAuth bundles
cannot be used as ManageSieve PLAIN passwords; Microsoft response streams are
bounded; AppleScript stderr and failed input pipes are bounded/terminated;
native send failures preserve delivery uncertainty; EWS attachments use
SaveOnly followed by SendItem; HTTP initialization/replacement capacity is
reserved atomically; token responses are bounded and errors omit returned
secrets; Microsoft requests reject redirects and treat send-side 5xx as unknown.

## Compatibility and operational changes

- Plaintext IMAP is no longer accepted. `useTLS: false` requires server STARTTLS.
- Preview text comes from the initial 4 KiB of BODY[TEXT]; a message whose text
  occurs later may have an empty or partial preview. Use full reading when needed.
- Parsed full-message reads are limited to 32 MiB. Raw reads have an explicit
  bound of at most 50 MiB. Attachment downloads enforce the requested decoded
  byte limit while streaming and use bounded MIME fallback for unusual parts.
- Parsed body caches hold at most 100 entries and approximately 64 MiB of
  accounted payload per account, expiring after five minutes. This is a payload
  budget, not an exact measurement of V8 heap consumption.
- Microsoft JSON/XML response bodies are limited to 4 MiB; OAuth token responses
  to 64 KiB. Oversized responses fail explicitly instead of returning truncation.
- Microsoft search and Message-ID lookup now return `{ messages, partial }`,
  replacing bare arrays. EWS callers continue using the returned `nextOffset`
  as `offset` with unchanged filters. The mailbox remains live during paging.
- Microsoft `getMessage` returns full bodies and address/attachment metadata.
  Message bodies remain untrusted mail content; clients must not execute HTML.
- Apple Mail rules are application-global. `allowGlobalRules` defaults to false;
  enabling it explicitly grants rule access across all native Mail.app accounts.
  The configured account is only the access context and mailbox destination.
- `smtp_preflight_failed` means no SMTP message transaction began. Correct the
  message before retrying. Unknown send outcomes across providers explicitly
  prohibit automatic retries and require inspecting Sent/Outbox/provider logs.
- EWS attachment sends first save a draft, then send its exact ItemId/ChangeKey.
  The draft ID remains available when SendItem fails. A saved draft can remain
  after a later failure; it is not automatically deleted or resent.
- EWS and Graph draft creation can also have an uncertain result. These errors
  report `operation: createDraft`, `deliveryAttempted: false` and `retrySafe: false`.
  Inspect Drafts before creating another copy; delivery has not started.
- EWS honors `saveToSentItems: false` for both direct and attachment sends.
- Apple Mail compose/draft operations require the chosen From address to belong
  to the selected native account. An empty alias list fails before message creation.
- Draft journals now bind to the mailbox host, port and user. Replacing the
  mailbox while reusing an account ID fails closed. Policy-only changes preserve
  delivery deduplication. Existing nonempty journals without this binding require
  the explicit migration described below; they are not silently reset.
- `--redact` is selective text masking, not universal data-loss prevention.
  Raw RFC 822 bytes and binary attachments are returned byte-for-byte and are
  not sanitized, including when base64-encoded. Do not request raw/binary content
  when the client is not authorized to receive its original contents.

### Existing draft journal migration

The previous journal format recorded only the configured account ID, which
cannot establish which mailbox originally owned its UIDs. Automatic migration
would recreate the ambiguity this change fixes.

1. Stop every mail-mcp process using the account. Back up `accounts.json` and its
   neighboring `draft-state` directory, retaining their access restrictions.
2. Establish the original mailbox from the previous configuration. If host,
   port or user changed, use a new configured account ID for the replacement
   mailbox and retain the original journal with the original mailbox. Do not
   reuse old draft IDs or locators in the replacement account.
3. For an unchanged mailbox, inspect pending replacement and delivery-attempt
   records with the corresponding Drafts/Sent data before binding the journal.
   An interrupted or uncertain send must remain non-retryable.
4. A qualified operator can add the top-level `accountIdentity` field only after
   confirming that mapping. Its value is the lowercase hex SHA-256 of UTF-8
   `JSON.stringify({ backend: 'imap', host: account.host.toLowerCase(), port: account.port, user: account.user })`
   in that property order. Preserve every record, alias, Message-ID, pending
   operation and attempt result. Save atomically while the service is stopped.
5. Reopen the journal and verify that only this binding was added before restart.
   Do not delete the journal, erase attempts, or create a new account ID for the
   same mailbox to bypass delivery deduplication. If ownership cannot be proven,
   keep the journal blocked until it can be reconciled.

## Previous merged PR comments

All seven review threads on [PR #1](https://github.com/starychenko/mail-mcp/pull/1)
were inspected. Four early comments were already addressed in the audit baseline.
The three remaining issues are now covered by F12, F13 and F23:

- [Gmail cross-folder expansion](https://github.com/starychenko/mail-mcp/pull/1#discussion_r4259292912)
- [Legacy draft result](https://github.com/starychenko/mail-mcp/pull/1#discussion_r4259292900)
- [Backslash request target](https://github.com/starychenko/mail-mcp/pull/1#discussion_r4259292890)

Review-thread state in GitHub is separate from code status; old comments were
not silently marked resolved.

## Automated qualification

The complete `npm run release:check` passed on Windows with Node 24 after the
independent review fixes: build, English-only check, 1018 unit tests in 66 files,
8 integration tests, stdio/HTTP/import/installed-package smoke checks, and
`npm audit` with zero reported vulnerabilities. Three environment-dependent
IMAP integration cases were skipped because no live test mailbox was supplied.
The PR also runs the release checks on Linux and Windows with Node 20 and 22.
Check the PR status for the result associated with its current commit.

Three independent agents reviewed protocol/security, providers, and
mail/draft/install workflows. Their seven actionable findings were fixed in
separate commits and re-reviewed: SMTP connection lifecycle, OAuth error
redaction, EWS query order and Sent-copy preference, CDATA handling, Apple sender
scope, and persisted draft identity. A real TCP reproduction also exposed that
Nodemailer's non-pooled `close()` does not close its verification socket; the
follow-up fix owns and destroys those sockets. No actionable findings remained
open in these review scopes after re-review.

Committed regressions verify that disconnected SMTP verification cannot send
credentials and that real SMTP OAuth rejection triggers renewal before a single
delivery. Independent local TLS fixtures additionally passed implicit TLS,
STARTTLS, hostname-mismatch rejection in both modes, and disconnect during TLS
authentication. These checks used disposable local servers and fixture tokens.

Hosted Code Review additionally identified uncertain EWS SaveOnly creation;
that finding and the equivalent Graph draft-creation paths were corrected and
independently re-reviewed. Five failure modes per provider verify that no send
follows an ambiguous save.

The hosted security claim that an implicit-TLS custom socket sends plaintext
AUTH was not reproduced with the locked Nodemailer 10.0.9 dependency. Its
SMTPConnection upgrades a supplied connection when secure is true and secured
is false. The committed real-TCP regression sends a malicious plaintext SMTP
greeting, observes a TLS ClientHello as the first client bytes, and verifies
there is no SMTP EHLO/AUTH or credential content. This is evidence for the
locked dependency; the regression must keep passing after dependency updates.
Four independent plaintext-peer cases also passed for password and OAuth2
authentication, with greetings before and after the first client packet. None
received SMTP commands or invoked the OAuth token callback.

Linux CI also exposed a warm npx-cache permission failure after rebuilding a
local file package. Build now restores executable mode on the compiled entrypoint;
installed-command smoke checks this before npm can repair a cold-cache install.

The tests establish bounded fetch requests, stream cancellation, cache behavior,
protocol safety and failure semantics. They do not establish provider latency,
production throughput, or an absolute process RSS ceiling under every workload.

## Live acceptance still required for deployment

Use dedicated test accounts and explicitly approved recipients. No live email
was sent, no real mailbox was modified and no deployment was performed during
this qualification.

| Environment | Acceptance checks |
| --- | --- |
| IMAP/SMTP | Trusted TLS/STARTTLS, reconnect after sleep, mailbox generation changes, large MIME, selected attachments, provider Sent-copy behavior |
| OAuth SMTP | Token expiry, forced refresh and revoked refresh token against the actual provider |
| Microsoft Graph | Tenant permissions for message body access, multi-page lookups, send/reply and large attachment upload against the chosen tenant |
| Exchange EWS | Server version support, full message shapes, offset paging, SaveOnly/SendItem attachments and failures after draft creation |
| Mailtrap | Sandbox send/log reconciliation, token scopes, timeout/5xx behavior and campaign-specific semantics |
| Apple Mail | macOS Automation permission, native account binding, reply/forward/draft behavior and explicitly enabled global rules |
| Long-running host | Expected account count and concurrency, sleep/restart recovery, memory and latency measurements using representative mailbox data |

Follow the [Graph paging rules](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
and [EWS attachment workflow](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-add-attachments-by-using-ews-in-exchange)
when comparing live behavior to the fixtures.
