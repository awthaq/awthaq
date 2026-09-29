# ADR-EA-030: Events Cross Process Boundaries by Tailing the Audit Log, Not by Widening the Bus

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-030 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — relay and the first-party webhooks plugin implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (CWM-004, MAPS-010, D2); 1.1 (2026-09-29): the first-party `@awthaq/webhooks` plugin is built (Decision 7 rewritten; [BEH-EA-275 through 265](../behaviors/34-webhooks.md)) |

---

## Context

`AuthEvents` is an in-process, bounded, at-most-once bus (BEH-EA-097/098): it never suspends a publisher, so at capacity the bus copy is dropped (counted), and a subscriber in another process never sees it. That is right for an in-process reaction (`AuthEvents.on`) and wrong for another service, a webhook fan-out, a SIEM, or a cache that must learn a session was revoked. Every event, however, already reaches the durable audit log inside the publishing operation (BEH-EA-100), each row carrying a time-ordered id.

## Decision

1. **The transport seam is the audit log, tailed.** `EventRelay.layer({ name })` is an opt-in background fiber that reads `AuditLog` after a persisted position, hands events (the typed event plus its envelope, exactly what a live subscriber sees) to an application-provided `EventTransport` (Redis, Kafka, SQS, an HTTP call), and advances the position only after the transport accepted the batch. The bus is not made durable or distributed; nothing on the write path changes.
2. **At-least-once, idempotent on `eventId`.** A failed delivery leaves the position and is retried with capped exponential backoff; a crash between delivery and the position write redelivers that batch. Consumers deduplicate on `eventId` (the audit row's id).
3. **Ordering is by id, with a settle delay.** Ids are publish order within a process and millisecond-granular across processes, so a row committed late by a slower process could land behind the position. An event is relayed once it is `settleDelay` old (default 2 s). This trades latency for not skipping a row.
4. **The position is a table, one row per relay name** (`auth_relay_cursor`, core migration 27; `RelayCursorStore.layerCursorSql`, with a memory store for tests). Relays with different names (one per consumer) are independent. Two processes running one name both deliver: safe, but run one per name.
5. **A row that no longer decodes stops the relay at that row**, loudly (`auth.relay.failed`, `awthaq_relay_failures_total{relay}`), rather than skipping an event silently.
6. **Posture.** What crosses the transport is identifiers and envelope only (ADR-EA-029), so an external consumer inherits it. Erasure pseudonymizes rows that a relay has not yet delivered; rows already delivered are the consumer's to erase on `auth.user.deleted`.
7. **Webhooks are a consumer of this seam, not part of it.** The first-party, opt-in `@awthaq/webhooks` plugin is an `EventTransport` over the relay. Its design, and why:
   - **The transport only enqueues.** `deliver` inserts one `webhooks_delivery` row per (endpoint, event) — unique on that pair, so the relay's redelivered batch adds nothing — and returns; a separate worker sends. One relay cursor is one stream, so a transport that made the HTTP calls would let a single dead receiver stall every other endpoint and the cursor itself. Queue-then-send gives each endpoint its own retry clock and dead-letter state, and the cursor advances when the batch is durably queued.
   - **Signed like Standard Webhooks**: `webhook-id` = `eventId` (stable across retries), `webhook-timestamp` re-stamped per attempt, HMAC-SHA256 `webhook-signature` under a per-endpoint `whsec_` secret that is generated here, shown once and stored only as an `Encryption` envelope; a rotation signs with both secrets for a grace window. `WebhookSignature.verify` is exported for receivers (replay window, constant-time compare).
   - **At-least-once with retry, capped exponential backoff, dead-letter, a manual redrive, and auto-disable** after consecutive dead-letters; claims are leased, so two workers never send one row at once and a dead worker's row is sent again.
   - **Endpoint URLs are an SSRF surface**: https only, no credentials, no private/loopback/link-local/reserved address or internal name (`OutboundUrl` in `@awthaq/ports`), and the name must resolve to public addresses only (`HostResolver`), at registration and again on every attempt; redirects are never followed; response bodies are never read or stored. DNS rebinding is narrowed, not closed (egress filtering remains the deployer's).
   - **Payloads are identifiers only** ([ADR-EA-029](029-event-pii-posture.md)): declared free text is dropped, the client address only with `includeClientContext`, and credential- or contact-named fields are always dropped.
   - **Administration is fail-closed** (`canManageWebhooks`, deny by default) on the admin tier, rate limited per administrator; the delivery log takes part in account erasure and export and is pruned after `deliveryRetention`.
   Per-endpoint event filters (`*`, families, exact tags) are validated against the tags the library publishes. Audit rows carry no tenant id, so an endpoint is platform-wide, not per-tenant; scoping deliveries by tenant needs the tenant on the audit row first.

## Alternatives considered

**Make the bus durable/distributed** (a Redis-backed `PubSub`). Rejected: it duplicates the audit table's guarantees with a second store and a new operational dependency, and it does not give a resumable position.

**Push from `publish`.** Rejected: it puts a network call on every operation's path, or needs its own outbox anyway.

## Consequences

**Positive**: reliable cross-process delivery with no new write-path cost, resumable and replayable from any `eventId` (`AuditLog.replay`); the same table serves forensics and delivery.

**Negative**: delivery lags the bus by `settleDelay` plus the poll interval; a transport must be idempotent; an unbounded log means a relay that starts at the beginning replays history (seed with `startAfter`).
