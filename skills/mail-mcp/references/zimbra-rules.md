# Zimbra incoming and outgoing filters

Use native Zimbra rules, not IMAP/Sieve credentials. Rules run on the server and
affect future mail while mail-mcp is offline. Incoming and outgoing lists are
separate; `direction` defaults to `incoming`, or use `outgoing`. Server account
features and Sieve extensions still apply.

| Operation | Input | Effect |
| --- | --- | --- |
| `zimbra.getFilterRules` | `direction?` | Returns native `rules`, `revision`, and concurrency warning. Read-only. |
| `zimbra.upsertFilterRule` | `direction?`, `expectedRevision`, `rule`, `beforeRuleName?` | Replaces a same-name rule in place or appends a new one. Optional insertion before another existing rule. |
| `zimbra.setFilterRuleEnabled` | `direction?`, `expectedRevision`, `name`, `enabled` | Changes only the named rule's active setting; preserves other native fields. |
| `zimbra.deleteFilterRule` | `direction?`, `expectedRevision`, `name` | Removes the named rule. Does not undo past actions. |
| `zimbra.replaceFilterRules` | `direction?`, `expectedRevision`, `rules` | Replaces the whole ordered list using retained entries and typed new rules. Empty removes all user rules in this direction. |
| `zimbra.applyFilterRules` | `direction?`, `expectedRevision`, `names`, `messageIds` | Applies named rules to 1-100 explicit local message IDs. Can move/delete/tag messages or trigger notifications. |

## Safe editing workflow

1. Read the list. Inspect every rule's order and effects; keep the returned
   revision (a SHA-256 digest, not a mailbox modseq). Every write requires it;
   stale lists fail before replacement. Prefer a targeted operation.
2. For reordering, `rules` contains `{ "source": "existing", "name": "Old" }`
   (optional `active` boolean) or `{ "source": "new", "rule": { ... } }`.
   Existing entries are copied from the fresh server read, including unfamiliar
   constructs. Omitted entries are deleted. Names must be unique; maximum 1,000
   rules / 1 MiB. An upsert with a new name adds a rule, not a rename.
3. Inspect returned `rules`. `status: accepted` means acknowledgement plus
   successful read-back. `exactMatch: false` indicates server normalization or
   another edit; compare actual actions/order. `accepted_unverified` means
   read-back failed. Read the list before another write; never automatically
   retry an uncertain replacement or rule execution.

**Concurrency limit:** Zimbra replaces the entire list without atomic
compare-and-set. The revision check detects prior changes and one client
serializes its edits, but another process or webmail can edit between requests.
Avoid concurrent editors. Read-back cannot detect every overwritten edit.

## Typed rule contract

A rule is `{ name, active?, variables?, branch }`; active defaults to true.
Variables are up to 100 `{ name, value }` strings, names matching
`[A-Za-z_][A-Za-z0-9_]*`. A branch has `condition?` (allof default or anyof),
1-100 `tests`, and either 1-100 `actions` (plus optional action-level variables)
or one `nested` branch. Up to four levels are supported by the builder; deeper
existing rules can be retained. Test/action array order becomes native indexes.

Every test has `type` and optional `negative` (false). Additional fields:

| Test type | Fields |
| --- | --- |
| header, mimeHeader, address, envelope | `header`, `value`, `comparison`; address/envelope also allow `part`: all/localpart/domain |
| addressBook, contactRanking, headerExists, me | `header` |
| true, attachment, bulk, facebook, linkedin, list, socialcast, twitter, communityRequests, communityContent, communityConnections | None |
| body | `value`, `caseSensitive?` (false) |
| conversation | `where`: started/participated |
| currentDayOfWeek | `days`: integers 0-6 (Sunday-Saturday) |
| currentTime | `comparison`: before/after; `time`: HHmm |
| date | `comparison`: before/after; `seconds`: Unix seconds (server compares dates) |
| flagged | `flag`: flagged/read/priority |
| importance | `importance`: high/normal/low |
| size | `comparison`: over/under; `bytes`: nonnegative integer |
| invite | `methods`: array of anyrequest, anyreply, publish, request, reply, add, cancel, refresh, counter, declinecounter; empty matches any invite |

Header comparison shapes:

- `{ kind: "string", operator: "is" | "contains" | "matches", caseSensitive?: false }`
- `{ kind: "value", operator: "gt" | "ge" | "lt" | "le" | "eq" | "ne", comparator?: "i;ascii-casemap" }`
- `{ kind: "count", operator: "gt" | "ge" | "lt" | "le" | "eq" | "ne" }`

Value comparators also accept `i;ascii-numeric` and `i;octet`. Headers are
comma-separated names without spaces. Wildcards, variables, timezone behavior
and social/community predicates follow server semantics and version support.

Every action has `type`. Additional fields:

| Action type | Fields |
| --- | --- |
| keep, discard, stop | None; discard may permanently discard future matching mail |
| fileInto | `folderPath`, `copy?` (false) |
| tag | `tagName` |
| flag | `flag`: flagged/read/priority |
| redirect | `address` (one email), `copy?` (false) |
| reply | `body` |
| notify | `address` (one email), `subject?`, `body?`, `maxBodySize?` (0-1048576), `originalHeaders?` (comma-separated names or `*`) |
| rfcNotify | `from` (email), `subject`, `method` (`mailto:` URI); requires RFC notify enabled on server |
| reject, ereject | `message` |
| log | `message`, `level?` (info; fatal/error/warn/debug/trace also supported) |

No arbitrary SOAP or raw Sieve is accepted. Preserve existing header-edit actions
and other extensions using `source: existing`; do not guess translations.

## Recipient policy and execution

With `allowedRecipients`, the entire desired list is checked, including retained,
disabled and nested rules. Redirect/notify must target exact allowed emails with
no substitution. Replies, reject/ereject, RFC notify and unknown actions are
blocked because their recipients cannot be established. Removing unsafe rules is
possible when the remaining list passes. Applying rules is blocked on restricted
accounts: server lookup by name can race with changes after preflight.

On unrestricted accounts apply only to explicitly selected IDs and re-query
affected messages. Query-wide unbounded execution is not exposed. Zimbra says
redirects are ignored when applying to existing mail; other side effects still
matter. Execution is not an idempotent retry. These checks govern client writes,
not pre-existing server/administrator rules or edits through other clients.

Read first, then use the actual returned revision in a mutation:

```json
{ "accountId": "work-zimbra", "operation": "zimbra.getFilterRules", "input": { "direction": "incoming" } }
```

Example typed rule value inside an upsert (the enclosing mutation also requires
`expectedRevision`):

```text
{
  "name": "Invoices", "active": false,
  "branch": {
    "tests": [{ "type": "header", "header": "Subject", "value": "Invoice",
                "comparison": { "kind": "string", "operator": "contains" } }],
    "actions": [{ "type": "fileInto", "folderPath": "/Invoices" },
                { "type": "stop" }]
  }
}
```

Create/verify the folder first, save inactive, read back and review, then enable
with a fresh revision. Apply to existing mail only when requested, starting with
a small selected set and inspecting results.

Protocol evidence: Zimbra/zm-mailbox revision
`bb771f67c53ab99a202ef0a70e1768f2fa05209b`, `store/docs/soap.txt`,
`store/src/java/com/zimbra/cs/service/mail/ModifyFilterRules.java`, and
`soap/src/java-test/com/zimbra/soap/JaxbToJsonTest.java` (JSON wrapper arrays).
Mock tests validate shapes, retention, conflicts and policy, not live Sieve
execution on a particular server.
