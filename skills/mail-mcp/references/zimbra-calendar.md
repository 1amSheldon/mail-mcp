# Zimbra calendars, tasks and invitations

Use folders with view `appointment` or `task`, discovered through folder reads.
Calendar item IDs, invitation IDs and MIME message IDs are different. Do not
substitute an ordinary mail ID for a calendar item ID. Shared folders retain
their server owner-qualified IDs and permissions.

| Operation | Input | Behavior |
| --- | --- | --- |
| `zimbra.replyToInboxInvitation` | Inbox guard, `response` (ACCEPT/TENTATIVE/DECLINE), `notifyOrganizer?` (true), `instance?`, `identityId?`, `message?` | Responds to a REQUEST in an ordinary mail item; can create/update the calendar and persist alarms. Unrestricted accounts only. |
| `zimbra.forwardInboxInvitation` | Inbox guard, `to` (1-100 emails), `message?` | Forwards every appointment REQUEST component in the mail, possibly notifying the organizer. Unrestricted accounts only. |
| `zimbra.declineCounterProposal` | Inbox guard, `proposerEmail`, `message?` | Organizer declines the original incoming appointment COUNTER details to a matching attendee; checks recipient policy. Does not reschedule the meeting. |
| `zimbra.forwardAppointment` | Edit guard, `to` (1-100 emails), `instance?`, `message?` | Forwards the series or original occurrence and may additionally notify the native organizer. Unrestricted accounts only. |
| `zimbra.counterAppointment` | Edit guard, `start`, `endExclusive`, `location?`, `instance?`, `message?` | Attendee sends a proposed time/location to the inspected organizer; does not reschedule or record acceptance. |
| `zimbra.importICalendar` | `folderId`, `content` | Imports UTF-8 iCalendar text up to 1 MiB through native ImportAppointments. May update existing UIDs; non-atomic and unavailable for recipient-restricted accounts. |
| `zimbra.exportICalendar` | `folderId`, `window?` (`startsAt`, `endsAt`), `includeAttachments?` (true), `maxBytes?` (10 MiB, max 50 MiB) | REST ICS export of the selected folder; returns a binary `text/calendar` resource. Optional window selects series with occurrences, not a clipped set of individual instances. |
| `zimbra.searchAppointments` | `query`, `startsAt`, `endsAt`, `limit?`, `cursor?` | Native search with occurrences expanded in the required bounded window. Pages contain calendar items with nested instances, not one row per occurrence. |
| `zimbra.searchTasks` | `query`, `limit?`, `cursor?` | Native task search without a date filter; includes undated tasks. Read matching tasks for full invitations. |
| `zimbra.getAppointment` | `appointmentId`, `includeContent?` (true) | Reads invitations and replies; `sync=1` requests `ms`/`rev` for conflict handling. |
| `zimbra.getTask` | `taskId`, `includeContent?` (true) | Reads task invitations/content and conflict versions. |
| `zimbra.getRecurrence` | `itemId` | Reads native recurrence and exception definitions. |
| `zimbra.getCalendarSummaries` | `folderId`, `startsAt`, `endsAt` | Occurrences in one accessible folder/window, not full invitation bodies or all-time export. |
| `zimbra.getFreeBusy` | `startsAt`, `endsAt`, `users`, `excludeUid?` | Users are 1-100 `{email, folderId?}` entries. Preserves free/busy/tentative/unavailable/no-data distinctions. |
| `zimbra.getWorkingHours` | `startsAt`, `endsAt`, `emails` (1-100) | Server working-hour intervals; unknown/no-data is not free. |
| `zimbra.getICalendar` | `invitationId` | Exports component zero of the selected native invitation through GetICal. Not a complete recurring-series export. |
| `zimbra.createAppointment` | `folderId`, `subject`, `start`, `endExclusive`, optional fields below | Creates a personal appointment or invitation draft; sending is explicit. |
| `zimbra.createTask` | `folderId`, `subject`, optional task/shared fields below | Creates a task, including undated tasks. |
| `zimbra.dismissCalendarAlarm` | `kind` (appointment/task), `itemId`, `dismissedAt` | Dismisses the alarm at an explicit instant; inspect returned next alarm. |
| `zimbra.snoozeCalendarAlarm` | `kind` (appointment/task), `itemId`, `until` | Snoozes to an explicit instant. |
| `zimbra.updateAppointment` | Edit guard, `changes`, `notifyAttendees?` (false), `allowExceptionReset?` (false) | Patches supplied fields; preserves other native metadata and MIME attachments. |
| `zimbra.updateTask` | Edit guard, `changes`, `notifyAttendees?` (false), `allowExceptionReset?` (false) | Patches task content/progress with server conflict versions. |
| `zimbra.createAppointmentException` | Edit guard, `instance`, `changes`, `notifyAttendees?` (false) | Creates an exception for an original occurrence from the default recurring invitation. |
| `zimbra.createTaskException` | Edit guard, `instance`, `changes`, `notifyAttendees?` (false) | Equivalent native task exception operation. |
| `zimbra.cancelAppointment` | Edit guard, `instance?`, `range?`, `message?` | Cancels the series or selected instance/range, notifying affected attendees. |
| `zimbra.cancelTask` | Edit guard, `instance?`, `range?`, `message?` | Native task cancellation, with the same notification caveats. |
| `zimbra.replyToInvitation` | Edit guard, `kind?` (appointment default/task), `response`, `notifyOrganizer?` (true), `instance?`, `message?`, `identityId?` | ACCEPT/TENTATIVE/DECLINE; explicitly addresses the inspected organizer or records a local-only response. |

Range timestamps and alarm action timestamps are ISO dates with a time and UTC
offset, at whole-second precision. Read windows must be positive and at most
200 days. Split dense windows if the bounded SOAP response is too large; do not
interpret a failed or inaccessible calendar read as an empty calendar.

Search pages default to 50 items (maximum 100). Use a native folder query such
as `inid:10`; discover actual folder IDs first. Appointment searches omit items
without occurrences in the requested window. Task searches impose no implicit
date range. Cursors expire after five minutes and must be used with unchanged
query, limit and appointment window. Offset paging can shift during mailbox
changes; nested instances may make even a small page large. Split a dense
window when the server response exceeds the transport limit.

An `invitationId` is `calendarItemId-invitationMailId`, optionally preceded by
`ownerUUID:`. Build it from the actual calendar read's item and `inv.id`, or use
a compound `invId` returned by a mutation. GetICal's implementation exports
component zero only. A standalone invitation mail can be deleted independently
of the calendar item, so do not use its raw mail ID for durable calendar reads.

## Importing iCalendar

For a folder export, use `exportICalendar`, not GetICal with an invented folder
parameter. Omit `window` to include all server-exported items, including undated
tasks. A REST window must start on or after 1970-01-01 UTC, is limited to 200 days and excludes items without occurrences
there; selected recurring series still retain their recurrence definitions and
may describe dates outside the window. Dense exports must fit `maxBytes` or fail
without returning truncated bytes. Window exports are not complete backups.
`includeAttachments: true` requests inline attachment data, increasing size.
An ICS envelope check rejects HTML login pages and obvious truncation, but is
not a semantic validation of every event. Inspect or trial-import the result to
verify migration fidelity. Never assume an export includes inaccessible items.

Choose the destination calendar/task folder explicitly and inspect the ICS before
import. Native import can preserve timezone definitions, recurrence, exceptions,
attendees and alarms represented in the file; server version and parser support
determine the accepted content. Embedded email alarms can send later. Accounts
with any `allowedRecipients` policy cannot use opaque ICS import; use typed
create/update operations with checked recipients instead.

The result separates `serverParsedComponents` from
`reportedSavedInvitationIds`. `missingComponents` is their difference when the
response permits that calculation, and `completeness` is `reported_all`,
`partial` or `unknown`. Even `reported_all` only describes the server's report,
not a verified round trip. The server may skip invalid components and still
return success; multiple components can belong to one recurring item. Read each
returned calendar item to check dates, recurrence, exceptions and alarms.

Import is not a transaction across the file. Existing items with matching UIDs
may change, and an interrupted request may already have saved some components.
Never automatically retry the whole file. Reconcile destination items and UIDs
before preparing a targeted retry. Use a disposable folder for migration trials.

## Editing, exceptions and responses

For an unprocessed invitation in Inbox, first use `readMessage`. Its `m.id`,
`m.ms` and selected `m.inv[].comp[].compNum` form the **inbox guard**:
`messageId`, `expectedModSequence`, `component?` (default zero). Use the actual
component number, not its array position. These operations re-read the message
without marking it read and refuse stale or ambiguous metadata. This preflight
does not atomically lock the subsequent server operation.

`replyToInboxInvitation` can add the event/task to its default calendar folder,
update an existing item, or restore it from Trash according to native semantics.
It may also persist embedded/default alarms, including email alarms. Setting
`notifyOrganizer: false` suppresses the organizer reply, not the calendar write.
Thus it is unavailable under any recipient restriction, even for a local-only
reply. Read the resulting calendar item after success. The server can refuse an
outdated invitation or suppress a reply where RSVP was not requested.

`forwardInboxInvitation` acts on the whole mail, not just the selected component;
all returned components must be appointment REQUESTs. It can send an additional
organizer notification and is unavailable under recipient restrictions. Use
`forwardAppointment` for a selected occurrence already in the calendar.

To reject a proposed time, select its incoming COUNTER message, inspect its
proposed dates and attendee, then call `declineCounterProposal` with that
`proposerEmail`. The response echoes the original UID, sequence, dates and
recurrence ID, rather than inventing proposal data from the current meeting.
Only the inspected matching attendee receives the explicit response; original
alarms/attachments are not copied. This does not remove or accept the proposal,
move the incoming message, or update the meeting. Review any uncertain send
before retrying.

Forwarding and counter proposals use the same edit guard below. Forwarding is a
native send with no atomic version guard: preflight can detect an already stale
read, but cannot freeze the server item afterward. A Zimbra organizer may receive
an additional notification even when absent from `to`. Recipient-restricted
accounts therefore cannot use this operation. Select the default invitation to
forward the series; when an exception is selected, explicitly pass its original
`instance` to avoid forwarding the whole series accidentally.

A counter proposal carries the inspected UID/sequence and organizer, the
proposed dates and the sending account as attendee. It does not copy original
attachments or alarms. Native `ms`/`rev` detect stale versions at the server's
pre-send check; this is not an atomic reschedule. The organizer must accept the
proposal and issue an update separately. To change your own meeting, use
`updateAppointment`. An uncertain send must be reconciled before retrying.

Every edit guard consists of `invitationId`, `component?` (default 0),
`expectedModSequence` and `expectedRevision` (positive decimal strings).
Use the calendar item's returned `ms` and `rev`, plus the selected invitation's
`compNum`. The client re-reads and compares them before editing. Modify and
create-exception requests also send native `ms`/`rev`; INVITE_OUT_OF_DATE is a
conflict, not a reason to repeat the old write.

`changes` is a nonempty partial object. Shared editable fields: subject,
location, description, htmlDescription, privacy, priority, categories, url,
attendees, alarms and recurrence. Appointment fields also include start,
endExclusive, status and freeBusy. Task fields also include start, due, status,
percentComplete and completedAt. Field formats follow creation. No create-time
defaults are inserted into omitted top-level patch fields. Supplied attendees,
categories and alarms replace those lists; use `[]` to clear. Use recurrence
`null` to remove it, task start/due/completedAt `null` to clear those fields,
and empty strings to clear text/url. Description formats are independent:
changing description alone retains existing htmlDescription and vice versa.
Explicitly update both if both versions of the text should change.

The client preserves attendee participation status for retained email addresses,
custom native properties, descriptions and existing attachments. For MIME-backed
invitations it reads original MIME, not sanitized HTML from SOAP, and references
original attachment parts under the compound invitation ID. It refuses edits
when MIME/part metadata disagree, when multiple calendar MIME parts cannot be
disambiguated, or when signed/encrypted content cannot be rebuilt safely. For
metadata-only HTML invitations, supply htmlDescription explicitly because the
server may sanitize the returned HTML. No update is submitted in those cases.

An exception's `instance` is the **original occurrence start**, even if moving
it to another time. Use the series time basis/timezone. If changes.start is
omitted it defaults to that instance; omitted end/due retains the series
wall-clock duration. Existing exceptions must be modified using their own
invitation IDs, not created again. Exception creation cannot replace recurrence.

Changing a recurring series' start/end/due/recurrence can reset exceptions,
depending on server preferences. When exceptions exist, first inspect them and
set `allowExceptionReset: true` only if this consequence is intended. Removing
attendees or resetting exceptions may send cancellation emails even when the
main update has no recipients. Such edits require `notifyAttendees: true`.
Recipient policy includes removed participants and participants of exceptions;
it also checks preserved email alarms. Only an organizer can send event updates.

Cancellation always permits the native cancellation notices; it has no silent
mode. `range` is THISANDFUTURE or THISANDPRIOR and requires `instance`. Without
instance, select the default invitation to cancel the entire series. An exception
invitation cannot accidentally serve as a whole-series selection. Attendees
should decline through replyToInvitation, not cancel another organizer's event.

**Cancellation concurrency limitation:** the native CancelCalendarItem handler
does not atomically check ms/rev and may derive additional notification recipients
from exceptions after preflight. Cancellation is therefore disabled on accounts
with allowedRecipients, including an empty list. The preflight guard on unrestricted
accounts does not guarantee an atomic cancellation snapshot. Inspect and avoid
concurrent edits; do not retry an uncertain result automatically.

Replies use the inspected organizer as the explicit message recipient.
`notifyOrganizer: false` records only the local participation change. Zimbra
may suppress replies if the original RSVP setting is false, and returns statuses
such as OK, OLD, ALREADY-REPLIED or FAIL. Inspect them and read the calendar item;
SOAP success alone does not prove acceptance or email delivery. This operation
uses an existing calendar invitation, not an unprocessed standalone inbox invite.

For task completion, set status COMP and percentComplete 100 together; optionally
set completedAt. Reopening a completed task must explicitly clear completedAt.

## Dates and creation fields

Each calendar time is exactly one of:

- `{ type: "date", date: "2026-10-14" }` for an all-day date
- `{ type: "instant", at: "2026-10-14T09:00:00+03:00" }` for an absolute instant
- `{ type: "local", at: "2026-10-14T09:00:00", timeZone: "Europe/Kyiv" }` for wall-clock time in a server-known zone

Start/end must use the same form and local timezone. Use instants for endpoints
expressed in different zones. Appointments require a later `endExclusive`.
For an all-day event on October 14, start is October 14 and endExclusive is
October 15. The client subtracts one day only at the SOAP boundary because
Zimbra uses an inclusive all-day end. Tasks use inclusive `due`, with no such
subtraction. A task may omit start and due; when both exist, due must not precede
start.

Local time keeps wall-clock recurrence across DST. Zimbra must know the timezone
ID; do not silently substitute UTC for a rejected zone. Ambiguous or nonexistent
DST local times follow server interpretation: verify returned times and actual
occurrences. Use an explicit instant when the intended occurrence must be
unambiguous. These tools do not invent custom timezone definitions.

Both creation operations accept:

- `location?`, `description?` (plain), `htmlDescription?`, `categories?` (up to
  100 strings), `url?`, `priority?` (0-9, default 0), `privacy?` (PUB/PRI/CON,
  default PUB).
- `attendees?` (up to 100 unique emails), each `{ email, name?, role?, type?,
  rsvp? }`. Roles: REQ default, OPT, CHA, NON. Types: IND default, GRO, RES, ROO,
  UNK. RSVP defaults to true.
- `notifyAttendees?` defaults to false. Attendees are saved in the event but no
  invitation email is addressed unless true. Sending requires user intent;
  recipient policy is checked before the write. Organizer is the account.
- `alarms?` and `recurrence?`, described below.

Appointments additionally accept `status?` (CONF default, TENT or CANC) and
`freeBusy?` (B default, F free, T tentative or O unavailable). Tasks accept
`status?` (NEED default, INPR, COMP, WAITING, DEFERRED, CANC), `percentComplete?`
(0-100, default 0), and `completedAt?` (instant, only for COMP). A completed task
requires percentComplete 100.

## Recurrence and alarms

`recurrence` contains arrays `rules`, `excludeRules`, `includeDates`,
`excludeDates` (all default empty); at least a rule or included date is required.
Rules are limited to 10 each, dates to 1,000 each. Recurrence requires a start;
included/excluded dates use its time basis. A rule contains:

- `frequency`: SEC, MIN, HOU, DAI, WEE, MON, YEA; `interval?` (1-10000, default 1).
- `count?` (1-100000) or `until?`, never both. Until is a date for all-day rules,
  an offset timestamp for timed rules, normalized to UTC. Neither means an
  unbounded recurrence; queries still use bounded windows.
- `byDay?`: `{day: SU|MO|TU|WE|TH|FR|SA, ordinal?: -53..-1|1..53}` entries.
- `byMonthDay?` (-31..-1 or 1..31), `byMonth?` (1..12), `byYearDay?` (-366..-1
  or 1..366), `byWeekNo?` (-53..-1 or 1..53), `bySetPosition?` (-366..-1 or
  1..366), `byHour?` (0..23), `byMinute?` and `bySecond?` (0..59): arrays.
- `weekStartsOn?`: weekday code. By-set-position requires another by-filter.

The server enforces valid recurrence combinations; use only meaningful RFC
recurrence rules for the selected frequency. Inspect actual expanded instances,
especially month-end/ordinal patterns and DST transitions.

Up to 10 alarms are supported. Each has a `trigger` that is either
`{type: "relative", minutes, related?: "START" | "END"}` (negative minutes
before, positive after; absolute maximum 525600) or `{type: "absolute", at}`.
An alarm is one of:

- `{type: "display", trigger, description?}` (defaults to event subject).
- `{type: "audio", trigger}` (native/default sound).
- `{type: "email", trigger, to, subject, body}` (1-100 recipient emails).

Email alarms may send later even when notifyAttendees is false. Their recipients
are checked independently against allowedRecipients. Server/client support
controls whether a configured alarm is actually delivered/displayed.

## Workflow: recurring team appointment

Resolve the calendar folder and participants; read free/busy and working hours,
treating no-data as unknown. Create inactive notification state first unless
sending was requested:

```json
{
  "accountId": "work-zimbra", "operation": "zimbra.createAppointment",
  "input": {
    "folderId": "10", "subject": "Weekly planning",
    "start": { "type": "local", "at": "2026-10-14T09:00:00", "timeZone": "Europe/Kyiv" },
    "endExclusive": { "type": "local", "at": "2026-10-14T10:00:00", "timeZone": "Europe/Kyiv" },
    "attendees": [{ "email": "colleague@example.test" }],
    "notifyAttendees": false,
    "recurrence": { "rules": [{ "frequency": "WEE", "count": 8, "byDay": [{ "day": "WE" }] }] },
    "alarms": [{ "type": "display", "trigger": { "type": "relative", "minutes": -15 } }]
  }
}
```

Substitute discovered IDs, recipients and intended dates. Read the returned
calendar item and query occurrences to verify time, duration, participants and
recurrence. A write can be saved before notification fails; uncertain writes
must be reconciled rather than automatically repeated. Acceptance is not proof
that invitations or alarms reached recipients.

Protocol reference: Zimbra/zm-mailbox revision
`bb771f67c53ab99a202ef0a70e1768f2fa05209b`, `store/docs/soap-calendar.txt`,
`CalendarUtils.java` (inclusive SOAP all-day end), `GetCalendarItem.java` (sync
versions), `CreateCalendarItem.java`, `GetICal.java`. Mock tests establish
payloads and policy boundaries, not live server timezone or delivery behavior.
