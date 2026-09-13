# Effect Ecosystem — Research

Domain: Effect architecture (Q8–Q19) for effect-auth. All versions/dates verified against npm, unpkg type declarations, and effect.website as of **2026-09-12**.

## TL;DR

- **Stable Effect is `3.22.2`** (published 2026-09-09). **Effect v4 is in release-candidate**: `4.0.0-rc.115` (2026-09-11), RC announced 2026-08-12, "no more broad breaking changes planned", **stable targeted Q3/Q4 2026**; install via `effect@rc`; requires TS ≥ 5.9.
- **The PRD's `Context.Service` API does not exist in Effect 3.22.** Current idioms are `Context.Tag` classes, **`Effect.Service`** (since 3.9.0) and **`Context.Reference`** (experimental, default-valued tags). In v4 the context system was rebuilt as `ServiceMap` then **renamed back to `Context`** (Apr 2026).
- **`LayerMap` (keyed, cached, lifecycle-managed layers) ships in `effect` ≥ 3.14** — verified present in 3.14.0–3.22.2 — making the PRD's multi-tenant seam viable today. Layer memoization is documented and built into composition (`MemoMap`, `Layer.memoize`).
- **`HttpApi` lives in `@effect/platform@0.97.2` and is officially "Unstable"** (per the platform docs page). It has builder, typed client, OpenAPI generation, Scalar/Swagger hosting, security schemes, and middleware — but no dedicated website guide (docs are the package README), a known middleware-skipping bug class (#6121), and no streaming/SSE in v3 (HttpApi streaming landed in the **v4 beta**, June 2026).
- **v4 consolidates the ecosystem**: `@effect/platform`/`rpc`/`cluster` core moves into `effect` with `effect/unstable/*` subpaths (`httpapi`, `http`, `sql`, `observability`, …), single version number for all packages, rewritten fiber runtime, ~70 kB → ~20 kB minimal bundle.
- **`@effect/sql@0.52.1`** provides `Migrator` (+ filesystem loader), `Model` (Schema-driven tables + repositories), `SqlResolver`, `SqlPersistedQueue`, `SqlEventJournal`; dialects: pg, mysql2, sqlite-node/bun/libsql/d1/mssql/clickhouse/pglite, plus kysely/drizzle bridges.
- **Config & secrets are first-class**: `Config`/`ConfigProvider` (typed env config "validated at startup"), `Redacted` module (`Config.redacted`, `Schema.RedactedFromSelf`) for secret redaction.
- **Testing stack**: `TestClock`/`TestContext`/`TestLive`/`TestSized` in core, `@effect/vitest@0.30.0` (vitest ^3.2), `effect/FastCheck` + `Schema` arbitraries for property tests, and HTTP tests without a server (HttpApi → web handler; HttpClient fetch injection); v4 adds `HttpApiTest`.
- **Observability**: built-in tracing/metrics/logging; `@effect/opentelemetry@0.64.1` bridges to OpenTelemetry SDK 2.x (traces, metrics, logs); v4 adds native OTLP observability.
- **Prior art is immature**: `@effect-auth/core` + `@effect-auth/cli` (alpha, 18 versions, last publish 2026-07-29, GitHub repo now 404) and `@kndwin/effect-auth` (2026-08-31, brand new) exist; the dominant community pattern is **better-auth wrapped in Effect** (multiple starters). **The `@effect-auth/*` npm namespace is already taken** — the PRD's own fallback clause ("subject to npm availability") will trigger.

## Questions answered

### Q8 — How should `Auth.make({ plugins })` produce a single typed Layer graph, and where are TypeScript's inference limits?

Evidence:
- Layers are the composition unit: `Layer.effect`, `Layer.provide`, `Layer.mergeAll`, `Layer.flatten` exist in `effect@3.22.2` (`Layer.d.ts`, verified via unpkg). Memoization is built into composition via `MemoMap`; `Layer.memoize` is public API, and the official docs have a dedicated [Layer memoization](https://effect.website/docs/v3/requirements-management/layer-memoization) page.
- The R (requirements) channel is an intersection of tag types; each plugin contributing services grows the row. Effect's own guidance keeps service interfaces small and composes via layers, not by manually merging objects. The official [services](https://effect.website/docs/v3/requirements-management/services) and [layers](https://effect.website/docs/v3/requirements-management/layers) guides describe the pattern.
- TypeScript inference limits are real and Effect invests heavily in tooling to stay under them: the **Effect Language Service** (`@effect/language-service@0.87.2`) and the native TS port **tsgo** (`@effect/tsgo@0.45.0`, official Effect repo) exist precisely because large R/E rows stress tsc and IDEs ([getting-started docs recommend the LSP/tsgo](https://effect.website/docs/v3/getting-started)). Effect 4's type layer was simplified (variance annotations reduced, runtime rewritten) per the [v4 beta announcement](https://effect.website/blog/releases/effect/40-beta) and [InfoQ coverage](https://www.infoq.com/news/2026/04/effect-v4-beta/).
- Practical limit data points: aggregating N plugins × M endpoint/error/service types creates intersections with thousands of instantiations; community reports and Effect team guidance converge on "keep R rows composed of named tags, avoid deep mapped-type merges" [INFERENCE from tooling investment + docs guidance; no formal benchmark published].
- Mechanically, the cost concentrates in three places: (1) the R row — an intersection of every provided tag type across all plugins; (2) `HttpApi` endpoint types — each endpoint carries its payload/success/error unions; (3) the plugin-list generic (variadic tuple). TypeScript degrades on very large intersections and deep conditional nesting (editor latency, "type instantiation is excessively deep" errors). Effect's own mitigation pattern is named service tags + **runtime** compilation, and v4 simplified variance annotations accordingly — the same strategy applies here [INFERENCE on TS internals; the strategy follows Effect's observable practice].

Sketch (compiler output — one layer, one facade, opaque internals):

```ts
const AuthLayer: Layer.Layer<
  CompiledAuth,        // the only service app code touches
  PluginCompileError,  // cycle / conflict / capability errors, before startup
  AppDeps              // only adapter ports (e.g. SqlClient), resolved by the app
> = Auth.make({
  plugins: [password(), passkey(), oauth(), organization()]
})
```

**Recommendation:** `Auth.make` should produce one `Layer.Layer<CompiledAuth, PluginCompileError, PluginDeps>` built by `Layer.mergeAll`/`Layer.provide` over per-plugin layers (each already memoized by the MemoMap). Keep the *public* type surface tiny: one `CompiledAuth` service tag plus the HttpApi type — do not expose each plugin's internal service tags in the top-level R row. Bound type-level work at compile time (tuple-of-plugins generic, capped recursion) and never rely on unbounded mapped/conditional-type merging across N plugins; the compiler (runtime function) should validate dependencies/cycles instead of encoding them in conditional types. Add `@effect/language-service`/tsgo to the dev setup and CI matrix early — type-graph regressions will show up there first.

**Confidence:** high

### Q9 — Service naming/namespacing convention for plugin-contributed Context tags

Evidence:
- Tag ids are developer-facing identifier strings. Canonical Effect examples: `"@effect/platform/FileSystem/WatchBackend"` (verified in `@effect/platform@0.97.2` `FileSystem.d.ts`) and `effect`'s own module-scoped ids (e.g. `"@effect/Clock"` style) — the `@scope/Module/Service` convention is pervasive in first-party code.
- Tag **identity is the class itself, not the string**: two `Context.Tag` classes with the same id are distinct keys; the id string appears in diagnostics, logs, and RPC wire metadata. The [services guide](https://effect.website/docs/v3/requirements-management/services) presents the Tag as the typed key for a service.
- `Effect.Service<Name>()("Name", {...})` (since 3.9.0, verified in `Effect.d.ts` JSDoc) similarly takes an id string used for debugging/annotation.

**Recommendation:** Mandate tag ids of the form `"@<package-scope>/<PluginId>/<ServiceName>"` (e.g. `"@effect-auth/password/PasswordService"`). Since identity is nominal, collisions cannot corrupt runtime behavior — but enforce id **uniqueness in the plugin compiler anyway** (it is a DX, log-clarity, and RPC-safety rule, and it feeds `auth plugin list`/`doctor`). Reserve the `"@effect-auth/*"` id prefix for first-party plugins; reject third-party plugins claiming it. Keep capability strings (`"auth.password"`) in a separate, separately-namespaced registry (plugin-system domain, Q23) — tag ids are not the capability namespace.

```ts
// first-party plugin service
export class PasswordService extends Effect.Service<PasswordService>()(
  "@effect-auth/password/PasswordService"
) {}
// core-owned capability (reserved prefix)
export class PasswordHasher extends Effect.Service<PasswordHasher>()(
  "@effect-auth/core/PasswordHasher"
) {}
```

**Confidence:** high

### Q10 — Do plugins contribute raw Layers or declarative contributions the compiler wraps into Layers?

Evidence:
- Layers give you, for free: typed requirements (R rows), scoped acquisition/release (the PRD's §32 requirement — pools, Redis, crypto providers), memoization, and test doubles via layer replacement. Official docs: [layers](https://effect.website/docs/v3/requirements-management/layers), [scoped resources](https://effect.website/docs/v3/resource-management/introduction).
- But layers alone cannot express what the PRD's compiler must validate: plugin ids, `requiresPlugins`, capability claims, apiVersion, migrations, hooks, route tables. These need declarative metadata. The PRD (ADR-001/ADR-002, §9, §12) already demands a plugin graph **separate** from the service graph.
- `LayerMap` shows Effect itself moving toward "declarative key → layer" registries for keyed resources ([LayerMap.d.ts](https://unpkg.com/effect@3.22.2/dist/dts/LayerMap.d.ts) — `LayerMap.Service`, `make`, `fromRecord`).

**Recommendation:** Hybrid, with the Layer as the only runtime artifact: plugins ship **declarative contributions for everything the compiler must introspect** (id, deps, capabilities, apiVersion, api groups, schema IR, migrations, hooks, events) **plus raw Layers for services**; the compiler normalizes, validates, and aggregates layers it does not need to look inside. Wrapping service construction in custom descriptors would buy nothing for validation (types already validate layer wiring) and would break `Layer.memoize`/scoped-release semantics. What the declarative half buys: `auth plugin list`, cycle/dependency errors with plugin names (PRD §9.4), migration planning, and docs — all impossible from opaque layers.

What each half buys:

| Compiler must… | Declarative metadata | Raw Layer |
|---|---|---|
| Detect duplicate ids, cycles, missing deps | yes | impossible |
| Enforce `apiVersion` / capability exclusivity | yes | impossible |
| Plan migrations, docs, `auth routes` / `auth plugin list` | yes | impossible |
| Validate service wiring, acquire/release, memoize | no — the type system already does | yes |
| Support test doubles / overrides | no | yes |

**Confidence:** high

### Q11 — How are capability interfaces (`PasswordHasher`, `RateLimiter`, `Mailer`, …) declared, defaulted, and swapped?

Evidence:
- `Effect.Service` (3.9.0+) generates `Tag` + `Default` layer in one class: verified JSDoc — `class Prefix extends Effect.Service<Prefix>()("Prefix", { sync: ... }) {}` and usage `dependencies: [Prefix.Default]` ([Effect.d.ts](https://unpkg.com/effect@3.22.2/dist/dts/Effect.d.ts)). `.Default` is the canonical self-contained default implementation.
- `Context.Reference` (verified in 3.22 `Context.d.ts`, marked `@experimental`) creates tags **with default values** that apply unless overridden — designed exactly for optional/overridable capabilities.
- Swapping: `Layer.provide` / `Layer.provideMerge` compose overrides explicitly; when duplicate tags are in play, precedence follows composition order, so the compiler must wire overrides deliberately (`Layer.provide`) instead of relying on incidental merge order (dts JSDoc documents the operations, not a conflict direction — treated as unspecified).

**Recommendation:** Declare every capability as an `Effect.Service` class with a safe `.Default` (e.g. `ArgonHasher.Default` for `PasswordHasher`, `NoopMailer.Default` that fails loudly in production and logs in test). Plugins `yield* PasswordHasher` — never another plugin's concrete hasher (PRD §5.1). Priority/conflict rules belong to the compiler: an explicit `capabilities` registry with `provides/requires/conflicts` (PRD §34/§36) resolves which layer wins, then the compiler wires overrides via `Layer.provide`; do not rely on merge-order accidents. For test doubles, `@effect-auth/test` ships `Layer.succeed`-based replacements; `Context.Reference` is worth watching but too experimental to build the public contract on in 3.x.

```ts
export class PasswordHasher extends Effect.Service<PasswordHasher>()(
  "@effect-auth/core/PasswordHasher",
  { effect: Effect.gen(function* () { /* argon2id default impl */ }) }
) {}

// apps override without touching core:
export const Live = Auth.make({ plugins: [password()] }).pipe(
  Layer.provide(Layer.succeed(PasswordHasher, makeBcryptHasher())) // explicit override
)
```

**Confidence:** high

### Q12 — Where do hooks live — one `AuthHooks` service vs per-hook tags — and how is execution order kept deterministic?

Evidence:
- The PRD (§17) already models hooks as typed arrays aggregated into a runtime `HookRegistry`; multiple plugins may contribute `beforeSignIn`, `afterSignIn`, etc.
- Effect primitives relevant to ordering: `Effect.forEach` (default sequential, deterministic), `Effect.all` with `concurrency`, and scheduled composition ([concurrency docs](https://effect.website/docs/v3/concurrency/basic-concurrency)). Effect has **no built-in priority-ordered broadcast** — ordering must be decided by the aggregator.
- One service vs many tags: per-hook tags (`BeforeSignIn`, `AfterSignIn`, …) multiply the R-row surface (Q8's inference budget) and force handlers to depend on each tag; a single aggregated `AuthHooks` service constructed by the compiler is one dependency, unit-testable as a whole.

**Recommendation:** One compiler-assembled `AuthHooks` service. Ordering: plugin topological order (from the plugin dependency graph), refined by an explicit per-hook `priority: number` (stable tiebreak: plugin id). Hook kinds split by contract: **guards** (`before*`) run sequentially and their typed error aborts the operation (that is their purpose — e.g. ban-list hook); **observers** (`after*`) run via `Effect.forEach` with `Effect.catchAll` isolation so a failing observer can never fail auth (PRD §18 requirement), with failures logged + counted. Make ordering part of `CompiledPlugins.metadata` so `auth doctor` can print the hook chain.

```ts
// the compiled hook chain is data — printable by `auth doctor`, testable as a unit
interface HookEntry<I> {
  readonly plugin: string      // topo position of the contributing plugin
  readonly priority: number    // explicit refinement, default 0
  readonly run: (input: I) => Effect.Effect<void, AuthError>
}
// guards (before*): sequential in order; typed error aborts the operation
// observers (after*): same order; each wrapped in Effect.catchAll → log + metric
```

**Confidence:** high

### Q13 — Events: PubSub/Stream-based bus? Delivery guarantees, error isolation, backpressure, shutdown draining?

Evidence:
- `PubSub` is the core publish/subscribe primitive with bounded capacity and graceful shutdown via Scope ([PubSub docs](https://effect.website/docs/v3/concurrency/pubsub)); `Queue` similarly ([queue docs](https://effect.website/docs/v3/concurrency/queue)). `Mailbox` (verified in `effect@3.22.2` exports) is the newer producer/consumer primitive designed for safe handoff; `Stream` composes fan-out (`Stream.broadcast`).
- For durability, the ecosystem already has SQL-backed building blocks: `@effect/sql`'s `SqlPersistedQueue` and `SqlEventJournal` (verified in `@effect/sql@0.52.1` exports), and `@effect/cluster`/v4 add `DurableQueue` (v4 beta, TWiE #118).
- PRD §18: "The event system must not make authentication success depend on non-critical observers."

**Recommendation:** In-process bus: a bounded `Mailbox`/`PubSub` per event type (backpressure explicit via capacity), publishers `offer` and never await observers; observers are fibers forked into the app-level scope with `Effect.catchCause` isolation — observer failures become logs + `auth.event.observer.error` metrics, never auth failures. Delivery guarantee: **at-most-once in-process**; make the append-only `auth_audit` table the record of record (written synchronously, typed via Schema, Q49's domain) and defer durable outbox/streaming (`SqlPersistedQueue`, cluster `DurableQueue`) to a later plugin. Shutdown: scope-owned — draining is `Scope.close` semantics of the PubSub/Mailbox, covered by a TestClock-driven test.

```ts
const bus = yield* AuthEventBus                       // bounded per-type PubSub/Mailbox
bus.publish(new UserSignedIn({ principalId }))        // returns immediately; never awaits observers
// each subscriber: fiber forked into the app-level scope,
// body wrapped in Effect.catchCause → failure becomes log + auth.event.observer.error metric
// shutdown: Scope.close drains in-flight deliveries — asserted in a TestClock test
```

**Confidence:** high

### Q14 — How does the compiled auth expose a typed facade (`auth.password.signIn`) whose keys depend on installed plugins?

Evidence:
- `HttpApiClient` already derives a fully typed client from an `HttpApi` definition — "Deriving a Client" is a first-class HttpApi feature ([platform README §Deriving a Client](https://github.com/Effect-TS/effect/blob/v3/packages/platform/README.md)); endpoint names/group names are the object keys. The PRD (§22) explicitly wants "one contract, no duplication" and cites better-auth's server→client inference as the benchmark.
- Alternatives compared: (a) type-level merge of plugin `client` objects (`UnionToIntersection`) — costs deep inference across N plugins (Q8's budget), duplicates the HttpApi contract; (b) mapped Context tags per plugin — reintroduces per-plugin service surface; (c) derive from the compiled `HttpApi` — single source of truth, zero duplicate types, matches PRD §5.4.
- Prior art: `@kndwin/effect-auth-server` advertises "`Auth.make` / `Auth.define`, session HTTP, email/password, and storage adapters" (npm description, verified 2026-08-31) — the same facade-shape idea, but built outside HttpApi's type system [INFERENCE on internals; package is 1 week old].

**Recommendation:** The facade is the compiled `HttpApi`, exposed as `auth.client` (and `auth.serverHandlers` for in-process use): keys = `HttpApiGroup` names contributed by installed plugins, values = `HttpApiClient`-derived typed calls. The plugin compiler only assembles the `HttpApi`; it does not synthesize a second type-level API. This gives plugin-contributed client surface for free (plugin-system Q29), keeps IDE latency bounded (types come from HttpApi, not from nested conditional merges), and makes "keys depend on installed plugins" literally true because uninstalled plugins' groups are absent from the type.

```ts
const auth = yield* CompiledAuth
const { password } = auth.client                     // groups present = plugins installed
const session = yield* password.signIn({ email, password }) // fully typed payload + error union
// `oauth` is absent here unless the oauth() plugin was installed — the type says so
```

**Confidence:** high

### Q15 — Configuration: plugin configs × Effect `Config`, secrets, redaction, compile-time validation

Evidence:
- `Config`/`ConfigProvider` give typed, validated-at-startup environment config with provider nesting and path patching ([configuration docs](https://effect.website/docs/v3/configuration)); Effect's homepage leads with "Typed config from the environment, validated at startup, secrets redacted".
- Secrets: `Redacted` module (verified export), `Config.redacted`, docs page [data-types/redacted](https://effect.website/docs/v3/data-types/redacted), and `Schema.RedactedFromSelf` in `Schema` (verified in `Schema.d.ts`) so schemas can carry redaction through validation and logging. PRD §31: "Secrets must never be hard-coded into plugin definitions."
- Plugin config needs two shapes: **static structural config** (min password length, providers enabled — known at `Auth.make` time, plain typed objects, validated by Schema at compile/startup) and **environment-backed secrets** (OAuth client secrets, SMTP creds — must come from `Config` at layer-build time).

**Recommendation:** Plugin factories take plain typed config objects (Schema-validated at `Auth.make` — full merged-config validation happens once, in the compiler, producing actionable errors before startup). Anything secret is typed `Redacted<...>` and sourced inside the plugin's Layer via `Config.redacted("...")` with a plugin-scoped path convention (e.g. `AUTH_OAUTH_GOOGLE_CLIENT_SECRET` → namespace via `ConfigProvider` nesting). Redaction is enforced by type (Redacted never stringifies; logs show `Redacted(<redacted>)`) plus Schema annotations for event payloads. Do not attempt to make the *whole* merged config a single `Config` value — structural config is compile-time, secrets are runtime-`Config`.

```ts
// structural config: plain typed object, Schema-validated once by the compiler
const password = pluginPassword({ minLength: 12, breachCheck: true })

// secrets: environment-backed, resolved inside the plugin's Layer only
const hibpKey = yield* Config.redacted("AUTH_HIBP_API_KEY")   // Redacted<...>, never a string
```

**Confidence:** high

### Q16 — Observability: span naming (`auth.*`), metrics, sensitive-field redaction — core-enforced or plugin-declared?

Evidence:
- Effect has built-in tracing (`Effect.withSpan`, child-span propagation), `Metric` (counters/histograms/gauges), and structured `Logger` ([logging](https://effect.website/docs/v3/observability/logging), [metrics](https://effect.website/docs/v3/observability/metrics), [tracing](https://effect.website/docs/v3/observability/tracing)).
- `@effect/opentelemetry@0.64.1` bridges to OTel SDK 2.x (peer deps verified: `@opentelemetry/sdk-trace-node ^2.0.0`, `sdk-metrics ^2.0.0`, `semantic-conventions ^1.33.0`, `api-logs`) — traces, metrics, **and logs** exportable to any OTLP backend. v4 beta added native OTLP observability (TWiE #121, June recap "OpenTelemetry enhancements").
- PRD §A (G6) requires auditability; Q93 (security domain) will own the redaction table — this answer owns the mechanism.

**Recommendation:** Hybrid. **Core-enforced skeleton**: the auth runtime creates one span per authentication operation (`auth.signin`, `auth.signup`, `auth.session.refresh` — attribute `effect-auth.plugin`, `strategy`, `principal_id`; never credentials/tokens) and emits standard metrics (`auth.signin.total`, `auth.signin.duration`, `auth.session.active`, `auth.denied.total` by reason). **Plugin-declared leaves**: plugins add child spans via `Effect.withSpan("auth.oauth.tokenExchange")` and their own metrics — the contract-test harness (Q31) asserts plugins declare no unredacted sensitive attributes. Redaction mechanism: sensitive values only ever travel as `Redacted`/Schema-annotated types (Q15), and the `auth_audit` event pipeline applies the redaction rules before any observer sees payloads. Ship `@effect/opentelemetry` wiring as an optional `AuthObservability.layer` so zero-provider dev setups still get pretty console spans/logs.

Convention table (core-enforced skeleton, plugin-declared leaves):

| Signal | Name | Owner |
|---|---|---|
| Span | `auth.signin`, `auth.signup`, `auth.session.refresh`, `auth.oauth.callback` | core middleware |
| Span | `auth.<plugin>.<op>` (e.g. `auth.password.verify`) | plugin, by convention |
| Metric | `auth.signin.total`, `auth.signin.duration`, `auth.denied.total{reason}`, `auth.session.active` | core |
| Span attrs | `effect-auth.plugin`, `strategy`, `outcome` — never tokens, passwords, emails | core-enforced, contract-tested |

**Confidence:** high

### Q17 — Error architecture: one hierarchy vs per-domain errors; HttpApi mapping; user-facing vs internal detail

Evidence:
- Effect's model is typed error channels with **yieldable tagged error classes** (`Schema.TaggedError` / `Data.TaggedError`) — [yieldable errors docs](https://effect.website/docs/v3/error-management/yieldable-errors), and the HttpApi README has a full "Adding errors" section: errors are Schemas attached with `.addError`, gaining typed decoding on the client and status mapping ([README §Adding errors](https://github.com/Effect-TS/effect/blob/v3/packages/platform/README.md), §Status Codes).
- `HttpApiSchema` supports per-error status/content-type annotations (verified: `HttpApiSchema` export; README §Status Codes at endpoint level). Known rough edges: error-encoding/middleware interactions have open issues (e.g. [#6121 middleware is skipped](https://github.com/Effect-TS/effect/issues/6121)) — budget for workarounds.
- PRD §5.5 requires `Effect<User, InvalidCredentials | RateLimited | DatabaseError>`-style unions.

**Recommendation:** **Per-domain tagged errors sharing one marker base** (`AuthError` with `readonly code` and an `expose: "user" | "internal"` policy field), NOT one monolithic hierarchy: per-domain unions keep each plugin's `addError` list closed and reviewable, while the base marker lets middleware/loggers catch `AuthError` uniformly. Map to HTTP centrally: each error Schema carries its status via `HttpApiSchema.setStatus` at declaration (one source of truth, no per-endpoint tables), user-facing `message` lives on the error, internal detail lives in `cause` and is stripped by the HttpApi error encoder (client decodes only the declared Schema — this is exactly what `.addError` gives you). Enumeration-sensitive errors (`InvalidCredentials`) get uniform messages/timing at the strategy layer (Q90 owns policy; Q17 owns transport).

```ts
export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  { message: Schema.String },                 // safe to serialize to the client
  HttpApiSchema.annotations({ status: 401 })  // status declared once, on the error itself
) {}
// internal detail (hash timings, DB causes) lives in `cause` — outside the declared Schema,
// so the HttpApi error encoder never ships it
```

**Confidence:** high

### Q18 — Testing on Effect: TestLayer/in-memory repos, TestClock expiry tests, property tests, HTTP tests without a server

Evidence:
- `TestClock`/`TestContext`/`TestLive`/`TestSized`/`TestAnnotation` are core modules (verified in `effect@3.22.2` exports); official docs: [testing/testclock](https://effect.website/docs/v3/testing/testclock) — deterministic time is exactly what session/token expiry tests need (PRD Q47 wants `Duration` + `TestClock`).
- `@effect/vitest@0.30.0` (peer `vitest ^3.2.0`, verified) provides `it.effect`/`it.scoped`/`it.live` runners with the test runtime preconfigured.
- Property-based testing is built in: `effect/FastCheck` export + `Schema` arbitrary derivation ([schema/arbitrary docs](https://effect.website/docs/v3/schema/arbitrary)) — arbitrary instances for every payload Schema come free.
- **HTTP without a server** is documented: `HttpApiBuilder` apps convert "to a Web Handler" (README §Converting to a Web Handler) and call it with `HttpClient` where fetch is injectable (README §Testing → Injecting Fetch). v4 adds a dedicated `HttpApiTest` (TWiE #117, May 2026). In-memory repositories are plain `Layer.succeed` implementations — no framework needed.

**Recommendation:** `@effect-auth/test` ships: (1) `TestAuth.layer({ plugins })` = full compiled auth over in-memory repositories + fake `Mailer`/`RateLimiter` + `TestClock`; (2) `authTestClient` = the compiled HttpApi mounted as a web handler with an injectable fetch (no socket, no port); (3) re-exports of `it.effect` helpers and `TestClock.adjust` recipes for expiry/rotation tests; (4) Schema arbitraries + `FastCheck` for property tests on token formats and payload validation. Plugin contract tests (Q31) run the plugin through the same harness so "works with the framework" is mechanically checkable.

Sketch of the shape `@effect-auth/test` enables (no server, deterministic time):

```ts
it.effect("session expires after TTL", () =>
  Effect.gen(function* () {
    const client = yield* TestAuth.client({ plugins: [password()] }) // HttpApi → web handler
    yield* client.password.signIn(credentials)
    yield* TestClock.adjust(Duration.days(31))
    const error = yield* Effect.flip(client.session.current())
    assert.strictEqual(error._tag, "SessionExpired")
  }))
```

**Confidence:** high

### Q19 — Performance: Layer memoization, per-request context cost, principal propagation (middleware service vs `FiberRef`), benchmark harness

Evidence:
- **Layer memoization** is a documented core behavior: layers built once per runtime and shared across the graph ([layer-memoization docs](https://effect.website/docs/v3/requirements-management/layer-memoization); `Layer.memoize`/`MemoMap` verified in `Layer.d.ts`). `ManagedRuntime` (core module, verified) builds the layer graph once and reuses it across requests — the standard server pattern ([runtime docs](https://effect.website/docs/v3/runtime)).
- **Per-request context cost**: services in the app layer are plain context reads at request time; request-scoped values are provided by middleware wrappers rather than rebuilt layers. Effect's v4 runtime was rewritten for "lower memory overhead, faster execution", and minimal Effect+Stream+Schema bundles dropped ~70 kB → ~20 kB ([InfoQ, Apr 2026](https://www.infoq.com/news/2026/04/effect-v4-beta/)); v3 also offers `Micro`, a miniature runtime for constrained environments ([Micro docs](https://effect.website/docs/v3/micro/effect-users)) — the ancestor of the v4 runtime ("effect-smol" merged into the main repo, TWiE #127).
- **Principal propagation**: HttpApi's middleware model (`HttpApiMiddleware` tag, verified export) injects per-request services into handler requirements — handlers declare `HttpApiMiddleware | CurrentPrincipal` in types; this is the documented mechanism (README §Implementing HttpApiSecurity middleware). `FiberRef` is the escape hatch for ambient values but is invisible in types.
- **Benchmarks**: Effect's repo carries its own benchmark suites; there is no auth-specific harness in the ecosystem [INFERENCE]. `LayerMap` (keyed layers, verified since 3.14) covers per-tenant resource caching for multi-tenant builds (PRD §33).

**Recommendation:** Build one `ManagedRuntime` per process (memoized layer graph — layers are built once, so per-plugin acquisition costs are amortized); never rebuild layers per request. Propagate `CurrentPrincipal` as a **middleware-provided service** (typed in handler requirements) — keep `FiberRef` only for ambient logging correlation; typed requirements are the framework's whole selling point. Keep the session-lookup hot path allocation-light: cached prepared statements via `@effect/sql` (Q79's domain) and avoid per-request `Layer` work. Benchmark harness: `vitest bench` (or `mitata`) with three fixed scenarios — unauthenticated request, session-authenticated request, `signIn` — run in CI against a local Postgres + in-memory variant, tracking p50/p99 and allocations; publish numbers so plugins can be compared.

Harness spec detail: scenarios = `GET /me` without credentials (401 path), `GET /me` with a valid session cookie, `POST /sign-in` success and failure; variants = in-memory repositories vs local Postgres; report p50/p99 latency and throughput via `vitest bench`; gate = the plugin contract suite fails if a plugin performs per-request layer building (detectable via span inspection).

**Confidence:** medium-high (mechanisms are verified; the recommendation's performance characteristics rest on documented semantics, not on auth-specific benchmarks that don't yet exist)

## Technologies & libraries

| Name | What it is | License | Maturity (2026-09) | Relevance to effect-auth |
|---|---|---|---|---|
| `effect` 3.22.2 | Core runtime: Effect, Layer, Context, Schema, Config, PubSub, Mailbox, Micro, TestClock | MIT | Stable `latest`; 15M weekly downloads (TWiE #120) | Foundation; target `^3.22` at v1 |
| `effect` 4.0.0-rc.115 | v4 release candidate: rewritten runtime, unified packages, `effect/unstable/*` | MIT | RC (stable targeted Q3/Q4 2026) | Next migration target; track via `effect@rc` CI |
| `@effect/platform` 0.97.2 | FileSystem/Path/HttpClient/**HttpApi**/OpenApi abstractions | MIT | HttpApi officially **Unstable** | Hosts the entire `HttpApi*` module family |
| `@effect/platform-node` 0.108.2 | Node/Deno server & services (`NodeContext`, `NodeRuntime`) | MIT | Stable-ish (0.x) | Day-1 server runtime |
| `@effect/platform-bun` 0.91.2 | Bun server & services | MIT | 0.x | Day-1 runtime target |
| `@effect/platform-browser` 0.77.1 | Browser-side abstractions | MIT | 0.x | Client package foundations |
| `@effect/platform-deno` (4.0.0-beta.107) | Deno platform package | MIT | Published on v4 line; v3 Deno runs via platform-node | Later |
| `@effect/sql` 0.52.1 + dialects (pg 0.53, mysql2 0.53, sqlite-node/bun 0.53, libsql, d1, mssql, clickhouse, pglite, kysely, drizzle) | SQL toolkit: `Migrator`, `Model`, `SqlResolver`, `SqlPersistedQueue` | MIT | 0.x, actively released (2026-07-30) | Repositories, migrations, session storage |
| `@effect/vitest` 0.30.0 | Vitest integration (`it.effect`, test runtime) | MIT | 0.x, vitest ^3.2 | Test harness for `@effect-auth/test` |
| `@effect/opentelemetry` 0.64.1 | OTel bridge (traces/metrics/logs, SDK 2.x) | MIT | 0.x | Optional `AuthObservability.layer` |
| `@effect/cli` 0.77.1 | Declarative CLI framework | MIT | 0.x | `@effect-auth/cli` (`auth doctor`, migrations) |
| `@effect/rpc` 0.76.2 / `@effect/cluster` 0.60.2 / `@effect/workflow` 0.19.1 | RPC, entity clustering, durable workflows | MIT | 0.x/experimental | Future distributed-session/audit patterns |
| `@effect/ai` 0.37.0 | AI provider SDK on Schema | MIT | 0.x | Adjacent ecosystem signal |
| `@effect/language-service` 0.87.2 / `@effect/tsgo` 0.45.0 | LSP plugin / native TS port | MIT | Active | Dev experience for heavy type graphs (Q8) |
| `@effect/atom` + `@effect/atom-react` (v4 beta line) | Reactivity primitives | MIT | v4 beta | Client package option later |
| `@kndwin/effect-auth` 0.0.1 (+ `-server/-client/-oauth/-organization`) | New native Effect auth framework attempt | n/a | 1 week old, ★0, no repo listed | Direct competitor/prior art to watch |
| `@effect-auth/core` 0.1.0-alpha.20 + `@effect-auth/cli` | "Composable Effect-first authentication primitives" | n/a | Alpha, repo 404, last publish 2026-07-29 | **Namespace collision** with PRD's working names |
| `better-auth` 1.7.4 | Dominant TS auth framework (Promise-based) | MIT | Very mature | Benchmark; common "better-auth in Effect" wrapper pattern |
| `@ballatech/effect-oauth-client` 0.3.2 | Small OAuth client for Effect | n/a | Low activity | OAuth plugin prior art |
| `effect-cf` 0.40.3 / community starters (`chroxify/effect-cf-workers`, `brandhaug/b2b-saas-starter` ★42) | Cloudflare Workers Effect setups (often with better-auth) | n/a | Community | Workers runtime evidence |

## Books, papers, blogs, talks

- *Effect Oriented Programming* — Bill Frasure, Bruce Eckel, James Ward (effectorientedprogramming.com; Leanpub). Effect-systems concepts book; **note: code is Scala/ZIO**, concepts transfer — the only published book of its kind. https://effectorientedprogramming.com/
- Official docs guides (v3) — services, layers, layer memoization, PubSub, TestClock, configuration, observability: the canonical patterns this research cites. https://effect.website/docs/v3/getting-started
- *The Death of tRPC? Effect's HttpApi Library* — Lucas Barake (Effect Days 2025). The best single argument for HttpApi as an API contract. Via TWiE #62: https://effect.website/blog/this-week-in-effect/62
- *Effect and the Near Inexpressible Majesty of Layers* — Kit Langton. Mental model for layer composition; pair with the TL;DR architecture. Via TWiE #104: https://effect.website/blog/this-week-in-effect/104
- *Building Effect 4.0* — Michael Arnaldi, Effect Days 2025. Where the runtime/plugin architecture is heading. Via TWiE #61: https://effect.website/blog/this-week-in-effect/61
- *Effect v4 Beta* + *v4 RC* announcements + monthly v4 recaps (Feb–Aug 2026) — the authoritative record of what changed (runtime, unified packages, unstable modules, HttpApi streaming, OTLP). https://effect.website/blog/releases/effect/40-beta , https://effect.website/blog/releases/effect/40-rc
- *Effect v4 Beta: Rewritten Runtime, Smaller Bundles and Unified Package System* — InfoQ (Apr 2026). Independent summary incl. bundle numbers and migration caveats. https://www.infoq.com/news/2026/04/effect-v4-beta/
- devtools.fm #149 — Maxwell Brown on Effect.ts (long-form architecture interview). https://www.devtools.fm/episode/149
- Cause & Effect podcast — Effect team interviews (John De Goes ep. 10; Warp CTO Adam Rankin ep. 7; Spiko CTO). https://effect.website/blog (episode index in TWiE posts)
- Effect Days talk archive (YouTube, @effect-ts): production architecture workshop (Maxwell Brown, 2024), Effect Cluster (Tim Smart), *Effect for Domains at Vercel*, *Rebuilding Redis for great Effect* (2025). https://www.youtube.com/@effect-ts
- *Why We Chose Effect for Building Spiko* — production adopter engineering blog. https://tech.spiko.io/posts/why-we-chose-effect/
- *My Effect v4 beta migrations* — Sandro Maglione. Real migration experience incl. AI-agent pitfalls. https://www.sandromaglione.com/newsletter/my-effect-v4-beta-migrations
- *The Case for Effect* — Ryan Hunter; *Maybe I Was Wrong About Effect* — Ben Davis; Effect devlog — Tom MacWright (Val Town). Adopter-skepticism calibration. https://macwright.com/2026/03/18/effect-devlog
- Intro series: Yurij Bogomolov's *Intro To Effect* (ybogomolov.me), Tweag's *Exploring Effect in TypeScript*. https://ybogomolov.me/01-effect-intro , https://tweag.io/blog/2024-11-07-typescript-effect/
- Effect Office Hours (weekly livestream, maintainers) — playlist linked from the v4 RC post; the place migration questions get answered. https://www.youtube.com/playlist?list=PLDf3uQLaK2B_0hEiHT82cv-DotrtD6Bhi
- *Advanced Effect Workshop (Effect Days 2024)* — Maxwell Brown. The deepest public end-to-end Effect architecture walkthrough. https://www.youtube.com/watch?v=7jOD5okJC00
- *Effect: the unreadable library that captured my heart* — Matt Pocock. Mainstream-educator framing of Effect's value proposition. https://www.youtube.com/watch?v=S2GChOwivwQ
- *Effect, the Origin Story* — Michael Arnaldi (TWiE #21). Context for the design philosophy behind Layer/Context. https://effect.website/blog/this-week-in-effect/21
- *Demystifying Effect Scopes* — Harry Solovay (TWiE #82). Scope semantics underpin the plugin resource-lifecycle model (PRD §32).
- Curated ecosystem indexes: https://github.com/m9tdev/awesome-effect , https://github.com/betalyra/awesome-effect-ts , https://github.com/tcmlabs/awesome-effect-ts

## People & projects to follow

- **Michael Arnaldi** — Effect creator/lead, Effectful CEO — https://github.com/mikearnaldi (see also his agentic-coding reference repo `accountability`)
- **Tim Smart** — platform/HttpApi/Cluster core ("Second revision of HTTP API", `effect-genserver`) — https://github.com/tim-smart
- **Maxwell Brown (IMax153)** — maintainer, docgen, Effect Days workshops — https://github.com/IMax153
- **Sebastian Lorenz (fubhy)** — core team, v4 RC announcement author — https://x.com/thefubhy
- **Johannes Schickling** — Prisma founder, Effect DX/docs/Effect Days MC — https://x.com/schickling
- **Kit Langton** — Anomaly; Cause & Effect podcast; v4 migration skills; `doctor-effect` — https://github.com/kitlangton
- **Lucas Barake** — video educator (HttpApi, Schema v4 crash course, "Effect in 5(ish)") — https://www.youtube.com/@effect-ts
- **Mattia Manzati** — Effect AI SDK, tracing talks — https://github.com/msmfa
- **Ethan Niser** — community content, `effect-distributed-lock` — https://github.com/ethanniser
- **Harry Solovay** — "Demystifying Effect Scopes", Crosshatch (x402 on Effect) — https://github.com/harrysolovay
- **Dillon Mulroy** — SvelteKit+Effect, "Effect, the Good Parts" (w/ swyx) — https://github.com/dmmulroy
- **Sandro Maglione** — courses/blog, v4 migration write-ups — https://www.sandromaglione.com
- **John De Goes / Ziverge** — first official Effect Adoption Partner (Jul 2026), trainings — https://ziverge.com
- **Orgs**: Effectful (effectful.co), Effect Institute (launched Jan 2026, TWiE #100), Effect-TS org (26 repos) — https://github.com/Effect-TS
- **Projects to watch**: `Effect-TS/examples` + `create-effect-app` (official templates), `xi-effect/xi.auth` (Effect user-services backend), `kndwin/effect-auth`, `nr1brolyfan/effect-auth`, `kitlangton/effect-better-auth-example` (★20, the canonical "better-auth + Effect" integration example)
- **Community**: Discord discord.gg/effect-ts (6k members Jan 2026, TWiE #101); This Week in Effect (weekly); meetups Milan/Paris/Berlin/Vienna/NYC/SF/Miami; **Effect Days 2026 — Dec 9–11, Italy** (tickets live)
- **Peter Steinberger** — builds with Effect (Birdclaw), high-signal community voice — https://github.com/steipete
- **Dax Raad** — OpenCode adopted Effect (TWiE #108); Effect Miami speaker — https://github.com/thdxr
- **David Khourshid** — "Effective State Machines for Complex Logic" (Effect Days) — https://github.com/davidkpiano
- **Tom MacWright** — Val Town engineer; independent adopter/skeptic write-ups — https://macwright.com/

## Recommended defaults for effect-auth

1. **Target `effect@^3.22` for v1**; run a nightly CI job against `effect@rc` (v4) from day one; read the v4 `MIGRATION.md` now and avoid constructs it deprecates (deep `Runtime` use, removed experimental modules). Public API should stick to stable v3 modules + `Effect.Service`/`LayerMap`; never leak "Unstable" HttpApi internals beyond the HttpApi contract itself.
2. **Fix the PRD's API fiction**: `Context.Service` does not exist. Use `Effect.Service<PasswordService>()("@effect-auth/password/PasswordService", {...})` classes with `.Default` layers; `Context.Reference` only where an overridable default is the feature.
3. **Plugin contributions**: declarative metadata (id, deps, capabilities, apiVersion, api, schema IR, migrations, hooks, events) + raw `Layer`s for services; compiler validates metadata, layers stay opaque; one merged, memoized `AuthLayer` via `Layer.mergeAll` + `ManagedRuntime`.
4. **Single tiny top-level type**: `Layer<CompiledAuth, PluginCompileError>`; the facade is the compiled `HttpApi` (clients + server handlers derived from it) — no type-level mega-merges.
5. **Naming**: tags `"@effect-auth/<plugin>/<Service>"`; reserve `@effect-auth/*` for first-party; capability strings live in their own registry.
6. **Events**: bounded `Mailbox`/`PubSub` + isolated observer fibers (never fail auth), `auth_audit` table as record of record; durable outbox deferred.
7. **Config**: Schema-validated plain objects at `Auth.make`; secrets only as `Config.redacted`/`Redacted` sourced inside layers; redaction enforced by type.
8. **Observability**: core-enforced `auth.<op>` spans + metric set; `@effect/opentelemetry` optional layer; contract tests forbid unredacted sensitive attributes.
9. **Errors**: per-domain `Schema.TaggedError` extending `AuthError`; status + user-facing message declared once on the error; internal detail only in `cause`.
10. **Testing**: `@effect/vitest` + `TestClock` for expiry; HTTP tests via HttpApi-as-web-handler with injected fetch; `FastCheck` + Schema arbitraries for property tests; `@effect-auth/test` = `TestAuth.layer` + in-memory repos + fake capabilities.
11. **Performance**: one `ManagedRuntime`, memoized layers, principal via `HttpApiMiddleware`-provided service (typed requirement, not `FiberRef`), `LayerMap` for the multi-tenant seam (verified available since effect 3.14); fixed benchmark scenarios in CI.
12. **Rename before launch**: `@effect-auth/core` and `@effect-auth/cli` are taken on npm (alpha, possibly abandoned but published) — pick a free scope now (PRD already flags this).

## Open questions for the user

1. **Effect version strategy at v1**: (a) v3-only, migrate after v4 stable; (b) dual-track v3 + v4-RC from the start via a compatibility layer; (c) wait ~1–2 quarters and ship v1 on v4 stable (targeted Q3/Q4 2026). This decides the entire HttpApi surface (v4's HttpApi consolidates into `effect/unstable/httpapi` with streaming + `HttpApiTest`).
2. **HttpApi "Unstable" risk**: (a) adopt HttpApi directly and pin versions tightly; (b) adopt HttpApi but wrap it behind `@effect-auth/http` so a future rewrite is contained; (c) build on lower-level `HttpRouter`/`HttpLayerRouter` and treat HttpApi as optional. (The PRD's ADR-003 assumes (a)/(b).)
3. **Package namespace**: `@effect-auth/*` is taken — (a) negotiate/take over the abandoned `@effect-auth` scope; (b) rebrand (e.g. `@authed/*`, `@authfx/*`); (c) ship under `@effectful-auth/*`-style scope. Affects every doc example, so decide before MVP.
4. **Multi-tenancy seam**: build `LayerMap`-keyed tenant resources into v1 now (small surface: `TenantLayerMap` capability), or ship single-tenant and add the seam in v1.1? (PRD §33 leaves it open.)
5. **Event durability**: in-process only at v1 (PubSub/Mailbox + audit table), or make the SQL-backed outbox (`SqlPersistedQueue`) a first-party plugin at v1?

## Sources

- npm registry: https://registry.npmjs.org/effect/latest , https://registry.npmjs.org/@effect%2Fplatform/latest , https://registry.npmjs.org/@effect%2Fsql/latest , https://registry.npmjs.org/@effect%2Fvitest/latest , https://registry.npmjs.org/@effect%2Fopentelemetry/latest , https://registry.npmjs.org/@effect%2Fplatform-deno/latest , https://registry.npmjs.org/-/package/effect/dist-tags , https://registry.npmjs.org/@effect-auth%2Fcore , https://registry.npmjs.org/@kndwin%2Feffect-auth , https://registry.npmjs.org/@effect%2Frpc/latest , https://registry.npmjs.org/@effect%2Fcluster/latest
- Type declarations (unpkg): https://unpkg.com/effect@3.22.2/dist/dts/Context.d.ts , https://unpkg.com/effect@3.22.2/dist/dts/Effect.d.ts , https://unpkg.com/effect@3.22.2/dist/dts/Layer.d.ts , https://unpkg.com/effect@3.22.2/dist/dts/LayerMap.d.ts , https://unpkg.com/effect@3.22.2/dist/dts/Schema.d.ts , https://unpkg.com/@effect/platform@0.97.2/dist/dts/FileSystem.d.ts
- Effect docs (v3): https://effect.website/docs/v3/onboarding , https://effect.website/docs/v3/requirements-management/services , https://effect.website/docs/v3/requirements-management/layers , https://effect.website/docs/v3/requirements-management/layer-memoization , https://effect.website/docs/v3/concurrency/pubsub , https://effect.website/docs/v3/testing/testclock , https://effect.website/docs/v3/configuration , https://effect.website/docs/v3/data-types/redacted , https://effect.website/docs/v3/schema/arbitrary , https://effect.website/docs/v3/observability/tracing , https://effect.website/docs/v3/micro/effect-users , https://effect.website/docs/v3/platform/introduction , https://effect.website/docs/v3/error-management/yieldable-errors , https://www.effect.website/docs/v3/api/platform/HttpApi
- Awesome lists: https://github.com/m9tdev/awesome-effect , https://github.com/betalyra/awesome-effect-ts , https://github.com/tcmlabs/awesome-effect-ts
- Talks: https://www.youtube.com/watch?v=7jOD5okJC00 (Advanced Effect Workshop) , https://www.youtube.com/watch?v=S2GChOwivwQ (Matt Pocock on Effect)
- HttpApi reference documentation: https://github.com/Effect-TS/effect/blob/v3/packages/platform/README.md
- Blog/announcements: https://effect.website/blog , https://effect.website/blog/releases/effect/40-beta , https://effect.website/blog/releases/effect/40-rc , https://effect.website/blog/this-week-in-effect/106 … /131 (TWiE index), https://effect.website/blog/effect-v4-rc-august-recap , https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive
- v4 migration: https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
- Coverage & community: https://www.infoq.com/news/2026/04/effect-v4-beta/ , https://www.devtools.fm/episode/149 , https://github.com/Effect-TS/effect , https://github.com/Effect-TS/examples , https://github.com/mikearnaldi/accountability , https://github.com/Effect-TS/tsgo , https://discord.gg/effect-ts , https://www.youtube.com/@effect-ts , https://www.youtube.com/playlist?list=PLDf3uQLaK2B_0hEiHT82cv-DotrtD6Bhi
- Prior art: https://github.com/kitlangton/effect-better-auth-example , https://github.com/davidlbowman/cloudflare-effect-better-auth , https://github.com/chroxify/effect-cf-workers , https://github.com/brandhaug/b2b-saas-starter , https://github.com/xi-effect/xi.auth , https://github.com/kndwin/effect-auth , https://github.com/nr1brolyfan/effect-auth (404 as of 2026-09-12; npm package live)
- Adopter posts: https://tech.spiko.io/posts/why-we-chose-effect/ , https://macwright.com/2026/03/18/effect-devlog , https://www.sandromaglione.com/newsletter/my-effect-v4-beta-migrations , https://ybogomolov.me/01-effect-intro , https://tweag.io/blog/2024-11-07-typescript-effect/
- Book: https://effectorientedprogramming.com/
