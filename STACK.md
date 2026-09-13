# awthaq on Effect v4 — Stack Survey

> **What this is.** A grounded inventory of Effect v4 primitives — stable core and `packages/effect/src/unstable/` — that awthaq's planned implementation can build on, gathered by reading the real source at `../effect` (sibling checkout) rather than from memory or documentation. Every module/export named below was opened and read; where something plausible-sounding does **not** exist, that is stated explicitly rather than left implied. This document is organized around one question per feature: **does adopting this make awthaq a meaningfully better product** — richer capability, less hand-written code, a stronger guarantee — not whether the underlying API is stable. `unstable/*` is explicitly pre-stable by Effect's own convention; that is not treated here as a reason to avoid a feature, only as something worth a one-line pinning note where it's genuinely actionable (see the short list at the end).
>
> This is a research artifact, not a specification — it does not carry `EA` IDs and is not gated by `spec/scripts/verify-traceability.sh`. Where it points at a concrete stratum or behavior range, it is citing `spec/overview.md`'s package map and `spec/behaviors/` for orientation, not asserting anything has been decided or built.
>
> This survey was done in two passes. The first (five parallel reads of the unstable tree) missed two modules that turned out to matter a lot — `unstable/schema/Model.ts` and `unstable/persistence/RateLimiter.ts` — because they were only seen as *imports* from other files, never opened directly. A second pass, prompted by a direct question, went back and read them in full, then did a systematic directory listing to rule out further blind spots. Both are folded in below rather than kept as an errata list.

---

## 1. Contract stratum (`@awthaq/api`) — `HttpApi`, `Schema`, typed errors

This is the stratum ADR-EA-003 ("HttpApi Is the API Contract") commits to, and it is well covered.

| Need | Effect primitive | Why this makes awthaq better |
|---|---|---|
| Declare an auth-gated endpoint | `unstable/httpapi/HttpApiSecurity.ts` — `HttpApiSecurity.apiKey({ key, in: "cookie" \| "header" \| "query" })`, `.http({ scheme })` / `.bearer`, `.basic` | Auth requirements become part of the endpoint's own type signature and OpenAPI output (see §9), not a side comment — a plugin author can't forget to gate a route without it showing up in the types. |
| Verify the credential, inject a principal | `unstable/httpapi/HttpApiMiddleware.ts` — `HttpApiMiddleware.Service<Self>()(id, { error, security, requiredForClient })` | Middleware is typed end-to-end: what it provides downstream (`CurrentUser`/`Principal`) and what error it can throw are both tracked by the compiler, so a handler that forgets to require `Authentication` simply won't type-check against a protected route. This is the mechanism behind `Authentication`/`OptionalAuthentication`/`AuthorizedSubject` in `spec/overview.md`'s planned surface. |
| Extract the raw credential from the request | `unstable/httpapi/HttpApiBuilder.ts` — `securityDecode(scheme)` | One correct implementation of "read this credential from header/query/cookie/Basic" instead of thirteen slightly-different hand-rolled ones across plugins. |
| Set the session cookie on response | `HttpApiBuilder.securitySetCookie(apiKeyScheme, value, options)` | Issuing a session cookie on sign-in/refresh and clearing it on sign-out becomes a one-line call with secure defaults (`secure: true, httpOnly: true`) baked in, rather than something every plugin re-derives — direct fit for BEH-EA-049–056 Sessions. |
| Map domain errors to HTTP status | `unstable/httpapi/HttpApiError.ts` | A ready-made, complete status taxonomy (`Unauthorized`, `Forbidden`, `Conflict`, `UnprocessableEntity`, etc.) means awthaq's own errors (`InvalidCredentials`, `SessionExpired`, `EmailAlreadyRegistered`) get correct HTTP mapping by inheriting a pattern instead of awthaq inventing its own — the concrete mechanism behind ADR-EA-013. |
| Annotate a schema's status / empty-body responses | `unstable/httpapi/HttpApiSchema.ts` — `status(code)`, `Empty(code)`, `NoContent`, `Created`(201), `Accepted`(202) | Sign-up → 201, sign-out → 204, etc., declared once at the schema level. |
| Validate request payloads | `Schema.ts` (stable) — `Schema.Class`, `Schema.TaggedError`, `Schema.Redacted(valueSchema, {label?})`, `Schema.isUUID(version?)` | `Schema.Redacted` on a `LoginRequest.password` field means a decode failure literally cannot echo the raw password back in an error message — a real security property, not just convenience. **Gap**: no `Schema.isEmail` exists yet, so awthaq needs its own `Email` schema. |
| Typed domain errors | `Data.TaggedError`, `Data.TaggedClass`, `Data.taggedEnum` (stable `Data.ts`) | `_tag` narrowing for RBAC/auth-flow pattern matching without awthaq building its own tagged-union machinery. |
| Cross-ecosystem schema interop | `JsonSchema.ts` / `StandardSchema.ts` | `Schema.toStandardSchemaV1` lets awthaq's own validators (a login-form schema) be handed directly to non-Effect form libraries (react-hook-form, TanStack Form) — a real integration win for consumers who aren't otherwise using Effect. |

## 2. Ports stratum (`@awthaq/ports`) — `PasswordHasher`, `Mailer`, `WebAuthn`

Effect gives the *shape* every port should take, and a genuinely useful crypto/encoding substrate underneath it — but not the domain-specific implementations themselves:

- `Context.Service(key, options)` and `Context.Reference` (stable `Context.ts`) are the standard tag/default pattern every port should be defined as — directly satisfying ADR-EA-011 ("Configuration Is a Service With a Default"): swapping `PasswordHasher.layerArgon2id` for a test double is a Layer swap, not a conditional.
- `unstable/Crypto.ts` — a full platform-agnostic crypto **service**: `Crypto.randomBytes` (CSPRNG), `Crypto.digest` (SHA-1/256/384/512), and derived `randomUUIDv7` (time-ordered — good for sortable session/API-key IDs that also sort correctly in a database index). Being a real `Context.Service` means a plugin can be tested against a deterministic fake `Crypto` implementation instead of mocking `crypto` globally. **Gap**: no bcrypt/argon2/scrypt/HMAC — `PasswordHasher` still needs an external KDF library, wrapped behind this same service shape.
- `unstable/workers/Worker.ts` / `WorkerRunner.ts` — real worker-thread primitives, letting argon2/bcrypt hashing run off the main event loop without awthaq writing its own worker-pool plumbing from scratch.
- `unstable/encoding/Encoding.ts` — `encodeBase64Url`/`decodeBase64Url` (JWT segments), `encodeHex`/`decodeHex` (API-key display, TOTP secret encoding). **Gap**: no Base32 codec, which standard TOTP secrets require.
- `unstable/arbitrary/Arbitrary.ts` — `Arbitrary.schema(schema)` derives property-based test generators straight from the same `Schema` used at runtime, so BEH-EA-193–200's fuzz/property tests for `LoginRequest`/`TotpCode`/`ApiKey` stay in sync with validation logic automatically instead of drifting from hand-written generators.
- `Redacted.ts` (stable) — wraps every secret-bearing value so it can't leak via an accidental `console.log`/JSON serialization; `Redacted.wipeUnsafe()` shrinks the exposure window right after a credential is consumed.

## 3. Persistence stratum (`@awthaq/sql`) — database-neutral models

This is where ADR-EA-004 ("Database-Neutral Models") and ADR-EA-014 ("Session Storage Is Backend-Neutral") get the most direct, concrete support — the whole point of those ADRs (write a plugin's persistence once, run it on any backend) is close to an off-the-shelf capability rather than a pattern awthaq has to invent from scratch.

| Need | Effect primitive | Why this makes awthaq better |
|---|---|---|
| One driver-agnostic client interface | `unstable/sql/SqlClient.ts` | `withTransaction` is savepoint-aware for nested calls out of the box — a signup flow (user row + account row + initial session) gets real atomicity without awthaq writing its own transaction bookkeeping. |
| Driver seam | `unstable/sql/SqlConnection.ts` | Every driver call is `(sql, params)` by construction — a backend author implements this once, and awthaq's plugins never see a specific driver. |
| Safe query construction | `unstable/sql/Statement.ts` | `sql.insert(user)`/`sql.update(user, ["id"])` from plain objects, with identifiers dialect-escaped automatically — removes the single largest per-plugin SQL-injection surface (hand-built INSERT/UPDATE strings) by construction rather than by code review discipline. |
| Normalized DB error taxonomy | `unstable/sql/SqlError.ts` | `UniqueViolation` turns "duplicate email" into one typed domain error awthaq handles once, instead of parsing driver-specific error codes per backend. |
| Schema migrations | `unstable/sql/Migrator.ts` | Numbered migrations, applied-migration tracking, transactional apply, duplicate-id detection — matches the `PgMigrator.fromRecord(auth.migrations)` line already in `spec/overview.md`'s worked example, so awthaq doesn't need its own migration runner. |
| Schema-validated query adapters | `unstable/sql/SqlSchema.ts` — `findAll`, `findOne`, `findOneOption` | `findUserByEmail` → `findOneOption` with encode/decode handled by the same Schema used everywhere else — one less hand-written mapping layer per query. |
| **Define the model once, get DB and JSON shapes for free** | `unstable/schema/Model.ts` — `Model.Class<Self>(name)(fields)` | One field declaration generates six schema variants (`select`/`insert`/`update` for the DB, `json`/`jsonCreate`/`jsonUpdate` for the API) — the DB row shape and the public API shape can never silently drift apart the way two hand-maintained schemas would. **`Model.Sensitive(schema)`** is the standout: a field present in `select`/`insert`/`update` but structurally **absent from every JSON variant** — a password hash or TOTP secret genuinely cannot leak into an API response, enforced by the type checker instead of a reviewer remembering to strip a field. `Model.UuidV7Insert`/`Model.DateTimeInsertFromDate` give self-generating ids and `createdAt`/`updatedAt` for free. |
| Repository/batched-lookup generation | `unstable/sql/SqlModel.ts` / `SqlResolver.ts` — `makeRepository`, `makeResolvers` | `makeRepository<S extends Model.Any>` derives insert/update/find/delete straight from a `Model.Class` — a whole CRUD layer per entity (User, Account, Session, VerificationToken) without hand-writing it four times. `SqlResolver` batches concurrent identical lookups (many requests validating the same session at once) into one grouped query automatically. |
| **Backend-neutral session/KV storage — the strongest single match for ADR-EA-014** | `unstable/persistence/KeyValueStore.ts` | One service tag with interchangeable Layers (`layerMemory`, `layerFileSystem`, `layerSql` — auto-generating its own table across pg/mysql/mssql/sqlite, `layerStorage` for the browser). A session adapter written once against `KeyValueStore` runs unmodified over memory (tests), any SQL dialect, or browser storage just by swapping the Layer — this genuinely *is* "session storage is backend-neutral" as a real capability, not a pattern awthaq would otherwise have to design and defend on its own. |
| Async work queue (adjacent) | `unstable/persistence/PersistedQueue.ts` | An at-least-once persisted work queue (dedup, attempt tracking, deterministic retry replay), with memory/Redis/SQL stores. Not core to auth today, but exactly the primitive for a later async outbox — e.g. sending a verification email or webhook reliably without awthaq building its own delivery-retry system. |
| Process-local cache invalidation | `unstable/reactivity/Reactivity.ts` | Rerunning a live session-list query automatically after a logout mutation, in-process, with no extra plumbing — though this is single-process only (see §8 for cross-instance). |

## 3a. Rate limiting (BEH-EA-105–112) — `unstable/persistence/RateLimiter.ts`

**This corrects the single biggest gap in the first pass of this survey**, which stated flatly that no rate-limiting primitive exists. That was only true of `http/`/`httpapi/`; `unstable/persistence/RateLimiter.ts` (publicly exported at `effect/unstable/persistence`) is a genuinely strong feature — and awthaq's own `spec/overview.md` worked example already contains `Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)))`, meaning the original design already assumed this exact API.

**Why this is a real product-value win, not just "a rate limiter exists"**: it ships fixed-window *and* token-bucket algorithms, with fractional token costs and precise reset/retry accounting — the two algorithms most auth libraries either pick one of or hand-roll badly. Beyond that, it has an **adaptive rate limiter** — `adaptiveConsume`/`adaptiveFeedback` that learns a safe request rate from upstream `429`+`Retry-After` responses (`inactive → cooldown → learning → learned` phases, inferring its own limit/window from observed traffic). That's a materially better capability than a typical fixed config-file rate limit, and it's not something awthaq would build itself for a v1. Memory and Redis-backed stores (Redis via atomic Lua scripts) mean the same `consume`/`sleep` call works identically in a single-process dev setup and a multi-instance production deployment, just by swapping the store Layer.

**Recommendation**: adopt this as awthaq's `RateLimiter` port directly — it already matches the shape the design assumed. Treat the adaptive mode as an advertised, differentiating capability of awthaq's rate limiting (not every auth library offers traffic-adaptive limits), while keeping the basic fixed-window/token-bucket mode as the default so plugins aren't forced into adaptive behavior they don't need.

## 4. Domain stratum (`@awthaq/core`) — services, hooks, events

- `Context.Service`/`Layer` composition (stable) is the whole basis of `Sessions`, `Users`, `Accounts`, `Verification` as planned in `spec/overview.md`.
- `unstable/Schedule.ts` and `Cron.ts` (stable) — backoff policies for rate-limiting and periodic token/key rotation, plus human-readable cron expressions ("rotate signing keys every Monday") instead of raw durations for anything schedule-configured.
- **Caching — three primitives, each the right fit for a different job**: `Cache.ts` (no `Scope` in its `lookup` requirements) is the right fit for **decoded/verified session or JWT-claims lookups** — a plain memoizing TTL cache, nothing to release. `ScopedCache.ts` (its `lookup` *can* require a `Scope`, and each entry owns its own child scope closed on eviction) is the right fit for **JWKS key sets or an OAuth discovery document** fetched over a connection that must be released together with the cached value. Both dedupe concurrent cache misses automatically — many simultaneous requests for the same uncached JWKS key trigger exactly one fetch, not N.
- `LayerMap.ts` — a keyed table of Layers with TTL and explicit invalidation, whose own doc comment names "tenant clients, regional connections, or environment-specific services" — a close match if awthaq grows per-tenant configuration later.
- `FiberMap.ts`/`FiberSet.ts`/`FiberHandle.ts` — "at most one live fiber per key, auto-interrupted when the key is removed," which is precisely live session-revocation push done right: one fiber per active session watching a revocation channel, and removing the key on logout/kick interrupts it for free instead of awthaq building its own fiber-lifecycle bookkeeping.
- `unstable/eventlog/Event.ts` / `EventGroup.ts` — `Event.make({tag, primaryKey, payload, success?, error?})` gives `AuthEvents` (`UserLoggedIn`, `PasswordChanged`, `SessionRevoked`) a durable, Schema-typed, primary-keyed shape — a stronger foundation for BEH-EA-097–104 than a bare `PubSub`.
- `unstable/eventlog/SqlEventJournal.ts` — durable, replayable, queryable audit-event storage via `SqlClient`, without awthaq building its own event-store schema and replay logic. (The surrounding `eventlog` package's encryption/remote-peer-replication machinery is for offline-sync CRDT use cases and isn't needed here — the useful core is just `Event`/`EventGroup`/`EventJournal`/`SqlEventJournal`.)
- Redaction of event/log payloads is covered in §6, not a separate mechanism here.

## 5. HTTP stratum (`@awthaq/server`)

- `unstable/http/Cookies.ts` — a complete cookie model: parsing, validated construction, the full modern attribute set (including CHIPS `Partitioned`), and `expireCookie` for a correct sign-out in one call. **Gap**: no signing/HMAC/encryption built in — awthaq still needs its own cookie-signing layer.
- `unstable/http/HttpMiddleware.ts` / `HttpRouter.ts` — `HttpMiddleware.cors(options)` is a complete, correctly-behaved CORS implementation (dynamic-origin handling, credentials mode, preflight) — a whole class of subtle browser-auth bugs awthaq doesn't have to get right itself. **Gap**: no CSRF middleware exists — `CsrfProtection` (per `spec/overview.md`'s planned surface) is custom `HttpApiMiddleware.Service` work. (Rate limiting is *not* a gap — see §3a.)
- `unstable/http/Multipart.ts` — typed, size/MIME-bounded multipart ingestion (`MaxFileSize`, `FieldMimeTypes` as `Context.Reference` limits) tied to endpoint schemas — gives WebAuthn/passkey attestation-object uploads a bounded, typed path without a separate multipart library.
- `unstable/http/HttpServerRequest.ts` — schema-validated request accessors (`schemaCookies`/`schemaHeaders`/`schemaBodyJson`) used directly by `securityDecode` (§1) and available to handlers outside the middleware path too.

## 6. Observability, redaction, and audit (cross-cutting)

Worth stating precisely, since it's easy to guess wrong: **redaction does not live in `unstable/observability/`** — a directory-wide check for "redact"/"sensitive" there returns nothing. The real mechanism is two stable, top-level modules that observability code happens to consume, and together they're a genuine security feature, not just log hygiene:

- `Redacted.ts` — the value wrapper.
- `Redactable.ts` — `symbolRedactable`, letting any class implement a *context-dependent* masked view (show more to an admin, less to a plain logger) instead of one blanket mask — useful for a `Credential`/`MfaSecret` domain object controlling exactly what an audit-event payload reveals based on who's asking.
- `Formatter.ts` — `format()`/`formatJson()` recurse into any nested `Redacted`/`Redactable` value **before** stringifying, automatically and recursively. `Logger.formatJson` is built directly on this, so using it as awthaq's structured logger enforces redaction at the sink — a secret can't leak just because one call site forgot to wrap it.
- `unstable/observability/OtlpResource.ts` — the same masking reaches OTLP span/log export automatically: a `Redacted` value set as a span attribute serializes as `<redacted>` with zero extra awthaq code.
- `Metric.ts` — `counter`/`histogram`/`timer`/`frequency` give awthaq real operational signal (failed-login rate, auth-latency, per-reason failure cardinality) for free, exportable via `OtlpMetrics`/`PrometheusMetrics`.
- `unstable/devtools/DevTools.ts` — confirmed **not** relevant here: a live WebSocket debugging inspector, not an audit or telemetry mechanism. Worth naming only to stop it from being conflated with `eventlog`.

## 7. CLI (`@awthaq/cli`) — BEH-EA-201–208

`unstable/cli/` is a complete, real CLI framework — awthaq gets a whole command-line tool's worth of infrastructure for free rather than reinventing argument parsing, prompts, and help generation:

- `Command.ts` — subcommand composition with dependency injection built in, maps directly to `awthaq migrate` / `keys rotate` / `scaffold init` / `openapi` (§9) as subcommands of one root command.
- `Flag.ts`/`Argument.ts` — **`Flag.Redacted(name)`** parses `--password`/`--signing-key` straight into `Redacted<string>`, so a secret literally cannot leak into help text or logs — the CLI-side counterpart to §6's redaction story, for free.
- `Prompt.ts` — `Prompt.Password`/`Hidden`/`Confirm` for interactive confirmations ("rotate the signing key?") and hidden-input secret entry during scaffold.
- `Completions.ts` — real shell-completion generation (`bash`/`fish`/`zsh`) driven by the command's own descriptor — `awthaq completions zsh` for close to free.

## 8. Multi-instance / distributed deployment (optional, forward-looking)

Not part of the seven-stratum map today, but each of these maps onto a concrete later capability once awthaq runs on more than one server instance:

| Concern | Effect primitive | Product-value verdict |
|---|---|---|
| Cross-instance rate-limit counters / distributed session store / cluster-wide session-revocation broadcast | `unstable/cluster/` — `Sharding`, `Entity`, `MessageStorage`/`SqlMessageStorage`, `Singleton`/`ClusterCron` | **High.** A rate-limit bucket as a sharded `Entity` avoids cross-instance races by construction, not by luck; `Singleton` gives a cluster-wide expired-session sweep with no leader-election code of awthaq's own. |
| Multi-step auth flows that must survive restarts (OAuth code exchange with retries, durable email-verification timers, SCIM sync) | `unstable/workflow/` — `Workflow`, `Activity`, `DurableClock` | **High** — maps close to 1:1 onto these flows; a real durable-execution engine instead of ad-hoc retry logic. |
| qadi-bridge or plugin contract across a process boundary | `unstable/rpc/` — `Rpc`/`RpcGroup`, `RpcMiddleware` | **High** if that boundary is ever needed — the middleware shape mirrors `HttpApiMiddleware` closely enough to reuse the same mental model. |
| Single-process alternative to a Redis-backed counter (tests, single-instance deployments) | `TxRef.ts`/`TxHashMap.ts`/`TxReentrantLock.ts` | **Medium** — atomic in-memory counters with no store round-trip, useful for a `layerMemory`-equivalent mode. |
| Live session-revocation push | `unstable/socket/Socket.ts`/`SocketServer.ts` plus `FiberMap` (§4) | **Medium** — the transport primitive exists; a broadcast/fan-out registry is still awthaq's to build. |
| IP-based rate limiting / CIDR allowlists | `unstable/net/` — `NetAddress`, `IpInterface`, `IpNetwork` | **Low-Medium** — correct CIDR containment for `X-Forwarded-For`-style checks, a small utility rather than a core dependency. |
| LLM-based risk scoring / fraud detection | `unstable/ai/` — `LanguageModel`, `Tool`/`Toolkit` | **Low, stretch only** — a real optional bolt-on plugin idea, not core infrastructure. |
| Spawning OS processes | `unstable/process/` | **None** — no plausible use in an auth request path. |

## 9. Testing, docs, and typed client (`HttpApiTest`, `OpenApi`, `HttpApiScalar`/`Swagger`, `HttpApiClient`)

Four more `httpapi/` files that map onto three concrete parts of awthaq's planned surface — each saves awthaq from building a whole subsystem itself:

- **`HttpApiTest.ts`** — `HttpApiTest.groups(api, groupIdentifiers, options?)` builds an in-memory typed client that runs requests through the *real* production pipeline (encode → route → middleware → decode) with no socket opened. This is the right foundation for `@awthaq/test`'s `TestAuth`/contract-test harness (BEH-EA-193–200): tests get faithful auth-middleware behavior for free instead of a hand-rolled fake client that might not match production routing. awthaq's own value-add on top is just a set of fake-identity Layers to feed into this harness.
- **`OpenApi.ts`** — `OpenApi.fromApi(api, options?)` generates a full OpenAPI 3.1 document from an `HttpApi` definition, correctly including `HttpApiSecurity` schemes in `components.securitySchemes` — awthaq's auth middleware shows up in generated docs automatically. This is most of the planned `awthaq openapi` CLI command already built.
- **`HttpApiScalar.ts`** / **`HttpApiSwagger.ts`** — mountable browser API-reference UIs (Scalar or Swagger UI) rendering `OpenApi.fromApi` internally, memoized and deferred to first request. Interactive docs for a running awthaq server, with no separate spec file and no HTML/JS-bundling work of awthaq's own.
- **`HttpApiClient.ts`** — `HttpApiClient.make(api, options?)` produces a fully typed client with schema encode/decode, client-side middleware, and streaming/SSE support already handled. The right foundation for `@awthaq/client`'s planned `AtomHttpApi` — reimplementing correct wire-level encode/decode and streaming from scratch would be a substantial, easy-to-get-subtly-wrong undertaking on its own.

## 10. A naming trap worth recording

`PrimaryKey.ts` sounds like it should back request deduplication ("dedupe concurrent identical session-token validations"), but checking actual usages shows Effect's own `Request.ts`/`RequestResolver.ts` dedup relies on structural `Equal`/`Hash` on the request object instead — `PrimaryKey` is a persistence/routing identity protocol (used by `Persistable`, `rpc`, `eventlog`, `cluster`), not a request-batching mechanism. So the real building block for "many requests validating the same session at once" is `Effect.request` + a custom `RequestResolver` with `Equal`/`Hash` on the request class (or `SqlResolver`'s batching, §3) — not `PrimaryKey`. Recorded here so this doesn't get reached for by name alone later.

## A few things worth pinning a version for

Everything above is a genuine capability worth building on. A small number of exact API shapes cited here have changed recently enough that pinning the Effect version awthaq builds against — and re-checking on upgrade — is cheap insurance, not a reason to avoid the feature:

- `RateLimiterStore.tokenBucket`'s return shape changed from a single value to a `[remaining, elapsedMillis]` tuple recently — only matters if awthaq writes a *custom* `RateLimiterStore` (unlikely; the memory/Redis stores already cover the normal cases).
- `unstable/schema/Model.ts` renamed `Model.Generated` to `Model.GeneratedByDb` — use the current name (already reflected above).
- `unstable/sql/SqlClient.ts`/`Statement.ts` underwent a native-driver rewrite recently — worth a quick re-check of transaction/error-mapping behavior when awthaq's persistence layer is actually implemented, since that's exactly the code path it depends on.

Everything else surveyed is safe to build on as described without a special caveat.
