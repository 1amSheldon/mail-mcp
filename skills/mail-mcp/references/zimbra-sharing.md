# Zimbra sharing and mounted folders

Sharing exposes folder contents to other principals. Permission changes and
notification emails are separate operations; granting access never implicitly
sends a notification through this client. Server account/domain policy remains
authoritative. A local mountpoint is a link to another mailbox's shared folder.

| Operation | Input | Behavior |
| --- | --- | --- |
| `zimbra.getShareInfo` | `owner?` (email), `includeOwn?` (true), `granteeType?` (usr/grp/dom/cos/all/pub) | Without owner, searches published directory share metadata. With owner, discovers applicable shares in that mailbox. |
| `zimbra.getFolderGrants` | `folderId` | Reads folder metadata/ACL at depth zero with grantee names. Missing ACL does not establish that there are no grants; ACL visibility requires appropriate rights. |
| `zimbra.grantFolderAccess` | `folderId`, `grantee`, `permissions`, `expiresAt?` | Adds/updates one grantee's rights without replacing other grants. |
| `zimbra.revokeFolderAccess` | `folderId`, `granteeId` (UUID or external email) | Revokes that principal's grant. Does not remove access inherited from another group/public grant. |
| `zimbra.createMountpoint` | `name`, `parentFolderId`, `owner` (email), `remoteFolderId` (owner-local numeric ID), `view?`, `color?`, `reminders?` (false) | Creates a local link to an accessible shared folder. Does not grant permission. |
| `zimbra.setSharedReminders` | `mountpointId` (local numeric ID), `enabled` | Enables/disables client reminders for shared appointments/tasks. |
| `zimbra.removeMountpoint` | `mountpointId` (local numeric ID) | Verifies the item is a link, then deletes the local link. Refuses ordinary owned folders. |
| `zimbra.sendShareNotification` | `folderId`, `to` (1-100 emails), `notes?`, `revoked?` (false) | Sends a sharing or revocation email. Requires explicit sending intent; does not itself grant/revoke access. |

`grantee` has one of these strict shapes:

- `{ type: "usr" | "grp" | "dom" | "cos", id: "directory-UUID" }`
- `{ type: "all" }` for all authenticated users
- `{ type: "pub" }` for public access, including unauthenticated users
- `{ type: "guest", email: "external@example.test", password: "chosen-guest-password" }`
- `{ type: "key", email: "external@example.test", accessKey: "chosen-access-key" }`

Use real directory IDs for internal principals. Zimbra can silently convert an
unknown username into a guest; this API deliberately requires IDs to avoid that
fallback. A contact's mailbox ID is not a directory account UUID. Resolve the
actual account/group identity through GAL/directory data; never invent an ID.
Domain/COS grants affect many accounts and still only use user-accessible folder
ACL operations; they do not modify domain/server configuration.

`permissions` is a nonempty combination of unique `r` read, `w` write, `i`
insert, `d` delete, `a` administer, `x` workflow action, `p` view private, `f`
free/busy. Choose exactly the intended rights. `expiresAt` is an ISO timestamp
with timezone, or `never`; omitted uses native defaults. Server maximum sharing
lifetimes can override/reject it. Check actual grants afterward.

Guest passwords/access keys are sensitive: do not place them in explanations or
reuse an account password. Access keys accept 16-1024 URL-safe letters, digits,
underscores and hyphens. Returned native `pw`/`key` fields are redacted, including
in folder reads. Keep the chosen secret using the user's approved secret-handling
workflow; mail-mcp does not return a generated credential. Native guest behavior
varies by server version and domain sharing policy.

For revocation, use the actual grant's `zid`. Special IDs are
`00000000-0000-0000-0000-000000000000` for all authenticated users and
`99999999-9999-9999-9999-999999999999` for public access. Guest/key grants use the
external email supplied by this client. Re-read the ACL; revoking one grant may
leave access through others. On mountpoints, grant/revoke can target the remote
resource when the caller has permission, so inspect owner and folder identity.

## Workflow: use a colleague's shared calendar

```json
{ "accountId": "work-zimbra", "operation": "zimbra.getShareInfo", "input": { "owner": "colleague@example.test" } }
```

Select the returned calendar and owner, verify it is the requested resource,
then create a mountpoint under the chosen local parent. `view` can be message,
contact, appointment, task or document; color is 0-127. Use the actual remote
folder ID and owner, not a guessed path. List folders again to verify the local
link's `id`, `rid` and `zid`; a link can be broken after permissions change.
Rename/move/color through the existing folder operations. Remove it through
`removeMountpoint` to distinguish unlinking from deleting owned folders.

## Workflow: share an owned folder

Read the folder/ACL, resolve the grantee, grant only the intended rights, then
re-read and compare that grantee's actual rights and expiry. Send a notification
only if requested. `allowedRecipients` applies to notification addresses (an
explicit empty list denies all); it does not redefine folder-sharing authority.
Distribution lists can expand on the server. An acknowledgement is acceptance,
not proof of delivery; an uncertain notification must not be retried blindly.
Do not treat missing published share metadata as proof of revoked access.

Protocol evidence: Zimbra/zm-mailbox revision
`bb771f67c53ab99a202ef0a70e1768f2fa05209b`, `store/docs/soap.txt`,
`FolderAction.java`, `GetFolder.java`, `SendShareNotification.java`, and
`soap/account/message/GetShareInfoRequest.java`. Tests use mock transport;
cross-mailbox permissions must be qualified using disposable test accounts.
