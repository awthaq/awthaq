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

`archive/PRD.md` §13 fixes the event bus as "bounded `PubSub`" among the domain stratum's core facts. A bounded queue is the mechanism that makes the next requirement (BEH-EA-098) actually enforceable in practice: with an unbounded queue, a publisher that "never awaits" a subscriber could still accumulate unbounded backlog for a subscriber that never catches up, which is a slower version of the same problem an unbounded queue is meant to avoid.

## BEH-EA-098: A publisher never awaits its subscribers

```text
REQUIREMENT: Publishing an event to `AuthEvents` MUST NOT suspend the
             publishing fiber on any subscriber's handling of that event;
             `publish` MUST return once the event is enqueued, regardless
             of how many subscribers exist or how long they take to run.
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

**Session lifecycle events are published by `Sessions` itself (ESA-006, TIR-008).** The session tags are not the responsibility of whichever plugin happens to mint or end a session: `Sessions.issue` publishes exactly one `auth.session.issued` (session, user and family id, `actingAs` when present) for every path — password, OAuth, passkey, admin impersonation, a legacy-session bridge, a `supersedes` rotation. Every revocation primitive (`revoke`, `revokeOwned`, `revokeOthers`, `revokeAll`, and reuse detection's family revocation) takes the reason the session ended (`signOut`, `userRevoked`, `passwordChanged`, `passwordReset`, `userDeleted`, `impersonationStopped`, `admin`, `reuseDetected`) and publishes exactly one `auth.session.revoked` (`sessionId` for a single row, `null` for `others`/`all`/`family` scope), after the delete, so sign-out, account deletion and admin stops reach subscribers and `AuditLog` ([BEH-EA-100](13-events.md)). `Sessions.verify` publishes `auth.session.expired` (`absolute` or `idle`) when a correctly-secreted credential is presented past its expiry — lazily, since no background reaper exists. Plugins MUST NOT publish these tags themselves; they pass reasons instead. Cross-reference: [BEH-EA-053](07-sessions.md), [BEH-EA-054](07-sessions.md).

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

`archive/design/usage-examples-v4.md` §15's `Analytics` subscriber is the direct example: a one-line call producing a Layer an application composes into its wiring the same way any other contribution (a hook tap, a rate-limit rule) is composed, per the registry-aggregation pattern in BEH-EA-024 — the isolation and fork-per-subscriber machinery is the sugar's responsibility, not something every subscriber author re-derives.

## BEH-EA-104: A failing subscriber is logged under a stable, queryable event name and never re-raised

> **Invariant:** [INV-EA-010](../invariants.md#inv-ea-010-verification-token-replay-is-observable--every-consumption-attempt-after-the-first-publishes-an-event)

```text
REQUIREMENT: A subscriber failure MUST be logged as `auth.event.observer.error`,
             carrying enough context to identify which subscription and
             which event triggered it, and MUST NOT be re-raised to any
             caller — it is terminal at the point it is logged.
```

`archive/design/usage-examples-v4.md` §15 fixes the log event's name directly. This gives operators a single, stable signal to alert on for "a subscriber is broken" (distinct from `auth.token.replay`, which signals a security event in the domain itself, per BEH-EA-059) without that signal ever becoming a second path by which a broken subscriber could affect request-serving code — the isolation BEH-EA-092 and BEH-EA-099 both require is only meaningful if the failure is observable somewhere, and this is the designed place it surfaces.

_Previous: [BEH-EA-096](12-hooks.md#beh-ea-096-the-resolved-order-of-every-hook-points-taps-is-introspectable-without-running-any-code)_
_Next: [BEH-EA-113](15-password.md#beh-ea-113-sign-up-issues-a-pending-user-and-a-verification-mail)_
