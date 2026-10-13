# Zimbra user-mailbox integration

The Zimbra backend uses authenticated user SOAP/REST for mail, contacts, rules,
settings, sharing, calendars/tasks, scheduled delivery and Briefcase. These
operations do not require IMAP/SMTP. Keep any IMAP account under a separate ID.
Domain/server administration and arbitrary SOAP pass-through are not exposed.

## Setup and local authentication

Build the checkout, run `node dist/index.js accounts add`, select Zimbra and
supply the mailbox email and an HTTPS endpoint such as
`https://mail.example.com/service/soap`. Admin endpoints are rejected. Run:

```sh
node dist/index.js accounts login ZIMBRA_ACCOUNT_ID
```

Password and any TOTP/backup code are entered in a masked local prompt, never in
chat, MCP arguments or command-line flags. By default only the completed session, expiry,
endpoint and mailbox identity enter the OS credential store. Failed login leaves
the previous session untouched. Each operation loads the current session, so
reauthentication does not require an MCP restart. IMAP app passwords are not
assumed to authenticate SOAP. SAML/SSO, email OTP and 2FA enrollment are not
implemented. Compatibility depends on the server,
authentication extensions and account permissions.

Optional trusted-device login is available through:

```sh
node dist/index.js accounts login ZIMBRA_ACCOUNT_ID --trusted-device
node dist/index.js accounts disable-auto-login ZIMBRA_ACCOUNT_ID
```

The first command asks the server to trust this device after local authentication.
If the server returns usable trust, a separate default-no prompt offers to store
the MAIN password in the OS credential store for automatic reauthentication.
Without that consent, only session and device trust are saved. Codes are never
stored. Native OS keychain/Secret Service is required for this mode; command-line,
file and null storage fallbacks are refused. The second command removes the saved password; revoke server trust in
webmail separately. No administrator is needed when the server already permits
trusted devices. Disabled or unsupported trust is not bypassed.

Automatic login runs on demand when the session expires, under a local process
lock, and persists its attempt before sending credentials. Failure or process
interruption blocks further automatic attempts until local login. A crash-owned
lock requires inspecting its PID, closing mail-mcp processes and removing only
the identified abandoned file. Mail writes are never replayed after dispatch.
See the [portable authentication workflow](../skills/mail-mcp/references/zimbra.md)
for recovery, disabling and verification. Existing session-only records still work;
older MCP versions cannot read the new trusted-login record, so downgrade requires
a fresh session-only login rather than copying credentials.

`zimbra.sessionStatus` checks local availability and saved login mode without
authentication; `{remote:true}` makes an authenticated GetInfo request and can
first perform explicitly enabled automatic login. HTTP 401 and SOAP auth
faults require local login. HTTP 403 normally means access denial; check account
and proxy permissions rather than automatically changing credentials.

Protocol reference: Zimbra/zm-mailbox bb771f67c53ab99a202ef0a70e1768f2fa05209b,
account Auth.java and AuthResponse.java. Auth with an existing authToken returns
its remaining lifetime; trusted-device login still requires the account password.
No live corporate-server trust registration or password storage was performed
during implementation; capability and real renewal require the local login flow
on the intended device. This is distinct from automated fixture qualification.

## Operations and portable skills

Use `mail_query`/`mail_mutate` with `accountId`, a prefixed operation such as
`zimbra.searchMessages`, and its strict `input` object. Discover installed schemas
before guessing parameters. The runtime guide is generated from these references.

| Area | Exact contract |
| --- | --- |
| Mail | [Zimbra mail](../skills/mail-mcp/references/zimbra.md): search, MIME/attachments, folders/flags/tags, copy/move/recovery, reply drafts, identities/signatures, partial edits and durable sends |
| Contacts/settings | [Contacts and settings](../skills/mail-mcp/references/zimbra-contacts-settings.md): contacts/groups/import, GAL/autocomplete, identities, signatures, preferences and out-of-office |
| Filters | [Rules](../skills/mail-mcp/references/zimbra-rules.md): incoming/outgoing filters, typed conditions/actions, preservation, activation and application |
| Sharing | [Sharing](../skills/mail-mcp/references/zimbra-sharing.md): grants/revocation, discovery, mountpoints and notifications |
| Files | [Briefcase](../skills/mail-mcp/references/zimbra-documents.md): upload/download, metadata, revisions/diffs/restoration, actions and grants |
| Collaboration | [Calendars and tasks](../skills/mail-mcp/references/zimbra-calendar.md): search, recurrence/exceptions, free/busy, invitations, reminders/progress and ICS |
| Delayed delivery | [Scheduling](../skills/mail-mcp/references/zimbra-scheduling.md): native scheduling, inspection, cancellation and durable claims |

Use native IDs from the selected account, preserving shared-owner prefixes.
IMAP IDs are not interchangeable; conversation IDs may be negative. Offset search
pages can shift during mailbox changes. Cursors expire after five minutes.
SOAP JSON is capped at 8 MiB. MIME/download limits and partial results are
operation-specific. REST/upload authentication uses cookies, never URL tokens;
redirects are rejected. Binary resources retain their exact bytes.

## Integrity and side effects

Partial draft edits preserve omitted content and attachments and use native
modification guards. Signed/encrypted MIME is refused when reconstruction cannot
be safe. Ordinary editing refuses scheduled drafts rather than canceling them.

Immediate sending validates and uploads an exact MIME snapshot, including Bcc,
and rechecks the source revision. It does not use mutable-draft `did` sending.
A durable exclusive journal prevents repeated local attempts after restart and
arbitrates manual/scheduled sends. Acceptance is saved before guarded cleanup.
Preserve `~/.config/mail-mcp/zimbra-send-state` during migration. Server acceptance
and a Sent copy are not recipient-delivery confirmation.

Native scheduled delivery uses the server draft at execution time. Any
`allowedRecipients` policy blocks scheduling because later webmail edits can
bypass a local check. Cancellation cannot recall a worker already sending.
Calendar, preference and filter operations check explicit recipients where
possible and refuse unbounded server-derived side effects under restrictions.

Filter replacement has a preflight digest/read-back but no native atomic CAS.
Calendar cancellation/forwarding and inbox replies have documented race limits.
ICS import may partially succeed and update matching UIDs. Sharing can expose
folder trees. Existing router read-only controls, write allowlists, confirmation
challenges, audit logging and redaction remain in effect. Uncertain writes are
never retried automatically.

## Verification boundary

Tests cover schemas, real MIME/PDF parsing, injected transports, errors, limits,
recipient policy, partial results, durable journals and concurrency. They do not
certify a corporate deployment. Follow [disposable-account acceptance](ZIMBRA-ACCEPTANCE.md)
before deployment; no production write is needed merely to inspect setup.

Protocol evidence is pinned to Zimbra/zm-mailbox revision
`bb771f67c53ab99a202ef0a70e1768f2fa05209b`, including
[user SOAP](https://github.com/Zimbra/zm-mailbox/blob/bb771f67c53ab99a202ef0a70e1768f2fa05209b/store/docs/soap.txt),
calendar/document contracts and request handlers/DTOs. Source inspection establishes
the intended protocol, not compatibility with every edition or extension.
No release or deployment is implied by this development branch.
