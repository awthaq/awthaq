# ADR-EA-029: Events Carry Identifiers, Not Personal Data, and the Audit Trail Is Pseudonymized on Erasure

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-029 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (ESA-005, ALF-009, CSG-001) |

---

## Context

`AuthEvents` payloads are recorded durably by `AuditLog` and handed to arbitrary subscribers. Several payloads carried an email address or free text (an invitation's invitee, a failed sign-in's identifier). A GDPR Art. 17 erasure that deletes the user's rows but leaves those payloads behind has not erased the person, and a hash-chained ledger cannot be edited to fix it afterwards.

## Decision

1. **Payloads carry opaque identifiers (user ids, session ids, event tags), never an email, a name or free text.** Where an event must correlate an attempt with an identifier the caller typed (`auth.user.signInFailed`), it carries a keyed digest (`identifierDigest`, HMAC under `identifierDigestKey`, random per process unless configured) and the request's `clientIp`, never the identifier itself. `auth.user.invitationCreated` no longer carries the invitee's address; `auth.user.deleted` carries none either.
2. **Fields that can still hold personal data are declared, not discovered.** `AuthEventSchemas.PII_FIELDS` lists them; `AuditLog.pseudonymizeActor` blanks exactly those, and `RedactionGuard` (in `@awthaq/test`) fails a test that lets a registered canary reach a span, a log line or an event.
3. **Erasure pseudonymizes; it does not delete.** `AuditLog.pseudonymizeActor(userId)` rewrites every row naming the user (actor column and anywhere in the payload) to one fresh random alias, so "one actor did these things" survives while the alias is unlinkable to the person; row id, tag, timestamp and correlation id are kept. It runs last inside `AccountErasure`'s transaction (ADR-EA-031). A deployment that must keep the rows verbatim under an Art. 17(3)(b)/(e) obligation sets `ErasureConfig.auditLog: "retain"`.
4. **The erasure receipt is the one row that keeps the id.** `auth.user.deleted` is published after the commit with the (now orphan) opaque user id and no email: subscribers and an outbox relay need the id to remove their own copies, and the row is the proof that an erasure happened.
5. **The impersonation ledger is out of scope.** `admin_impersonation` and its hash chain are retained under a legal-obligation basis (who accessed whose account is itself an audit duty, ALF-005) and are protected by database triggers on purpose; their chain payloads embed the ids a pseudonymization would rewrite. A ledger designed to survive erasure (identifiers replaced by per-user keyed digests) is a follow-up, recorded in ADR-EA-031.

## Consequences

**Positive**: an erasure leaves nothing in the durable audit trail that names the person; the digest keeps brute-force forensics (many failures against one identifier) possible without storing it.

**Negative**: `identifierDigest` values are not comparable across processes unless `identifierDigestKey` is configured; a consumer that wants the email of an invitation must read the invitation row, not the event.
