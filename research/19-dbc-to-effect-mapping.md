# DbC-to-Effect Mapping — better-auth's contracts onto Effect v4 primitives

Domain: bridges two artifacts already in this repo — the Design-by-Contract
behavioral specification of better-auth at `../better-auth/` (Meyer 1992;
Findler & Felleisen 2002 ×2) and this research corpus's product/architecture
decisions (`00`–`17`) — onto **verified Effect v4 primitives**, read directly
from the local monorepo checkout at `/Users/mohammadalmechkor/Projects/Perso/effect`
(not from npm, not from the v3.22-era research in `01-effect-ecosystem.md`).

**Why not just cite `01-effect-ecosystem.md`:** that report was written
against `effect@3.22.2` stable and is explicit that it predates v4 (it
flags v4 as "beta/RC" and repeatedly says the PRD's `Context.Service` API
"does not exist" in the version it tested). The local checkout used here
**is** v4 source, and several of that report's API-level findings do not
hold there — noted inline as **[v4 supersedes v3.22 finding]**. Its
*product/architecture decisions* (deny-by-default authz, opaque `id.secret`
tokens, frozen declarative plugins, etc.) are unaffected by the version
difference and are cited as-is.

Every primitive cited below was read from source in this session at the
paths given (relative to the effect repo root); doc-comment `@since` tags
are quoted where they clarify whether a module is v4-native or carried
over from v3.

---

## 0. Vocabulary mapping (methodology → Effect v4)

| DbC concept (`better-auth/00-methodology`) | Effect v4 primitive | Verified at |
|---|---|---|
| Precondition (`Requires`) | `Schema.decode`/`decodeUnknown` at a boundary; refined via `Schema.filter`/branded schemas | `packages/effect/src/Schema.ts` |
| Postcondition (`Ensures`) | The success type `A` of `Effect<A, E, R>`, itself Schema-declared on the service method or `HttpApiEndpoint` | `Effect.ts`, `unstable/httpapi/HttpApiEndpoint.ts` |
| Invariant | State held behind a `Context.Service`, constructible only through the `make` Effect supplied at the service's own declaration — the key and its validated constructor are **one declaration**, not two | `Context.ts:150-260` (`Context.Service`) |
| Hoare triple `{P} op {Q}` | A service method's type signature `(input: Schema<P>) => Effect<Schema<Q>, E, R>` | — |
| Liskov-style extension rule | `Layer<ROut, E, RIn>` variance — an extension's `RIn` must not exceed what the base contract already admits, and its `ROut` may only add capability | `Layer.ts` |
| Arrow contract (`domain -> range`) | Any `Effect`-returning function value — Effect's execution model already defers all work until the `Effect` is run, which is exactly Findler & Felleisen's "checked at invocation, not at definition" requirement, with no extra machinery needed | `Effect.ts` |
| Staged/dependent contract (plugin `init` ordering) | The `Layer.provide`/`Layer.mergeAll` dependency graph, memoized per-build by `CurrentMemoMap` | `Layer.ts:584` (`CurrentMemoMap extends Context.Service`) |
| Contract boundary | The edge of an `HttpApiEndpoint`, `HttpApiMiddleware`, or a `Layer` — anywhere a `Schema` decodes/encodes or a `Context.Service` is provided | `unstable/httpapi/*`, `Layer.ts` |
| Blame (positive/negative) | `Cause`'s `Fail` (typed `E`, expected — blame is assignable) vs. `Die` (defect — always SUPPLIER-blamed) vs. `Interrupt` | `Cause.ts` |
| Race-safe invariant (adapter's `consumeOne`/`incrementOne`, better-auth's hand-rolled "atomic-fallback") | **Native STM**: `Effect.tx`, `TxRef`, `TxHashMap`, `TxChunk`, `TxHashSet`, `TxPriorityQueue`, `TxPubSub`, `TxQueue`, `TxReentrantLock`, `TxSemaphore`, `TxSubscriptionRef`, `TxDeferred` — an in-core transactional-memory module family with an explicit `Transaction` context service and journal | `Effect.ts:14544` (`Transaction extends Context.Service`), `TxRef.ts` |
| "First cause, not first observer" | `Effect.catchCause`-isolated execution for after-hooks/observers, so a plugin's own defect surfaces attributed to that plugin's span, not to whatever was running when it threw | `Effect.ts`, `Cause.ts` |

**[v4 supersedes v3.22 finding]** `01-effect-ecosystem.md` states "the PRD's
`Context.Service` API does not exist in Effect 3.22" and recommends
`Effect.Service`/`Context.Tag` instead. In this v4 checkout, `Context.Service`
is the real, current, unifying primitive (`Context.ts:150-260`) — it
subsumes what v3 split across `Effect.Service` and `Context.Tag`, and there
is no `Effect.Service` export left in `Effect.ts` (grep confirms none). **The
PRD's original naming is correct for v4**; the correction only applies to
the v3.22 line. Every subsystem section below uses `Context.Service`.

---

## 1. Core domain (`01-core-domain/`)

| Contract category | Effect v4 primitive | Note |
|---|---|---|
| Entity invariant (`User`/`Account`/`Session`/`Verification` shared base) | `Schema.Class`, extended per-plugin via `Schema.extend`; construction only through a validated factory `Effect` | Additional-fields extension becomes a declared Schema-field contribution the compiler merges — closing the "silent last-wins" gap the better-auth spec found in the real source (`01-core-domain/01`) |
| Session lifecycle (create/expire/roll/revoke) | A `SessionService` `Context.Service`; expiry/rolling-refresh gated by `Clock`/`Duration`, testable via `TestClock` | Token format: opaque composite `id.secret` (research 04's verified recommendation) — a design decision, not an Effect-primitive question |
| Consume-once tokens (email OTP, magic link, one-time-token, OAuth state/PKCE) | `effect/unstable/persistence/Persistence` + `PersistedCache`: stores are keyed by each request's `PrimaryKey`, persist a Schema-encoded `Exit` with an optional TTL, and are explicitly designed so "expensive or idempotent results can be reused across fibers, process restarts, or workers sharing a backing store" | Verified at `unstable/persistence/Persistence.ts`, `PersistedCache.ts`. This is a **better native fit** than hand-rolling `consumeOne` compare-and-delete: the "single-use, TTL'd, replay-of-an-in-flight-double-click-is-a-no-op" contract the better-auth spec and research 07 both describe is close to exactly what `Persistence`'s per-key, `Exit`-caching semantics already give you |
| Database adapter contract (create/findOne/.../transaction) | One `Context.Service` interface; concrete backends are `Layer`s built on `effect/unstable/sql`'s `SqlClient`/`Statement`/`SqlSchema`/`SqlResolver` | `unstable/sql/*`. Liskov substitutability across backends is what a single service key + swappable `Layer` already structurally guarantees |
| Race-safe counters/consume, in-process | `TxRef`/`TxHashMap` inside an `Effect.tx` transaction — replaces every hand-rolled compare-and-swap loop the better-auth spec documented as "atomic-fallback" | `TxRef.ts` (module doc: "reads and writes inside `Effect.tx` are recorded in a transaction journal and committed together only when the outermost transaction succeeds") |
| Race-safe consume/increment, cross-process | Pushed down into the concrete adapter's native atomic op (SQL `UPDATE ... WHERE consumed IS NULL`, KV `GETDEL`); the adapter declares a `capabilities: { transactions, returning, atomicConsume }` record so the compiler can fail fast rather than silently trust a weaker backend (research 10) | This directly answers the better-auth spec's "who is blamed when the weaker guarantee causes a downstream violation" question: a declared-but-unmet capability becomes a config-time error, not a runtime surprise |
| Secondary/cache storage (better-auth's `redis-storage` package) | `effect/unstable/persistence/KeyValueStore` — a narrower, schema-aware get/set/delete store with prefixed views and swappable `Layer`s (memory, filesystem, Web Storage, SQL-backed; Redis via the sibling `Redis.ts`) | `unstable/persistence/KeyValueStore.ts`. This is the **in-core equivalent** of what better-auth hand-rolled as a separate package — confirming the better-auth spec's own finding that this role is a distinct, narrower contract from the full adapter, never a substitute for it |

---

## 2. Request pipeline (`02-request-pipeline/`)

| Contract category | Effect v4 primitive | Note |
|---|---|---|
| Endpoint contract | `HttpApi`/`HttpApiGroup`/`HttpApiEndpoint` with `.setPayload`/`.addSuccess`/`.addError` | `unstable/httpapi/HttpApi.ts`, `HttpApiEndpoint.ts` — no longer flagged "Unstable" as a separate `@effect/platform` package; it now ships inside `effect/unstable/httpapi`, i.e. still pre-1.0-stability-tier by naming convention, but co-located with core |
| Before/after hooks, cross-cutting concerns | `HttpApiMiddleware` — its own module doc lists its purpose as "authentication, authorization, logging, tracing, rate limiting, request-scoped services, schema-error handling, and client request decoration," i.e. nearly a verbatim enumeration of better-auth's hook use-cases | `unstable/httpapi/HttpApiMiddleware.ts` |
| onRequest/onResponse asymmetry (better-auth: onRequest chains, onResponse is first-wins) | No native asymmetry exists in `HttpApiMiddleware` — ordinary middleware composition chains uniformly in both directions. Effect-auth should not reproduce better-auth's undocumented asymmetry; treat uniform chaining as the default and require an explicit, documented reason to special-case either direction | Design decision, not a primitive gap |
| Rate limiting | **Native, production-grade**: `effect/unstable/persistence/RateLimiter` — keyed `consume`/`adaptiveConsume`/`adaptiveFeedback`, `algorithm: "fixed-window" \| "token-bucket"`, `onExceeded: "delay" \| "fail"`, in-memory or Redis-backed store `Layer`s | `unstable/persistence/RateLimiter.ts`. **[v4 supersedes v3.22 finding]** — `01-effect-ecosystem.md` (Q11) assumed effect-auth would need to declare and build its own `RateLimiter` capability from scratch; v4 ships one. effect-auth's per-plugin `rateLimit` contribution now just supplies `{ key, window, limit }` to this existing service rather than reinventing window/bucket logic |
| Cookies | `effect/unstable/http/Cookies` | `unstable/http/Cookies.ts` |
| Error model / blame taxonomy | Per-domain `Schema.TaggedError<Self>()("Tag", {...})` classes; HTTP status is attached **on the error schema itself**, one line, via `HttpApiSchema.status(code)` (e.g. `.pipe(HttpApiSchema.status(401))`) | `Schema.ts:14201` (`TaggedError`), `unstable/httpapi/HttpApiSchema.ts:113` (`status`). This gives the better-auth spec's per-category blame table (`02-request-pipeline/05`) a literal 1:1 encoding: each error class *is* one row of that table |
| CSRF | No dedicated module found in this checkout; remains an `Effect.orElse`-composed policy decision layered on top of `HttpApiMiddleware`, not a gap in Effect itself | — |

---

## 3. Plugin system (`03-plugin-system/`)

| Contract category | Effect v4 primitive | Note |
|---|---|---|
| Plugin contribution surface | Compiles to a `Layer` (services) plus an `HttpApiGroup` (endpoints/middleware) contributed into one assembled `HttpApi` | `Layer.ts`, `unstable/httpapi/HttpApiGroup.ts` |
| `init`'s staged context/options delta | The `Layer.provide`/`Layer.mergeAll` dependency graph itself, resolved structurally and memoized once per build via `CurrentMemoMap` — there is no separate "options channel" with its own merge precedence the way better-auth's `init` return value has, so the spec's flagged "opposite precedence for context vs. options" footgun has no equivalent to reproduce | `Layer.ts:584` |
| Schema field / endpoint collision (better-auth: silent last-wins) | Not caught by `Layer`/`Context` alone — two plugins contributing the same `Schema` field name or `HttpApiEndpoint` path is a **compiler-level** concern effect-auth must still implement itself (research 09's compile-time conflict-detection recommendation stands regardless of v3/v4) | Still an effect-auth build responsibility, not something the runtime gives for free |
| Plugin dependency declaration | `requiresPlugins`/`requiresCapabilities`, checked by the effect-auth compiler via Kahn's algorithm — `Context.Service` requirements alone (the `RIn` of a `Layer`) already fail to compile on a missing service, but that is service-level, not plugin-level, so the plugin compiler still needs its own dependency graph on top (research 09) | Same conclusion as v3.22 research; unaffected by the v4 API change |
| Client/server plugin correspondence | `HttpApiClient.make`/`makeClient` — a client is **derived** from the compiled `HttpApi`; a plugin whose server group is absent is structurally absent from the derived client's type | `unstable/httpapi/HttpApiClient.ts:259,479` (`makeClient`, `make`) — verified real exports in v4. This removes the possibility of better-auth's `$InferServerPlugin` failure mode (a type-only, runtime-inert correspondence channel) by construction: there is only one source of truth, the compiled `HttpApi` |

---

## 4. OAuth & federation (`04-oauth-and-federation/`)

| Contract category | Effect v4 primitive | Note |
|---|---|---|
| Provider-strategy arrow contract | A `Context.Service` per provider; normalized profile as a shared `Schema` | — |
| State/PKCE/nonce flow state | The same `Persistence`/`PersistedCache` substrate as §1's consume-once tokens — no reason to invent a second ephemeral-state mechanism | `unstable/persistence/Persistence.ts` |
| Multi-step federated flows (device-authorization polling, SAML/SCIM provisioning sagas) | **Read in full; recommend against adopting for v1.** See the dedicated verdict below | `unstable/workflow/*` (all 9 files, ~3800 lines) + `unstable/cluster/ClusterWorkflowEngine.ts` (header + service wiring) |
| Per-provider ephemeral resources (e.g. one OAuth HTTP client per configured provider, reused across requests but released when idle) | `RcMap`/`RcRef` — reference-counted, keyed resource sharing that releases when the last scope using a key closes | `RcMap.ts` (`@since 3.5.0`, carried into v4) |
| Blame category `UPSTREAM PROVIDER` | A distinct `Schema.TaggedError` tag in the shared `AuthError` union, `HttpApiSchema.status(...)`-annotated, generic user-facing message with the real detail only in `cause` | — |

### 4a. `effect/unstable/workflow` verdict (read in full this session)

The module ships genuinely elegant primitives that map closely onto exactly
the flows flagged as candidates:

| Workflow primitive | What it gives | Verified at |
|---|---|---|
| `Workflow.make` + `.execute`/`.poll`/`.interrupt`/`.resume` | Typed durable executions with a deterministic `executionId` derived from an idempotency key (`hash(tag + idempotencyKey(payload))`) — re-executing with the same payload is automatically idempotent | `Workflow.ts:45-464` |
| `Activity.make` | A named, schema-typed sub-step whose result is memoized per `(executionId, name, attempt)`; replays skip re-running a completed activity | `Activity.ts:130-186` |
| `DurableClock.sleep` | A named durable timer — short sleeps run as an in-memory activity, long ones schedule a wake via the engine and suspend the workflow in between | `DurableClock.ts:70-115` |
| `DurableDeferred` (`make`/`await`/`token`/`succeed`/`fail`) | A named wait-point an external actor completes later via a **token** (workflow name + execution id + deferred name, base64url-encoded) — the workflow suspends until that token is completed | `DurableDeferred.ts:38-168, 411-461` |
| `DurableQueue.process`/`worker` | At-least-once background-worker handoff (offer → suspend → worker completes the paired `DurableDeferred`) built on `PersistedQueue`, with explicit dead-lettering after exhausted retries | `DurableQueue.ts:1-20, 186-342` |
| `Workflow.withCompensation` | Saga-style compensating cleanup, run only if the *whole* workflow ultimately fails | `Workflow.ts:162-186, 908-927` |
| `WorkflowProxy.toHttpApiGroup`/`WorkflowProxyServer.layerHttpApi` | Auto-derives `execute`/`discard`/`resume` `HttpApiEndpoint`s per workflow and wires handlers — a direct, zero-boilerplate integration with the same `HttpApi` effect-auth already targets | `WorkflowProxy.ts:142-166`, `WorkflowProxyServer.ts:30-87` |

**This is exactly the right shape for device-authorization polling** (an
`Activity` that calls the token endpoint in a loop separated by
`DurableClock.sleep(interval)`), **an admin-approval or invitation-accept
wait** (a `DurableDeferred` the accept-link/approval endpoint completes via
its `token`), and **an SSO/SCIM provisioning saga** (`withCompensation` for
rollback if a later step fails).

**Why the recommendation is still against adopting it for v1**, despite the
conceptual fit — verified, not inferred:

1. **Only two `WorkflowEngine` implementations exist**, and both are read in
   full: `layerMemory` (`WorkflowEngine.ts:656-885`) is explicitly
   documented as "not suitable for production workflows that require
   durability" (in-memory `Map`s only, lost on restart); the only durable
   option is `ClusterWorkflowEngine.make` (`ClusterWorkflowEngine.ts`,
   856 lines, header + service wiring read). There is no third,
   lighter-weight "just persist to SQL" `WorkflowEngine`.
2. **`ClusterWorkflowEngine` requires the full cluster runtime**: its
   constructor (`ClusterWorkflowEngine.ts:60-62`) depends on
   `Sharding.Sharding` and `MessageStorage` and represents every workflow
   step (run, activity, deferred completion, resume) as a persisted RPC
   `Envelope` sent to a sharded cluster `Entity`. Adopting durable
   workflows for effect-auth therefore means adopting a distributed
   actor/entity-sharding runtime as an operational dependency — a
   fundamentally different deployment model (shard manager, runners,
   entity placement) than "a stateless HTTP handler plus a SQL database,"
   which is the deployment model every other decision in this research
   corpus assumes for v1 (research 10, 11).
3. **It is `unstable`**, same stability tier and API-churn risk already
   flagged for `HttpApi` (research 01) — compounded here by depending on
   `unstable/cluster` as well, which was not part of any prior research
   pass's risk assessment.
4. **The flows in question don't need what only the cluster engine
   provides.** Device-code polling and SSO/SCIM sagas need "a row with a
   status and an expiry column, checked/updated per request" — exactly how
   better-auth and every comparable framework already implements them —
   which is already covered by effect-auth's decided SQL-adapter +
   `Persistence`/`KeyValueStore` primitives (§1 above). Reaching for a
   distributed-workflow engine to get compensation/suspend-resume
   ergonomics for something with no genuine multi-day, cross-process
   coordination requirement would be adding the heaviest available tool
   for a problem the lightest available tool already solves.

**Recommendation:** do not adopt `unstable/workflow` for v1 device-
authorization or SSO/SCIM flows; model them as adapter-backed state
machines directly. **Do** borrow two of its *patterns* without importing
the module, since they cost nothing and the fit is genuinely good: (a) a
deterministic idempotency-key-derived id for any create-if-absent
operation (mirrors `Workflow`'s `executionId` derivation), and (b) an
external-token-completes-a-row pattern for admin-approval/invitation-accept
waits (mirrors `DurableDeferred`'s token shape) — both are just naming
conventions over the adapter contract already specified in
`01-core-domain/04-database-adapter-contract.md`, not new primitives.
Revisit `unstable/workflow` only if effect-auth ever needs a genuinely
long-running, cross-process saga (e.g. a full-directory SCIM resync) **and**
the team is willing to operate `unstable/cluster` — not a v1 question, and
worth re-examining only after that module leaves `unstable`.

---

## 5. MFA & verification (`05-mfa-and-verification/`)

| Contract category | Effect v4 primitive | Note |
|---|---|---|
| Channel-delivered credential (email OTP, magic link, SMS OTP) | `Persistence`/`PersistedCache` substrate (§1) + a `Notifier`/`Sms` `Context.Service` invoked as the delivery callback, so delivery failure is a typed `E`, never a swallowed exception | — |
| Attempt-budget discipline | A `RateLimiter.consume` call scoped to the verification key, using the same native rate limiter as §2 — bounded-guess OTPs get an attempt budget "for free" from the same primitive that already protects every other endpoint | `unstable/persistence/RateLimiter.ts` |
| Ceremonies (WebAuthn, SIWE) | Single-use, TTL'd, ceremony-tagged challenges on the same `Persistence` substrate | — |
| Fail-open/fail-closed (captcha, HIBP) | An explicit `Effect.catchTag`/`Effect.orElse` policy chosen per check, not implicit try/catch fallthrough | `Effect.ts` |

---

## 6. Authorization (`06-authorization/`)

| Contract category | Effect v4 primitive | Note |
|---|---|---|
| Statement/role/permission primitive | One `Authorizer` `Context.Service`: `check`/`require`/`filter`, deny-by-default (research 08's decision, unaffected by v4) | — |
| Composing multiple role-grants into one decision | `Combiner`/`Reducer` — new-in-this-checkout functional modules for associative combination/aggregation are a structurally clean fit for "merge N granted-statement sets into one effective permission set," an operation better-auth performs ad hoc | `Combiner.ts`, `Reducer.ts` — genuinely new relative to what the v3.22 research corpus had available to recommend; worth prototyping before committing |
| Admin impersonation (session-substitution contract) | A scoped `Layer.provide`/`Effect.provideService` override of the request's `Principal` service for that request's `Effect` only, with the real actor preserved in a separate, immutable field — **not** a `FiberRef` mutation, matching research 01's own explicit rejection of `FiberRef` for principal propagation | `Layer.ts`, `Effect.ts` (`provideService`) |
| API-key permission-narrowing (Liskov rule, unenforced in better-auth) | A `Schema.filter`-checked smart constructor: `createApiKey` takes the actor's resolved permission set as an upper bound and rejects a requested superset at the type/validation boundary, rather than trusting the caller | `Schema.ts` |
| Consistency / read-after-write for external authorization engines | An opaque `ConsistencyToken` (`Schema.String`-shaped) threaded through the `Authorizer` interface (research 08, decision unaffected by v4) | — |

---

## 7. Session extensions (`07-session-extensions/`)

| Contract category | Effect v4 primitive | Note |
|---|---|---|
| Multi-session device slots | `TxHashMap`/`TxRef` inside `Effect.tx` for race-safe bookkeeping of concurrent device sessions — an upgrade over a plain `Ref<HashMap<...>>`, since slot add/remove/switch-active now composes transactionally with other state changes in the same operation | `TxHashMap.ts`, `TxRef.ts` |
| Custom session enrichment | A plain `(session, user) => Effect<Enriched, E, R>` value — already an arrow contract with no extra ceremony | — |
| Bearer/JWT carrier equivalence | Bearer: decode-then-delegate to the same canonical `SessionService` validation (a true equivalence). JWT: a distinct `JwtSession` `Context.Service` whose `validate` signature is typed differently (it cannot express "consults the session store"), making the documented postcondition weakening from `07-session-extensions/03` a type-level signal, not a comment | — |
| Last-login-method read model | A side effect written inside the same `Effect` that issues the session in `SessionService`, never a separately-triggered, independently-failable write | — |

---

## 8. Client SDK (`08-client-sdk/`)

| Contract category | Effect v4 primitive | Note |
|---|---|---|
| Reactive session store (loading/error/data, never a stale-but-unmarked state) | `Result` — now a **core** module (`packages/effect/src/Result.ts`), not solely an `@effect-atom`-package concept; encodes exactly the three-state contract the better-auth spec's client-core document requires | `Result.ts` |
| Base action set + derived client, blame preserved across the network boundary | `HttpApiClient.make`/`makeClient` derives a fully typed client straight from the compiled `HttpApi`; typed errors decode client-side exactly as declared server-side, so an error's blame (`code`, `expose`) survives the boundary automatically | `unstable/httpapi/HttpApiClient.ts` |
| Framework binding (React first, per research 11) | `@effect-atom/atom-react` remains the intended external substrate, built on top of core `Result`/`Effect`/`Layer` — this checkout confirms `Result` is now a core-owned type such a library can consume directly rather than reimplementing its own success/loading/error union | — |
| SSR hydration | `hydrateSession(initialSession)` — copied verbatim from better-auth's proven contract per research 11; not an Effect-primitive question | — |

---

## 9. Platform services (`09-platform-services/`)

| Contract category | Effect v4 primitive | Note |
|---|---|---|
| Storage adapter substitutability | `effect/unstable/sql`: `SqlClient`/`SqlConnection`/`SqlSchema`/`SqlResolver`/`Statement`/`Migrator` | `unstable/sql/*` |
| Secondary/cache storage (redis-storage equivalent) | `KeyValueStore` (§1) — native, backend-swappable, schema-aware | `unstable/persistence/KeyValueStore.ts` |
| Schema migrations (generate/apply asymmetry) | `unstable/sql/Migrator` — **read in full (453 lines); confirms research 10's critique is unchanged in v4.** See the dedicated verdict below | `unstable/sql/Migrator.ts` (full read) |
| CLI (scaffolding, `generate`/`migrate` commands) | **Native, in-core**: `effect/unstable/cli` — `Command`, `Flag`, `Argument`, `Param`, `Prompt`, `CliConfig`, `Completions` | `unstable/cli/*`. **[v4 supersedes v3.22 finding]** — the v3.22 research corpus assumed an external `@effect/cli` package; in this v4 checkout the CLI framework lives inside `effect/unstable/cli` |
| Telemetry / observability | **Native, in-core**: `effect/unstable/observability` — `Otlp`, `OtlpExporter`, `OtlpLogger`, `OtlpMetrics`, `OtlpTracer`, `PrometheusMetrics` | `unstable/observability/*`. Opt-in gating still layers `Config` on top; the disclosure-inventory contract from the better-auth spec (`09-platform-services/03`) is unaffected — only the wiring substrate changes |
| Secret/PII redaction | Two complementary mechanisms: `Redacted<A>` (opaque wrapper, masks in string/JSON/inspect output) and the newer **`Redactable`** protocol (objects present alternative, context-aware representations of themselves depending on runtime context — e.g. masked in a log context, real in a trusted one) | `Redacted.ts`, `Redactable.ts` (`Redactable.ts` module doc: "Context-aware redaction for sensitive values... masking secrets, tokens, or personal data in logs, traces, and serialized output") — `Redactable` was not present in the v3.22-era research and is a genuinely new, more flexible option for effect-auth's `Redactor` boundary (research 12) |
| i18n message-key contract | No dedicated module found in this checkout; remains a design-level contract (plugin-declared strings attached to the same `Schema`-backed error/response definitions as §2) | — |

### 9a. `unstable/sql/Migrator` verdict (full 453-line body read this session)

Every gap research 10 identified against the v3 stock `@effect/sql` Migrator
is **confirmed still present, unchanged, in v4**:

| Research 10's v3 finding | v4 status (verified against `Migrator.ts`) |
|---|---|
| No checksums | **Confirmed absent.** The `migrations` table DDL for every dialect (`ensureMigrationsTable`, lines 120-151: `mssql`/`mysql`/`pg`/`orElse` branches) and the `Migration` model (lines 68-72) carry only `migration_id`, `name`, `created_at` — no hash/checksum column anywhere. A migration file edited after being recorded as applied is undetectable. |
| No dry-run | **Confirmed absent.** `MigratorOptions` (lines 29-33) has no dry-run flag; `run` (lines 223-303) always executes every pending migration it loads. |
| Everything in one `withTransaction` | **Confirmed unchanged.** Line 307-308: `sql.withTransaction(run)` wraps loading *and running every pending migration* in a single transaction. There is still no per-migration transaction-mode option, so a migration that must run outside a transaction (Postgres `CREATE INDEX CONCURRENTLY`, large non-transactional backfills) cannot be expressed — attempting it inside this Migrator would simply fail. |
| Ledger-lock via racing an INSERT into the PK | **Confirmed, same design.** Lines 262-274: pending migration rows are inserted *before* their bodies run; a concurrent second migrator's insert hits a unique/PK conflict, caught by `isConstraintConflict` (line 326) and turned into a soft `MigrationError({kind: "Locked"})` that logs and returns `[]` rather than failing (lines 309-312) — this is the exact mechanism research 10 described in the v3 Migrator, just re-verified present in v4. Postgres additionally takes an explicit `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` (line 225) other dialects lack. |
| Duplicate-id detection | **Confirmed, unchanged.** Lines 240-245, a `Set`-size comparison. |
| Optional post-migration schema dump | **Confirmed, unchanged.** `dumpSchema` parameter (lines 100-106), invoked at lines 315-319 only when the batch had `completed.length > 0`. |

**New in v4, not in research 10's v3 picture** (minor, not structural fixes):
explicit per-dialect table DDL (`mssql`/`mysql`/`pg` branches vs. one generic
statement), and four ready-made migration loaders (`fromGlob`,
`fromBabelGlob`, `fromRecord`, `fromFileSystem`, lines 337-453) for
different bundler/runtime conventions. Neither changes the correctness
gaps above.

**Consequence for effect-auth's migration story (research 10's own
recommendation stands, now confirmed rather than assumed):** the stock
`Migrator` is still a fine **ledger/lock/runner substrate** — its
insert-as-concurrency-guard mechanism is worth reusing as-is — but it is
still not the migration *engine* effect-auth needs on its own. A
snapshot-diff planner with a checksum ledger, per-migration transaction-mode
declarations (`transactional: none` for `CONCURRENTLY`-style DDL), and a
dry-run/plan-review step must be built on top, exactly as research 10
specified before this v4 read and unchanged by it.

---

## Net effect on the gaps the better-auth spec pass flagged

| Gap flagged in `better-auth/` | Resolution via Effect v4 |
|---|---|
| Silent last-wins on plugin schema/endpoint collisions | Still requires effect-auth's own compiler-level conflict detection (research 09) — **not** solved by the runtime alone, v3 or v4 |
| `init` context-vs-options opposite-precedence merge | No equivalent exists to get backwards: the `Layer` graph has one merge mechanism |
| API-key permission narrowing documented but unenforced | `Schema.filter`-checked smart constructor makes the violation unconstructible, not just documented |
| `onRequest` chains / `onResponse` first-wins asymmetry | Not reproduced — `HttpApiMiddleware` composes uniformly; treat as a disclosed, deliberate behavioral break from better-auth |
| JWT can't guarantee immediate revocation | Preserved as an intentional, typed distinction (`JwtSession` vs. `SessionService`), per research 04's "JWT is a documented phase-2 bridge" framing — this is a design decision Effect's type system can *encode* but not eliminate |
| Custom `RateLimiter`/`atomic-fallback` primitives assumed necessary (v3.22 research) | **No longer necessary** — v4 ships `RateLimiter` and full `Tx*` STM natively |
| Custom secondary-storage (`redis-storage`) package assumed necessary | **No longer necessary** — v4 ships `KeyValueStore` with a Redis-backed layer natively |
| External `@effect/cli` package assumed for the CLI subsystem | **No longer applicable** — CLI framework is in-core at `effect/unstable/cli` |

## Open follow-ups this pass surfaced (not yet in `00-questions.md`)

- ~~Read `unstable/workflow` in full before deciding whether device-authorization polling and SSO/SCIM provisioning sagas should be built on it~~ — **done, see §4a**: recommend against adoption for v1 (durability requires the full `unstable/cluster` sharding runtime, which is a heavier operational dependency than the flows warrant); borrow the idempotency-key and external-token patterns conceptually instead.
- ~~Read the full body of `unstable/sql/Migrator.ts` to confirm or refute whether v4 closed the "no checksums, no dry-run" gap~~ — **done, see §9a**: confirmed unchanged from v3 (no checksums, no dry-run, single all-or-nothing transaction over the whole batch). Research 10's "build a snapshot-diff planner + checksum ledger on top" stands as verified, not just assumed.
- Prototype `Combiner`/`Reducer` for statement/role aggregation in the `Authorizer` service (§6) — flagged as a promising but unverified-in-practice fit.
- Decide whether `Redactable`'s context-aware representation model should replace or complement `Redacted` as the primary redaction mechanism at the log/span/event boundary (§9) — it did not exist in the v3.22 research corpus's picture of the redaction story.
