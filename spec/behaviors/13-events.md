# Events

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-13 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

> awthaq is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/PRD.md` §13 and `archive/design/usage-examples-v4.md` §15 — not code that has shipped.

## BEH-EA-097: `AuthEvents` is a bounded `PubSub`

> **See:** [ADR-EA-001](../decisions/001-plugins-contribute-layers.md)

```ts
const Audit = AuthEvents.on("auth.user.signedIn", (e) => AuditLog.use((a) => a.write({ kind: "sign-in", userId: e.userId, strategy: e.strategy })))
```

```text
REQUIREMENT: `AuthEvents`'s underlying `PubSub` MUST be bounded (a finite
             capacity, not `PubSub.unbounded`), so that a slow or absent
             subscriber cannot cause unbounded memory growth in the
             publishing process.
```

**As shipped (MA-009, wayfinder ticket 02):** the bus is a bounded *dropping* `PubSub` (capacity 1024): at capacity a new event is dropped from the bus — never from the durable audit table (BEH-EA-100) — counted by `AuthEvents.droppedCount` and the `awthaq_event_dropped_total{tag}` metric, and logged as a warning. The bus is therefore at-most-once observation within one process; anything that must not lose events backfills from `AuditLog.replay` (BEH-EA-102) or tails the audit table through the outbox relay.

`archive/PRD.md` §13 fixes the event bus as "bounded `PubSub`" among the domain stratum's core facts. A bounded queue is the mechanism that makes the next requirement (BEH-EA-098) actually enforceable in practice: with an unbounded queue, a publisher that "never awaits" a subscriber could still accumulate unbounded backlog for a subscriber that never catches up, which is a slower version of the same problem an unbounded queue is meant to avoid.

## BEH-EA-098: A publisher never awaits its subscribers

```text
REQUIREMENT: Publishing an event to `AuthEvents` MUST NOT suspend the
             publishing fiber on any subscriber's handling of that event,
             or on the bus's own capacity; `publish` MUST return
             immediately whether or not the event was accepted into the
             bounded buffer, regardless of how many subscribers exist or
             how long they take to run.
```

`archive/PRD.md` §13 states this directly: "publishers never await; the audit table is the record of record." This is what keeps event publication decoupled from the operation that triggers it — a sign-in is not slower because an analytics subscriber is slow, and a sign-in does not fail because a subscriber fails, which is the same isolation principle BEH-EA-092 requires of observe-kind hook taps, applied here to the event bus instead of the hook-point mechanism.

## BEH-EA-099: Subscribers run on forked, isolated fibers — a failing subscriber cannot affect the publisher or any other subscriber

```ts
yield* AuthEvents.use((ev) => ev.stream.pipe(Stream.filter((e) => e._tag === "auth.token.replay"), Stream.runForEach(alertSecurity), Effect.forkScoped))
```

```text
REQUIREMENT: Each subscription to `AuthEvents`'s stream MUST run on its own
             forked fiber; a failure in one subscriber's handling of an
             event MUST be caught and logged, and MUST NOT propagate to the
             publisher or to any other subscriber's fiber.
```

`archive/design/usage-examples-v4.md` §15 documents the isolation directly: "A failing subscriber is logged with `auth.event.observer.error` and does not fail the operation." The same file's worked example shows a security-alerting subscriber filtering the stream for `auth.token.replay` events (BEH-EA-059) on its own `forkScoped` fiber — one subscriber's concern (alerting) is structurally incapable of interfering with another's (analytics, audit) or with the request that produced the event.

## BEH-EA-100: The audit table is the durable record of record, independent of the `PubSub` stream

```text
REQUIREMENT: The audit trail of security-relevant operations MUST be
             written durably (to persistence) as part of the operation
             itself, and MUST NOT depend on any `AuthEvents` subscriber
             being present, running, or having succeeded.
```

`archive/PRD.md` §13's own phrasing draws the line precisely: "publishers never await subscribers; the audit table is the record of record." `AuthEvents` is designed for observation — analytics, alerting, cross-cutting reactions — while the audit table is the durable ground truth a security review or an incident investigation is meant to consult; the two are deliberately not the same mechanism, so that disabling or misconfiguring event subscribers can never cause an audit gap.

**Cross-process delivery (CWM-004, ADR-EA-030).** The bus is in-process and at-most-once, so the audit table is also the outbox: `EventRelay.layer({ name })` (opt-in) tails it from a persisted position (`RelayCursorStore`, `auth_relay_cursor`) into an application-provided `EventTransport`, advancing only after the transport accepted the batch — at-least-once, idempotent on `eventId`, an event relayed once it is `settleDelay` old so a late-committing row is not skipped (`packages/core/test/EventRelay.test.ts`).

**As shipped (ALF-010, ADR-EA-031):** the audit trail is kept for ever by default. `Retention.config({ auditLog: { default, rules } })` opts in to purge windows — `rules` are per-event-class (`{ tags, keepFor }`), `default` covers every tag no rule names — and only `Retention.sweep` (`AuditLog.purge`) deletes, in bounded batches over the `occurredAt` index (core migration 26). `admin_impersonation` and its hash chain are never purged (ADR-EA-031). `packages/core/test/Retention.test.ts`, `packages/sql/test/contract.ts` ("AuditLog.deleteOccurredBefore ...").

## BEH-EA-101: Events are typed, tagged values forming a registry contract

```ts
"auth.user.created" | "auth.user.signedIn" | "auth.token.replay"
| "auth.session.issued" | "auth.session.revoked" | "auth.session.expired" | "auth.session.reuse" | "auth.mail.failed"
```

```text
REQUIREMENT: Every event published to `AuthEvents` MUST be a tagged value
             from a closed, statically-known set of event types the
             registry declares; a subscriber filtering or handling by tag
             MUST be able to rely on the payload shape associated with that
             tag.
```

`archive/design/usage-examples-v4.md` §15 and §19 show events named this way (`auth.user.signedIn`, `auth.user.created`, `auth.token.replay`, `auth.session.issued`) with payloads a subscriber destructures directly (`e.userId`, `e.strategy`). Treating the event set as a registry — the same aggregation pattern BEH-EA-024 describes for hook taps and rate-limit rules — is what lets a plugin author add a new event tag without breaking existing subscribers filtering on the tags they already know about.

**The registry is schema-first and versioned (ESA-007).** Every event is an Effect `Schema` (`Schema.TaggedStruct`) in `packages/core/src/AuthEventSchemas.ts` and its TypeScript type is derived from it; `AuthEventSchema` is the union codec. The durable audit row stores the encoded event plus a `version` (currently `1`), so `AuditLog` decodes every stored payload back into a typed `AuthEvent` (a row that no longer decodes surfaces as the typed `AuditLogDecodeError`, never `unknown`). A breaking payload change bumps `EVENT_VERSION` and adds an upcaster in `upcastPayload`; rows written under an older version stay decodable. Id fields are branded (`UserId`, `SessionId`) so a bare string does not type-check (GC-007).

**Every delivered event is an envelope (ESA-002, ALF-006).** `publish` stamps one envelope — `eventId` (a time-ordered, uuidv7-shaped id, monotonic within a process), `occurredAt`, `correlationId`, `ip`, `userAgent` (from `AuthRequestContext`, populated by the server per request), and `traceId`/`spanId` of the span current at the publish site — and uses it for both the `AuditLog` row (whose `id` *is* the `eventId`) and the bus event, so a subscriber joins its event to the durable row by equality. `AuditLog.list` orders newest-first with `id` as the tiebreak, so the order is total.

**PII posture (ESA-005, ADR-EA-029).** Payloads are identifiers-only: no email address and no free text about a person reaches the bus or the audit table (`auth.organization.invitationCreated` carries `invitationId`, not the invitee's email); a subscriber that needs contact details resolves the id through the record store, which the erasure cascade owns. The one free-text field, the impersonation justification, is declared in `PII_FIELDS`. On user erasure `AuditLog.pseudonymizeActor(userId)` rewrites every row naming the user (as actor or anywhere in its payload) to a fresh random alias — the same alias across that user's rows, unrelated to the id — and blanks the declared free-text fields, keeping row id, tag, timestamp and correlation, so the forensic timeline survives. Subscribing to the stream is an audit-read-level privilege.

**Taxonomy additions.** `auth.password.resetRequested` (a real account only, published from inside the detached mail branch so it adds no enumeration side channel, ARF-006), `auth.user.emailVerified` (ARF-006), `auth.user.deleted` (after the deletion commits, no email, SCP-006), `auth.user.dataExported` (each data-subject export, ids only and who requested it, CSG-005), `auth.session.rotated` (only the winning rotation) and `auth.session.superseded` (RRS-008). `auth.user.signInFailed` is published by every strategy and carries `clientIp` and, for the password strategy, `identifierDigest` — a keyed HMAC of the normalized attempted identifier, computed identically for real and nonexistent accounts, so a detector can key velocity on it without an existence oracle (CSD-004). The impersonation events name both parties and, for a denial, the refused operation and attempted target/session (IDS-006).

**Session lifecycle events are published by `Sessions` itself (ESA-006, TIR-008).** The session tags are not the responsibility of whichever plugin happens to mint or end a session: `Sessions.issue` publishes exactly one `auth.session.issued` (session, user and family id, `actingAs` when present) for every path — password, OAuth, passkey, admin impersonation, a legacy-session bridge, a `supersedes` rotation. Every revocation primitive (`revoke`, `revokeOwned`, `revokeOthers`, `revokeAll`, and reuse detection's family revocation) takes the reason the session ended (`signOut`, `userRevoked`, `passwordChanged`, `passwordReset`, `userDeleted`, `impersonationStopped`, `admin`, `reuseDetected`) and publishes exactly one `auth.session.revoked` (`sessionId` for a single row, `null` for `others`/`all`/`family` scope), after the delete, so sign-out, account deletion and admin stops reach subscribers and `AuditLog` ([BEH-EA-100](13-events.md)). `Sessions.verify` publishes `auth.session.expired` (`absolute` or `idle`) when a correctly-secreted credential is presented past its expiry — lazily, since no background reaper exists. Plugins MUST NOT publish these tags themselves; they pass reasons instead. Cross-reference: [BEH-EA-053](07-sessions.md), [BEH-EA-054](07-sessions.md).

**CLI-published events (ECS-006, ECS-002).** `awthaq seed admin` publishes `auth.admin.seeded` (target user id, `created` or `promoted`, the `forced` flag, the role, `via: "cli"`) after a successful grant and `auth.admin.seedRefused` (`reason: "adminExists"`, no address) when it refuses (BEH-EA-206); `awthaq import --yes` publishes one `auth.import.completed` or `auth.import.failed` per run (source, run id, imported/skipped/failed/unmapped counts, BEH-EA-207). All four are `AuthEvent` members, so `AuditLog` records them durably (BEH-EA-100) without a subscriber; a CLI run has no session, so none has an actor user except the seeded target's own id in the payload.

## BEH-EA-102: The raw event stream is available for direct, low-level consumption

```ts
yield* AuthEvents.use((ev) => ev.stream.pipe(Stream.filter(/* … */), Stream.runForEach(/* … */), Effect.forkScoped))
```

```text
REQUIREMENT: `AuthEvents` MUST expose its underlying `stream` directly, in
             addition to the `on(tag, handler)` sugar (BEH-EA-103), so that
             a consumer needing custom filtering, batching, or multiplexing
             across several tags is not limited to the one-tag-one-handler
             shape.
```

**As shipped (ALF-007, ESS-004, ESS-007, ESA-003).** `stream` is lazy: it registers a subscription when a fiber first pulls, so an event published before that is not seen. `AuthEvents.subscribe` registers the subscription *now*, in the caller's `Scope`, and returns the stream — the race-free way to attach; `on`/`onBatch` are built on it. Every consumer is a full subscriber of the one bus, so prefer one multi-tag `on([...], h)` over many single-tag ones. `AuditLog.replay({ after, eventTag, batchSize })` is the recovery path: an ascending, cursor-based `Stream` over the durable log (the cursor is the last `eventId` handled), so a consumer that starts late or restarts backfills from its checkpoint, then tails the live stream and deduplicates on `eventId`.

`archive/design/usage-examples-v4.md` §15 shows both forms side by side: `AuthEvents.on(...)` for the common case, and direct `ev.stream` access piped through `Stream.filter`/`Stream.runForEach` for the security-alerting example that needs to select on a predicate rather than a single tag. Exposing both is designed so the common case stays terse without foreclosing the less common one.

## BEH-EA-103: `AuthEvents.on(tag, handler)` is sugar that produces a subscription Layer

```ts
const Analytics = AuthEvents.on("auth.user.created", (e) => Segment.use((s) => s.track("signup", { userId: e.userId })))
```

```text
REQUIREMENT: `AuthEvents.on(tag, handler)` MUST return a `Layer` that,
             when provided, establishes a subscription satisfying
             BEH-EA-099's isolation guarantee — a plugin author MUST NOT
             need to write `Stream.runForEach`/`Effect.forkScoped`
             themselves to get a correctly isolated subscriber.
```

**As shipped (ALF-007, ESS-007, ESS-004, ECF-010).** The subscription is registered synchronously while the Layer builds, then the drain is forked, so an event published right after the Layer is up is delivered. `on` accepts one tag or an array (one subscription, the handler narrowed to the union of the selected events). `onBatch(select, { size, within }, handler)` is the batched twin — up to `size` events, or whatever arrived within `within` of the first — the pattern for a secondary sink (SIEM export, warehouse loader) that wants one round trip per batch; a failed batch is logged and dropped, so a sink that must not lose events checkpoints on `eventId` and backfills with `replay`. If the drain fiber ends for any reason other than the Layer's scope closing, it is logged as `auth.event.subscription.died` and resubscribed with bounded exponential backoff (events published in that gap are the bus's at-most-once loss). Each handler runs under an `awthaq.event.handle` span linked to the publishing span, with the correlation id annotated on its logs.

**A detector built on it (CSG-008).** `SecuritySignals.layer` (opt-in, like `Retention.layerScheduled`) is one such subscription over the security tags: a sliding window per (rule, key) over the envelope's `occurredAt`, and an incident when a rule's threshold is reached inside its window. The default rules cover a session reuse and a passkey counter anomaly (one event each), replayed verification tokens (5 per identifier in 10 minutes, the incident never names the identifier), failed sign-ins (10 per source address and 5 per identifier digest in 10 minutes) and denied impersonation attempts (3 per admin in 10 minutes); `SecuritySignals.config({ rules })` replaces them. An incident is a `warning` log `auth.security.incident`, `awthaq_security_incident_total{rule}`, and the `IncidentSink` reference an application backs with a table or pager (a failing sink is logged, never fatal). It detects over the bus's at-most-once delivery; the durable trail remains `AuditLog` (`packages/core/test/SecuritySignals.test.ts`).

`archive/design/usage-examples-v4.md` §15's `Analytics` subscriber is the direct example: a one-line call producing a Layer an application composes into its wiring the same way any other contribution (a hook tap, a rate-limit rule) is composed, per the registry-aggregation pattern in BEH-EA-024 — the isolation and fork-per-subscriber machinery is the sugar's responsibility, not something every subscriber author re-derives.

## BEH-EA-104: A failing subscriber is logged under a stable, queryable event name and never re-raised

> **Invariant:** [INV-EA-010](../invariants.md#inv-ea-010-verification-token-replay-is-observable--every-consumption-attempt-after-the-first-publishes-an-event)

```text
REQUIREMENT: A subscriber failure MUST be logged as `auth.event.observer.error`,
             carrying enough context to identify which subscription and
             which event triggered it, and MUST NOT be re-raised to any
             caller — it is terminal at the point it is logged.
```

**As shipped (EOTS-005).** The error-level line carries only a sanitized summary (`errorTag` and a truncated message — never the error's data fields, where a token or identifier could ride); the raw `Cause` is logged only at debug level. The failure is also counted in `awthaq_event_observer_error_total{tag}` (`awthaq_hook_observer_error_total{hook}` for hook taps, BEH-EA-092).

`archive/design/usage-examples-v4.md` §15 fixes the log event's name directly. This gives operators a single, stable signal to alert on for "a subscriber is broken" (distinct from `auth.token.replay`, which signals a security event in the domain itself, per BEH-EA-059) without that signal ever becoming a second path by which a broken subscriber could affect request-serving code — the isolation BEH-EA-092 and BEH-EA-099 both require is only meaningful if the failure is observable somewhere, and this is the designed place it surfaces.

_Previous: [BEH-EA-096](12-hooks.md#beh-ea-096-the-resolved-order-of-every-hook-points-taps-is-introspectable-without-running-any-code)_
_Next: [BEH-EA-113](15-password.md#beh-ea-113-sign-up-issues-a-pending-user-and-a-verification-mail)_
