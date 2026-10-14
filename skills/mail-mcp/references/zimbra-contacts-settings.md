# Zimbra contacts, directory and settings

Use with backend zimbra and the envelopes in [Zimbra](zimbra.md). Ordinary contacts
are mailbox objects, contact groups contain membership references, and the GAL is
the server directory. A GAL ref is not an item ID and must not be passed as a
message/contact ID. These operations use the user's permissions, not administrator
SOAP. Creating contacts or groups does not send invitations.

## Directory and groups

Reads through mail_query:

| Operation | Input | Result/boundary |
| --- | --- | --- |
| `zimbra.searchGal` | query, type?, limit?, cursor? | Name search; type all (default), account or resource; limit 1-100, default 50 |
| `zimbra.autoComplete` | name, includeGal?, folderIds?, type? | Suggestions, not exhaustive directory search; type account (default), resource, group or all |

searchGal uses opaque query/type/limit-bound cursors. Continue only with the newest
returned cursor. When the backend does not confirm pagination support, no cursor
is invented: inspect partial and narrow the query. autoComplete defaults includeGal
to true, accepts 1-100 native folder IDs and is capped by the server's suggestion
limit. A group suggestion can contain multiple comma-separated addresses; inspect
it rather than treating display text as one mailbox.

Writes through mail_mutate:

| Operation | Input | Effect |
| --- | --- | --- |
| `zimbra.createContactGroup` | name, members, folderId? | Creates a group in the selected/default Contacts folder |
| `zimbra.updateContactGroup` | contactId, name?, addMembers?, removeMembers?, clearMembers? | Patches group membership/label; preserves other contact fields and tags |
| `zimbra.addContactTag`, `zimbra.removeContactTag` | contactIds, tagName | Changes one tag without replacing other tags |
| `zimbra.importContact` | vcard, folderId? | Imports exactly one inline vCard, at most 1 MiB |

members/addMembers/removeMembers contain at most 1000 entries. Each entry is one of:

- `{ "type": "contact", "contactId": "123" }` using a previously read native ID.
- `{ "type": "gal", "ref": "RETURNED_GAL_REF" }` using the actual directory ref.
- `{ "type": "email", "email": "person@example.test", "name": "Person" }`; name is optional.

Read the contact with getContact before editing a group. The implementation also
checks its group type before mutation. clearMembers=true removes all current
members before adding addMembers; it cannot be combined with removeMembers.
Without clearMembers, additions/removals preserve unrelated members. For ordinary
field edits use updateContact. Empty field strings remove those fields; omitted
fields survive. getContact with dereferenceMembers=true expands references up to
maxMembers; honor server tooManyMembers/omitted entries rather than claiming a
complete group. Verify the group again after editing.

## Preferences, identities and out-of-office

Call getAccountInfo to inspect server version and visible zimbraFeature* attributes,
and getPreferences/listIdentities/listSignatures for the objects to change. Local
capability flags describe implemented operations, not server permissions, installed
licenses or remote connectivity. Missing feature attributes are unknown, not false.

| Operation | Input | Effect |
| --- | --- | --- |
| `zimbra.setPreferences` | values | Patch native zimbraPref settings; omitted preferences survive |
| `zimbra.createIdentity` | name, values | Create a native sending persona |
| `zimbra.updateIdentity` | identityId, values | Patch preferences on the selected persona |
| `zimbra.deleteIdentity` | identityId | Remove the selected persona, subject to server restrictions |
| `zimbra.getOutOfOffice` | {} | Read automatic-reply enablement, content and date settings; mail_query |
| `zimbra.setOutOfOffice` | enabled, message?, startsAt?, endsAt? | Set automatic reply; mail_mutate; enabling requires message |

values is a nonempty map of 1-100 native zimbraPref names to string or string-array
values, at most 1 MiB serialized. Use the server's expected string representation
(for example TRUE/FALSE), not arbitrary objects. Only user preference names are
accepted; account/admin attributes are not. The server remains responsible for
validating supported names, types, identity-specific fields and permission to edit.
Native JSON uses _attrs internally; the public input is always values.

Identity IDs are UUIDs returned by listIdentities. Updating a From preference does
not grant send-as permission. Select the identityId when composing and inspect
the saved From/Reply-To. Deleting a persona or signature can affect webmail defaults;
read the current references and verify them afterward.

Out-of-office is ongoing automatic sending, not a draft. Enabling it needs that
specific user intent. startsAt/endsAt are ISO timestamps with an explicit UTC offset
or Z; the service converts them to Zimbra UTC timestamps. Omitted dates and external
reply settings remain unchanged. Read current dates before enabling so a stale
range does not defeat the requested schedule. Disable with enabled=false and
verify getOutOfOffice. When both dates are supplied, start must precede end.

Accounts with allowedRecipients enforce it on forwarding/Bcc/notification
destinations. They permit known non-sending preferences but block enabling OOO
or unclassified settings that could trigger unconstrained automatic mail.
Disabling OOO remains possible. Do not broaden account policy as a workaround.
Recipient restrictions do not override the server's own forwarding or delivery
configuration outside this client.

```json
{"accountId":"ZIMBRA_ACCOUNT_ID","operation":"zimbra.setPreferences","input":{"values":{"zimbraPrefLocale":"en_US","zimbraPrefTimeZoneId":"Europe/Kyiv"}}}
```

The locale/time zone are example values, not a request to change the user's setup.
Re-read the specific preferences after a write. Unknown outcomes require inspection
before retrying; an absent response is not proof that a setting stayed unchanged.
