# P10 — Events, hooks & observability

Phase 2 · 33 open issues to fix (6 high, 19 medium, 8 low) · 11 closed by validation · ~133h summed per-issue estimate (upper bound) · 1 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `hook-registry-per-composition` — Per-composition hook registries with spec'd three-key tap ordering and introspection

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~20h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ELC-001](../slices/02-core-events-hooks.md) | medium | architecture | CONFIRMED | L | — | Move each point's tap registry out of the module closure into the point's own per-composition service: the point's `.layer` owns a `Ref` of registrations; `tap()` returns a Layer that *requires* the point (RIn = Self) and registers through it. Freezing becomes per-built-layer. |
| [JH-003](../slices/02-core-events-hooks.md) | medium | api | CONFIRMED | M | ELC-001 | Capture tap ownership and sort by the spec'd three keys (dependency order, declared order, plugin id) at freeze time, using the composition's topological order that Auth.make already computes. |
| [PERS-003](../slices/02-core-events-hooks.md) | medium | correctness | CONFIRMED | M | JH-003 | Make taps statically declarable on a plugin (the BEH-EA-024 illustration's `AuthPlugin.layer(Self, { make, taps: [...] })` shape) so Auth.make can print the resolved per-point order into its manifest without running anything; also expose the frozen order at runtime. |

Closed by validation in this workstream: GC-006 (DUPLICATE → ELC-001), TS-006-torin-sandall (DUPLICATE → JH-003), MW-004 (DUPLICATE → JH-003)

## `authn-failure-observability` — Observable session-verification failures

Slices: [06-server-api](../slices/06-server-api.md) · ~1h · depends on workstreams: `observability-substrate (MW-001, slice 02)`, `per-request-session-cache`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EOTS-003](../slices/06-server-api.md) | high | security | PARTIAL | S | MW-001, TS-003-tim-smart | The password half is fixed (f5eb570). Make session-verify failures observable in resolveSession without leaking credentials or session ids. |

## `observability-substrate` — (cross-slice) Observability substrate — canonical MW-001, slice 02 / HTTP tracer/request-logger re-exports and example wiring (wayfinder 27) / Implement wayfinder ticket 27: spans, field convention, metrics, redaction interceptor

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md), [06-server-api](../slices/06-server-api.md), [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~19h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EOTS-002](../slices/02-core-events-hooks.md) | high | compliance | CONFIRMED | M | MW-001 | Build a redaction-asserting Tracer + Logger in @awthaq/test, install it in TestAuth.layer, and run it inside runPluginContractTests (ticket 27 §5). |
| [MW-001](../slices/02-core-events-hooks.md) | high | architecture | CONFIRMED | L | — | Implement wayfinder ticket 27 in its stated order: HTTP re-exports, business-logic spans, field convention + metrics, then the redaction interceptor (EOTS-002). |
| [EOTS-005](../slices/02-core-events-hooks.md) | medium | correctness | CONFIRMED | S | MW-001 | Log a sanitized summary at error level and the full cause only at debug level, via one shared helper. |
| [EOTS-006](../slices/13-repo-features-tooling.md) | medium | dx | CONFIRMED | S | MW-001 | Follow wayfinder ticket 27 (MW-001's decision): re-export HttpMiddleware.tracer/logger from AuthHttp (not a bespoke AuthObservability logger — the decision leaves logging/metrics backends to the host), and make the example demonstrate the recommended composition: structured JSON logging + request logger + Effect.logInfo startup line. |
| [MAPS-007](../slices/02-core-events-hooks.md) | medium | dx | CONFIRMED | S | MW-001 | Annotate the principal/session on the current span at the shared resolution choke point, and rely on HttpMiddleware.tracer (MW-001) for W3C traceparent propagation. |

Closed by validation in this workstream: NHS-008 (DUPLICATE → MW-001)

## `core-hook-point-coverage` — Finish the spec'd core hook-point set (BeforeSignIn, AfterSignUp, BeforeSignUp on every creation path)

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~9h · depends on workstreams: `hook-registry-per-composition`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [NAM-002](../slices/02-core-events-hooks.md) | high | architecture | PARTIAL | M | — | Complete the core hook-point set the spec lists: add a `BeforeSignIn` veto consulted by every sign-in-completing flow, consult `BeforeSignUp` on OAuth (and any other) first-login user creation, add `AfterSignUp`, and document the Auth.js mapping. |
| [SCP-008](../slices/02-core-events-hooks.md) | low | architecture | PARTIAL | S | NAM-002 | Close the non-SCIM part now via NAM-002's plan (BeforeSignUp on every creation path); add deactivation hook/event points in the same change that implements ticket 09's deactivation state. |
| [TS-007-torin-sandall](../slices/02-core-events-hooks.md) | low | architecture | PARTIAL | M | NAM-002 | Extend examples/memory-server (or add examples/qadi-path-a) to compose Auth + AuthorizedSubject/SubjectExtractor (Path A) + one RequirePermission-protected endpoint + one BeforeSignUp domain-allow-list tap, and smoke-test it. |

## `auth-event-envelope` — Event envelope: eventId, occurredAt, correlation and trace linkage

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~8h · depends on workstreams: `auth-event-schema`, `auth-events-subscription`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ESA-002](../slices/02-core-events-hooks.md) | high | correctness | PARTIAL | M | ESA-007 | Stamp one envelope (eventId uuidv7 + occurredAt) in `publish`, use it for both the AuditLog row and the bus, and deliver it to subscribers. |
| [ALF-006](../slices/02-core-events-hooks.md) | medium | correctness | PARTIAL | M | ESA-002 | Introduce a request-scoped `AuthRequestContext` reference populated by the server layer and read by `publish`, and link subscriber handling to the originating span. |

Closed by validation in this workstream: EOTS-009 (DUPLICATE → ALF-006)

## `auth-operation-tracing` — Business-logic spans for auth operations (ticket 27 §2)

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EOTS-001](../slices/07-password-mfa.md) | high | architecture | CONFIRMED | M | — | Add ticket 27's business-logic spans via one shared helper, starting with every Password operation. |

## `auth-event-taxonomy` — Missing event tags and fields (sign-in failure dimensions, recovery, session lifecycle, user deletion)

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~10h · depends on workstreams: `auth-event-schema`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ARF-006](../slices/02-core-events-hooks.md) | medium | architecture | PARTIAL | S | — | Add and publish `auth.password.resetRequested` and `auth.user.emailVerified`. |
| [CSD-004](../slices/02-core-events-hooks.md) | medium | security | PARTIAL | M | — | Enrich the failure event with `ip` and a keyed, non-reversible `identifierDigest`, and publish it from every strategy's failure path. |
| [SCP-006](../slices/02-core-events-hooks.md) | medium | architecture | CONFIRMED | S | — | Add `auth.user.deleted` now (published after the deletion transaction commits); add `auth.user.deactivated`/`reactivated` together with ticket 09's deactivation state. |
| [RRS-008](../slices/02-core-events-hooks.md) | low | architecture | PARTIAL | M | — | Publish session lifecycle events from Sessions itself (both layers), not per plugin. |

## `hook-run-semantics` — Hook run semantics: sequential observe taps and schema-validated tap outputs

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~2h · depends on workstreams: `hook-registry-per-composition`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [JH-002](../slices/02-core-events-hooks.md) | medium | correctness | CONFIRMED | S | — | Run observe taps sequentially in resolved order (like veto/divert), and add an observer-failure metric next to the existing log line. |
| [JH-004](../slices/02-core-events-hooks.md) | medium | security | CONFIRMED | S | — | Validate every veto tap's returned value (and every divert tap's diverted value) against the point's own schema inside `run`, using `Schema.is` (a type guard over the already-passed schema — no decoding services, no type assertions). |

Closed by validation in this workstream: ECF-006 (DUPLICATE → JH-002), ERS-005 (DUPLICATE → JH-002), PERS-004 (DUPLICATE → JH-002), GC-009 (DUPLICATE → JH-004)

## `security-signal-pipeline` — Opt-in SecuritySignals threshold/incident layer

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~4h · depends on workstreams: `auth-event-taxonomy`, `auth-events-subscription`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CSG-008](../slices/02-core-events-hooks.md) | medium | security | PARTIAL | M | ALF-007, ESS-007, CSD-004 | Ship an opt-in `SecuritySignals` subscriber layer that applies configurable threshold rules over the security tags and emits incidents (log + metric + optional incident sink port). |

## `auth-events-subscription` — Race-free, supervised, ergonomic AuthEvents subscriptions

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~6h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ALF-007](../slices/02-core-events-hooks.md) | medium | correctness | CONFIRMED | S | — | Register the PubSub subscription synchronously during the subscription Layer's build, then fork the drain loop over that already-registered subscription. |
| [ESS-004](../slices/02-core-events-hooks.md) | medium | performance | PARTIAL | S | ALF-007 | Add a batched-subscription sugar next to `on()` and document it as the pattern for secondary sinks. |
| [ETVS-001](../slices/02-core-events-hooks.md) | medium | testing | CONFIRMED | S | ALF-007 | Once ALF-007 makes `on()` register synchronously, rewrite the test as `it.effect` with a handler-completed Deferred/Queue instead of sleeps. |
| [MA-009](../slices/02-core-events-hooks.md) | medium | correctness | PARTIAL | S | — | Apply wayfinder ticket 02's BEH-EA-098 rewording and document the dropping/droppedCount semantics in BEH-EA-097. |
| [ECF-010](../slices/02-core-events-hooks.md) | low | architecture | CONFIRMED | S | ALF-007 | Supervise each `on()` subscription: log when the drain fiber ends for any reason other than scope close, and resubscribe with bounded backoff. |
| [ESS-007-effect-stream-specialist](../slices/02-core-events-hooks.md) | low | architecture | CONFIRMED | S | ALF-007 | Let `on`/`onBatch` accept a tag array (one subscription, narrowed union type) and document the fan-out characteristic on `stream`; do not build per-tag PubSubs (speculative). |

Closed by validation in this workstream: ESS-003-effect-stream-specialist (DUPLICATE → ALF-007)

## `auth-event-external-delivery` — Cross-process delivery: outbox relay and webhooks

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~32h · depends on workstreams: `auth-event-envelope`, `auth-event-schema`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CWM-004](../slices/02-core-events-hooks.md) | medium | architecture | CONFIRMED ⚖️ decision | XL | ESA-007, ESA-002 | Per decision D2: build an outbox relay over auth_audit_log and an opt-in webhooks plugin on top of it; document the in-process recipe meanwhile. |

Closed by validation in this workstream: MAPS-010 (DUPLICATE → CWM-004)

## `events-delivery-durability` — Replayable durable event log (AuditLog.replay by sequence)

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ESA-003](../slices/13-repo-features-tooling.md) | medium | architecture | PARTIAL | M | — | Keep the bus at-most-once; make the durable AuditLog the recovery path: add a monotonic sequence and an ascending, cursor-based `replay` read (Stream) so consumers can backfill from a checkpoint. |

## `auth-event-schema` — Schema-first, versioned, branded AuthEvent payloads

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~14h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ESA-007](../slices/02-core-events-hooks.md) | low | architecture | CONFIRMED | L | — | Define every AuthEvent as an Effect Schema (TaggedStruct) with a `version` literal, derive the TS types from the schemas, and decode AuditLog payloads through the union codec. |
| [GC-007](../slices/02-core-events-hooks.md) | low | dx | CONFIRMED | S | ESA-007 | Brand session ids in the event union (type-only import to avoid a runtime cycle), as part of the ESA-007 schema migration. |
| [IDS-006](../slices/02-core-events-hooks.md) | low | security | CONFIRMED | S | — | Add attribution fields to the impersonation lifecycle events. |

