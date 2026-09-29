# ADR-EA-030: Events Cross Process Boundaries by Tailing the Audit Log, Not by Widening the Bus

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-030 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — relay implemented; first-party webhooks plugin not yet built |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (CWM-004, MAPS-010, D2) |

---

## Context

`AuthEvents` is an in-process, bounded, at-most-once bus (BEH-EA-097/098): it never suspends a publisher, so at capacity the bus copy is dropped (counted), and a subscriber in another process never sees it. That is right for an in-process reaction (`AuthEvents.on`) and wrong for another service, a webhook fan-out, a SIEM, or a cache that must learn a session was revoked. Every event, however, already reaches the durable audit log inside the publishing operation (BEH-EA-100), each row carrying a time-ordered id.

## Decision

1. **The transport seam is the audit log, tailed.** `EventRelay.layer({ name })` is an opt-in background fiber that reads `AuditLog` after a persisted position, hands events (the typed event plus its envelope, exactly what a live subscriber sees) to an application-provided `EventTransport` (Redis, Kafka, SQS, an HTTP call), and advances the position only after the transport accepted the batch. The bus is not made durable or distributed; nothing on the write path changes.
2. **At-least-once, idempotent on `eventId`.** A failed delivery leaves the position and is retried with capped exponential backoff; a crash between delivery and the position write redelivers that batch. Consumers deduplicate on `eventId` (the audit row's id).
3. **Ordering is by id, with a settle delay.** Ids are publish order within a process and millisecond-granular across processes, so a row committed late by a slower process could land behind the position. An event is relayed once it is `settleDelay` old (default 2 s). This trades latency for not skipping a row.
4. **The position is a table, one row per relay name** (`auth_relay_cursor`, core migration 22; `RelayCursorStore.layerCursorSql`, with a memory store for tests). Relays with different names (one per consumer) are independent. Two processes running one name both deliver: safe, but run one per name.
5. **A row that no longer decodes stops the relay at that row**, loudly (`auth.relay.failed`, `awthaq_relay_failures_total{relay}`), rather than skipping an event silently.
6. **Posture.** What crosses the transport is identifiers and envelope only (ADR-EA-029), so an external consumer inherits it. Erasure pseudonymizes rows that a relay has not yet delivered; rows already delivered are the consumer's to erase on `auth.user.deleted`.
7. **Webhooks are a consumer of this seam, not part of it.** A first-party `@awthaq/webhooks` plugin (endpoint table, Standard-Webhooks-style HMAC signing headers with `webhook-id` = `eventId`, retry, dead-letter, admin API) is an `EventTransport` over the relay. It is not built; the docs give the in-process recipe and the relay in the meantime.

## Alternatives considered

**Make the bus durable/distributed** (a Redis-backed `PubSub`). Rejected: it duplicates the audit table's guarantees with a second store and a new operational dependency, and it does not give a resumable position.

**Push from `publish`.** Rejected: it puts a network call on every operation's path, or needs its own outbox anyway.

## Consequences

**Positive**: reliable cross-process delivery with no new write-path cost, resumable and replayable from any `eventId` (`AuditLog.replay`); the same table serves forensics and delivery.

**Negative**: delivery lags the bus by `settleDelay` plus the poll interval; a transport must be idempotent; an unbounded log means a relay that starts at the beginning replays history (seed with `startAfter`).
