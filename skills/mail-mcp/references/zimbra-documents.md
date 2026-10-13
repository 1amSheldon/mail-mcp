# Zimbra Briefcase and document revisions

Briefcase stores files in folders with view `document`. It is distinct from mail
attachments, though an attachment can become a document. Use existing folder
creation/listing and [sharing](zimbra-sharing.md) operations for its folders.
Use actual IDs returned by the server, including owner-qualified shared IDs.

| Operation | Input | Behavior |
| --- | --- | --- |
| `zimbra.searchDocuments` | `query`, `limit?` (1-100, default 50), `cursor?` | Native document search, with the same five-minute query-bound cursor rules as mail. |
| `zimbra.getDocumentMetadata` | `documentId` | Reads name, version, description, type, folder, flags and other available metadata; refuses other item types. |
| `zimbra.downloadDocument` | `documentId`, `version?`, `maxBytes?` (default 10 MiB, maximum 50 MiB) | Downloads bytes of a specific revision; omitted version is pinned from current metadata first. Binary resource output. |
| `zimbra.listDocumentRevisions` | `documentId`, `fromVersion?`, `count?` (1-100, default 20) | Descending revision windows; `nextVersion` is the next starting version, null when exhausted. Purged versions may leave gaps. |
| `zimbra.diffDocument` | `documentId`, `firstVersion`, `secondVersion` | Server text diff chunks; not a binary Office/PDF comparison. |
| `zimbra.createDocument` | `folderId`, `name`, `source`, `description?`, `descriptionEnabled?` | Creates a file without a replacement ID/version. Existing-name conflicts are not retried as updates. |
| `zimbra.updateDocument` | `documentId`, `expectedVersion`, `source`, `name?`, `description?`, `descriptionEnabled?` | Adds a revision; preflights the version and sends native `ver`. Preserves omitted name/description settings. |
| `zimbra.restoreDocumentRevision` | `documentId`, `expectedVersion`, `restoreVersion` | Adds a revision using historical content/description. Keeps the current name and does not erase newer history. |
| `zimbra.renameDocument` | `documentId`, `name` | Renames the document. |
| `zimbra.moveDocument` | `documentId`, `folderId` | Moves the document. |
| `zimbra.copyDocument` | `documentId`, `folderId` | Copies through native document action; re-query destination for the copy's ID. |
| `zimbra.trashDocument` | `documentId` | Moves to Trash. |
| `zimbra.deleteDocument` | `documentId` | Deletes the document and retained revisions; recovery depends on server retention. |
| `zimbra.setDocumentTag` | `documentId`, `tagName`, `enabled` | Adds/removes one tag without replacing other tags. |
| `zimbra.setDocumentFlagged` | `documentId`, `flagged` | Sets/clears flagged state. |
| `zimbra.setDocumentLock` | `documentId`, `locked` | Native checkout lock/unlock; authorization and lock ownership are enforced by the server. |
| `zimbra.setDocumentWatch` | `documentId`, `enabled` | Adds/removes a native document watch, where supported. |
| `zimbra.grantDocumentAccess` | `documentId`, `grantee`, `permissions`, `expiresAt?` | File-level sharing on supporting servers; grantee is `{type: "usr", id: "directory-UUID"}`, `{type: "all"}`, or `{type: "pub"}`. |
| `zimbra.revokeDocumentAccess` | `documentId`, `granteeId` (UUID) | Revokes a file-level grant. Inherited folder access may remain. |

Document sharing uses the rights/expiry semantics in the sharing reference.
Other grantee types are unsupported by the native DocumentAction handler; share
the containing folder when appropriate. File-level sharing/watch support varies
by server version. No notification email is sent implicitly by grant/revoke.

`source` is exactly one of:

- `{ type: "file", file: { path, filename?, contentType? } }`
- `{ type: "file", file: { filename, contentBase64, contentType? } }`
- `{ type: "text", text, contentType?: "text/plain" | "text/html" }`
- `{ type: "attachment", messageId, partId }`

File reads use the same real-path `allowedAttachmentRoots`, strict base64 and
25 MiB file limit as outgoing attachments. Text is limited to 1,048,576
characters. Files upload as original bytes, not a MIME mail wrapper. Content
type and extension handling remain server-controlled. New names are explicit;
update names default to the current name rather than the upload's filename.
An empty description explicitly clears it. New revisions cannot silently move a
document; use the move operation. Attachment sources refer to a specific part
returned by a prior mail read, not an arbitrary URL.

## Workflow: store a received report

Read the mail's attachment metadata. Select the intended file and existing
Briefcase folder, then create a document:

```json
{
  "accountId": "work-zimbra",
  "operation": "zimbra.createDocument",
  "input": {
    "folderId": "16", "name": "report.pdf",
    "source": { "type": "attachment", "messageId": "257", "partId": "2" }
  }
}
```

These are illustrative IDs; substitute discovered IDs. Read returned document
metadata and download its returned version to verify the intended bytes. A SOAP
acknowledgement only establishes acceptance. Upload may succeed before a save
fails; an uncertain save must be reconciled by searching the folder/name and
reading versions, not blindly retried.

For updates, first read metadata and use its `ver` as `expectedVersion`. If a
conflict occurs, inspect the new revision before reapplying an edit. A document
lock is separate from version checking; do not unlock another editor's document
to bypass a conflict. For restore, inspect/download the historical revision,
read the latest version, restore, then verify the resulting current revision.

Revision paging advances by requested version windows, not the number returned,
so missing historical revisions do not prematurely end enumeration. Search
paging can shift under concurrent edits; it is not a stable export snapshot.

Protocol evidence: Zimbra/zm-mailbox revision
`bb771f67c53ab99a202ef0a70e1768f2fa05209b`, `store/docs/soap-document.txt`,
`store/src/java/com/zimbra/cs/service/doc/SaveDocument.java`,
`ListDocumentRevisions.java`, `service/mail/DocumentAction.java`, and
`service/UserServlet.java`. SaveDocument's current implementation reads inline
`content` as an attribute (unlike the older XML prose example). Tests verify
binary uploads, guarded revisions, metadata preservation, bounded reads and
error handling with mock transport; live server qualification is separate.
