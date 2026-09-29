# Slice `02-core-events-hooks` — validation & fix plan

- **Validated at:** `ec065a7` (HEAD) on 2026-09-29
- **Scope:** `packages/core/src/AuthEvents.ts`, `packages/core/src/HookPoint.ts` (+ `Hooks.ts`, `AuditLog.ts` as they now bear on these findings), `packages/test/src/TestAuth.ts`, `packages/core/test/AuthEvents.test.ts` — 53 issues
- **Machine-readable twin:** `.plan/slices/02-core-events-hooks.json`

## Counts (verdict × level)

| Verdict | high | medium | low | info | total |
|---|---|---|---|---|---|
| CONFIRMED | 2 | 14 | 5 | 0 | 21 |
| PARTIAL | 2 | 8 | 3 | 0 | 13 |
| ALREADY-FIXED | 0 | 5 | 1 | 1 | 7 |
| INVALID | 0 | 0 | 0 | 0 | 0 |
| DUPLICATE | 0 | 2 | 8 | 2 | 12 |
| WONTFIX-CANDIDATE | 0 | 0 | 0 | 0 | 0 |
| **total** | 4 | 29 | 17 | 3 | 53 |

## Summary

A lot moved since the 2026-09-19 audit. Three commits closed the headline items in this area. `4b48cb2` switched the bus to `PubSub.dropping` with a `droppedCount`, so publishing never suspends. `6bd3f1d` added a durable `AuditLog` that `publish` writes inline. `3e298c8` declared `Hooks.ts` (BeforeSignUp/AfterSignIn/BeforeSessionIssue/BeforeUserDelete) and wired those points into the password, OAuth, passkey and users flows. Event-taxonomy commits (`f5eb570`, `45325bb`, `9017a8a`) added signInFailed, password and session events, and session reuse. As a result, 7 findings are already fixed and 13 more are only partly open.

Four real problems remain:

1. **HookPoint's tap registry is still module-level state.** It freezes process-wide, it pushed the GDPR erasure taps into opt-in side exports, and `tap()` has an empty RIn, which breaks INV-EA-005. Tap order also still ignores dependency order and plugin id.
2. **Events carry no envelope.** There is no eventId, occurredAt, correlation or trace on the bus. Payloads are plain interfaces with no codec or version, yet they are now stored forever in `auth_audit_log`, raw PII included, with no erasure path.
3. **`AuthEvents.on` has a startup attach race.** Its fiber is also unsupervised, and the repo's own test works around the race with real sleeps.
4. **The observability substrate that wayfinder ticket 27 decided has not been built.** There are no spans, metrics or redaction interceptor, and BEH-EA-199 is still unenforced.

On the test-kit side, the contract suite still 'verifies' migration determinism by comparing JSON, and the canonical starters still ship a permissive limiter and a Node-only Crypto layer.

**Discovered while validating (not in the manifest, recorded in the JSON as `cross_slice_notes`):**
- INV-EA-005/BEH-EA-094 is violated at HEAD: HookPoint `tap()` returns Layer<never> with empty RIn, yet spec/traceability.md:112 claims the TypeScript compiler enforces it. Folded into ELC-001's plan.
- packages/core/src/RateLimits.ts:18-21 claims HookPoint's per-point registries are scoped to a built service/closure 'rather than a module-level global' — inaccurate until ELC-001 lands.
- Wayfinder ticket 30 decided an ErasureRegistry ('not a hook'), but CSG-001/DRS-002 (ec065a7) implemented erasure as BeforeUserDelete veto taps shipped as opt-in side exports because of the module-singleton registry. The data-retention/erasure slice should reconcile; ELC-001 removes the reason for the opt-in split.
- The auth_audit_log table has no retention/erasure path (ticket 01 deferred it to ticket 30, whose Retention/erasure design does not mention auth_audit_log) — see D1.
- ID collision in .issues/: ESS-00N exists for both effect-schema-specialist and effect-stream-specialist; commit e3059f2's 'ESS-004' is the schema one, not this slice's stream ESS-004.

## Workstreams

### `auth-events-subscription` — Race-free, supervised, ergonomic AuthEvents subscriptions

- **Closes:** ALF-007, ESS-003, ETVS-001, ECF-010, ESS-004, ESS-007, MA-009
- **Effort:** M · **Order hint:** 1 · **Depends on workstreams:** —
- **Why grouped:** All touch `AuthEvents.on`/subscription plumbing: the attach race and its sleep-based test, missing supervision, missing multi-tag/batched sugar, and the BEH-EA-097/098 spec wording left behind by the dropping fix.
- **Ordered steps:**
  1. ALF-007: `subscribe` (PubSub.subscribe + Stream.fromSubscription) and use it in on().
  2. ETVS-001: rewrite the BEH-EA-103 test deterministically.
  3. ECF-010: resubscribe-with-backoff + subscription.died log.
  4. ESS-007: multi-tag on().
  5. ESS-004: onBatch via groupedWithin.
  6. MA-009: BEH-EA-097/098 rewording.
- **Test plan:** AuthEvents.test.ts: publish-immediately-after-build delivered; supervised restart; multi-tag; onBatch under TestClock; no it.live.
- **Acceptance:** No startup event loss; no real-time sleeps; spec matches dropping semantics.

### `hook-registry-per-composition` — Per-composition hook registries with spec'd three-key tap ordering and introspection

- **Closes:** ELC-001, GC-006, JH-003, TS-006, MW-004, PERS-003
- **Effort:** L · **Order hint:** 1 · **Depends on workstreams:** —
- **Why grouped:** All six trace to HookPoint.ts's module-scoped registry: no composition scoping, a global sequence counter, no plugin identity at tap time, hence no dependency/plugin-id ordering and nothing to introspect. The registry move (ELC-001) is what makes owner-aware ordering (JH-003) and manifest/runtime introspection (PERS-003) clean; it also restores BEH-EA-094's compile-time check.
- **Ordered steps:**
  1. ELC-001: move registries into each point's built layer; tap() requires the point (RIn); delete nextSequence; fold erasure taps back into plugin layers.
  2. JH-003: TapOptions.owner + PluginOrder reference provided by Auth.make's composeLayer; sort by (dep index, order, owner id, sequence) at freeze.
  3. PERS-003: AuthPlugin.layer({ taps }) declarations + manifest.hooks + runtime `resolved`, sharing one comparator.
- **Test plan:** New HookPoint.test.ts cases: cross-composition isolation, @ts-expect-error for an unprovided point, dependency-order tie-breaking, `resolved` without execution; Auth.test.ts manifest.hooks.
- **Acceptance:** No module-level state in HookPoint.ts; resolved order is a pure function of the plugin tuple + declared orders; INV-EA-005 has a real type test; erasure taps no longer opt-in.

### `observability-substrate` — Implement wayfinder ticket 27: spans, field convention, metrics, redaction interceptor

- **Closes:** MW-001, EOTS-002, MAPS-007, EOTS-005
- **Effort:** L · **Order hint:** 1 · **Depends on workstreams:** —
- **Why grouped:** Ticket 27 decided the design (MW-001) and names the others as built on it; none of it exists at HEAD.
- **Ordered steps:**
  1. MW-001: AuthHttp tracer/logger re-exports; business spans; Observability.ts vocabulary + metrics; ADR.
  2. MAPS-007: principal/session annotations at resolvePrincipal.
  3. EOTS-005: sanitized observer-error logging helper.
  4. EOTS-002: RedactionGuard Tracer/Logger in @awthaq/test wired into runPluginContractTests and TestAuth.
- **Test plan:** Recording-Tracer span tests; metric value tests; RedactionGuard failing fixture; REQ-EA-566 executable.
- **Acceptance:** BEH-EA-199 mechanically enforced; spans/metrics exist at the listed boundaries.

### `auth-event-schema` — Schema-first, versioned, branded AuthEvent payloads

- **Closes:** ESA-007, GC-007, IDS-006
- **Effort:** L · **Order hint:** 2 · **Depends on workstreams:** —
- **Why grouped:** Payload-shape work on the same union; doing the Schema migration first means the brand and attribution changes are authored once as schemas and the audit table gets a real codec.
- **Ordered steps:**
  1. ESA-007: TaggedStruct schemas + union codec + version; AuditLog decodes payloads.
  2. GC-007: SessionId brand on all session-id fields.
  3. IDS-006: denied/stopped attribution fields.
- **Test plan:** AuditLog.test.ts round-trip per variant (SQLite); type test for SessionId; Admin.test.ts attribution.
- **Acceptance:** AuditLogRecord.payload is AuthEvent; no plain-string session ids in events.

### `canonical-starter-defaults` — Production-safe defaults in README/examples (rate limiter, edge crypto)

- **Closes:** RBS-007, ERAS-002
- **Effort:** S · **Order hint:** 2 · **Depends on workstreams:** —
- **Why grouped:** Both are about what the canonical starting templates compose: a permissive limiter and a Node-only Crypto provider.
- **Ordered steps:**
  1. RBS-007: RateLimiter.layerMemory composite, docs/example default, permissive warning.
  2. ERAS-002: @awthaq/ports WebCrypto.layer + docs + parity test.
- **Test plan:** RateLimiter.layerMemory enforcement + warning; WebCrypto parity test.
- **Acceptance:** Copying README yields real limiting; edge apps have a documented Crypto layer.

### `hook-run-semantics` — Hook run semantics: sequential observe taps and schema-validated tap outputs

- **Closes:** JH-002, ECF-006, ERS-005, PERS-004, JH-004, GC-009
- **Effort:** S · **Order hint:** 2 · **Depends on workstreams:** hook-registry-per-composition
- **Why grouped:** Both concern what `run` does with taps now that points guard real sign-up/sign-in: observe order is discarded by unbounded concurrency, and veto/divert outputs bypass the point schema.
- **Ordered steps:**
  1. JH-002: sequential observe + awthaq_hook_observer_error_total metric + docs.
  2. JH-004: Schema.is-validate veto amendments and divert outcomes; die with HookTapOutputInvalid naming point/owner.
- **Test plan:** HookPoint.test.ts: observe order under TestClock; invalid veto/divert output is a defect.
- **Acceptance:** Declared order is real for all three kinds; no `void input` remains.

### `test-harness-completeness` — TestAuth memory bundle completeness and real migration determinism

- **Closes:** SSMS-004, ETVS-005, ETVS-004
- **Effort:** M · **Order hint:** 2 · **Depends on workstreams:** —
- **Why grouped:** Both are about @awthaq/test's harness overclaiming (whole pipeline over memory; migrations applied deterministically).
- **Ordered steps:**
  1. SSMS-004: double-apply migrations on fresh SQLite and compare sqlite_master; rename static check.
  2. ETVS-004: add Verification/PasswordHasher, rename middleware→services, migrate hand-rolled suites.
- **Test plan:** runPluginContractTests nondeterministic-migration fixture; TestAuth password composition test.
- **Acceptance:** Contract suite executes migrations; one memory assembly across suites.

### `auth-event-envelope` — Event envelope: eventId, occurredAt, correlation and trace linkage

- **Closes:** ESA-002, ALF-006, EOTS-009
- **Effort:** M · **Order hint:** 3 · **Depends on workstreams:** auth-event-schema, auth-events-subscription
- **Why grouped:** The durable row already has time/id; the bus event does not, and nothing correlates events to requests. One envelope stamped in publish fixes all three.
- **Ordered steps:**
  1. ESA-002: Published<E> = E & EventMetadata stamped in publish, shared with AuditLog row; total list order.
  2. ALF-006: AuthRequestContext reference set by server; correlationId/ip/UA persisted; handler spans linked + annotated logs (EOTS-009).
- **Test plan:** AuthEvents.test.ts eventId == audit row id; correlation stamped from reference; AuthHttp.test.ts x-request-id propagation.
- **Acceptance:** Every delivered event and audit row share eventId/occurredAt/correlationId.

### `core-hook-point-coverage` — Finish the spec'd core hook-point set (BeforeSignIn, AfterSignUp, BeforeSignUp on every creation path)

- **Closes:** NAM-002, SCP-008, TS-007
- **Effort:** M · **Order hint:** 3 · **Depends on workstreams:** hook-registry-per-composition
- **Why grouped:** Commit 3e298c8 wired four points; the remaining open parts of these findings are the same gap: sign-in cannot be vetoed, OAuth JIT creation skips BeforeSignUp, and no end-to-end example exercises the PEP seams.
- **Ordered steps:**
  1. NAM-002: declare BeforeSignIn/AfterSignUp; wire into password/oauth/passkey; BeforeSignUp on OAuth JIT; Auth.js mapping doc; delete stale TestAuth comment.
  2. SCP-008: nothing extra now; deactivation points with ticket 09.
  3. TS-007: example composing Path A + RequirePermission + a BeforeSignUp tap, with smoke test.
- **Test plan:** Per-flow *HooksSignIn tests for BeforeSignIn deny; OAuth BeforeSignUp veto; example smoke test.
- **Acceptance:** Hooks.ts declares all six spec/overview.md:107 points; every sign-in/sign-up path consults them.

### `auth-event-pii-posture` — PII posture for events and the durable audit log

- **Closes:** ESA-005, ALF-009
- **Effort:** M · **Order hint:** 4 · **Depends on workstreams:** auth-event-schema
- **Why grouped:** Raw email/free-text now lands in an append-only table with no erasure path; needs a posture decision (D1) then a pseudonymization contribution to the erasure cascade.
- **Ordered steps:**
  1. Decide D1.
  2. Drop email from invitationCreated.
  3. AuditLog.pseudonymizeActor + erasure registration.
  4. Document stream privilege; new retention/erasure ADR.
- **Test plan:** AuditLog pseudonymization tests; Organization event shape; DELETE /account audit check.
- **Acceptance:** No raw email on the bus; erased users' audit rows pseudonymized in the same transaction.

### `auth-event-taxonomy` — Missing event tags and fields (sign-in failure dimensions, recovery, session lifecycle, user deletion)

- **Closes:** CSD-004, ARF-006, RRS-008, SCP-006
- **Effort:** M · **Order hint:** 4 · **Depends on workstreams:** auth-event-schema
- **Why grouped:** Each is a remaining gap in which operations publish events and with what fields; all edit the same union/actorOf switch and publisher sites.
- **Ordered steps:**
  1. CSD-004: ip + keyed identifierDigest; oauth/passkey failure publishes.
  2. ARF-006: resetRequested + emailVerified.
  3. RRS-008: rotated/superseded; move issued/revoked into Sessions.
  4. SCP-006: auth.user.deleted after commit.
- **Test plan:** Password/Passkey/Sessions/AuthHttp tests per new tag.
- **Acceptance:** Every security-relevant operation listed is an event + audit row.

### `security-signal-pipeline` — Opt-in SecuritySignals threshold/incident layer

- **Closes:** CSG-008
- **Effort:** M · **Order hint:** 5 · **Depends on workstreams:** auth-events-subscription, auth-event-taxonomy
- **Why grouped:** Signals are published and persisted but nothing detects on them.
- **Ordered steps:**
  1. SecuritySignals config + layer over one multi-tag subscription; incidents → log + metric + IncidentSink port.
- **Test plan:** SecuritySignals.test.ts threshold behavior under TestClock.
- **Acceptance:** Composing SecuritySignals.layer produces incidents for the documented signals.

### `auth-event-external-delivery` — Cross-process delivery: outbox relay and webhooks

- **Closes:** CWM-004, MAPS-010
- **Effort:** XL · **Order hint:** 6 · **Depends on workstreams:** auth-event-schema, auth-event-envelope
- **Why grouped:** Same missing transport seam; decision D2 picks scope. The durable audit table is the reliable outbox source.
- **Ordered steps:**
  1. Docs now (single-process assumption + in-process recipe).
  2. EventRelay + EventTransport port over auth_audit_log.
  3. @awthaq/webhooks plugin (M7).
- **Test plan:** EventRelay exactly-once-per-cursor/resume/redelivery; webhook signing/retry/dead-letter.
- **Acceptance:** Events reach other processes reliably; signed webhooks available.

## Decisions needed

### D1 — PII posture for event payloads and the durable audit log (ESA-005, ALF-009)

- A. Identifiers-only payloads (drop invitation email; subscribers join via records) + pseudonymize audit rows on user erasure + document stream privilege.
- B. Keep contact fields but store an HMAC digest instead of the raw value (email → digest) in both bus and audit row; no erasure hook needed for those fields.
- C. Keep payloads as-is; rely on a retention sweep (ticket 30's Retention service extended to auth_audit_log) to age rows out.

**Recommendation:** A, plus C's retention sweep as an operator-configurable add-on (flexibility): identifiers-only is the standard event-sourcing answer and the erasure cascade already owns the records that hold the email; pseudonymizing audit rows keeps the forensic timeline (tag/time/order) intact under GDPR Art. 17. B loses utility for legitimate notification subscribers without buying much over A.

### D2 — Scope of cross-process event delivery (docs vs outbox relay vs first-party webhooks) (CWM-004, MAPS-010)

- A. Docs only: state the single-process assumption and the in-process subscription recipe; no transport.
- B. Outbox relay over auth_audit_log + app-provided EventTransport port (cross-process fan-out), no webhooks plugin yet.
- C. B plus a first-party opt-in @awthaq/webhooks plugin (signed, retried, dead-lettered) scheduled as an M7 Phase-2 plugin.

**Recommendation:** C, staged: ship A's docs immediately, B right after the event schema/envelope workstreams (it needs eventId + a codec), and the webhooks plugin as an M7 Phase-2 plugin. Tailing the durable audit table (not the lossy dropping PubSub) is what makes delivery reliable, and it reuses what ticket 01 already built.

No other finding in this slice needs a product decision. The existing decisions cover them: wayfinder tickets 01, 02, 03 and 27, plus spec BEH-EA-024/091/096 and spec/overview.md:107.

## Per-issue dossiers

## Workstream `auth-events-subscription`

### ALF-007 — on() subscriptions attach asynchronously — events published during startup are silently lost

`medium` · `correctness` · `core` · [.issues/medium/ALF-007-audit-logging-forensics-specialist.md](../../.issues/medium/ALF-007-audit-logging-forensics-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for ESS-003

`on()` still forks a lazy `Stream.fromPubSub` consumer with plain `forkScoped`; the PubSub subscription registers only when that fiber first runs, so events published between Layer build and first scheduling are lost. The repo's own tests work around it (20ms sleep; `startImmediately` in 10+ test sites and AdminWorld.ts:73).

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:405` — on() forks with plain forkScoped (no startImmediately, no pre-registered subscription); the full Cause is logged verbatim.

```
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
          ),
        ),
        Effect.forkScoped,
```

`packages/core/src/AuthEvents.ts:376` — stream is a lazy Stream.fromPubSub: the subscription only registers when a consuming fiber first pulls. Also: the only delivery channel is this in-process PubSub.

```
    return AuthEvents.of({
      publish,
      stream: Stream.fromPubSub(pubsub),
      droppedCount: Ref.get(dropped),
    });
```

`packages/core/test/AuthEvents.test.ts:112` — The repo's own test documents the attach race and papers over it with a 20ms real sleep (twice: lines 116 and 119).

```
      // Real wall-clock time (`it.live`, not `it.effect`'s `TestClock`): a
      // small real sleep gives the subscription Layer's own internally
      // forked fiber (built without `startImmediately`, since `on`'s public
      // signature has no such knob) a chance to actually subscribe.
      yield* Effect.sleep("20 millis");
```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-099, BEH-EA-102, BEH-EA-103)

_Register the PubSub subscription synchronously during the subscription Layer's build, then fork the drain loop over that already-registered subscription._

Steps:
1. packages/core/src/AuthEvents.ts: add `subscribe: Effect.Effect<Stream.Stream<AuthEvent>, never, Scope.Scope>` to AuthEventsShape, implemented as `PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription))` (both verified in ../effect/packages/effect/src/PubSub.ts:1083 and Stream.ts:1351).
2. `on(tag, handler)`: `const stream = yield* events.subscribe` (registers now, scoped to the Layer) then `yield* stream.pipe(Stream.filter(...), Stream.runForEach(...), Effect.forkScoped)`.
3. Keep `stream` for BEH-EA-102 raw access but document that it is lazy (registers on first pull) and point consumers needing no-loss-from-now semantics at `subscribe`.
4. Remove the `startImmediately` workarounds that exist only because of this race where they use `on()` (AdminWorld.ts:66-75 uses raw stream — switch it to `events.subscribe`).

Files: `packages/core/src/AuthEvents.ts`, `packages/core/test/AuthEvents.test.ts`, `features/step-definitions/AdminWorld.ts`

Tests (write first):
- packages/core/test/AuthEvents.test.ts — `it.effect("on(): an event published immediately after the subscription Layer is built is delivered")`: build `on(...)` layer, publish with no sleep/yield, then await a Deferred completed by the handler (TestClock, no it.live). Fails/flakes today.

Acceptance:
- `on()` has no startup window where published events are lost.
- No test needs a real-time sleep to observe an `on()` subscription.

**Recommended status:** `ready-for-agent`

### ESS-004 — No batching or buffering stage anywhere — the designed heavy sinks write one event per round trip

`medium` · `performance` · `core` · [.issues/medium/ESS-004-effect-stream-specialist.md](../../.issues/medium/ESS-004-effect-stream-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

Overtaken in part: the heavy durable sink the finding had in mind (the audit table) now exists and is written inline per event *by design* (wayfinder ticket 01 explicitly rejected a batched subscriber as the record of record). Still true: the only consumer sugar is per-event `runForEach`; there is no batching helper or documented batched-consumer pattern for secondary sinks (SIEM/export), which ticket 01 itself names as the right place for `Stream.groupedWithin`.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:363` — Bus is now PubSub.dropping (never suspends) and AuditLog.record runs inline before enqueue.

```
    const pubsub = yield* PubSub.dropping<AuthEvent>(CAPACITY);
    const dropped = yield* Ref.make(0);
    const publish: AuthEventsShape["publish"] = (event) =>
      Effect.gen(function* () {
        yield* auditLog.record(event);
        const accepted = yield* PubSub.publish(pubsub, event);
        if (!accepted) {
          yield* Ref.update(dropped, (n) => n + 1);
```

`packages/core/src/AuthEvents.ts:405` — on() forks with plain forkScoped (no startImmediately, no pre-registered subscription); the full Cause is logged verbatim.

```
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
          ),
        ),
        Effect.forkScoped,
```

**Fix plan** (effort S; depends on: ALF-007; spec: BEH-EA-102, BEH-EA-103)

_Add a batched-subscription sugar next to `on()` and document it as the pattern for secondary sinks._

Steps:
1. packages/core/src/AuthEvents.ts: add `onBatch(select, { size, within }, handler)` where `select` is a tag or tag array, built on the ALF-007 `subscribe` + `Stream.groupedWithin(size, within)` (Stream.ts:8376) + `Stream.runForEach(handler(chunk))`, with the same catchCause → `auth.event.observer.error` isolation.
2. spec/behaviors/13-events.md BEH-EA-102/103 usage text: add the batched-consumer example (SIEM export).

Files: `packages/core/src/AuthEvents.ts`, `packages/core/test/AuthEvents.test.ts`, `spec/behaviors/13-events.md`

Tests (write first):
- packages/core/test/AuthEvents.test.ts — `it.effect("onBatch groups up to `size` events or flushes after `within` (TestClock)")`.

Acceptance:
- A consumer can subscribe to batches without hand-writing Stream plumbing; handler failures stay isolated.

**Recommended status:** `ready-for-agent`

### ETVS-001 — Real wall-clock sleeps in the AuthEvents subscription test

`medium` · `testing` · `core` · [.issues/medium/ETVS-001-effect-testing-vitest-specialist.md](../../.issues/medium/ETVS-001-effect-testing-vitest-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

The BEH-EA-103 test is still `it.live` with two real 20ms sleeps (AuthEvents.test.ts:108-121).

**Evidence at HEAD:**

`packages/core/test/AuthEvents.test.ts:112` — The repo's own test documents the attach race and papers over it with a 20ms real sleep (twice: lines 116 and 119).

```
      // Real wall-clock time (`it.live`, not `it.effect`'s `TestClock`): a
      // small real sleep gives the subscription Layer's own internally
      // forked fiber (built without `startImmediately`, since `on`'s public
      // signature has no such knob) a chance to actually subscribe.
      yield* Effect.sleep("20 millis");
```

**Fix plan** (effort S; depends on: ALF-007; spec: BEH-EA-103)

_Once ALF-007 makes `on()` register synchronously, rewrite the test as `it.effect` with a handler-completed Deferred/Queue instead of sleeps._

Steps:
1. packages/core/test/AuthEvents.test.ts: replace the module-level `Effect.runSync(Ref.make(...))` + `it.live` + sleeps with an `it.effect` that builds a `Queue.unbounded<string>()`, installs `on("auth.token.replay", (e) => Queue.offer(q, e.identifier))` via `Layer.build` in the test scope, publishes a signedIn then a replay, and `Queue.take`s exactly one value; assert the queue is then empty (`Queue.size` 0) after a `TestClock`/`Effect.yieldNow` step.

Files: `packages/core/test/AuthEvents.test.ts`

Tests (write first):
- The rewritten BEH-EA-103 test itself (fails without ALF-007's fix because the publish races the subscription).

Acceptance:
- `grep -n 'it.live\|sleep("20 millis")' packages/core/test/AuthEvents.test.ts` is empty; test is deterministic.

**Recommended status:** `ready-for-agent`

### MA-009 — Bounded AuthEvents PubSub converts event saturation into stalled authentication requests

`medium` · `correctness` · `core` · [.issues/medium/MA-009-michael-arnaldi.md](../../.issues/medium/MA-009-michael-arnaldi.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · fixed-by `4b48cb2`

Core defect fixed by 4b48cb2 (PubSub.bounded → PubSub.dropping + droppedCount + warning log): saturation no longer stalls requests. Remaining piece of the recommended fix: 'correct the BEH-EA-098 wording to state the saturation behavior' — spec text unchanged (wayfinder ticket 02 flagged the exact rewording).

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:363` — Bus is now PubSub.dropping (never suspends) and AuditLog.record runs inline before enqueue.

```
    const pubsub = yield* PubSub.dropping<AuthEvent>(CAPACITY);
    const dropped = yield* Ref.make(0);
    const publish: AuthEventsShape["publish"] = (event) =>
      Effect.gen(function* () {
        yield* auditLog.record(event);
        const accepted = yield* PubSub.publish(pubsub, event);
        if (!accepted) {
          yield* Ref.update(dropped, (n) => n + 1);
```

`packages/core/test/AuthEvents.test.ts:67` — Capacity-stress regression test proving publish no longer hangs past CAPACITY.

```
        assert.strictEqual(yield* events.droppedCount, overflow - 1);
```

`spec/behaviors/13-events.md:39` — Spec text still assumes enqueue-always; the dropping/droppedCount saturation behavior is undocumented (wayfinder ticket 02 flagged this rewording, never applied).

```
REQUIREMENT: Publishing an event to `AuthEvents` MUST NOT suspend the
             publishing fiber on any subscriber's handling of that event;
             `publish` MUST return once the event is enqueued, regardless
             of how many subscribers exist or how long they take to run.
```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-097, BEH-EA-098)

_Apply wayfinder ticket 02's BEH-EA-098 rewording and document the dropping/droppedCount semantics in BEH-EA-097._

Steps:
1. spec/behaviors/13-events.md BEH-EA-098 REQUIREMENT → 'Publishing an event to `AuthEvents` MUST NOT suspend the publishing fiber on any subscriber's handling of that event, or on the PubSub's own capacity; `publish` MUST return immediately whether or not the event was accepted into the bounded buffer.'
2. BEH-EA-097 prose: state that at capacity new events are dropped from the bus (never from AuditLog, BEH-EA-100), counted by `droppedCount`, and logged.
3. Update features/features/**/13-events.feature REQ-EA-261/262 wording if it still says 'enqueued'; run `pnpm run spec:verify:strict`.

Files: `spec/behaviors/13-events.md`, `features/features/04-cross-cutting/13-events.feature`

Tests (write first):
- No new code test (behavior already covered by AuthEvents.test.ts:39-69); spec:verify:strict must pass.

Acceptance:
- BEH-EA-097/098 text matches the shipped dropping semantics.

**Recommended status:** `ready-for-agent`

### ECF-010 — Event subscription fibers have no restart policy

`low` · `architecture` · `core` · [.issues/low/ECF-010-effect-concurrency-fiber-specialist.md](../../.issues/low/ECF-010-effect-concurrency-fiber-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence medium)

The forked drain fiber has no supervision: per-event handler failures are caught, but if the fiber itself ends for any other reason (a defect outside the handler, interruption from inside the handler escaping catchCause) delivery silently stops for the process lifetime with no log or health signal. Low likelihood, real gap.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:405` — on() forks with plain forkScoped (no startImmediately, no pre-registered subscription); the full Cause is logged verbatim.

```
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
          ),
        ),
        Effect.forkScoped,
```

**Fix plan** (effort S; depends on: ALF-007; spec: BEH-EA-099, BEH-EA-104)

_Supervise each `on()` subscription: log when the drain fiber ends for any reason other than scope close, and resubscribe with bounded backoff._

Steps:
1. packages/core/src/AuthEvents.ts `on`: wrap the subscribe+drain in `Effect.gen` that re-subscribes inside `Effect.retry(Schedule.exponential("100 millis").pipe(Schedule.either(Schedule.spaced("30 seconds"))))` over `Effect.sandbox`/`catchCause` of the whole drain, logging `auth.event.subscription.died` with `{ tag }` on each restart (never logging on scope interruption).
2. Expose liveness cheaply: a `Metric.gauge("awthaq_event_subscriptions_active")` incremented on subscribe / decremented on exit (optional; align with MW-001 metrics module).

Files: `packages/core/src/AuthEvents.ts`, `packages/core/test/AuthEvents.test.ts`

Tests (write first):
- packages/core/test/AuthEvents.test.ts — `it.effect("on(): a drain fiber killed by a defect outside the handler resubscribes and keeps delivering")` using a handler that interrupts itself / a test hook; assert a later event is still handled and `auth.event.subscription.died` was logged (capture via a test Logger).

Acceptance:
- A subscription survives a non-handler defect; the death is logged under a stable name.

**Recommended status:** `ready-for-agent`

### ESS-007 — Every subscriber filters all 25 event types itself; no per-tag channel for the one-tag-one-handler case

`low` · `architecture` · `core` · [.issues/low/ESS-007-effect-stream-specialist.md](../../.issues/low/ESS-007-effect-stream-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence medium)

Each `on(tag)` Layer is a separate full PubSub subscriber that pulls and discards every non-matching event (now 31 tags). Correct, and cheap per event, but the only way to handle N tags is N subscriptions.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:398` — Every on() Layer is its own full subscriber of the shared PubSub and filters all 31 tags itself.

```
      yield* events.stream.pipe(
        Stream.filter((event): event is Extract<AuthEvent, { readonly _tag: Tag }> =>
          Object.is(event._tag, tag),
        ),
```

**Fix plan** (effort S; depends on: ALF-007; spec: BEH-EA-102, BEH-EA-103)

_Let `on`/`onBatch` accept a tag array (one subscription, narrowed union type) and document the fan-out characteristic on `stream`; do not build per-tag PubSubs (speculative)._

Steps:
1. packages/core/src/AuthEvents.ts: overload `on` to accept `ReadonlyArray<Tag>`; filter with a `Set` membership check; handler typed `Extract<AuthEvent, { _tag: Tags[number] }>` (type guard, no assertion).
2. Doc comment on `AuthEventsShape.stream`/`on`: each call is a full subscriber; prefer one multi-tag subscription over many single-tag ones.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/test/AuthEvents.test.ts`

Tests (write first):
- packages/core/test/AuthEvents.test.ts — `it.effect("on([a, b], h) delivers both tags through one subscription and nothing else")`.

Acceptance:
- Multi-tag subscription exists and is type-narrowed.

**Recommended status:** `ready-for-agent`

### ESS-003 — Subscription-attach race in AuthEvents.on: events published before the forked subscriber registers are silently lost

`medium` · `correctness` · `core` · [.issues/medium/ESS-003-effect-stream-specialist.md](../../.issues/medium/ESS-003-effect-stream-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ALF-007**

Same subscription-attach race in `on()` and same fix (subscribe synchronously before forking). A replay buffer (`PubSub.dropping({ capacity, replay })`) is not needed once registration is synchronous.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:405` — on() forks with plain forkScoped (no startImmediately, no pre-registered subscription); the full Cause is logged verbatim.

```
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
          ),
        ),
        Effect.forkScoped,
```

**Fix plan:** none — tracked by ALF-007's plan.

**Recommended status:** `resolved`

## Workstream `hook-registry-per-composition`

### ELC-001 — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention

`medium` · `architecture` · `core` · [.issues/medium/ELC-001-effect-layer-context-architect.md](../../.issues/medium/ELC-001-effect-layer-context-architect.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for GC-006

Every factory still closes over a module-lifetime `entries`/`frozen` pair; the first `run()` anywhere freezes the point process-wide. This has already bitten production code: the GDPR erasure taps in Organization.ts/Passkey.ts had to be shipped as opt-in side exports instead of being part of each plugin's layer. Additionally discovered while validating: `tap()` returns `Layer.Layer<never>` with an empty RIn, so BEH-EA-094/INV-EA-005 ('tapping a point nobody provides refuses to compile') is not enforced either — traceability.md:112 claims the compiler enforces it.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:200` — Registry lives in the factory closure (module lifetime). tap() returns Layer<never> with NO RIn — so tapping a point nobody provides compiles (BEH-EA-094/INV-EA-005 also violated).

```
    const entries: Array<Registration<VetoTap<Input>>> = [];
    let frozen: ReadonlyArray<VetoTap<Input>> | undefined;
    const resolveTaps = (): ReadonlyArray<VetoTap<Input>> => {
      if (frozen === undefined) frozen = sortEntries(entries);
      return frozen;
    };
    const tap = (handler: VetoTap<Input>, options?: TapOptions): Layer.Layer<never> =>
      Layer.effectDiscard(
```

`packages/organization/src/Organization.ts:2385` — Real production consequence at HEAD: GDPR erasure taps (Organization, Passkey.ts:1017-1025) had to become opt-in side exports because of the module singleton.

```
 * **A separate export, not merged into `Organization.layer` itself** —
 * see `@awthaq/passkey`'s own `beforeUserDeleteErasure` for why:
 * `Hooks.BeforeUserDelete`'s tap registry is a module-level singleton
 * that freezes permanently after its first `run()` (BEH-EA-024,
 * empirically confirmed per CSG-002's own resolution comment), so
 * merging a tap into a `Layer` rebuilt repeatedly across a test suite
 * would die with `HookPointFrozen` once the point has run anywhere in
```

**Fix plan** (effort L; depends on: —; spec: BEH-EA-024, BEH-EA-094, INV-EA-005, BEH-EA-091)

_Move each point's tap registry out of the module closure into the point's own per-composition service: the point's `.layer` owns a `Ref` of registrations; `tap()` returns a Layer that *requires* the point (RIn = Self) and registers through it. Freezing becomes per-built-layer._

Steps:
1. packages/core/src/HookPoint.ts: extend VetoShape/ObserveShape/DivertShape with an internal `register: (reg: Registration<Tap>) => Effect<void, never>` (keep `run`/`kind`). Keep per-kind factories so each shape stays precisely generic in Input/Diverted (no erased registry, no type assertions).
2. Change each factory's `layer` from `Layer.succeed(serviceKey, ...)` to `Layer.effect(serviceKey, Effect.gen(...))` that allocates `const state = yield* Ref.make<{ entries: ReadonlyArray<Registration<Tap>>; frozen: Option<ReadonlyArray<Tap>> }>(...)` and builds `register`/`run` over it (freeze on first `run` via `Ref.modify`).
3. Change `tap(handler, options)` to `Layer.effectDiscard(Effect.flatMap(serviceKey, (point) => point.register({ handler, order, owner })))` — its RIn becomes `Self`, restoring BEH-EA-094/BEH-EA-024 compile-time enforcement. Registering after the point froze still dies with `HookPointFrozen`, but only within that one built composition.
4. Delete the module-level `let nextSequence = 0` (HookPoint.ts:178); sequence = index within the point's own `entries` (fixes GC-006).
5. Callers: `Organization.beforeUserDeleteErasure`, `Passkey.beforeUserDeleteErasure` and `OrganizationHooks.ts` taps now carry `Hooks.BeforeUserDelete`/their point in RIn — satisfied by `Hooks.HooksLive`/`OrganizationHooksLive` exactly as today. Fold the erasure taps back into `Organization.layer`/`Passkey.layer` (the reason they were split out disappears) so erasure is no longer opt-in.
6. Update comments that describe the singleton: HookPoint.ts header, Hooks.ts:90-92, Organization.ts:2385-2394, Passkey.ts:1017-1025, RateLimits.ts:18-21 (which already, wrongly, claims hook registries are scoped).
7. Update spec/traceability.md:112 (INV-EA-005) to point at a real type-level test instead of 'no test file'.

Files: `packages/core/src/HookPoint.ts`, `packages/core/src/Hooks.ts`, `packages/core/src/RateLimits.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationHooks.ts`, `packages/passkey/src/Passkey.ts`, `packages/core/test/HookPoint.test.ts`, `spec/traceability.md`

Tests (write first):
- packages/core/test/HookPoint.test.ts — new `it.effect("two independently built compositions do not share taps or freeze state")`: build `Point.layer` + tap A in composition 1, run it; build `Point.layer` + tap B in composition 2 (same module load) → composition 2 must see only B and must NOT die with HookPointFrozen. Fails today.
- packages/core/test/HookPoint.types.test.ts (or a `// @ts-expect-error` block in HookPoint.test.ts) — `Layer.launch(SomePoint.tap(h))` without `SomePoint.layer` must be a type error (BEH-EA-094/INV-EA-005). Fails today (tap is Layer<never>).
- Merge OrganizationErasure.test.ts / PasskeyErasure.test.ts expectations into the plugin-layer compositions once taps move into `Organization.layer`/`Passkey.layer`.

Acceptance:
- No module-level mutable state remains in HookPoint.ts (`grep -n '^let ' packages/core/src/HookPoint.ts` is empty).
- Two compositions in one process each see only their own taps; freezing one never affects the other.
- A tap Layer's RIn includes its point; omitting the point's layer fails `pnpm run typecheck`.
- Erasure taps are part of Organization.layer / Passkey.layer; the side exports are removed or deprecated.
- pnpm check green.

**Recommended status:** `ready-for-agent`

### JH-003 — Tap ordering implements 2 of 3 spec keys via a module-global counter

`medium` · `api` · `core` · [.issues/medium/JH-003-jared-hanson.md](../../.issues/medium/JH-003-jared-hanson.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for TS-006, MW-004

Tap order is still `order` then a process-global registration sequence; plugin identity is never captured, so neither dependency order nor plugin-id tiebreak can be applied. Equal-order veto taps from different plugins run in Layer-build order.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:180` — Two of three spec'd keys; no plugin identity, no dependency order.

```
/** BEH-EA-091/096: stable ordering by declared `order`, then registration sequence — see this module's own header comment for what full BEH-EA-111 ordering still needs. */
const sortEntries = <F>(entries: ReadonlyArray<Registration<F>>): ReadonlyArray<F> =>
  entries
    .toSorted((a, b) => a.order - b.order || a.sequence - b.sequence)
    .map((entry) => entry.handler);
```

`packages/core/src/HookPoint.ts:44` — Still documented as a follow-up at HEAD.

```
// This module implements the piece that doesn't depend on it: declared
// `order` (a plain number, default 0), then registration sequence, frozen
// the first time a point runs (BEH-EA-024's "must freeze at first read").
// Threading dependency order through is a follow-up once a plugin's own
// identity is available at `.tap()`'s call site.
```

`spec/behaviors/12-hooks.md:60`

```
REQUIREMENT: A tap on a `kind: "veto"` hook point MUST be able to return a
             transformed value that subsequent taps and the operation
             itself observe in place of the original input; when more than
             one tap is registered on the same point, they MUST run in
             dependency order, then declared `order`, then plugin id.
```

**Fix plan** (effort M; depends on: ELC-001; spec: BEH-EA-091, BEH-EA-022, BEH-EA-024, BEH-EA-111)

_Capture tap ownership and sort by the spec'd three keys (dependency order, declared order, plugin id) at freeze time, using the composition's topological order that Auth.make already computes._

Steps:
1. packages/core/src/HookPoint.ts: `TapOptions` gains `owner?: { readonly id: string }` (the same narrow `PluginOwner`-style shape Slots.ts uses; do not require the full AuthPlugin.Any to avoid the static-initializer circularity documented in OAuth.ts:529-535). Registrations store `ownerId` (application-level taps default to a reserved id, e.g. `"app"`, sorted after every plugin).
2. packages/core/src/Auth.ts: expose the resolved plugin order to the runtime — add a `PluginOrder` `Context.Reference<ReadonlyArray<string>>` (default `[]`) in core and have `composeLayer` provide it (`Layer.succeed(PluginOrder, order.map((p) => p.id))`) into the composed layer.
3. At freeze time (first `run`) each point reads `PluginOrder` and sorts by (index of ownerId in PluginOrder, unknown/app last) → `order` → ownerId (lexicographic) → within-point sequence as final stable tiebreak.
4. Pass `owner` at every existing in-repo tap site: OrganizationHooks consumers, Organization/Passkey erasure taps, tests.
5. Rewrite HookPoint.ts:36-48 header to describe the implemented rule; remove 'follow-up'.

Files: `packages/core/src/HookPoint.ts`, `packages/core/src/Auth.ts`, `packages/organization/src/Organization.ts`, `packages/passkey/src/Passkey.ts`, `packages/core/test/HookPoint.test.ts`, `features/features/04-cross-cutting/12-hooks.feature`

Tests (write first):
- packages/core/test/HookPoint.test.ts — `it.effect("equal-order taps run in dependency order, then plugin id, regardless of registration order")`: plugin `b` depends on `a`; register b's tap before a's with equal order; expect a's amendment observed first. Fails today (registration order wins).
- Same file — `it.effect("equal dependency depth and order → plugin id breaks the tie")`.
- If features/features/04-cross-cutting/12-hooks.feature has a BEH-EA-091 ordering scenario, wire its step definitions to the new rule.

Acceptance:
- Resolved tap order is a pure function of (installed plugin tuple, declared orders, owner ids) — independent of Layer build/registration order.
- BEH-EA-091's normalize-before-allow-list example holds across plugins without manual `order` tuning.

**Recommended status:** `ready-for-agent`

### PERS-003 — Hook tap ordering implements 2 of the 3 spec'd ordering keys and has no introspection

`medium` · `correctness` · `core` · [.issues/medium/PERS-003-policy-engine-rego-specialist.md](../../.issues/medium/PERS-003-policy-engine-rego-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Ordering half duplicates JH-003; the introspection half is distinct and unaddressed: point services expose only kind/run, and Auth.make's manifest (Auth.ts:370-377) carries no hook information, so BEH-EA-096 ('resolved order derivable from the plugin tuple alone, printable by tooling, without executing any tap') is unimplemented.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:180` — Two of three spec'd keys; no plugin identity, no dependency order.

```
/** BEH-EA-091/096: stable ordering by declared `order`, then registration sequence — see this module's own header comment for what full BEH-EA-111 ordering still needs. */
const sortEntries = <F>(entries: ReadonlyArray<Registration<F>>): ReadonlyArray<F> =>
  entries
    .toSorted((a, b) => a.order - b.order || a.sequence - b.sequence)
    .map((entry) => entry.handler);
```

`packages/core/src/HookPoint.ts:127` — No introspection surface (BEH-EA-096); Auth.ts buildManifest (:370-377) lists only id/apiVersion/tables/dependsOn.

```
export interface VetoShape<Input> {
  readonly kind: "veto";
  readonly run: (input: Input) => Effect.Effect<Input, HookAbort>;
}
```

**Fix plan** (effort M; depends on: JH-003; spec: BEH-EA-096, BEH-EA-024, BEH-EA-091)

_Make taps statically declarable on a plugin (the BEH-EA-024 illustration's `AuthPlugin.layer(Self, { make, taps: [...] })` shape) so Auth.make can print the resolved per-point order into its manifest without running anything; also expose the frozen order at runtime._

Steps:
1. packages/core/src/AuthPlugin.ts: add an optional `taps` option to `AuthPlugin.layer(...)` accepting tap declarations; each declaration is a value `{ point: Key<Id>, order, install: (owner) => Layer }` produced by a new `Point.declareTap(handlerOrEffect, { order })` (an Effect-producing variant covers taps that resolve services at build, like the erasure taps). AuthPlugin.layer installs them with `owner = Self` and records `{ point, order }` metadata on the plugin class.
2. packages/core/src/Auth.ts: `buildManifest` gains `hooks: Record<pointKey, ReadonlyArray<{ plugin, order }>>`, sorted with the same comparator JH-003 introduces (share one exported `compareTaps` function so manifest order and runtime order cannot drift).
3. HookPoint shapes: add `resolved: Effect<ReadonlyArray<{ owner: string; order: number }>>` (reads the frozen/sorted registrations without executing taps).
4. packages/cli: if a `plugin list` command exists, add `--hooks` printing `manifest.hooks`; otherwise leave a TODO in the CLI slice (cross-slice).

Files: `packages/core/src/AuthPlugin.ts`, `packages/core/src/Auth.ts`, `packages/core/src/HookPoint.ts`, `packages/core/test/Auth.test.ts`, `packages/core/test/HookPoint.test.ts`

Tests (write first):
- packages/core/test/Auth.test.ts — `it("manifest.hooks lists every declared tap per point in resolved order")` with two plugins tapping one point.
- packages/core/test/HookPoint.test.ts — `resolved` returns the same order the chain executes in, without invoking any handler (handler that dies must not be called).

Acceptance:
- Auth.make(...).manifest.hooks prints resolved order per point without building any Layer.
- Runtime `resolved` and manifest order agree (shared comparator).

**Recommended status:** `ready-for-agent`

### MW-004 — Cross-plugin tap ordering is registration-sequence dependent; spec's dependency-order rule unimplemented

`medium` · `architecture` · `core` · [.issues/medium/MW-004-matias-woloski.md](../../.issues/medium/MW-004-matias-woloski.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **JH-003**

Same missing dependency-order key as JH-003. Its secondary note (observe taps run unbounded-concurrent) is covered by JH-002.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:44` — Still documented as a follow-up at HEAD.

```
// This module implements the piece that doesn't depend on it: declared
// `order` (a plain number, default 0), then registration sequence, frozen
// the first time a point runs (BEH-EA-024's "must freeze at first read").
// Threading dependency order through is a follow-up once a plugin's own
// identity is available at `.tap()`'s call site.
```

**Fix plan:** none — tracked by JH-003's plan.

**Recommended status:** `resolved`

### GC-006 — Module-level mutable tap-sequence counter contradicts the scoped-registry convention

`low` · `correctness` · `core` · [.issues/low/GC-006-giulio-canti.md](../../.issues/low/GC-006-giulio-canti.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ELC-001**

Same root cause as ELC-001 (module-scoped registry state); ELC-001's plan deletes `nextSequence` and scopes sequence to each point's own per-composition registry.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:178` — Module-global mutable counter shared by every point in the process (incremented at :217, :273, :334).

```
let nextSequence = 0;
```

**Fix plan:** none — tracked by ELC-001's plan.

**Recommended status:** `resolved`

### TS-006 — Hook tap ordering implements 2 of 3 specified keys; veto chains are composition-order sensitive

`low` · `correctness` · `core` · [.issues/low/TS-006-torin-sandall.md](../../.issues/low/TS-006-torin-sandall.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **JH-003**

Identical claim (2 of 3 ordering keys; veto chains composition-order sensitive) and identical fix (thread plugin identity through tap()).

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:180` — Two of three spec'd keys; no plugin identity, no dependency order.

```
/** BEH-EA-091/096: stable ordering by declared `order`, then registration sequence — see this module's own header comment for what full BEH-EA-111 ordering still needs. */
const sortEntries = <F>(entries: ReadonlyArray<Registration<F>>): ReadonlyArray<F> =>
  entries
    .toSorted((a, b) => a.order - b.order || a.sequence - b.sequence)
    .map((entry) => entry.handler);
```

**Fix plan:** none — tracked by JH-003's plan.

**Recommended status:** `resolved`

## Workstream `observability-substrate`

### EOTS-002 — BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half

`high` · `compliance` · `test` · [.issues/high/EOTS-002-effect-observability-tracing-specialist.md](../../.issues/high/EOTS-002-effect-observability-tracing-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

runPluginContractTests still implements only the contract-hash half of BEH-EA-199; no interceptor exists (the TestAuth header and spec/behaviors/25-testing-harness.md:142-146 both still say so).

**Evidence at HEAD:**

`packages/test/src/TestAuth.ts:29`

```
// - BEH-EA-199's "no `Redacted` value reaches a span or event" check is
//   already, honestly, documented by that behavior file itself as "not
//   mechanically verifiable today" (no tracer/logger interceptor exists) —
//   `runPluginContractTests` below implements only its other half
//   (contract-hash stability).
```

**Fix plan** (effort M; depends on: MW-001; spec: BEH-EA-199, BEH-EA-198)

_Build a redaction-asserting Tracer + Logger in @awthaq/test, install it in TestAuth.layer, and run it inside runPluginContractTests (ticket 27 §5)._

Steps:
1. packages/test/src/RedactionGuard.ts (new): `layer` providing a Tracer (wrapping the default, recording every span's attributes/events) and a Logger (recording every message/annotation/cause) into a Ref; `assertNoLeaks: Effect<void, RedactionLeak>` deep-walks recorded values and fails on any `Redacted.isRedacted(value)` instance and on any string equal to a registered secret (`RedactionGuard.watch(secret)` so plaintext copies are caught too).
2. packages/test/src/TestAuth.ts: include `RedactionGuard.layer` in `TestAuth.layer`.
3. runPluginContractTests: add an `it` that composes host + plugin via TestAuth.layer, drives a minimal smoke (build layer; if the plugin declares a sign-in style endpoint, optional `exercise` callback in ContractTestOptions) and then `assertNoLeaks`. Because TestFramework is runner-agnostic, run the Effect with `Effect.runPromise` inside the injected `it`.
4. Remove the 'not mechanically verifiable today' text from TestAuth.ts:29-33 and spec/behaviors/25-testing-harness.md:142-146; update traceability.md:200.

Files: `packages/test/src/RedactionGuard.ts`, `packages/test/src/TestAuth.ts`, `packages/test/src/index.ts`, `packages/test/test/runPluginContractTests.test.ts`, `spec/behaviors/25-testing-harness.md`, `spec/traceability.md`, `features/step-definitions/*testing-harness*`

Tests (write first):
- packages/test/test/runPluginContractTests.test.ts — a deliberately-broken fixture plugin whose layer logs `Effect.log(Redacted.make("s3cr3t"))` (and one that puts `Redacted.value(...)` into a span attribute) makes the contract suite fail with RedactionLeak; `@awthaq/password` passes. Fails today (no such check).
- Wire features REQ-EA-566 (25-testing-harness.feature:181) and REQ-EA-089 step definitions to the guard.

Acceptance:
- BEH-EA-199 is mechanically enforced by runPluginContractTests; REQ-EA-566 is an executable scenario.

**Recommended status:** `ready-for-agent`

### MW-001 — No observability substrate: two log statements in the whole library, no tracer/logger interceptor

`high` · `architecture` · `test` · [.issues/high/MW-001-matias-woloski.md](../../.issues/high/MW-001-matias-woloski.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Decision exists (wayfinder ticket 27, resolved) but none of it is implemented at HEAD: 0 withSpan/annotateCurrentSpan, no HttpMiddleware.tracer/logger re-export, no Metric, no Observability module, no redaction interceptor. Log sites are now three (a drop warning was added), all in core event/hook plumbing.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:284` — `grep -rn withSpan|annotateCurrentSpan packages/*/src` → 0 hits; the library's only log calls are AuthEvents.ts:371 (logWarning), AuthEvents.ts:408 and HookPoint.ts:284 (logError); no HttpMiddleware.tracer/logger re-export; no Metric usage. Wayfinder ticket 27's decision is unimplemented.

```
              Effect.logError("auth.hook.observer.error", { hook: key, cause }),
```

`packages/test/src/TestAuth.ts:29`

```
// - BEH-EA-199's "no `Redacted` value reaches a span or event" check is
//   already, honestly, documented by that behavior file itself as "not
//   mechanically verifiable today" (no tracer/logger interceptor exists) —
//   `runPluginContractTests` below implements only its other half
//   (contract-hash stability).
```

**Fix plan** (effort L; depends on: —; spec: BEH-EA-199, BEH-EA-104)

_Implement wayfinder ticket 27 in its stated order: HTTP re-exports, business-logic spans, field convention + metrics, then the redaction interceptor (EOTS-002)._

Steps:
1. packages/server/src/AuthHttp.ts: `export const tracer = HttpMiddleware.tracer; export const requestLogger = HttpMiddleware.logger;` (direct re-exports, per ticket 27 §1); document the recommended `HttpMiddleware.tracer(HttpMiddleware.logger(app))` composition in README/usage docs.
2. Spans (ticket 27 §2): `Effect.withSpan("awthaq.session.verify", { attributes: { "auth.session.id": id } })` in Sessions.verify (both layers); `awthaq.session.issue`; `awthaq.password.verify` around the hasher.verify call in Password.signIn; `awthaq.hook.dispatch` in each HookPoint run (`{ hook: key }`); `awthaq.event.publish` in AuthEvents.publish (`{ "auth.event": tag }`). Never put Redacted values or tokens in attributes.
3. packages/core/src/Observability.ts (new): the fixed field vocabulary (`auth.event`, `auth.principal.ref`, `auth.session.id`, `auth.outcome`) as exported constants, and the metric taxonomy (`awthaq_session_issued_total`, `awthaq_session_verify_failed_total{reason}`, `awthaq_login_failed_total`, `awthaq_session_verify_duration_seconds`, plus `awthaq_event_dropped_total{tag}` from ticket 02 and `awthaq_hook_observer_error_total` from JH-002). Wire the counters at their sites.
4. Record the field convention in a new ADR (spec/decisions/0NN-observability-field-naming.md) per ticket 27 §3.
5. EOTS-002 (redaction interceptor) lands last in this workstream.

Files: `packages/server/src/AuthHttp.ts`, `packages/core/src/Observability.ts`, `packages/core/src/Sessions.ts`, `packages/core/src/HookPoint.ts`, `packages/core/src/AuthEvents.ts`, `packages/password/src/Password.ts`, `spec/decisions/`, `README.md`

Tests (write first):
- packages/core/test/Observability.test.ts — with a recording Tracer (`Tracer.make` capturing spans), `Sessions.verify` emits one `awthaq.session.verify` span with `auth.session.id` and no attribute containing the token; `Password.signIn` emits `awthaq.password.verify`.
- Metric test: a failed verify increments `awthaq_session_verify_failed_total` with the right reason tag (`Metric.value`).

Acceptance:
- Spans exist at the listed boundaries; the metric set is exported; AuthHttp re-exports tracer/logger; ADR recorded.

**Recommended status:** `ready-for-agent`

### EOTS-005 — The only two log sites serialize raw Cause payloads with no redaction pass

`medium` · `correctness` · `core` · [.issues/medium/EOTS-005-effect-observability-tracing-specialist.md](../../.issues/medium/EOTS-005-effect-observability-tracing-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Both observer-error sites still log the entire Cause object (AuthEvents.ts:408, HookPoint.ts:284).

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:405` — on() forks with plain forkScoped (no startImmediately, no pre-registered subscription); the full Cause is logged verbatim.

```
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
          ),
        ),
        Effect.forkScoped,
```

`packages/core/src/HookPoint.ts:278` — Sorted order is discarded by unbounded concurrent execution; failures only logged (no metric); full Cause logged.

```
    const run: ObserveShape<Input>["run"] = (value) =>
      Effect.forEach(
        resolveTaps(),
        (handler) =>
          handler(value).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.hook.observer.error", { hook: key, cause }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
```

**Fix plan** (effort S; depends on: MW-001; spec: BEH-EA-104, BEH-EA-092, BEH-EA-199)

_Log a sanitized summary at error level and the full cause only at debug level, via one shared helper._

Steps:
1. packages/core/src/Observability.ts (or a small core helper): `logObserverFailure(name, context, cause)` → `Effect.logError(name, { ...context, errorTag, message })` where errorTag/message come from `Cause.squash`/`Cause.findError` of a tagged error (message truncated, never the error's data fields), then `Effect.logDebug(name, { ...context, cause })`.
2. Use it at AuthEvents.ts:408 and HookPoint.ts:284 (keep the stable names auth.event.observer.error / auth.hook.observer.error — BEH-EA-104).
3. Covered by EOTS-002's guard in tests.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/HookPoint.ts`, `packages/core/src/Observability.ts`, `packages/core/test/AuthEvents.test.ts`

Tests (write first):
- packages/core/test/AuthEvents.test.ts — a subscriber failing with an error whose data holds a token string: the error-level log record (captured by a test Logger) has errorTag/message but not the token; the debug-level record has the cause.

Acceptance:
- No error-level log line carries a raw Cause payload.

**Recommended status:** `ready-for-agent`

### MAPS-007 — No tracing correlation of auth context anywhere in the pipeline

`medium` · `dx` · `test` · [.issues/medium/MAPS-007-microservices-auth-propagation-specialist.md](../../.issues/medium/MAPS-007-microservices-auth-propagation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

No span or annotation at the principal-resolution choke point shared by Path A/Path B and the Authentication middleware; no traceparent handling in packages/*/src.

**Evidence at HEAD:**

`packages/server/src/Authentication.ts:205` — The shared choke point adds no span / annotation; no traceparent handling anywhere in packages/*/src.

```
export const resolvePrincipal = (
  sessions: Sessions.SessionsShape,
  resolver: PrincipalResolverShape,
  credential: Redacted.Redacted<string>,
) =>
  resolveSession(sessions, credential).pipe(
    Effect.flatMap(({ session }) => resolver.resolve(session)),
  );
```

`packages/core/src/HookPoint.ts:284` — `grep -rn withSpan|annotateCurrentSpan packages/*/src` → 0 hits; the library's only log calls are AuthEvents.ts:371 (logWarning), AuthEvents.ts:408 and HookPoint.ts:284 (logError); no HttpMiddleware.tracer/logger re-export; no Metric usage. Wayfinder ticket 27's decision is unimplemented.

```
              Effect.logError("auth.hook.observer.error", { hook: key, cause }),
```

**Fix plan** (effort S; depends on: MW-001; spec: BEH-EA-199)

_Annotate the principal/session on the current span at the shared resolution choke point, and rely on HttpMiddleware.tracer (MW-001) for W3C traceparent propagation._

Steps:
1. packages/server/src/Authentication.ts resolveSession/resolvePrincipal: wrap in `Effect.withSpan("awthaq.principal.resolve")` and `Effect.annotateCurrentSpan({ "auth.principal.type": ..., "auth.principal.ref": ref.id, "auth.session.id": session.id })` on success, `auth.outcome: "failure"` + reason on failure (field names from MW-001's Observability module).
2. Also `Effect.annotateLogs` with the same keys so downstream handler logs carry them.

Files: `packages/server/src/Authentication.ts`, `packages/server/test/Authentication.test.ts`

Tests (write first):
- packages/server/test/Authentication.test.ts — with a recording Tracer, an authenticated request's span tree contains `awthaq.principal.resolve` with principal/session attributes and no credential value.

Acceptance:
- Every authenticated request's trace identifies principal and session.

**Recommended status:** `ready-for-agent`

## Workstream `auth-event-schema`

### ESA-007 — Events are plain TypeScript interfaces: no version field, no runtime codec, no evolution path toward durability

`low` · `architecture` · `core` · [.issues/low/ESA-007-event-sourcing-audit-trail-specialist.md](../../.issues/low/ESA-007-event-sourcing-audit-trail-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Events are still plain TS interfaces; the new durable table stores them as opaque JSON and reads them back as `unknown` — exactly the 'first durable consumer must invent upcasting' situation the finding predicted, now real.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:279` — 31-member closed union of plain TS interfaces; no user.deleted/deactivated tag, no version, no Schema codec.

```
/** BEH-EA-101: the closed, statically-known set of event types `AuthEvents` carries today. */
export type AuthEvent =
  | TokenReplayEvent
  | UserCreatedEvent
  | UserSignedInEvent
```

`packages/core/src/AuditLog.ts:48` — Durable rows read back as `unknown` — no codec exists to decode a stored event, and no version discriminant to upcast old rows.

```
  /** The full original event, opaque — interpret using `eventTag`. */
  readonly payload: unknown;
```

**Fix plan** (effort L; depends on: —; spec: BEH-EA-100, BEH-EA-101)

_Define every AuthEvent as an Effect Schema (TaggedStruct) with a `version` literal, derive the TS types from the schemas, and decode AuditLog payloads through the union codec._

Steps:
1. packages/core/src/AuthEvents.ts: replace each `interface XEvent` with `export const XEvent = Schema.TaggedStruct("auth.x", { ...fields })` (plus `v: Schema.Literal(1)` or envelope-level `version`, see ESA-002); `export type XEvent = typeof XEvent.Type`; `export const AuthEventSchema = Schema.Union([...])`; `export type AuthEvent = typeof AuthEventSchema.Type`. Keep `_tag` literals unchanged.
2. Id fields use branded schemas (`UserId` schema via `Schema.String.pipe(Schema.brand("UserId"))` compatible with Users.ts's Brand.nominal — or migrate Users.UserId to a schema brand), enabling GC-007.
3. packages/core/src/AuditLog.ts: `AuditLogRecord.payload` becomes `AuthEvent` decoded via `Schema.decodeUnknownEffect(AuthEventSchema)` in `toRecord`; a row that fails to decode surfaces as a typed `AuditLogDecodeError` (or `Option.none` payload + raw text) — never `unknown`. `eventTag` can then be the narrow union.
4. packages/sql/src/Repositories.ts AuditLogRepository: store payload via `Schema.encode(AuthEventSchema)` + JSON; keep TEXT column.
5. Document the evolution rule in spec/behaviors/13-events.md BEH-EA-101: a breaking payload change bumps the version and adds a decode-time upcaster; old rows remain decodable.
6. Design note (not a blocker): plugin-owned event schemas (organization's 18 tags) still live in core; a future plugin-contributed registry can build on these schemas.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/sql/src/Repositories.ts`, `packages/core/test/AuditLog.test.ts`, `spec/behaviors/13-events.md`

Tests (write first):
- packages/core/test/AuditLog.test.ts — `it.effect("layerSql round-trips every AuthEvent variant through the schema codec")` (property-style over one sample per tag, in-memory SQLite): `list()` returns payloads that `===`-structurally equal the published events and are typed `AuthEvent`. Fails today (payload is unknown/JSON).
- Same file — a hand-inserted row with a malformed payload yields the typed decode error, not a defect.

Acceptance:
- `AuditLogRecord.payload` is `AuthEvent`, decoded; every event type is derived from a Schema; a version field exists.

**Recommended status:** `ready-for-agent`

### GC-007 — AuthEvent union mixes branded and unbranded id fields

`low` · `dx` · `core` · [.issues/low/GC-007-giulio-canti.md](../../.issues/low/GC-007-giulio-canti.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

`userId` fields are branded `UserId`, while every `sessionId` (reuse, issued, impersonationStarted/Stopped) and `familyId` is plain `string` although `Sessions.SessionId` exists. organizationId/teamId/invitationId are also unbranded (no brands exist for them yet).

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:68` — auth.session.reuse exists (commit 9017a8a, RRS-003); published at Sessions.ts:450/776.

```
export interface SessionReuseEvent {
  readonly _tag: "auth.session.reuse";
  readonly sessionId: string;
  readonly familyId: string;
  readonly userId: UserId;
}
```

`packages/core/src/Sessions.ts:30` — Brand exists; events use plain `sessionId: string` (AuthEvents.ts:70, 78, 127, 133).

```
export type SessionId = string & Brand.Brand<"SessionId">;
export const SessionId = Brand.nominal<SessionId>();
```

**Fix plan** (effort S; depends on: ESA-007; spec: BEH-EA-101)

_Brand session ids in the event union (type-only import to avoid a runtime cycle), as part of the ESA-007 schema migration._

Steps:
1. packages/core/src/AuthEvents.ts: `import type { SessionId } from "./Sessions.ts"` (Sessions.ts imports AuthEvents at runtime, so keep this type-only) — or, with ESA-007, a `SessionIdSchema` defined in a leaf module both can import.
2. sessionId: SessionId on SessionReuse/SessionIssued/AdminImpersonationStarted/Stopped; familyId: SessionFamilyId if a brand is introduced (optional).
3. Update publishers: Sessions.ts:450/776 (already hold SessionId), Password.ts session.issued publishes (issued.session.id), Admin.ts:302/325/350 (wrap `Sessions.SessionId(caller.sessionId)` where it is a string).

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/Sessions.ts`, `packages/password/src/Password.ts`, `packages/admin/src/Admin.ts`

Tests (write first):
- Type-level: a `// @ts-expect-error` test in packages/core/test/AuthEvents.test.ts that publishing `{ _tag: "auth.session.issued", sessionId: "raw", userId }` fails to typecheck.

Acceptance:
- All session-id fields in AuthEvent are `SessionId`; `pnpm run typecheck` green.

**Recommended status:** `ready-for-agent`

### IDS-006 — Lifecycle events under-attribute: denied event omits the target, stopped event omits the admin

`low` · `security` · `core` · [.issues/low/IDS-006-impersonation-delegation-specialist.md](../../.issues/low/IDS-006-impersonation-delegation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Denied still carries only adminUserId (target known at Admin.ts:266 in impersonate); Stopped carries only sessionId/endedBy although `records.endEpisode` returns the full record.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:130` — Stopped carries no admin/target; Denied (AuthEvents.ts:144-147) carries only adminUserId.

```
/** Published by `@awthaq/admin`'s `stopImpersonating`/`forceStop` (BEH-EA-218). */
export interface AdminImpersonationStoppedEvent {
  readonly _tag: "auth.admin.impersonationStopped";
  readonly sessionId: string;
  readonly endedBy: "self" | "forcedByAdmin" | "expired";
}
```

`packages/admin/src/Admin.ts:278` — targetUserId is in scope here (impersonate's own input); endEpisode (ImpersonationRecords.ts:77-80) returns the full record with adminUserId/targetUserId for the stopped event.

```
        const allowed = yield* adminConfig.canImpersonate(subjectOf(caller));
        if (!allowed) {
          yield* events.publish({
            _tag: "auth.admin.impersonationDenied",
            adminUserId: Users.UserId(caller.ref.id),
          });
```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-218, BEH-EA-101)

_Add attribution fields to the impersonation lifecycle events._

Steps:
1. packages/core/src/AuthEvents.ts: `AdminImpersonationDeniedEvent` gains `targetUserId: Option<UserId>`-equivalent (optional field `targetUserId?: UserId` and `sessionId?: SessionId`) plus `operation: "impersonate" | "forceStop" | "list"`; `AdminImpersonationStoppedEvent` gains `adminUserId: UserId`, `targetUserId: UserId`.
2. packages/admin/src/Admin.ts: impersonate denied → include targetUserId; forceStop denied → include sessionId; list denied → operation only; stopImpersonating/forceStop → take `const record = yield* records.endEpisode(...)` and publish `adminUserId: record.adminUserId, targetUserId: record.targetUserId`.
3. packages/core/src/AuditLog.ts actorOf: stopped → `Option.some(event.adminUserId)` (exhaustive switch will force this).

Files: `packages/core/src/AuthEvents.ts`, `packages/admin/src/Admin.ts`, `packages/core/src/AuditLog.ts`, `packages/admin/test/Admin.test.ts`, `features/features/**/27-admin-impersonation.feature`

Tests (write first):
- packages/admin/test/Admin.test.ts — `it.effect("impersonationDenied carries the attempted target; impersonationStopped carries admin and target")`. Fails today.

Acceptance:
- SIEM consumers can attribute denied/stopped events without joining ImpersonationRecords.

**Recommended status:** `ready-for-agent`

## Workstream `canonical-starter-defaults`

### ERAS-002 — Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships

`medium` · `dx` · `test` · [.issues/medium/ERAS-002-edge-runtime-auth-specialist.md](../../.issues/medium/ERAS-002-edge-runtime-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

NodeCrypto.layer is still the only Crypto provider composed anywhere (TestAuth, README, examples). Nuance: Effect v4 itself ships a globalThis.crypto provider (@effect/platform-browser BrowserCrypto.layer), so the gap is that awthaq neither ships nor documents an edge-safe path, not that one cannot exist.

**Evidence at HEAD:**

`packages/test/src/TestAuth.ts:107` — Only Crypto provider composed anywhere in the repo (also README.md:86/106/140). Effect v4 does ship a globalThis.crypto-backed provider (../effect/packages/platform/browser/src/BrowserCrypto.ts) but nothing in awthaq uses or documents it.

```
).pipe(
  Layer.provideMerge(NodeCrypto.layer),
```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-193)

_Ship a tiny, dependency-free WebCrypto-backed Crypto layer in @awthaq/ports and document it for edge runtimes._

Steps:
1. packages/ports/src/WebCrypto.ts (new): `export const layer = Layer.succeed(Crypto.Crypto, Crypto.make({ randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), digest: (alg, data) => Effect.tryPromise({ try: () => globalThis.crypto.subtle.digest(alg, data).then((b) => new Uint8Array(b)), catch: (e) => PlatformError... }) }))` — mirrors ../effect/packages/platform/browser/src/BrowserCrypto.ts without adding a browser-platform dependency to server packages (same edge-safe/no-new-dependency posture as wayfinder ticket 35). Map DigestAlgorithm names to WebCrypto names as BrowserCrypto does.
2. packages/next/README.md edge-runtime recipe + main README: use `WebCrypto.layer` on edge; NodeCrypto remains fine on Node.
3. Run the core Sessions/Verification test suites once under WebCrypto.layer (Node ≥ 20 exposes globalThis.crypto) to prove parity.

Files: `packages/ports/src/WebCrypto.ts`, `packages/ports/src/index.ts`, `packages/ports/test/WebCrypto.test.ts`, `README.md`, `packages/next/README.md`

Tests (write first):
- packages/ports/test/WebCrypto.test.ts — randomBytes length/entropy smoke, SHA-256 digest equals NodeCrypto's for the same input, and `Sessions.layerMemory` issue/verify round-trip under WebCrypto.layer.

Acceptance:
- An edge app can compose awthaq with WebCrypto.layer and no Node built-ins; docs show it.

**Recommended status:** `ready-for-agent`

### RBS-007 — Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense

`medium` · `dx` · `test` · [.issues/medium/RBS-007-rate-limiting-brute-force-specialist.md](../../.issues/medium/RBS-007-rate-limiting-brute-force-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

README quickstart and its configuration table still default to `RateLimiter.layerPermissive`; examples/memory-server inherits it via TestAuth; there is no one-line real limiter composite. Registered rules are inert out of the box, contradicting BEH-EA-110.

**Evidence at HEAD:**

`README.md:216` — README quickstart (README.md:139) and TestAuth (TestAuth.ts:99) — and thus examples/memory-server — compose the permissive limiter; no one-line real-limiter composite exists (RateLimiter.ts:86 layer needs :111 layerStoreMemory).

```
| `RateLimiter` | `layerPermissive` (no real limiting) | `layer` over `layerStoreMemory`, or your own `RateLimiterStore` |
```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-110, BEH-EA-112)

_Ship a real in-memory limiter composite as the documented default, reserve permissive for tests, and warn when rules are registered under a permissive limiter._

Steps:
1. packages/ports/src/RateLimiter.ts: `export const layerMemory = layer.pipe(Layer.provide(layerStoreMemory))` (no annotation; inferred).
2. README.md:139 quickstart and the table at :216 → default `RateLimiter.layerMemory`; mark `layerPermissive` 'tests only'.
3. examples/memory-server/index.ts: provide `RateLimiter.layerMemory` via the services param so it overrides TestAuth's permissive default (or give TestAuth.layer an option).
4. Boot-time warning: `layerPermissive` carries a marker (`permissive: true` on the shape); `RateLimits.layer`/Auth composition logs `auth.ratelimit.permissive` once at first `registered()` read when rules exist and the limiter is permissive.

Files: `packages/ports/src/RateLimiter.ts`, `packages/core/src/RateLimits.ts`, `README.md`, `examples/memory-server/index.ts`, `packages/ports/test/RateLimiter.test.ts`

Tests (write first):
- packages/ports/test/RateLimiter.test.ts — `layerMemory` enforces a registered limit (N+1th consume fails RateLimited); a composition with rules + layerPermissive emits the warning log once.

Acceptance:
- Copying the README quickstart yields real rate limiting; permissive is only used in tests.

**Recommended status:** `ready-for-agent`

## Workstream `hook-run-semantics`

### JH-002 — observe taps are sorted by declared order then run unbounded-concurrent

`medium` · `correctness` · `core` · [.issues/medium/JH-002-jared-hanson.md](../../.issues/medium/JH-002-jared-hanson.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for ECF-006, ERS-005, PERS-004

observe `run` still fans out with `concurrency: "unbounded"`, so the sorted order is cosmetic. Now live on the sign-in hot path (AfterSignIn in password/oauth/passkey). Observer failures are only logged, never counted.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:278` — Sorted order is discarded by unbounded concurrent execution; failures only logged (no metric); full Cause logged.

```
    const run: ObserveShape<Input>["run"] = (value) =>
      Effect.forEach(
        resolveTaps(),
        (handler) =>
          handler(value).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.hook.observer.error", { hook: key, cause }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
```

`packages/password/src/Password.ts:877` — AfterSignIn observe taps now run inline on the sign-in path (also OAuth.ts:859, Passkey.ts:838), so the unordered/unbounded fan-out is live.

```
        yield* afterSignIn.run({ userId: user.id, strategy: "password" });
```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-092, BEH-EA-023, BEH-EA-091)

_Run observe taps sequentially in resolved order (like veto/divert), and add an observer-failure metric next to the existing log line._

Steps:
1. packages/core/src/HookPoint.ts observe `run`: drop `concurrency: "unbounded"` (keep `discard: true`) so taps execute one after another in resolved order; per-tap `catchCause` stays, so one failure never stops later taps (BEH-EA-092).
2. Add `Metric.counter("awthaq_hook_observer_error_total")` tagged `{ hook: key }` incremented in the catchCause branch (define it in the Observability module MW-001's plan introduces, or locally in HookPoint.ts if that lands later).
3. Document on `ObserveTap`/`TapOptions.order` that observe taps run inline and sequentially, so a slow tap adds latency to the observed operation; recommend heavy work be forked or moved to an AuthEvents subscriber.

Files: `packages/core/src/HookPoint.ts`, `packages/core/test/HookPoint.test.ts`, `spec/behaviors/12-hooks.md`

Tests (write first):
- packages/core/test/HookPoint.test.ts — `it.effect("observe taps run sequentially in declared order")`: tap order:1 sleeps (TestClock) then appends "a"; tap order:2 appends "b" immediately; after `TestClock.adjust`, the log is ["a","b"]. Fails today (["b","a"]).
- Same file — failing observer increments `awthaq_hook_observer_error_total` (read via `Metric.value`).

Acceptance:
- Observe taps execute in resolved order; a later tap starts only after the earlier one completes.
- Observer failures are countable via a metric.

**Recommended status:** `ready-for-agent`

### JH-004 — Hook input schemas are required but never decoded — no runtime check at the tap boundary

`medium` · `security` · `core` · [.issues/medium/JH-004-jared-hanson.md](../../.issues/medium/JH-004-jared-hanson.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for GC-009

Point schemas are still discarded. Since commit 3e298c8 a veto tap's amended value flows straight into `users.create` (Password.ts:730/746) — the 'never external data' premise in the header no longer holds for the sign-up path (the amended value originates from third-party tap code guarding an externally-originated request).

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:29`

```
// `input` (and `divert`'s `diverted`) are accepted as `Schema.Schema`
// values purely as type carriers, matching BEH-EA-089's own
// `{ input: SignUpInput }` — never decoded here. A hook point's input is
// always an already-typed value handed down from application/plugin code
// (the operation the point guards), never unknown external data crossing a
// boundary, so there is nothing for this module itself to decode.
```

`packages/core/src/HookPoint.ts:197` — Schema accepted, never used (same at :253, :313-314).

```
    void input; // type carrier only — see this module's own header comment
```

`packages/password/src/Password.ts:730` — A tap's amended value now flows straight into users.create({ email: vetoedSignUp.email, ... }) at :746 with no check against the point's own schema (same pattern Organization.ts:1401-1407).

```
        const vetoedSignUp = yield* vetoBeforeSignUp(
          beforeSignUp.run({ email: input.email, name }),
        );
```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-089, BEH-EA-090, BEH-EA-091, BEH-EA-093)

_Validate every veto tap's returned value (and every divert tap's diverted value) against the point's own schema inside `run`, using `Schema.is` (a type guard over the already-passed schema — no decoding services, no type assertions)._

Steps:
1. packages/core/src/HookPoint.ts veto: keep `input` (remove `void input`); `const isInput = Schema.is(input)`; in the veto loop, after `current = yield* handler(current)`, if `!isInput(current)` → `Effect.die(new HookTapOutputInvalid({ point: key, owner }))` (new `Data.TaggedError`, names the offending tap's owner once JH-003 lands, else its index).
2. divert: `const isDiverted = Schema.is(diverted)`; validate `outcome.value` the same way before `divertTo`.
3. observe: no output to validate — leave as is.
4. Rewrite the header paragraph at HookPoint.ts:29-34 to state that tap outputs are validated against the point schema.
5. Optionally tighten Hooks.ts `SignUpInput.email` to an email-shaped schema so the check is meaningful for BeforeSignUp.

Files: `packages/core/src/HookPoint.ts`, `packages/core/src/Hooks.ts`, `packages/core/test/HookPoint.test.ts`

Tests (write first):
- packages/core/test/HookPoint.test.ts — `it.effect("a veto tap returning a value that fails the point schema is a defect naming the point")`: point with `Schema.Struct({ n: Schema.Number })`, tap built from an untyped JS function object returning `{ n: "x" }` via a `Schema.decodeUnknownSync`-free path (e.g. a handler typed through `unknown` narrowing in the test, not `as`) → `Effect.exit` is a Die with HookTapOutputInvalid. Fails today (value passes through).
- Same for divert.

Acceptance:
- No `void input` / `void diverted` remain.
- An invalid tap output never reaches the guarded operation.

**Recommended status:** `ready-for-agent`

### ECF-006 — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only

`low` · `correctness` · `core` · [.issues/low/ECF-006-effect-concurrency-fiber-specialist.md](../../.issues/low/ECF-006-effect-concurrency-fiber-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **JH-002**

Same unbounded observe fan-out as JH-002.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:278` — Sorted order is discarded by unbounded concurrent execution; failures only logged (no metric); full Cause logged.

```
    const run: ObserveShape<Input>["run"] = (value) =>
      Effect.forEach(
        resolveTaps(),
        (handler) =>
          handler(value).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.hook.observer.error", { hook: key, cause }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
```

**Fix plan:** none — tracked by JH-002's plan.

**Recommended status:** `resolved`

### ERS-005 — Hook-point taps run with unbounded concurrency, making tap order cosmetic

`low` · `correctness` · `core` · [.issues/low/ERS-005-effect-runtime-scheduler-specialist.md](../../.issues/low/ERS-005-effect-runtime-scheduler-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **JH-002**

Same unbounded observe fan-out as JH-002; its 'bounded-concurrency knob' suggestion is subsumed by sequential execution.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:278` — Sorted order is discarded by unbounded concurrent execution; failures only logged (no metric); full Cause logged.

```
    const run: ObserveShape<Input>["run"] = (value) =>
      Effect.forEach(
        resolveTaps(),
        (handler) =>
          handler(value).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.hook.observer.error", { hook: key, cause }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
```

**Fix plan:** none — tracked by JH-002's plan.

**Recommended status:** `resolved`

### PERS-004 — Observe taps run unbounded-concurrency with swallowed failures — observer side effects are unordered and silent

`low` · `correctness` · `core` · [.issues/low/PERS-004-policy-engine-rego-specialist.md](../../.issues/low/PERS-004-policy-engine-rego-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **JH-002**

Same unbounded observe fan-out as JH-002; its extra ask (an observer-error metric) is folded into JH-002's plan.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:278` — Sorted order is discarded by unbounded concurrent execution; failures only logged (no metric); full Cause logged.

```
    const run: ObserveShape<Input>["run"] = (value) =>
      Effect.forEach(
        resolveTaps(),
        (handler) =>
          handler(value).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.hook.observer.error", { hook: key, cause }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
```

**Fix plan:** none — tracked by JH-002's plan.

**Recommended status:** `resolved`

### GC-009 — Hook point input schemas are phantom witnesses, never decoded

`info` · `architecture` · `core` · [.issues/info/GC-009-giulio-canti.md](../../.issues/info/GC-009-giulio-canti.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **JH-004**

Same observation (schemas are phantom). GC-009's own trigger condition — 'if hook points ever guard an externally-originated operation, decode at run using the already-passed schema' — is now met (BeforeSignUp guards HTTP sign-up), so it resolves via JH-004's plan.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:197` — Schema accepted, never used (same at :253, :313-314).

```
    void input; // type carrier only — see this module's own header comment
```

**Fix plan:** none — tracked by JH-004's plan.

**Recommended status:** `resolved`

## Workstream `test-harness-completeness`

### ETVS-004 — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites

`medium` · `dx` · `test` · [.issues/medium/ETVS-004-effect-testing-vitest-specialist.md](../../.issues/medium/ETVS-004-effect-testing-vitest-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

Partly addressed: MemoryPorts now includes AuthEvents, AuditLog and Hooks.HooksLive. Still open: no Verification.layerMemory / PasswordHasher, so password-style compositions re-add them through the misnamed `middleware` parameter (examples/memory-server/index.ts:84-88), and the password/server/oauth/passkey AuthHttp suites plus BDD Worlds still hand-roll their own CoreLive assemblies.

**Evidence at HEAD:**

`packages/test/src/TestAuth.ts:94` — AuthEvents/AuditLog/Hooks now provided (lines 110-118) but still no Verification.layerMemory or PasswordHasher.

```
const MemoryPorts = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Mailer.layerMemory,
  RateLimiter.layerPermissive,
  RateLimits.layer,
  SqlTransaction.layerNoop,
```

`packages/password/test/AuthHttp.test.ts:62` — Hand-rolled assembly still duplicated (also features/step-definitions/PasswordWorld.ts:44, server/oauth/passkey AuthHttp.test.ts); examples/memory-server/index.ts:84-88 re-adds Verification+PasswordHasher via the middleware slot.

```
const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
```

**Fix plan** (effort M; depends on: —; spec: BEH-EA-193)

_Complete the memory bundle, rename the second parameter, and migrate the hand-rolled suites onto TestAuth.layer._

Steps:
1. packages/test/src/TestAuth.ts MemoryPorts: add `Verification.layerMemory` and a fast test hasher (`PasswordHasher.layerArgon2id` with low-cost test params, or a dedicated `PasswordHasher.layerTest` if one exists/is added) and `FetchHttpClient.layer` only if needed by plugins (prefer leaving HTTP client to the caller).
2. Rename `middleware` → `services` (it carries support layers, not only HttpApi middleware); update doc comment.
3. Migrate packages/password/test/AuthHttp.test.ts, packages/server/test/AuthHttp.test.ts, packages/oauth/test/AuthHttp.test.ts, packages/passkey/test/AuthHttp.test.ts, features/step-definitions/PasswordWorld.ts and SessionWorld.ts to TestAuth.layer; keep bespoke layers only where a test deliberately swaps a port (pass via `services`).
4. Simplify examples/memory-server/index.ts accordingly.

Files: `packages/test/src/TestAuth.ts`, `packages/test/test/TestAuth.test.ts`, `packages/password/test/AuthHttp.test.ts`, `packages/server/test/AuthHttp.test.ts`, `packages/oauth/test/AuthHttp.test.ts`, `packages/passkey/test/AuthHttp.test.ts`, `features/step-definitions/PasswordWorld.ts`, `features/step-definitions/SessionWorld.ts`, `examples/memory-server/index.ts`

Tests (write first):
- packages/test/test/TestAuth.test.ts — `TestAuth.layer(Auth.make([Password]), AuthenticationLive)` builds and serves sign-up/sign-in with no extra Verification/PasswordHasher layers. Fails today (missing services).

Acceptance:
- One memory assembly used by all wire-level suites; `grep -l 'Verification.layerMemory' packages/*/test` only hits tests that intentionally swap it.

**Recommended status:** `ready-for-agent`

### SSMS-004 — REQ-EA-563's 'migrations apply deterministically' check never applies a migration

`medium` · `testing` · `test` · [.issues/medium/SSMS-004-sql-schema-migration-specialist.md](../../.issues/medium/SSMS-004-sql-schema-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for ETVS-005

The contract check still JSON-compares two builds' migration arrays; `up` Effects are dropped by JSON.stringify and nothing touches a store, so REQ-EA-563's 'applies the migrations twice, independently' is not implemented.

**Evidence at HEAD:**

`packages/test/src/TestAuth.ts:310` — Inside the 'migrations apply deterministically' check (TestAuth.ts:302-318): a static JSON comparison — `up` Effects are dropped by JSON.stringify and nothing is ever applied to a store.

```
          const builtA = Auth.make([first, ...rest]);
          const builtB = Auth.make([first, ...rest]);
          if (JSON.stringify(builtA.migrations) !== JSON.stringify(builtB.migrations)) {
            framework.fail(
```

`features/features/08-tooling/25-testing-harness.feature:160`

```
    Scenario: runPluginContractTests asserts the plugin's migrations apply deterministically
      Given a plugin "invite" run through "runPluginContractTests"
      When the contract test suite applies "invite"'s migrations twice, independently
      Then it asserts both runs apply the migrations identically
```

**Fix plan** (effort M; depends on: —; spec: BEH-EA-198)

_Run the built migrations twice against two fresh in-memory SQLite databases and compare resulting schemas; keep the cheap declaration check under an honest name._

Steps:
1. packages/test/src/TestAuth.ts: rename the static check to `${label}: migration declarations are deterministic across builds` (compare ids/names).
2. Add `${label}: migrations apply identically on two fresh databases`: for each of builtA/builtB, build `SqliteClient.layer({ filename: ":memory:" })` (@effect/sql-sqlite-node, the pattern packages/sql/test uses) and run the migrations via the same Migrator the repo uses (packages/sql's Migrations runner), then read `SELECT type, name, sql FROM sqlite_master ORDER BY name` and compare. Execute via `Effect.runPromise` inside the injected `framework.it` (runner-agnostic); make TestFramework.it accept `() => void | Promise<void>`.
3. Also apply each build's migrations twice to the *same* DB to assert idempotent re-run (migrator skips applied ids).
4. Update spec/traceability.md:200 wording.

Files: `packages/test/src/TestAuth.ts`, `packages/test/test/runPluginContractTests.test.ts`, `packages/test/package.json`, `spec/traceability.md`

Tests (write first):
- packages/test/test/runPluginContractTests.test.ts — a fixture plugin whose migration `up` creates a table with a name derived from a module-level counter (differs per build) now FAILS the contract suite; @awthaq/password passes. Fails today (JSON compare passes it).

Acceptance:
- REQ-EA-563's scenario is backed by an actual double application of migrations; a nondeterministic `up` is caught.

**Recommended status:** `ready-for-agent`

### ETVS-005 — Contract suite's 'migrations apply deterministically' never applies a migration

`low` · `testing` · `test` · [.issues/low/ETVS-005-effect-testing-vitest-specialist.md](../../.issues/low/ETVS-005-effect-testing-vitest-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **SSMS-004**

Identical finding (static JSON compare never applies a migration); same fix.

**Evidence at HEAD:**

`packages/test/src/TestAuth.ts:310` — Inside the 'migrations apply deterministically' check (TestAuth.ts:302-318): a static JSON comparison — `up` Effects are dropped by JSON.stringify and nothing is ever applied to a store.

```
          const builtA = Auth.make([first, ...rest]);
          const builtB = Auth.make([first, ...rest]);
          if (JSON.stringify(builtA.migrations) !== JSON.stringify(builtB.migrations)) {
            framework.fail(
```

**Fix plan:** none — tracked by SSMS-004's plan.

**Recommended status:** `resolved`

## Workstream `auth-event-envelope`

### ESA-002 — No event carries a timestamp or sequence number — post-hoc ordering and point-in-time reconstruction are impossible

`high` · `correctness` · `core` · [.issues/high/ESA-002-event-sourcing-audit-trail-specialist.md](../../.issues/high/ESA-002-event-sourcing-audit-trail-specialist.md) · current status `ready-for-agent`

**Verdict:** PARTIAL (confidence high) · fixed-by `6bd3f1d`

Fixed part (6bd3f1d): the durable record of record now stamps `occurredAt` server-side and a uuidv7 `id` (layerSql), so point-in-time reconstruction from auth_audit_log is possible. Still open: the event values themselves (what every subscriber receives) carry no occurredAt/eventId, so a subscriber must stamp receive time and cannot join its event to the audit row; the SQL list orders by occurredAt only with no id tiebreak (same-ms rows unordered), and layerMemory's `newestFirst` keeps insertion order among ties (oldest-first).

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:122` — Free-text reason on the bus and in the audit row; no occurredAt/eventId on the event itself; sessionId is plain string.

```
export interface AdminImpersonationStartedEvent {
  readonly _tag: "auth.admin.impersonationStarted";
  readonly adminUserId: UserId;
  readonly targetUserId: UserId;
  readonly reason: string;
  readonly sessionId: string;
}
```

`packages/core/src/AuditLog.ts:151` — Time + identity are stamped only inside AuditLog, never on the event the bus delivers — a subscriber cannot join its event to the durable row.

```
        const id = yield* Ref.updateAndGet(nextId, (n) => n + 1);
        const now = yield* DateTime.now;
        const entry: AuditLogRecord = {
          id: `mem-${id}`,
```

`packages/core/src/AuditLog.ts:45` — Durable row has a server-stamped occurredAt; correlationId column exists but is always Option.none()/null (AuditLog.ts:158, :201).

```
  readonly occurredAt: DateTime.Utc;
  /** Reserved for ALF-006 — no `AuthEvent` payload carries one yet. */
  readonly correlationId: Option.Option<string>;
```

`packages/sql/src/Repositories.ts:863` — No id tiebreak: same-millisecond rows come back in unspecified order.

```
          return sql`SELECT * FROM auth_audit_log WHERE ${sql.and(conditions)} ORDER BY "occurredAt" DESC`;
```

**Fix plan** (effort M; depends on: ESA-007; spec: BEH-EA-100, BEH-EA-101, BEH-EA-102)

_Stamp one envelope (eventId uuidv7 + occurredAt) in `publish`, use it for both the AuditLog row and the bus, and deliver it to subscribers._

Steps:
1. packages/core/src/AuthEvents.ts: `export interface EventMetadata { readonly eventId: string; readonly occurredAt: DateTime.Utc; readonly correlationId: Option<string> }` (correlationId populated by ALF-006); `export type Published<E extends AuthEvent = AuthEvent> = E & EventMetadata` (distributes over the union, so `_tag` narrowing still works).
2. `publish(event)` stays `(event: AuthEvent) => Effect<void>` for publishers; internally `const meta = { eventId: yield* crypto.randomUUIDv7, occurredAt: yield* DateTime.now, ... }`, `const published = { ...event, ...meta }`, then `auditLog.record(published)` and `PubSub.publish(pubsub, published)`. AuthEvents.layer gains `Crypto.Crypto` in RIn (or AuditLog exposes the id generator) — AuditLog.layerMemory's counter id can stay for memory, but prefer one id source.
3. `stream: Stream<Published>`, `on(tag, handler: (e: Published<Extract<...>>) => ...)`.
4. packages/core/src/AuditLog.ts: `record(published)` uses `published.eventId`/`occurredAt` instead of generating its own; strip metadata keys from `payload` (or keep — decide in ESA-007's codec).
5. packages/sql/src/Repositories.ts:863: `ORDER BY "occurredAt" DESC, id DESC`; AuditLog.ts `newestFirst`: tiebreak on id desc (memory ids must then be zero-padded or numeric-compared).

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/sql/src/Repositories.ts`, `packages/core/test/AuthEvents.test.ts`, `packages/core/test/AuditLog.test.ts`

Tests (write first):
- packages/core/test/AuthEvents.test.ts — `it.effect("every delivered event carries eventId and occurredAt equal to its AuditLog row")`: publish, take from `subscribe`, `auditLog.list()`, assert `delivered.eventId === row.id` and same occurredAt (TestClock). Fails today (fields absent).
- packages/core/test/AuditLog.test.ts — two events in the same millisecond list newest-first deterministically (by id).

Acceptance:
- Every delivered event has eventId + occurredAt; audit rows and bus events share the id; list order is total.

**Recommended status:** `ready-for-agent`

### ALF-006 — Event payloads carry no timestamp, correlation id, or source context

`medium` · `correctness` · `core` · [.issues/medium/ALF-006-audit-logging-forensics-specialist.md](../../.issues/medium/ALF-006-audit-logging-forensics-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · canonical for EOTS-009

Timestamp part is covered for the durable row (occurredAt, 6bd3f1d) and for the bus by ESA-002's plan. Still open: no correlation/request id (column reserved, always null — AuditLog.ts:46 literally says 'Reserved for ALF-006'), no source context (ip/userAgent) on any event, no trace linkage from event → request span.

**Evidence at HEAD:**

`packages/core/src/AuditLog.ts:45` — Durable row has a server-stamped occurredAt; correlationId column exists but is always Option.none()/null (AuditLog.ts:158, :201).

```
  readonly occurredAt: DateTime.Utc;
  /** Reserved for ALF-006 — no `AuthEvent` payload carries one yet. */
  readonly correlationId: Option.Option<string>;
```

`packages/core/src/AuthEvents.ts:122` — Free-text reason on the bus and in the audit row; no occurredAt/eventId on the event itself; sessionId is plain string.

```
export interface AdminImpersonationStartedEvent {
  readonly _tag: "auth.admin.impersonationStarted";
  readonly adminUserId: UserId;
  readonly targetUserId: UserId;
  readonly reason: string;
  readonly sessionId: string;
}
```

**Fix plan** (effort M; depends on: ESA-002; spec: BEH-EA-100, BEH-EA-104)

_Introduce a request-scoped `AuthRequestContext` reference populated by the server layer and read by `publish`, and link subscriber handling to the originating span._

Steps:
1. packages/core: new `AuthRequestContext` = `Context.Reference<{ correlationId: Option<string>; ip: Option<string>; userAgent: Option<string> }>` with an all-none default (Reference → no RIn change for any caller).
2. packages/server: in the HttpApi middleware/handler wrapper that already derives `ClientAddress` (AGA-001/NHS-003) set the reference per request via `Effect.provideService` — correlationId from an incoming `x-request-id`/W3C `traceparent` trace-id, else a fresh uuidv7; ip from ClientAddress; userAgent from headers.
3. AuthEvents.publish (after ESA-002): read the reference and fill `EventMetadata.correlationId` (+ `source: { ip, userAgent }` optional fields); also capture `Effect.currentSpan` (Option) → `traceId`/`spanId` in metadata.
4. AuditLog.record: persist `correlationId` into the existing column; put ip/userAgent into payload metadata (no new column needed; optional indexed column later).
5. AuthEvents.on: run each handler under `Effect.withSpan("awthaq.event.handle", { attributes: { "auth.event": tag, "auth.correlation_id": ... }, links: traceId/spanId present ? [link] : [] })` and `Effect.annotateLogs({ correlationId })` so observer-error logs carry it (closes EOTS-009).

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/core/src/index.ts`, `packages/server/src/Authentication.ts`, `packages/server/src/AuthHttp.ts`, `packages/core/test/AuthEvents.test.ts`, `packages/server/test/AuthHttp.test.ts`

Tests (write first):
- packages/core/test/AuthEvents.test.ts — `it.effect("publish stamps correlationId/ip from AuthRequestContext")` (provideService the reference; assert delivered event + audit row). Fails today.
- packages/server/test/AuthHttp.test.ts — a sign-in request with `x-request-id: r-1` produces audit rows whose correlationId is `r-1`, and two events from one request share it.

Acceptance:
- Events from one HTTP request share a correlationId persisted in auth_audit_log.correlationId; subscriber logs/spans carry it.

**Recommended status:** `ready-for-agent`

### EOTS-009 — Event subscribers fork without trace linkage or annotations, detaching security events from the request that caused them

`low` · `correctness` · `core` · [.issues/low/EOTS-009-effect-observability-tracing-specialist.md](../../.issues/low/EOTS-009-effect-observability-tracing-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ALF-006**

Same missing correlation between an event and the request that produced it; ALF-006's plan stamps correlationId/trace ids at publish and runs handlers under a linked span with annotated logs.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:405` — on() forks with plain forkScoped (no startImmediately, no pre-registered subscription); the full Cause is logged verbatim.

```
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
          ),
        ),
        Effect.forkScoped,
```

**Fix plan:** none — tracked by ALF-006's plan.

**Recommended status:** `resolved`

## Workstream `core-hook-point-coverage`

### NAM-002 — Auth.js signIn-callback logic has no wired landing spot: hook points are mechanism-only

`high` · `architecture` · `core` · [.issues/high/NAM-002-nextauth-authjs-migration-specialist.md](../../.issues/high/NAM-002-nextauth-authjs-migration-specialist.md) · current status `ready-for-agent`

**Verdict:** PARTIAL (confidence high)

Fixed part (commit 3e298c8): hook points are no longer mechanism-only — BeforeSignUp/AfterSignIn/BeforeSessionIssue/BeforeUserDelete are declared in Hooks.ts and consumed by password/oauth/passkey/users. Still open: there is no *veto* point on sign-in (BeforeSessionIssue is a divert whose only outcome is TwoFactorRequired — it cannot deny), so an Auth.js `signIn` callback returning `false` (domain allow-list, banned user) still has no landing spot; OAuth first-login user creation (OAuth.ts:832) bypasses BeforeSignUp; the spec'd BeforeSignIn/AfterSignUp (spec/overview.md:107) are not declared; no migration note maps Auth.js callback returns to HookAbort codes.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:50` — The header the audit quoted ('not yet wiring any concrete hook point') has been replaced.

```
// AOMS-006/BCR-004/CSG-002/THS-002 (.issues/high) — wayfinder ticket 03:
// the concrete hook points this module's mechanism supports are now
// declared and wired into real flows, in `./Hooks.ts`
// (`BeforeSignUp`/`AfterSignIn`/`BeforeSessionIssue`/`BeforeUserDelete`),
```

`packages/password/src/Password.ts:550` — Consumed in real flows: Password signUp (:730) / signIn (:862, :877); OAuth.ts:517-518/846/859; Passkey.ts:555-556/825/838; Users.ts:244/351 (BeforeUserDelete).

```
      const beforeSignUp = yield* Hooks.BeforeSignUp;
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;
```

`spec/overview.md:107` — Spec'd BeforeSignIn (veto) and AfterSignUp (observe) are still not declared in Hooks.ts.

```
| `BeforeSignUp`, `BeforeSignIn`, `BeforeSessionIssue`, `AfterSignUp`, `AfterSignIn`, `BeforeUserDelete` | hook points (`HookPoint.Service`) | `Hooks.ts` |
```

`packages/oauth/src/OAuth.ts:832` — OAuth first-login user creation consults no BeforeSignUp veto (grep: OAuth.ts only reads BeforeSessionIssue/AfterSignIn).

```
              yield* events.publish({ _tag: "auth.user.created", userId: created.id });
              return created.id;
```

**Fix plan** (effort M; depends on: —; spec: BEH-EA-089, BEH-EA-090, BEH-EA-092, BEH-EA-095, BEH-EA-113)

_Complete the core hook-point set the spec lists: add a `BeforeSignIn` veto consulted by every sign-in-completing flow, consult `BeforeSignUp` on OAuth (and any other) first-login user creation, add `AfterSignUp`, and document the Auth.js mapping._

Steps:
1. packages/core/src/Hooks.ts: declare `BeforeSignIn = HookPoint.veto("auth.user.signIn", Schema.Struct({ userId: Schema.String, email: Schema.String, strategy: Schema.String }))` and `AfterSignUp = HookPoint.observe("auth.user.signedUp", Schema.Struct({ userId, email, strategy }))`; add both to `HooksLive`.
2. packages/password/src/Password.ts signIn: after credential + emailVerified checks and before `beforeSessionIssue.run` (:862), run `BeforeSignIn` and translate `HookAbort` → `HookPoint.HookAborted` (reuse the `vetoBeforeSignUp` helper pattern, generalised as `vetoPoint(pointId)`). Add `HookPoint.HookAborted` to PasswordApi signIn's error union.
3. packages/oauth/src/OAuth.ts callback: run `BeforeSignIn` on the targetUserId sign-in path before `beforeSessionIssue.run` (:846); in the new-user branch run `BeforeSignUp` (strategy = providerId) before the create transaction and `AfterSignUp` after (:832). Add HookAborted to OAuthApi callback errors.
4. packages/passkey/src/Passkey.ts authenticate: run `BeforeSignIn` before `beforeSessionIssue.run` (:825); PasskeyApi error union gains HookAborted.
5. packages/password/src/Password.ts signUp: run `AfterSignUp` after the transaction commits (next to the `auth.user.created` publish).
6. Consider extending `SignUpInput` with `strategy` so one BeforeSignUp tap can distinguish password vs OAuth JIT creation (breaking, acceptable pre-release).
7. Docs: add a migration note (e.g. docs/migrations/authjs.md or the migrate-* package README) mapping Auth.js `signIn` callback `true`/`false`/`string redirect`/throw to BeforeSignIn pass/HookAbort code/HookAbort with message; and `jwt`/`session` callbacks to AttributeResolver/claims (pointer only).
8. Delete the stale TestAuth.ts:23-28 header note ('no hook point is wired into a real signUp/signIn flow yet').

Files: `packages/core/src/Hooks.ts`, `packages/password/src/Password.ts`, `packages/password/src/PasswordApi.ts`, `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthApi.ts`, `packages/passkey/src/Passkey.ts`, `packages/passkey/src/PasskeyApi.ts`, `packages/test/src/TestAuth.ts`, `features/features/04-cross-cutting/12-hooks.feature`

Tests (write first):
- packages/password/test/PasswordHooksSignIn.test.ts (new, one file per tap scenario until ELC-001 lands) — `it.effect("a BeforeSignIn veto tap denies a correct-password sign-in with HookAborted naming its code; no session is issued and no auth.session.issued is published")`. Fails today (no such point).
- packages/oauth/test/OAuthHooksSignIn.test.ts — add "BeforeSignUp veto blocks OAuth first-login user creation" and "BeforeSignIn veto blocks a returning OAuth user".
- packages/passkey/test/PasskeyHooksSignIn.test.ts — add the BeforeSignIn deny case.
- features/features/04-cross-cutting/12-hooks.feature — add/enable a BEH-EA-090 scenario for sign-in veto if absent.

Acceptance:
- Every sign-in-completing flow (password, oauth, passkey) consults BeforeSignIn before BeforeSessionIssue, and a HookAbort surfaces as typed HookAborted (403).
- Every user-creating sign-up path (password, oauth JIT) consults BeforeSignUp.
- Hooks.ts declares all six points listed in spec/overview.md:107.

**Recommended status:** `ready-for-agent`

### SCP-008 — HookPoint machinery shipped but no concrete point is wired into real user flows for SCIM integration

`low` · `architecture` · `core` · [.issues/low/SCP-008-scim-provisioning-specialist.md](../../.issues/low/SCP-008-scim-provisioning-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

Fixed: core points now exist and are wired (3e298c8), so a plugin has something to tap. Still open: no creation-path-agnostic user-creation veto (BeforeSignUp only guards password sign-up; OAuth JIT creation at OAuth.ts:832 bypasses it), and `AfterUserDeactivated` cannot exist until a deactivation state does (wayfinder ticket 09, unimplemented at HEAD — Users.ts has no active/deactivated field). SCIM itself is Phase-3 scope (ticket 08).

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:50` — The header the audit quoted ('not yet wiring any concrete hook point') has been replaced.

```
// AOMS-006/BCR-004/CSG-002/THS-002 (.issues/high) — wayfinder ticket 03:
// the concrete hook points this module's mechanism supports are now
// declared and wired into real flows, in `./Hooks.ts`
// (`BeforeSignUp`/`AfterSignIn`/`BeforeSessionIssue`/`BeforeUserDelete`),
```

`packages/oauth/src/OAuth.ts:832` — OAuth first-login user creation consults no BeforeSignUp veto (grep: OAuth.ts only reads BeforeSessionIssue/AfterSignIn).

```
              yield* events.publish({ _tag: "auth.user.created", userId: created.id });
              return created.id;
```

**Fix plan** (effort S; depends on: NAM-002; spec: BEH-EA-090, BEH-EA-095)

_Close the non-SCIM part now via NAM-002's plan (BeforeSignUp on every creation path); add deactivation hook/event points in the same change that implements ticket 09's deactivation state._

Steps:
1. Covered by NAM-002 step 3 (BeforeSignUp consulted on OAuth JIT creation) — no separate code.
2. When ticket 09 (`09-userrecord-model-extension.md`) lands: declare `BeforeUserDeactivate` (veto) and `AfterUserDeactivated` (observe) in Hooks.ts next to BeforeUserDelete, and publish the `auth.user.deactivated` event from SCP-006's plan in the same flow.

Files: `packages/core/src/Hooks.ts`, `packages/core/src/Users.ts`

Tests (write first):
- Covered by NAM-002's OAuthHooksSignIn BeforeSignUp test; deactivation hook tests belong to the ticket-09 implementation.

Acceptance:
- A SCIM (or any) plugin can veto any user creation and observe deactivation via taps, without wrapping services.

**Recommended status:** `ready-for-agent`

### TS-007 — External-policy PEP seam (HookPoint) ships as mechanism with zero real flows

`low` · `architecture` · `core` · [.issues/low/TS-007-torin-sandall.md](../../.issues/low/TS-007-torin-sandall.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

Fixed: BeforeSignUp is a veto wired into the core signUp flow (Password.ts:730). Still open: no in-repo example composes Auth + qadi Path A + a RequirePermission endpoint end-to-end (examples/ has only memory-server with no qadi wiring).

**Evidence at HEAD:**

`packages/password/src/Password.ts:550` — Consumed in real flows: Password signUp (:730) / signIn (:862, :877); OAuth.ts:517-518/846/859; Passkey.ts:555-556/825/838; Users.ts:244/351 (BeforeUserDelete).

```
      const beforeSignUp = yield* Hooks.BeforeSignUp;
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;
```

`examples/memory-server/index.ts:94` — `examples/` contains only memory-server; grep for RequirePermission/AuthorizedSubject/SubjectExtractor under examples/ finds nothing.

```
const AppLayer = TestAuth.layer(
```

**Fix plan** (effort M; depends on: NAM-002; spec: BEH-EA-090, BEH-EA-145, BEH-EA-151)

_Extend examples/memory-server (or add examples/qadi-path-a) to compose Auth + AuthorizedSubject/SubjectExtractor (Path A) + one RequirePermission-protected endpoint + one BeforeSignUp domain-allow-list tap, and smoke-test it._

Steps:
1. Add an organization- or roles-backed permission check endpoint using @awthaq/qadi's RequirePermission to the example composition.
2. Add a BeforeSignUp tap (email-domain allow-list) in the example to exercise the hook PEP seam.
3. Add a smoke test (e.g. examples/memory-server/test/smoke.test.ts or a packages/test integration test) that boots the composed layer via HttpRouter.toWebHandler and asserts 403 without permission / 200 with it, and HookAborted for a disallowed domain.

Files: `examples/memory-server/index.ts`, `examples/memory-server/test/smoke.test.ts`

Tests (write first):
- examples smoke test: 'Path A denies without permission, allows with it; BeforeSignUp tap rejects a disallowed domain'.

Acceptance:
- The example typechecks and its smoke test passes in `pnpm run test`.

**Recommended status:** `ready-for-agent`

## Workstream `auth-event-pii-posture`

### ESA-005 — Event payloads embed PII (email, login identifier, free-text reason) with no redaction or retention design for a durable sink

`medium` · `compliance` · `core` · [.issues/medium/ESA-005-event-sourcing-audit-trail-specialist.md](../../.issues/medium/ESA-005-event-sourcing-audit-trail-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · canonical for ALF-009

Confirmed and now worse: the durable auth_audit_log (6bd3f1d) persists the full payload, so the raw invitee email (invitationCreated) and up-to-1000-char free-text impersonation reason are written into rows that no erasure path touches (the BeforeUserDelete erasure taps cover memberships/passkeys only; wayfinder ticket 01 explicitly deferred audit retention/erasure). Overstated part: `auth.token.replay.identifier` is `<prefix><userId>` / `oauth.flow:<uuid>`, not the email.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:192` — Raw invitee email on the bus.

```
export interface OrganizationInvitationCreatedEvent {
  readonly _tag: "auth.organization.invitationCreated";
  readonly invitationId: string;
  readonly organizationId: string;
  readonly email: string;
}
```

`packages/core/src/AuditLog.ts:195` — The durable auth_audit_log row now stores the full event payload (incl. raw email / free-text reason) with no redaction, retention or erasure path.

```
        yield* repo
          .insert({
            id,
            eventTag: event._tag,
            actorUserId: Option.getOrNull(actor),
            occurredAt: now,
            correlationId: null,
            payload: event,
```

`packages/core/src/AuthEvents.ts:122` — Free-text reason on the bus and in the audit row; no occurredAt/eventId on the event itself; sessionId is plain string.

```
export interface AdminImpersonationStartedEvent {
  readonly _tag: "auth.admin.impersonationStarted";
  readonly adminUserId: UserId;
  readonly targetUserId: UserId;
  readonly reason: string;
  readonly sessionId: string;
}
```

`packages/password/src/Password.ts:907` — Refutes ESA-005's 'identifier is typically the email': verification identifiers are `<prefix><userId>` (also VERIFY_PREFIX at :777, `oauth.flow:<uuid>` at OAuth.ts:86).

```
              const identifier = `${RESET_PREFIX}${user.id}`;
```

**Fix plan** (effort M; depends on: ESA-007; spec: BEH-EA-100, BEH-EA-101, BEH-EA-218)

_Adopt a PII posture for events + audit rows (see decision D1), then implement: identifiers-only payloads, redacted observer-error logs, audit-row pseudonymization on erasure, and documented stream privilege._

Steps:
1. (per D1 recommendation) packages/core/src/AuthEvents.ts: drop `email` from OrganizationInvitationCreatedEvent (subscribers resolve via InvitationRecords, which the erasure cascade owns); keep `reason` on impersonationStarted (it is the BEH-EA-218 justification) but treat it as PII for erasure.
2. packages/organization/src/Organization.ts: stop passing email into the publish.
3. packages/core/src/AuditLog.ts: add `pseudonymizeActor(userId)` to AuditLogShape — rewrites rows whose actorUserId or payload.userId/targetUserId = userId: replaces those ids with a stable per-user pseudonym (HMAC via KeyProvider) and blanks declared-PII payload fields (`reason`), keeping id/eventTag/occurredAt. Implement for layerMemory and layerSql (+ repository `updatePayloadByActor`).
4. Register it as a core BeforeUserDelete contribution (or ErasureRegistry entry if ticket 30's registry is built) so it runs inside the deletion transaction.
5. AuthEventsShape doc: stream/subscribe access is audit-table-equivalent privilege.
6. Log redaction of observer-error causes is EOTS-005's plan.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/sql/src/Repositories.ts`, `packages/organization/src/Organization.ts`, `packages/server/src/Account.ts`, `packages/core/test/AuditLog.test.ts`

Tests (write first):
- packages/core/test/AuditLog.test.ts — `pseudonymizeActor removes the user id and reason text from every matching row but keeps eventTag/occurredAt/id` (memory + SQLite).
- packages/organization/test/Organization.test.ts — invitationCreated event has no `email` property.
- packages/server/test/AuthHttp.test.ts — after DELETE /account, `auditLog.list({ actorUserId })` returns nothing for the deleted id.

Acceptance:
- No raw email on the bus; user erasure pseudonymizes that user's audit rows transactionally; retention/erasure rule documented in spec (new ADR per ticket 30's flagged gap).

**Needs decision:** yes — see the Decisions section. Recommendation: A, plus C's retention sweep as an operator-configurable add-on (flexibility): identifiers-only is the standard event-sourcing answer and the erasure cascade already owns the records that hold the email; pseudonymizing audit rows keeps the forensic timeline (tag/time/order) intact under GDPR Art. 17. B loses utility for legitimate notification subscribers without buying much over A.

**Recommended status:** `ready-for-human`

### ALF-009 — PII rides the bus with no subscription access control or redaction

`low` · `security` · `core` · [.issues/low/ALF-009-audit-logging-forensics-specialist.md](../../.issues/low/ALF-009-audit-logging-forensics-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ESA-005**

Same root cause (PII in event payloads with no redaction); its 'document stream access as audit-level privilege' is folded into ESA-005's plan and its verbatim-Cause-logging point is EOTS-005.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:192` — Raw invitee email on the bus.

```
export interface OrganizationInvitationCreatedEvent {
  readonly _tag: "auth.organization.invitationCreated";
  readonly invitationId: string;
  readonly organizationId: string;
  readonly email: string;
}
```

`packages/core/src/AuthEvents.ts:405` — on() forks with plain forkScoped (no startImmediately, no pre-registered subscription); the full Cause is logged verbatim.

```
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
          ),
        ),
        Effect.forkScoped,
```

**Fix plan:** none — tracked by ESA-005's plan.

**Recommended status:** `resolved`

## Workstream `auth-event-taxonomy`

### ARF-006 — Recovery is invisible to the event system: no resetRequested/resetCompleted/passwordChanged events, no owner-notification hook

`medium` · `architecture` · `core` · [.issues/medium/ARF-006-account-recovery-flow-specialist.md](../../.issues/medium/ARF-006-account-recovery-flow-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · fixed-by `45325bb`

Fixed by 45325bb (ALF-004): `auth.password.changed` and `auth.password.resetCompleted` exist and are published. Still open: no `resetRequested` (the earliest takeover signal, needed for out-of-band owner notification) and no `emailVerified` event.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:96` — passwordChanged / resetCompleted now exist (commit 45325bb, ALF-004).

```
/** ALF-004: published by `@awthaq/password`'s `changePassword`, after the new hash is persisted. */
export interface PasswordChangedEvent {
  readonly _tag: "auth.password.changed";
  readonly userId: UserId;
}
```

`packages/password/src/Password.ts:1031` — resetCompleted published after the confirmReset transaction commits. No `resetRequested` / `emailVerified` tag exists or is published (grep of AuthEvents.ts/Password.ts).

```
        yield* events.publish({ _tag: "auth.password.resetCompleted", userId });
```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-101, BEH-EA-064, BEH-EA-117, BEH-EA-118)

_Add and publish `auth.password.resetRequested` and `auth.user.emailVerified`._

Steps:
1. packages/core/src/AuthEvents.ts: `PasswordResetRequestedEvent { _tag: "auth.password.resetRequested"; userId }` and `UserEmailVerifiedEvent { _tag: "auth.user.emailVerified"; userId }`; AuditLog.ts actorOf → userId for both (exhaustiveness forces it).
2. packages/password/src/Password.ts requestReset: publish resetRequested inside the forked mail branch only when a real account exists (the branch that computes `${RESET_PREFIX}${user.id}` at :907) — publishing is internal, so it does not reintroduce the enumeration side channel ARF-003 closed (response path unchanged; keep it inside the detached fiber so latency is unaffected).
3. verifyEmail: publish emailVerified after the flag flips.
4. Doc comment on both: 'the hook for owner notification / SIEM export'.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/password/src/Password.ts`, `packages/password/test/Password.test.ts`

Tests (write first):
- packages/password/test/Password.test.ts — `requestReset for an existing account publishes auth.password.resetRequested; for a nonexistent email publishes nothing and response timing/shape is unchanged`; `verifyEmail publishes auth.user.emailVerified`. Fail today.

Acceptance:
- Recovery start and email verification are observable events and durable audit rows.

**Recommended status:** `ready-for-agent`

### CSD-004 — No failed-authentication event is published — stuffing detection has no signal to subscribe to

`medium` · `security` · `core` · [.issues/medium/CSD-004-credential-stuffing-defense-specialist.md](../../.issues/medium/CSD-004-credential-stuffing-defense-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · fixed-by `f5eb570`

Headline claim fixed by f5eb570 (ALF-003): `auth.user.signInFailed` is published on both password signIn failure paths. Still open: the event has no dimension a stuffing detector can key velocity on — no ip (in scope at Password.ts:799) and no identifier digest (ALF-003 deliberately omitted userId/email to avoid an existence oracle; a keyed digest of the *attempted* identifier has no such oracle since it is computed identically for existing and non-existing accounts). OAuth/passkey failures publish nothing.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:56` — Failure event now exists (commit f5eb570, ALF-003) but carries no keying dimension: no ip, no identifier digest.

```
export interface UserSignInFailedEvent {
  readonly _tag: "auth.user.signInFailed";
  readonly strategy: string;
  readonly reason: "invalidCredentials" | "emailNotVerified";
}
```

`packages/password/src/Password.ts:827` — Published on both signIn failure paths (827, 842). `input.ip` is in scope (used at Password.ts:799 for the per-IP limiter) but not carried.

```
          yield* events.publish({
            _tag: "auth.user.signInFailed",
            strategy: "password",
            reason: "invalidCredentials",
          });
```

**Fix plan** (effort M; depends on: —; spec: BEH-EA-101, BEH-EA-114)

_Enrich the failure event with `ip` and a keyed, non-reversible `identifierDigest`, and publish it from every strategy's failure path._

Steps:
1. packages/core/src/AuthEvents.ts UserSignInFailedEvent: add `ip?: string` and `identifierDigest?: string` (+ `digestKeyId?: string` for rotation).
2. packages/core: small helper `IdentifierDigest.of(normalizedEmail)` = HMAC-SHA256 over `KeyProvider.currentKey` (packages/ports/src/KeyProvider.ts) using the HMAC-from-Crypto.digest construction already in server/src/Csrf.ts:55-60 (lift it into core/ports to stop the copy in passkey/ChallengeStore.ts:193). Computed for every attempt, existing account or not.
3. packages/password/src/Password.ts:827/842: pass `ip: input.ip`, `identifierDigest`.
4. packages/passkey/src/Passkey.ts authenticate failure paths and packages/oauth/src/OAuth.ts callback failures (state/nonce/token-exchange rejection): publish `auth.user.signInFailed` with strategy and a reason enum extended accordingly (e.g. `"assertionInvalid" | "callbackRejected"`).
5. Update the AuthEvents.ts header (:5-13), which still lists only three real publishers.

Files: `packages/core/src/AuthEvents.ts`, `packages/password/src/Password.ts`, `packages/passkey/src/Passkey.ts`, `packages/oauth/src/OAuth.ts`, `packages/server/src/Csrf.ts`, `packages/password/test/Password.test.ts`

Tests (write first):
- packages/password/test/Password.test.ts — extend the existing ALF-003 tests: failure event carries `ip` equal to the request ip and an `identifierDigest` that is identical for a nonexistent and an existing email attempt of the same string, and differs across emails; still no userId/email property.
- packages/passkey/test/Passkey.test.ts — a failed assertion publishes signInFailed(strategy: "passkey").

Acceptance:
- A subscriber can count failures per ip and per targeted identifier without learning account existence; all strategies publish failures.

**Recommended status:** `ready-for-agent`

### SCP-006 — Closed AuthEvent union has zero deactivation/deletion events, blocking offboarding propagation and audit

`medium` · `architecture` · `core` · [.issues/medium/SCP-006-scim-provisioning-specialist.md](../../.issues/medium/SCP-006-scim-provisioning-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Still no `auth.user.deleted` or deactivation tag; account deletion (server/src/Account.ts) and Users.delete publish nothing, so GDPR erasure itself leaves no audit row. Deactivation cannot be evented yet because no deactivation state exists (wayfinder ticket 09 unimplemented).

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:279` — 31-member closed union of plain TS interfaces; no user.deleted/deactivated tag, no version, no Schema codec.

```
/** BEH-EA-101: the closed, statically-known set of event types `AuthEvents` carries today. */
export type AuthEvent =
  | TokenReplayEvent
  | UserCreatedEvent
  | UserSignedInEvent
```

`packages/server/src/Account.ts:112` — Account deletion path publishes no event (`grep -c publish packages/core/src/Users.ts` = 0).

```
              yield* sessions.revokeAll(userId);
              yield* verification.deleteAllByUser(userId);
              yield* users
                .delete(userId)
```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-100, BEH-EA-101, BEH-EA-095)

_Add `auth.user.deleted` now (published after the deletion transaction commits); add `auth.user.deactivated`/`reactivated` together with ticket 09's deactivation state._

Steps:
1. packages/core/src/AuthEvents.ts: `UserDeletedEvent { _tag: "auth.user.deleted"; userId; deletedBy: "self" | "admin"; }` — deliberately no email (the row is being erased; ESA-005 posture).
2. packages/server/src/Account.ts: publish after the `SqlTransaction.withTransaction(...)` block commits (never inside, mirroring Password.confirmReset's placement). If DRS-002/ticket 30's `Users.eraseAccount` lands, publish there instead.
3. AuditLog.actorOf: `auth.user.deleted` → Option.some(userId) (the audit row outlives the user by design; pseudonymization per D1).
4. Ticket-09 follow-up (not now): `auth.user.deactivated` / `auth.user.reactivated` + SCP-008's hook points.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/server/src/Account.ts`, `packages/server/test/AuthHttp.test.ts`

Tests (write first):
- packages/server/test/AuthHttp.test.ts — `DELETE /account publishes auth.user.deleted after commit and writes an audit row; a rolled-back deletion publishes nothing`. Fails today.

Acceptance:
- Account deletion produces exactly one auth.user.deleted event/audit row, only on commit.

**Recommended status:** `ready-for-agent`

### RRS-008 — No session-lifecycle events: rotation, supersession, and reuse are unobservable

`low` · `architecture` · `core` · [.issues/low/RRS-008-refresh-token-rotation-specialist.md](../../.issues/low/RRS-008-refresh-token-rotation-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · fixed-by `9017a8a`

Fixed by 9017a8a (RRS-003): `auth.session.reuse` is published on tombstoned-token replay. Still open: rotation (verify's in-place secret rotation) and supersession (`issue({ supersedes })`) publish nothing; `auth.session.issued` is published only by @awthaq/password, not by Sessions itself (oauth/passkey/admin issuance is silent).

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:68` — auth.session.reuse exists (commit 9017a8a, RRS-003); published at Sessions.ts:450/776.

```
export interface SessionReuseEvent {
  readonly _tag: "auth.session.reuse";
  readonly sessionId: string;
  readonly familyId: string;
  readonly userId: UserId;
}
```

`packages/core/src/Sessions.ts:188` — verify's in-place secret rotation and issue({ supersedes }) supersession publish nothing; the only Sessions.ts publishes are auth.session.reuse. auth.session.issued is published only by @awthaq/password.

```
   * rotates the session's secret (the standard session-fixation defense) —
   * `rotated` carries the freshly-minted full token exactly when this call
   * performed that rotation, `Option.none()` otherwise (including every
```

**Fix plan** (effort M; depends on: —; spec: BEH-EA-101, BEH-EA-053)

_Publish session lifecycle events from Sessions itself (both layers), not per plugin._

Steps:
1. packages/core/src/AuthEvents.ts: add `SessionRotatedEvent { _tag: "auth.session.rotated"; sessionId; familyId; userId }` (in-place secret rotation in verify) and `SessionSupersededEvent { _tag: "auth.session.superseded"; sessionId; supersededBy; familyId; userId }`.
2. packages/core/src/Sessions.ts (layerMemory and layerSql): publish rotated on the winning CAS rotation write only (the loser reports `rotated: none` and must not publish); publish superseded when `issue` tombstones `supersedes`.
3. Move `auth.session.issued` publication into `Sessions.issue` (both layers) and delete the per-plugin publishes in Password.ts, so oauth/passkey/admin issuance is covered; same consideration for `revoke`/`revokeAll`/`revokeOthers` → `auth.session.revoked` with a `reason` enum widened (`"signOut" | "admin" | "userDeleted" | ...`). Keep reason passed by caller.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/Sessions.ts`, `packages/core/src/AuditLog.ts`, `packages/password/src/Password.ts`, `packages/core/test/Sessions.test.ts`

Tests (write first):
- packages/core/test/Sessions.test.ts — `rotation publishes exactly one auth.session.rotated even under a concurrent verify race`; `issue({ supersedes }) publishes auth.session.superseded`; `oauth/passkey issuance publishes auth.session.issued` (via Sessions). Fail today.

Acceptance:
- Every session create/rotate/supersede/revoke is an event + audit row regardless of which plugin triggered it; exactly one rotated event per rotation.

**Recommended status:** `ready-for-agent`

## Workstream `security-signal-pipeline`

### CSG-008 — Breach-detection signals are published but never consumed by any pipeline

`medium` · `security` · `core` · [.issues/medium/CSG-008-compliance-soc2-gdpr-specialist.md](../../.issues/medium/CSG-008-compliance-soc2-gdpr-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

Partly addressed: every signal (counterAnomaly, token.replay, impersonationDenied, signInFailed, session.reuse) is now durably persisted and queryable via `AuditLog.list({ eventTag })` (6bd3f1d). Still absent: any threshold rule, incident record, or operator alert — detection signals without a detection pipeline.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:108` — Signal is now durably recorded by AuditLog (commit 6bd3f1d), but no code thresholds, alerts, or creates incidents: grep for counterAnomaly/auth.token.replay in packages/*/src finds only publishers, AuditLog.actorOf, and comments.

```
/**
 * Published by `@awthaq/passkey`'s authentication ceremony (BEH-EA-131,
 * ticket 08): a verified assertion's reported counter did not exceed the
 * stored one — "log + step-up, not an instant kill" per that ticket's own
 * language, so the session still issues and this event is the whole
 * response to the anomaly, not a request-level failure.
 */
```

**Fix plan** (effort M; depends on: ALF-007, ESS-007, CSD-004; spec: BEH-EA-059, BEH-EA-131, BEH-EA-102)

_Ship an opt-in `SecuritySignals` subscriber layer that applies configurable threshold rules over the security tags and emits incidents (log + metric + optional incident sink port)._

Steps:
1. packages/core/src/SecuritySignals.ts (new): `SecuritySignalsConfig` Context.Reference with default rules, e.g. `auth.passkey.counterAnomaly` ≥1 per credential → incident; `auth.token.replay` ≥ N per identifier per window; `auth.user.signInFailed` ≥ N per ip/identifierDigest per window (after CSD-004); `auth.session.reuse` ≥1 → incident; `auth.admin.impersonationDenied` ≥ N per admin.
2. `SecuritySignals.layer`: one multi-tag subscription (ESS-007) over `subscribe` (ALF-007), sliding-window counters in a Ref/HashMap with TestClock-friendly DateTime, emitting `Effect.logWarning("auth.security.incident", {...})`, `Metric.counter("awthaq_security_incident_total")`, and calling an optional `IncidentSink` port (default no-op) the app can back with a table/pager.
3. Document in spec (new BEH under 13-events or a new behavior file) and README; opt-in like Retention.layerScheduled.

Files: `packages/core/src/SecuritySignals.ts`, `packages/core/src/index.ts`, `packages/core/test/SecuritySignals.test.ts`, `spec/behaviors/13-events.md`

Tests (write first):
- packages/core/test/SecuritySignals.test.ts — `a single counterAnomaly raises an incident`; `N token.replay events for one identifier within the window raise one incident; N-1 do not` (TestClock).

Acceptance:
- With SecuritySignals.layer composed, the documented signals produce incidents through log, metric, and the IncidentSink port.

**Recommended status:** `ready-for-agent`

## Workstream `auth-event-external-delivery`

### CWM-004 — No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto

`medium` · `architecture` · `core` · [.issues/medium/CWM-004-clerk-workos-migration-specialist.md](../../.issues/medium/CWM-004-clerk-workos-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for MAPS-010

Still no outbound delivery: no webhook code anywhere in packages/*/src, and the only event channel is the in-process PubSub. New since the audit: auth_audit_log (uuidv7-ordered, durable) is a natural transactional-outbox source a relay could tail.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:376` — stream is a lazy Stream.fromPubSub: the subscription only registers when a consuming fiber first pulls. Also: the only delivery channel is this in-process PubSub.

```
    return AuthEvents.of({
      publish,
      stream: Stream.fromPubSub(pubsub),
      droppedCount: Ref.get(dropped),
    });
```

`packages/core/src/AuthEvents.ts:405` — on() forks with plain forkScoped (no startImmediately, no pre-registered subscription); the full Cause is logged verbatim.

```
        Stream.runForEach((event) =>
          handler(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.event.observer.error", { tag, cause }),
            ),
          ),
        ),
        Effect.forkScoped,
```

**Fix plan** (effort XL; depends on: ESA-007, ESA-002; spec: BEH-EA-100, BEH-EA-102)

_Per decision D2: build an outbox relay over auth_audit_log and an opt-in webhooks plugin on top of it; document the in-process recipe meanwhile._

Steps:
1. Immediately (S): document in README/spec the supported in-process recipe (`AuthEvents.on`/`subscribe` in the host composition) and the single-process nature of the bus in spec/overview.md.
2. packages/core: `AuditLog.listAfter(cursorId, limit)` (id > cursor ORDER BY id) + an `EventRelay` layer that polls/tails from a persisted cursor and hands decoded `Published<AuthEvent>` (ESA-007/ESA-002) to an app-provided `EventTransport` port (Redis/Kafka/HTTP) — at-least-once, idempotent on eventId.
3. packages/webhooks (new plugin, M7 Phase-2): endpoints table (url, secret, tag filter), Standard-Webhooks/svix-compatible HMAC signing headers (`webhook-id`=eventId, `webhook-timestamp`, `webhook-signature`), exponential retry, dead-letter table, admin API group to manage endpoints; implemented as an EventTransport over the relay.

Files: `README.md`, `spec/overview.md`, `packages/core/src/AuditLog.ts`, `packages/core/src/EventRelay.ts`, `packages/sql/src/Repositories.ts`, `packages/webhooks/src/*`

Tests (write first):
- packages/core/test/EventRelay.test.ts — relay delivers every audit row exactly once per cursor advance, resumes from the persisted cursor after restart, and redelivers on transport failure (idempotent eventId).
- packages/webhooks/test/Webhooks.test.ts — signature verifies with the endpoint secret; retries with backoff; dead-letters after max attempts.

Acceptance:
- A second process/service can consume auth events reliably; a Clerk-webhook consumer can be pointed at signed awthaq webhooks.

**Needs decision:** yes — see the Decisions section. Recommendation: C, staged: ship A's docs immediately, B right after the event schema/envelope workstreams (it needs eventId + a codec), and the webhooks plugin as an M7 Phase-2 plugin. Tailing the durable audit table (not the lossy dropping PubSub) is what makes delivery reliable, and it reuses what ticket 01 already built.

**Recommended status:** `ready-for-human`

### MAPS-010 — No cross-process event channel - revocation can never be pushed to other services

`info` · `architecture` · `core` · [.issues/info/MAPS-010-microservices-auth-propagation-specialist.md](../../.issues/info/MAPS-010-microservices-auth-propagation-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **CWM-004**

Same root cause (events are in-process only; no transport seam). The outbox relay + EventTransport port in CWM-004's plan (decision D2) is exactly the 'application-provided transport Layer' MAPS-010 asks for; the docs step covers its 'state the single-process assumption' alternative.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:376` — stream is a lazy Stream.fromPubSub: the subscription only registers when a consuming fiber first pulls. Also: the only delivery channel is this in-process PubSub.

```
    return AuthEvents.of({
      publish,
      stream: Stream.fromPubSub(pubsub),
      droppedCount: Ref.get(dropped),
    });
```

**Fix plan:** none — tracked by CWM-004's plan.

**Recommended status:** `resolved`

## Already fixed (no workstream)

### BE-005 — Core lifecycle hook points are declared but never fired by signUp/signIn

`medium` · `architecture` · `core` · [.issues/medium/BE-005-bereket-engida.md](../../.issues/medium/BE-005-bereket-engida.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed-by `3e298c8`

BeforeSignUp/AfterSignIn are declared (Hooks.ts) and fired by password signUp/signIn, oauth callback and passkey authenticate; the AuthCore prerequisite was dropped by wayfinder ticket 03, which names BE-005 as closed by this wiring.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:50` — The header the audit quoted ('not yet wiring any concrete hook point') has been replaced.

```
// AOMS-006/BCR-004/CSG-002/THS-002 (.issues/high) — wayfinder ticket 03:
// the concrete hook points this module's mechanism supports are now
// declared and wired into real flows, in `./Hooks.ts`
// (`BeforeSignUp`/`AfterSignIn`/`BeforeSessionIssue`/`BeforeUserDelete`),
```

`packages/password/src/Password.ts:550` — Consumed in real flows: Password signUp (:730) / signIn (:862, :877); OAuth.ts:517-518/846/859; Passkey.ts:555-556/825/838; Users.ts:244/351 (BeforeUserDelete).

```
      const beforeSignUp = yield* Hooks.BeforeSignUp;
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;
```

**Fix plan:** none — already fixed at HEAD (see commit above).

**Recommended status:** `resolved`

### ECF-003 — Bounded AuthEvents PubSub suspends publishers — sign-in can block behind a slow subscriber

`medium` · `correctness` · `core` · [.issues/medium/ECF-003-effect-concurrency-fiber-specialist.md](../../.issues/medium/ECF-003-effect-concurrency-fiber-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed-by `4b48cb2`

Bus switched from PubSub.bounded to PubSub.dropping; publish never suspends; drops are counted and logged; regression test proves the stuck-subscriber case no longer hangs.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:363` — Bus is now PubSub.dropping (never suspends) and AuditLog.record runs inline before enqueue.

```
    const pubsub = yield* PubSub.dropping<AuthEvent>(CAPACITY);
    const dropped = yield* Ref.make(0);
    const publish: AuthEventsShape["publish"] = (event) =>
      Effect.gen(function* () {
        yield* auditLog.record(event);
        const accepted = yield* PubSub.publish(pubsub, event);
        if (!accepted) {
          yield* Ref.update(dropped, (n) => n + 1);
```

`packages/core/test/AuthEvents.test.ts:67` — Capacity-stress regression test proving publish no longer hangs past CAPACITY.

```
        assert.strictEqual(yield* events.droppedCount, overflow - 1);
```

**Fix plan:** none — already fixed at HEAD (see commit above).

**Recommended status:** `resolved`

### ESA-004 — Bounded PubSub means publish can suspend the auth operation; with zero subscribers the shipped example wedges on the 1025th event

`medium` · `correctness` · `core` · [.issues/medium/ESA-004-event-sourcing-audit-trail-specialist.md](../../.issues/medium/ESA-004-event-sourcing-audit-trail-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed-by `4b48cb2`

Same fix (PubSub.dropping, 4b48cb2). Its 'ship one default durable sink so zero-subscriber config cannot occur' is also satisfied: AuditLog.record runs inline in publish (commit 6bd3f1d), independent of subscribers.

**Evidence at HEAD:**

`packages/core/src/AuthEvents.ts:363` — Bus is now PubSub.dropping (never suspends) and AuditLog.record runs inline before enqueue.

```
    const pubsub = yield* PubSub.dropping<AuthEvent>(CAPACITY);
    const dropped = yield* Ref.make(0);
    const publish: AuthEventsShape["publish"] = (event) =>
      Effect.gen(function* () {
        yield* auditLog.record(event);
        const accepted = yield* PubSub.publish(pubsub, event);
        if (!accepted) {
          yield* Ref.update(dropped, (n) => n + 1);
```

`packages/core/test/AuthEvents.test.ts:67` — Capacity-stress regression test proving publish no longer hangs past CAPACITY.

```
        assert.strictEqual(yield* events.droppedCount, overflow - 1);
```

**Fix plan:** none — already fixed at HEAD (see commit above).

**Recommended status:** `resolved`

### MW-003 — Hook points are mechanism-only: zero taps reachable from real signUp/signIn flows

`medium` · `architecture` · `core` · [.issues/medium/MW-003-matias-woloski.md](../../.issues/medium/MW-003-matias-woloski.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed-by `3e298c8`

Points are declared and reachable from real signUp/signIn flows, and the password plugin consumes them (commit 3e298c8). BeforePasswordVerify was only an example in the recommendation; sign-in veto coverage tracked under NAM-002.

**Evidence at HEAD:**

`packages/core/src/Hooks.ts:36` — Concrete core points declared (commit 3e298c8).

```
const SignUpInput = Schema.Struct({ email: Schema.String, name: Schema.String });
export class BeforeSignUp extends HookPoint.veto<BeforeSignUp>()("auth.user.signUp", SignUpInput) {}

// BEH-EA-092: observe — fired once a session-backed sign-in completes,
// regardless of which strategy (password/oauth/passkey) produced it.
const SignedIn = Schema.Struct({ userId: Schema.String, strategy: Schema.String });
export class AfterSignIn extends HookPoint.observe<AfterSignIn>()("auth.signIn", SignedIn) {}
```

`packages/password/src/Password.ts:550` — Consumed in real flows: Password signUp (:730) / signIn (:862, :877); OAuth.ts:517-518/846/859; Passkey.ts:555-556/825/838; Users.ts:244/351 (BeforeUserDelete).

```
      const beforeSignUp = yield* Hooks.BeforeSignUp;
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;
```

**Fix plan:** none — already fixed at HEAD (see commit above).

**Recommended status:** `resolved`

### SFS-004 — Hook-point mechanism not wired into core signUp/signIn — no JIT-provisioning seam

`medium` · `architecture` · `core` · [.issues/medium/SFS-004-saml-federation-specialist.md](../../.issues/medium/SFS-004-saml-federation-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed-by `3e298c8`

Core signUp/signIn now run hook points (BeforeSignUp veto, BeforeSessionIssue divert, AfterSignIn observe) — a SAML plugin has the JIT/divert seams. Its 'dependency-ordered tap resolution included' aside is tracked by JH-003.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:50` — The header the audit quoted ('not yet wiring any concrete hook point') has been replaced.

```
// AOMS-006/BCR-004/CSG-002/THS-002 (.issues/high) — wayfinder ticket 03:
// the concrete hook points this module's mechanism supports are now
// declared and wired into real flows, in `./Hooks.ts`
// (`BeforeSignUp`/`AfterSignIn`/`BeforeSessionIssue`/`BeforeUserDelete`),
```

`packages/core/src/Hooks.ts:69` — A production divert point, consulted by password/oauth/passkey sign-in.

```
export class BeforeSessionIssue extends HookPoint.divert<BeforeSessionIssue>()(
  "auth.session.beforeIssue",
  SessionIssueContext,
  SessionIssueDiverted,
) {}
```

**Fix plan:** none — already fixed at HEAD (see commit above).

**Recommended status:** `resolved`

### JH-010 — divert kind has zero production usage — the spec's step-up flow cannot be built today

`low` · `api` · `core` · [.issues/low/JH-010-jared-hanson.md](../../.issues/low/JH-010-jared-hanson.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed-by `3e298c8`

A production divert point (BeforeSessionIssue → TwoFactorRequired) now exists and is consulted by password/oauth/passkey sign-in, so the BEH-EA-093 step-up flow is buildable by installing a tap. The empty two-factor package is wayfinder ticket 05's work, not this finding's.

**Evidence at HEAD:**

`packages/core/src/Hooks.ts:69` — A production divert point, consulted by password/oauth/passkey sign-in.

```
export class BeforeSessionIssue extends HookPoint.divert<BeforeSessionIssue>()(
  "auth.session.beforeIssue",
  SessionIssueContext,
  SessionIssueDiverted,
) {}
```

`packages/two-factor/src/index.ts:10` — The first real divert tap (TOTP plugin) is still a placeholder — tracked by wayfinder ticket 05 (MFA subsystem), not by this finding.

```
export {};
```

**Fix plan:** none — already fixed at HEAD (see commit above).

**Recommended status:** `resolved`

### PERS-008 — Core signUp/signIn flows expose no hook points — no policy seam on the authentication hot path

`info` · `architecture` · `core` · [.issues/info/PERS-008-policy-engine-rego-specialist.md](../../.issues/info/PERS-008-policy-engine-rego-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed-by `3e298c8`

BeforeSignUp/AfterSignIn/BeforeSessionIssue are wired into the auth hot path (commit 3e298c8). Remaining sign-in *veto* gap is tracked under NAM-002.

**Evidence at HEAD:**

`packages/core/src/HookPoint.ts:50` — The header the audit quoted ('not yet wiring any concrete hook point') has been replaced.

```
// AOMS-006/BCR-004/CSG-002/THS-002 (.issues/high) — wayfinder ticket 03:
// the concrete hook points this module's mechanism supports are now
// declared and wired into real flows, in `./Hooks.ts`
// (`BeforeSignUp`/`AfterSignIn`/`BeforeSessionIssue`/`BeforeUserDelete`),
```

`packages/password/src/Password.ts:550` — Consumed in real flows: Password signUp (:730) / signIn (:862, :877); OAuth.ts:517-518/846/859; Passkey.ts:555-556/825/838; Users.ts:244/351 (BeforeUserDelete).

```
      const beforeSignUp = yield* Hooks.BeforeSignUp;
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;
```

**Fix plan:** none — already fixed at HEAD (see commit above).

**Recommended status:** `resolved`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| BE-005 | medium | ALREADY-FIXED (`3e298c8`) | BeforeSignUp/AfterSignIn are declared (Hooks.ts) and fired by password signUp/signIn, oauth callback and passkey authenticate; the AuthCore prerequisite was dropped by wayfinder ticket 03, which names BE-005 as… | `packages/core/src/HookPoint.ts:50` |
| ECF-003 | medium | ALREADY-FIXED (`4b48cb2`) | Bus switched from PubSub.bounded to PubSub.dropping; publish never suspends; drops are counted and logged; regression test proves the stuck-subscriber case no longer hangs. | `packages/core/src/AuthEvents.ts:363` |
| ESA-004 | medium | ALREADY-FIXED (`4b48cb2`) | Same fix (PubSub.dropping, 4b48cb2). Its 'ship one default durable sink so zero-subscriber config cannot occur' is also satisfied: AuditLog.record runs inline in publish (commit 6bd3f1d), independent of subscribers. | `packages/core/src/AuthEvents.ts:363` |
| MW-003 | medium | ALREADY-FIXED (`3e298c8`) | Points are declared and reachable from real signUp/signIn flows, and the password plugin consumes them (commit 3e298c8). BeforePasswordVerify was only an example in the recommendation; sign-in veto coverage tracked… | `packages/core/src/Hooks.ts:36` |
| SFS-004 | medium | ALREADY-FIXED (`3e298c8`) | Core signUp/signIn now run hook points (BeforeSignUp veto, BeforeSessionIssue divert, AfterSignIn observe) — a SAML plugin has the JIT/divert seams. Its 'dependency-ordered tap resolution included' aside is tracked… | `packages/core/src/HookPoint.ts:50` |
| JH-010 | low | ALREADY-FIXED (`3e298c8`) | A production divert point (BeforeSessionIssue → TwoFactorRequired) now exists and is consulted by password/oauth/passkey sign-in, so the BEH-EA-093 step-up flow is buildable by installing a tap. The empty two-factor… | `packages/core/src/Hooks.ts:69` |
| PERS-008 | info | ALREADY-FIXED (`3e298c8`) | BeforeSignUp/AfterSignIn/BeforeSessionIssue are wired into the auth hot path (commit 3e298c8). Remaining sign-in *veto* gap is tracked under NAM-002. | `packages/core/src/HookPoint.ts:50` |
| ESS-003 | medium | DUPLICATE of ALF-007 | Same subscription-attach race in `on()` and same fix (subscribe synchronously before forking). A replay buffer (`PubSub.dropping({ capacity, replay })`) is not needed once registration is synchronous. | `packages/core/src/AuthEvents.ts:405` |
| MW-004 | medium | DUPLICATE of JH-003 | Same missing dependency-order key as JH-003. Its secondary note (observe taps run unbounded-concurrent) is covered by JH-002. | `packages/core/src/HookPoint.ts:44` |
| ALF-009 | low | DUPLICATE of ESA-005 | Same root cause (PII in event payloads with no redaction); its 'document stream access as audit-level privilege' is folded into ESA-005's plan and its verbatim-Cause-logging point is EOTS-005. | `packages/core/src/AuthEvents.ts:192` |
| ECF-006 | low | DUPLICATE of JH-002 | Same unbounded observe fan-out as JH-002. | `packages/core/src/HookPoint.ts:278` |
| EOTS-009 | low | DUPLICATE of ALF-006 | Same missing correlation between an event and the request that produced it; ALF-006's plan stamps correlationId/trace ids at publish and runs handlers under a linked span with annotated logs. | `packages/core/src/AuthEvents.ts:405` |
| ERS-005 | low | DUPLICATE of JH-002 | Same unbounded observe fan-out as JH-002; its 'bounded-concurrency knob' suggestion is subsumed by sequential execution. | `packages/core/src/HookPoint.ts:278` |
| ETVS-005 | low | DUPLICATE of SSMS-004 | Identical finding (static JSON compare never applies a migration); same fix. | `packages/test/src/TestAuth.ts:310` |
| GC-006 | low | DUPLICATE of ELC-001 | Same root cause as ELC-001 (module-scoped registry state); ELC-001's plan deletes `nextSequence` and scopes sequence to each point's own per-composition registry. | `packages/core/src/HookPoint.ts:178` |
| PERS-004 | low | DUPLICATE of JH-002 | Same unbounded observe fan-out as JH-002; its extra ask (an observer-error metric) is folded into JH-002's plan. | `packages/core/src/HookPoint.ts:278` |
| TS-006 | low | DUPLICATE of JH-003 | Identical claim (2 of 3 ordering keys; veto chains composition-order sensitive) and identical fix (thread plugin identity through tap()). | `packages/core/src/HookPoint.ts:180` |
| GC-009 | info | DUPLICATE of JH-004 | Same observation (schemas are phantom). GC-009's own trigger condition — 'if hook points ever guard an externally-originated operation, decode at run using the already-passed schema' — is now met (BeforeSignUp guards… | `packages/core/src/HookPoint.ts:197` |
| MAPS-010 | info | DUPLICATE of CWM-004 | Same root cause (events are in-process only; no transport seam). The outbox relay + EventTransport port in CWM-004's plan (decision D2) is exactly the 'application-provided transport Layer' MAPS-010 asks for; the… | `packages/core/src/AuthEvents.ts:376` |
