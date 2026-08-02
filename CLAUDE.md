<!-- GSD:project-start source:PROJECT.md -->
## Project

**Mail MCP Server**

A local Model Context Protocol (MCP) server that provides tools and resources to interact with a mailbox via IMAP and SMTP. It allows AI models to search, read, list, and send emails, as well as manage threads and perform automated workflows like summarization and filtering.

**Core Value:** Empower AI agents to act as a personal mail assistant by providing structured, tool-based access to existing email accounts through standard protocols.

### Constraints

- **Protocol**: Must use IMAP/SMTP for broad compatibility.
- **Environment**: Must run locally on macOS (Darwin).
- **Interface**: Must adhere to the Model Context Protocol (MCP) specification.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Node.js (IMAP & SMTP)
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `imapflow` | `^1.0.158` | IMAP Client | Modern, native async/await, handles connection locking, built-in IDLE, and Gmail threading. |
| `nodemailer` | `^6.9.13` | SMTP Client | The gold standard for Node.js; zero dependencies, supports multiple transports, extremely stable. |
| `mailparser` | `^3.7.1` | MIME Parsing | Best-in-class MIME parser to handle attachments and body extraction for Node.js. |
### Go (IMAP & SMTP)
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `go-imap/v2` | `v2.0.0-beta.x` | IMAP Client | Implements IMAP4rev2 (RFC 9051), better concurrency than v1, native SORT/THREAD support. |
| `go-mail` | `v0.4.4` | SMTP Client | Actively maintained successor to `gomail`, modern API, robust attachment and SSL/TLS handling. |
| `go-message` | `v2.17.1` | MIME Parsing | Standard library for parsing MIME messages in the Go ecosystem (from emersion). |
## Comparison
| Feature | Node.js (ImapFlow + Nodemailer) | Go (go-imap v2 + go-mail) |
|---------|---------------------------------|---------------------------|
| **IDLE support** | Built-in (automatic detection) | Built-in in v2 (native protocol) |
| **Attachments** | High (via `mailparser` integration) | High (via `go-message` integration) |
| **Threading** | High (supports Gmail X-GM-THRID and RFC 5256) | High (RFC 5256 and RFC 9051 native) |
| **Maintenance** | **Very High** (Maintained by Nodemailer team) | **High** (Actively developed beta/v2) |
| **Integration** | Native Async/Await | Native Goroutines & Channels |
| **Security** | TLS 1.2/1.3, STARTTLS support | TLS 1.2/1.3, STARTTLS support |
## Alternatives Considered
| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Node IMAP | `imapflow` | `node-imap` | `node-imap` is legacy, callback-heavy, and unmaintained. |
| Node IMAP | `imapflow` | `imap-simple` | Only a wrapper around the legacy `node-imap`; inherits its bugs. |
| Go SMTP | `go-mail` | `gomail.v2` | Effectively unmaintained; lacks modern Go features like contexts. |
| Go SMTP | `go-mail` | `net/smtp` | Too low-level; requires manual MIME construction for HTML/attachments. |
## Installation
### Node.js
# Install core mail libraries
### Go
# Add dependencies to go.mod
## Sources
- [ImapFlow Documentation](https://imapflow.com/) (HIGH confidence)
- [Nodemailer Official Site](https://nodemailer.com/) (HIGH confidence)
- [go-imap v2 Repository](https://github.com/emersion/go-imap) (MEDIUM confidence - Beta)
- [wneessen/go-mail Documentation](https://github.com/wneessen/go-mail) (HIGH confidence)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
