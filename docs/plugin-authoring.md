# Authoring a plugin

Every plugin in this repo (`password`, `admin`, `organization`, ...) follows the same conventions. They used to live only in file header comments; this guide is the one place they are written down, and [`examples/plugin-template/`](../examples/plugin-template/) is the working code it points at. The template has a test suite that runs with `pnpm test`, so what follows cannot silently drift from what builds.

To start a plugin: copy `examples/plugin-template/`, rename `Notes` / `notes_note` / `TemplateApi`, and keep reading.

## The shape of a plugin

A plugin is a class extending `AuthPlugin.Service` (ADR-EA-008) plus the pieces it contributes (ADR-EA-001):

| Piece              | Template file                                         | Rule                                                                                                                         |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Contract           | `TemplateApi.ts`                                      | One `HttpApiGroup` whose id is the plugin id, wrapped in `HttpApi.make("auth")`.                                             |
| Config             | `Template.ts` (`NotesConfig`)                         | A `Context.Reference` with a default plus a `config(partial)` layer (ADR-EA-011). Policy knobs are never a required service. |
| Persistence        | `Template.ts` (`NoteRecords`, `layerMemory`, `layerSql`) | The plugin owns its tables; the table prefix is the plugin id. Record stores are keyed `<pkg>/records/<Name>` and declared as `records: { memory, sql }` on `AuthPlugin.Service` (compile-checked: complete, matched, records only), below. Tenancy, sealed columns and store failures come from `@awthaq/sql` (`TenantScoped`, `SealedColumn`, `StoreFailure`). |
| Migrations         | `Template.ts` (`notesMigrations`)                     | Append-only, dialect-branched with `sql.onDialectOrElse`.                                                                    |
| Hooks              | `Template.ts` (`BeforeCreateNote`, `AfterCreateNote`) | One veto (before) and one observe (after) point per mutating operation.                                                      |
| Hook points        | `Template.ts` (`NotesHooksLive`)                      | The merged default layers of the points the plugin owns, declared as `hookPoints` on `AuthPlugin.Service`.                   |
| Service + handlers | `Template.ts` (`Notes`, `NotesHandlers`)              | `AuthPlugin.layer(Notes, { handlers, make })`.                                                                               |

`Auth.make([Notes])` composes the plugin into one `api`, one `layer` and a manifest (BEH-EA-009 to 016); the template's first test shows it.

## Contract

- Endpoint errors are `Schema.TaggedError`s with an `httpApiStatus`; anything a client should match on is one of them. Do not make a client parse a message.
- Wire DTOs are plain strings and numbers (`createdAt` is an ISO string), never a domain object.
- Behind a session, declare `.middleware(Api.Authentication)` on the group, then `.middleware(Api.CsrfProtection)` last. The last-declared middleware runs first, so a forged request is rejected before any credential work.
- A veto hook can abort an endpoint, so list `HookPoint.HookAborted` in that endpoint's `error` array.
- A records module never turns a database failure into a defect. Pipe each method through `StoreFailure.orStoreUnavailable("<Records>.<method>")` (or `Effect.catchTag("SqlError", StoreFailure.storeUnavailable(op))` beside a domain outcome of its own, and `StoreFailure.orConflict` for a unique violation) so it fails with the typed `StoreUnavailable`, and list `Api.StoreUnavailable` in the `error` array of any endpoint outside `Api.Authentication`'s own list (a public group). A `SchemaError`, and a statement the database refused as malformed or unauthorised, stay defects (ADR-EA-028).
- Non-members and unknown resources must be indistinguishable: answer `404` for both, and reserve `403` for a caller who is a member but lacks the permission (BEH-EA-147).

## Dependencies: `dependsOn` versus a direct `yield*`

Core domain services (`Sessions`, `Users`, `AuthEvents`, `AuditLog`) and the plugin's own records are simply `yield*`ed inside `make`; nothing is declared. Declare `dependsOn: [OtherPlugin]` only when your plugin needs _another plugin's_ contribution to be composed first (it also orders migrations and makes `Auth.make` refuse cycles, BEH-EA-016). `admin/src/Admin.ts` explains why it needs no `dependsOn` despite using three core services. If your plugin also reads a table another plugin owns, list it in `readsTables` on `AuthPlugin.Service`; `Auth.make` then refuses the composition unless that plugin is in `dependsOn` (JH-007). Order the plugin tuple dependencies-first (`Auth.make([Password, TwoFactor])`): a dependent listed before its dependency does not type-check (JH-006). A plugin's layer may only _require_ ports (`PasswordHasher`, `Mailer`, ...), never provide one (JH-008), and two plugins overriding one slot fail the composed layer with `SlotConflict` (MA-005).

## Exposing a system interface (ADR-EA-040)

When a plugin has trusted callers (another plugin, a job, application code), it does not let them write its tables. It exposes a **system interface** beside its own service: a `Context.Service` keyed `awthaq/plugin/<id>/<Name>` whose methods take an explicit actor (who acted, for audit and hook taps) and never an `Api.UserPrincipal`. The interface owns its invariants, its veto and observe points, its events and its transaction, so every caller gets them. The plugin's own service then shrinks to the authorized layer: who may call what.

```ts
static readonly layer = AuthPlugin.layer(Notes, {
  exposes: { services: [NoteVault], layer: NoteVaultLive }, // keys must be awthaq/plugin/notes/...
  make: Effect.gen(function* () {
    const vault = yield* NoteVault; // `make` may require what the plugin exposes
    // ...
  }),
});
```

The compiler checks that every exposed key is in the plugin's own namespace and listed in `services` (so two plugins can never expose one tag). A dependent plugin requires the service with a plain `yield*` and lists the exposer in `dependsOn`; `Auth.make` discharges the requirement through its fold and refuses a dependent that omits `dependsOn`. Bind the exposed layer to a `const` (or build it with `Layer.mergeAll`): an inline single `Layer.succeed(Tag, ...)` does not infer. `awthaq plugin list --graph` prints each plugin's `exposes:`. A plugin still never provides a port.

## Ports are required, never provided (ADR-EA-010)

A plugin that needs a mailer, a crypto source, a rate limiter or a transaction boundary declares it in its layer's requirements and never builds one. The application provides the implementation. The template requires `Crypto` and `SqlClient` and provides neither. Inside a records service, do not reach into another plugin's tables.

## Hooks

- `HookPoint.veto` taps can amend the input or abort with `new HookPoint.HookAbort({ code })`; `observe` taps run afterwards (inside a transaction: after it commits, and not at all if it rolls back, ADR-EA-037) and a failing observer can never fail the operation (BEH-EA-089 to 093).
- Translate a veto abort where the point is run, into the typed `HookAborted` naming the point (BEH-EA-090). Use `HookPoint.aborted(Point)(point.run(...))`, which does exactly that and is what the core plugins and the template call.
- The tap registry lives in the point's own built layer, so it is **per composition** (ELC-001), and it **freezes at the first run of a point** in that composition (BEH-EA-024). A tap layer built after its point has already run fails with `HookPointFrozen`; two compositions built from one module never share taps.
- A tap's layer **requires its point**: `Point.tap(...)` is a `Layer<never, never, Point>`, so tapping a point nobody provides fails to compile (BEH-EA-094). Provide the point to the tap in the same layer graph: `Tap.pipe(Layer.provideMerge(NotesHooksLive))`.
- A plugin can declare its taps statically with `AuthPlugin.layer(Self, { taps: [Point.declareTap(handler, { order })] })`. They run in dependency order, then `order`, then plugin id (BEH-EA-091), `Auth.make(...).manifest.hooks` prints that order without building anything (BEH-EA-096), and the point requirements join the plugin layer's `RIn`.
- Tap outputs are checked against the point's schema (a veto tap's amended value, a divert tap's diverted value); observe taps run sequentially in resolved order, so keep them cheap.
- Provide each point's own `.layer` once; `NotesHooksLive` merges them.

## Declaring ports and rate limits

Two facts about a plugin are read by tooling without building its layer, so the plugin **declares** them (PV-241):

- **`ports`.** `AuthPlugin.layer(Self, { ports: [Mailer.Mailer, RateLimiter.RateLimiter], ... })` lists the port classes (`@awthaq/ports`) the layer requires. They join the layer's `RIn` like `dependsOn`, and the compiler checks the list is complete: a service whose key is `.../ports/...` that `make`, the handlers or `contributes` require but `ports` omits fails to type-check, naming the missing key. `awthaq plugin list --graph` prints them (`Manifest.ports`). Core services, effect's own (`Crypto`, `SqlClient`) and your own records need no entry.
- **`rateLimitRules`.** A plugin that throttles declares its rules once, as a typed table, and spends them by name (BEH-EA-105 to 111):

  ```ts
  const rules = {
    signInByIp: RateLimits.rule({ group: "notes", endpoint: "create", key: RateLimits.Key.ip, limit: 30, window: Duration.minutes(15) }),
    signIn: RateLimits.rule({ group: "notes", endpoint: "create", key: RateLimits.Key.email, limit: 5, window: Duration.minutes(15) }),
    lockout: RateLimits.failureRule({ group: "notes", endpoint: "create", key: RateLimits.Key.user, limit: 5, window: Duration.minutes(15), bucket: "notes.lockout" }),
  };
  // AuthPlugin.Service(id, { rateLimitRules: rules, ... })
  // make: const limits = yield* RateLimits.budget(Self, { tune, emailKey });
  yield* limits.spend(["signInByIp", "signIn"], input); // names and input shape are checked by the compiler
  yield* limits.guard("lockout", { userId });           // a failure budget (BCR-006): refuse before evaluating...
  yield* limits.charge("lockout", { userId });          // ...and charge only the failures
  ```

  - `group` is confined to your contract's groups at compile time (BEH-EA-107), `spend` accepts only the table's own attempts-rules and `guard`/`charge` only its failure-rules, and each name demands the input its key reads. `RateLimits.Key.*` are the key strategies (`ip`, `email`, `identifier`, `user`, `session`, `client`, `phone`, `custom`); the handler resolves the IP and the principal and passes `{ ip }` or `{ userId }` in, so the bucket never reads the ambient request. `Key.email` normalises with the one shared `Key.emailKey` (trim, lower-case, strip `+tag`), and `Key.custom(dimension, schema, part)` is the explicit opt-in to a key of your own (BEH-EA-108).
  - The static `rateLimits` listing `awthaq plugin list --rules` prints (`Manifest.rateLimits`, with each rule's key strategy and mode) is **derived from that same table**, and `budget` registers it: there is no second list to keep in agreement and no drift test to write. `AuthPlugin.layer` refuses at build a plugin that declares rules but never opens its budget (`RateLimitBudgetNotOpened`), and `budget` takes a narrow owner with no `layer` member, so `RateLimits.budget(Self)` inside `Self`'s own `layer` needs no type annotation.
  - A breach is published (`auth.rateLimit.exceeded`, never carrying the key), logged, counted and answered with `Api.RateLimited` (EOTS-007): declare it in the endpoint's `error` list. Handlers outside `make` and credential contributions read the opened handle with `RateLimits.budgetOf(Self)`; a group-wide rule (`endpoint: "*"`) reports the endpoint you pass in `spend(..., { endpoint })`.
  - Tune in `make` with `budget(Self, { tune })` (an `Effect` of per-rule `{ limit, window, escalation }`, evaluated on every call so a tenant's config in force applies, EP-007). An application tunes or escalates any shipped rule without touching the plugin: `RateLimits.overrides(RateLimits.tune(Password, { signIn: { limit: 3 } }))`.
  - Add `RateLimiter.RateLimiter` to `ports`: a budget consumes through it.

## Contributing a credential type

A plugin that authenticates callers a session cannot represent (an API key, a service token, a SCIM directory token) does not add a scheme to `Api.Authentication`. It contributes to `@awthaq/server`'s credential-resolver registry, an aggregating registry (ADR-EA-012):

```ts
Authentication.contribute("apiKey", {                       // or "bearer" for an `Authorization: Bearer` credential
  id: "my-plugin.token",
  claims: (raw) => raw.startsWith("mp_"),                   // a cheap shape check, never a verification
  resolve: (credential) => /* Effect<Api.Principal, Api.Unauthenticated, HttpServerRequest> */,
});
```

The first contribution whose `claims` matches resolves the credential (and a claimed credential that fails is `Unauthenticated`; later contributions are not tried), so make `claims` narrow: a key prefix, or a JOSE `typ` read with `JwtCodec.peekTyp`. Build the resolving `Layer` inside the plugin's own layer (it needs the registry, so the composition provides `Authentication.CredentialResolversLive` below it). Resolve to the principal kind that fits (`ApiKeyPrincipal`, `ServicePrincipal`, or a `User` for a stateless session), carrying its own `scopes`; qadi's default subject resolver maps them to permissions. Declare `Api.MachineAuthentication` on groups meant for such callers: `Api.Authentication` is the user tier and only admits a `User`. `@awthaq/api-key` is the worked example.
## Personal data: erasure and export

A plugin that stores anything about a person must take part in account erasure and in the data-subject export; both are aggregating registries in core that the plugin's own layer contributes to, so leaving the registry out of a composition does not compile (ADR-EA-031, BEH-EA-095, BEH-EA-254).

- `Erasure.contribute({ id, make })`: `make` resolves your record stores once and returns `(subject) => Effect<void>` that deletes the subject's rows. It runs inside `AccountErasure.eraseAccount`'s one transaction; a failure rolls the whole erasure back, so let it die rather than swallow it, and keep it idempotent. There is no database cascade (the schema has no foreign keys), so every table keyed by a user id needs one.
- `DataExport.contribute({ id, make })`: `make` returns `(subject) => Effect<Json>`, the personal data you hold, keyed by your plugin id in the export document. Never include a secret (a hash, a token, key material) or a third party's data; a contribution that fails fails the whole export.
- A plugin never deletes a user. To remove an account it calls `Erasure.AccountErasure.eraseAccount(userId, initiator)` (`@awthaq/scim`'s `DELETE` with `deleteBehavior: "erase"` is the worked example, with a `Directory` initiator); to abandon a user it is creating (a provisioning that failed halfway) it uses `Users.createWith(input, complete)`, which removes only the user it just made, with no veto and no event. `Users` has no `delete`.
- `Retention.contribute({ id, make })`: if your plugin owns a table whose rows expire or end (grants, challenges, delivery logs, revoked tokens), do not prune inside a request. `make` resolves your record stores and your own retention window (your config, not core's) once and returns `(now) => Effect<number>`: delete the rows past it and answer how many. `Retention.sweep` (or the opt-in `Retention.layerScheduled`) runs it after the core purges; a contribution that fails is logged and does not stop the others. Leave out credentials and audit-relevant state that has no safe deletion point.
- Install them with `AuthPlugin.layer(Self, { contributes: Layer.mergeAll(erasure, export, retention) })`. Test each against the registry (`packages/organization/test/OrganizationErasure.test.ts`, `OrganizationExport.test.ts`).

## Events

Events are identifiers-only (ADR-EA-029) and declared in `@awthaq/core`'s `AuthEventSchemas.ts` with `defineEvent(tag, fields, { actor, pii })`. Name the tag `auth.<plugin>.<pastTense>`. Brand user ids with the module's `UserIdSchema`. Choose the actor: `Actor.field("<userId field>")` for the user who *did* it (an administrator, not the target), `Actor.none` when no user acted (a directory, the CLI, an anonymous attempt), or `Actor.prefixed`. List every free-text field about a person in `pii` (never an email; carry an id and let subscribers join). Add the event to the registry list, add a sample to `test/support/eventSamples.ts` (the compiler asks for it), and publish with `AuthEvents.publish`. Add `attempt: true` to the declaration for an event that records an *attempt* (a failed sign-in or second factor, a replay, a denial): it is recorded and delivered after the surrounding transaction ends, committed or not. Leave it off for a state change: its audit row joins the transaction and its live-subscriber copy is released only if the transaction commits (see "Units of work" below). Until plugins own their events (plan 09 phase 5), a third-party plugin cannot add a tag: reuse an existing one, or contribute the definition to core.

## Migrations

- Append only. Never edit a migration that has shipped; add a new entry (BEH-EA-033 to 040). Names are re-keyed per plugin by `Auth.make`.
- Dialect-branch with `sql.onDialectOrElse({ pg, sqlite, orElse })` where a type differs; use `Effect.die` in `orElse` for an unsupported dialect.
- Use single-word lowercase column names, or quote consistently in **every** statement (DDL, queries, trigger bodies): Postgres folds unquoted identifiers to lowercase, so an unquoted camelCase column returns a lower-cased key that no row schema matches. All shipped plugins quote their camelCase columns; SQLite is indifferent.
- Row codecs follow the client's dialect: `@effect/sql-pg` returns `boolean`/`Date`, `node:sqlite` returns `0 | 1`/ISO strings. Build a store's row schemas from `Models.dialectFields(yield* Models.resolveDialect(sql))` (`@awthaq/sql`) instead of `Schema.DateTimeUtcFromString`/`BooleanFromBit`.
- Test with the real thing: `Migrations.run(Plugin.migrations)` against a database from `TestSql` (`import { TestSql } from "@awthaq/test"`; `TestSql.layer("<suite>")`: `:memory:` SQLite by default, a real per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`/`pnpm run test:pg`), never a hand-written `CREATE TABLE`. Plugin migrations run in their own ledger table (`Migrations.pluginMigrationsTable`), separate from core's.

## Tenancy: declare each table, filter in the store

Every table a plugin owns declares how it relates to the tenant (ADR-EA-018 decision 10), in `tables` on `AuthPlugin.Service`; a table without a declaration does not compile, and `Auth.make` validates the declarations and exposes them as `auth.tenancy`:

| Kind                                  | Use it when                                                                  | The store                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AuthPlugin.Table.partitioned(col?)`  | rows belong to the tenant that wrote them (the template's `notes_note`)       | stamps the ambient tenant at insert (`TenantScoped.stamp`), confines every read and write to it |
| `AuthPlugin.Table.keyed(col)`         | the organization id is the row's own key (`organization_*`, `saml_*`, `scim_*`) | every method takes the organization id; there is no ambient predicate                           |
| `AuthPlugin.Table.derived(parent, via)` | the row has no tenant column and is reached through a parent                 | scoped through the parent; the method takes a parent key the caller already resolved            |
| `AuthPlugin.Table.global(reason)`     | deliberately tenant-blind (the reason is reviewed and printed by `awthaq plugin list`) | none                                                                                 |

- Filter in the store, not the service: `TenantScoped.predicate(sql, "tenantId", seen)` (`= $1` or `IS NULL`, never `IS NOT DISTINCT FROM`) in SQL and `TenantScoped.matches(row, seen)` in memory, with `seen = yield* TenantScoped.visibility()`. Both adapters share one rule, so one suite proves them.
- A method that must see more than the ambient tenant (an erasure sweep, a platform listing, a lookup by a capability that arrives before any tenant is known) takes a `TenantScoped.CrossTenant` witness as its first argument, minted by `TenantScoped.crossTenant("<why it is sound>")` next to the call. On Postgres with RLS on, the SQL adapter runs that statement under `TenantScoped.lift(grant)` (or `liftOn(sql, grant)`), which lifts the policy for that one statement; `Tenant.withoutTenant` alone does not.
- Prove it with `TestAuth.runTenantIsolationTests` (`@awthaq/test`): one call per records interface, over `layerMemory` and `layerSql`, with `rls: { layer }` so `pnpm run test:pg` also checks the database backstop. Its `methods` map is keyed by `keyof Shape`, so a method added without a classification (`scoped`, `crossTenant`, `keyed`, `derived`, `insert`) does not compile. `examples/plugin-template/test/Template.test.ts` is the worked call.
- Opt-in row-level security covers the declarations when the operator asks: `TenantScope.enableRls({ plugins: auth.tenancy })` (`packages/sql/README.md`).

## Sealed columns

A column that must be decryptable (a client secret, a signing key, a TOTP secret) is a `SealedColumn` (ADR-EA-019 decision 6), declared once and never encrypted by hand:

- Declare it: `SealedColumn.column({ table, column, key, legacyAad? })`. The AAD is `<table>:<rowKey>:<column>`; list an older spelling in `legacyAad` and it still opens and re-seals canonically. Build one `SealedColumn.codec(column, swap)` per adapter (`sqlSwap(column)` in SQL, a `Ref`-backed swap in memory), so the memory adapter seals too.
- The records accept the plaintext as a `Redacted` and hand out a `Sealed<A>` whose `open` effect is the only place the plaintext appears; domain code never sees an envelope or an AAD. A stale key or a legacy envelope is re-sealed on read by compare-and-swap.
- `open` fails with the typed `SealedColumn/Unreadable`; each call site picks exactly one treatment: `SealedColumn.orDie` (fail closed, for a value the operation cannot proceed without) or `SealedColumn.option` (degrade one value with a warning).
- Prove it with `TestAuth.runSealedColumnTests` (one call per column and adapter: envelope at rest, round trip, moved ciphertext, key rotation, legacy AAD). `SealedColumn.sweep` re-seals the rows nobody reads again; running it is the operator's job.

### Operator runbook: sweeping sealed columns (legacy-AAD sunset preparation)

A `legacyAad` entry and `adoptPlaintext` stay in the code until a later release deletes them (ADR-EA-019 decision 6; `.scratch` ticket "legacy-aad-sunset"). Nothing deletes them yet; this is how an operator gets a deployment ready.

1. List every sealed column the deployment runs (each plugin's `SealedColumn.column` declarations, plus the core token and PII columns your composition enables).
2. Run `SealedColumn.sweepAll([...columns])` as a one-off job against the production database, with the production `Encryption` and `SqlClient` (it is never run by a request). It pages each column by its key, re-seals every stale-key or legacy-AAD value by compare-and-swap (a concurrent writer always wins), and answers one report per column: `{ table, column, scanned, resealed, legacy, unreadable }`. It also logs one Info line per column with the same counts (ids and counts only, never a value).
3. Read the reports. `legacy` counts the values re-sealed because only a legacy AAD opened them. `unreadable` values (tampered, or under a retired key) are never touched: investigate them, they will not heal.
4. Run `sweepAll` again. Every column must now report `legacy: 0`. While a deployment reads with `resealOnRead: false`, any read of a legacy value logs a warning (ids only) and the value stays legacy until a sweep.
5. A deployment is ready for the legacy read to be deleted only when step 4 holds on it. Keep the `legacyAad` entries until the release that removes them; they are what keeps unswept rows readable.

## Multi-statement writes

An operation that is several SQL statements runs in one transaction so it is all-or-nothing, even when called directly. Open it with `SqlTransaction.transactional(sql)(effect)` (or the `SqlTransaction` port's `withTransaction`, which is the same thing); never call `sql.withTransaction` directly, `pnpm check:transactions` fails the build. Composing two records services stays the domain service's job (BEH-EA-035); take the `SqlTransaction` port there.

A token a person presents: `Verification.redeem({ identifier, value, use, onFailure })` when it authorises a state change (it owns the transaction, the miss record and the give-back of a failed `use`; settle a refusal that should spend the token with `onFailure: Verification.commitUnlessUnavailable`); `Verification.consume` only when spending it is the point (OAuth/SAML request state, an exchange code). Never call `consume` for a token that authorises a state change, enforce rate limits before `redeem` rather than inside `use`, and never recover from a constraint violation inside `use` (use an `ON CONFLICT` form): on Postgres it poisons the transaction (ADR-EA-039).

## Units of work: what may happen inside a transaction (ADR-EA-037)

A transaction opened through `SqlTransaction` is a **unit of work** with two lanes. `AuthEvents.publish` and `HookPoint.observe` already use them, so ordinary plugin code needs nothing: publish a state-change event inside the transaction and live subscribers hear it only if the transaction commits; publish an attempt event (declared `attempt: true`) and it is recorded either way.

If your own code has work that must follow the same rule, use the lanes directly, from `@awthaq/ports`:

- `SqlTransaction.onCommit(effect)`: runs `effect` after the *outermost* enclosing unit commits, and never if it rolls back. For a reaction to a change (invalidate a cache, notify a host).
- `SqlTransaction.afterUnit(effect)`: runs `effect` after the outermost unit ends, committed or not, outside any transaction (a write made there commits by itself). For a fact about an attempt that must survive a rollback.
- Outside any unit (no transaction, `SqlTransaction.layerNoop`, a memory composition) both run immediately.
- A nested `transactional` is a savepoint: its `onCommit` work is dropped if the savepoint rolls back; its `afterUnit` work always reaches the parent. Both lanes take an `Effect<void>` with no error and no requirements, so handle or `orDie` errors inside, and capture any per-request context the work needs before deferring it.
- A host that opens its own raw `sql.withTransaction` around awthaq calls is not covered: use `SqlTransaction.transactional(sql)`.

## Completing a sign-in and creating a user (ADR-EA-038)

Resolve core's two modules once, in your plugin's `make`, and let them own the sequence; never hand-write it.

- **Sign-in.** `const signIn = yield* SignIn.make`, then `signIn.complete({ userId, strategy, amr }, request)` once your credential is proven: it applies the user lookup, the suspension gate, `BeforeSignIn`, the `BeforeSessionIssue` divert, mints the session, publishes `auth.user.signedIn` and runs `AfterSignIn`. Use `clear` then `issue` when you must do something between the veto and the mint (device authorization consumes its grant there). Map `SignIn/UserGone` to your flow's own uniform refusal. A flow that a second factor can finish later passes a `continuation` and hands the divert's handoff to `SignIn.resume`.
- **Sign-up.** `const signUp = yield* SignUp.make`, then `signUp.vet({ identity, name, strategy })` (this runs `BeforeSignUp`, so call it before any expensive work) and `create`, `createWith` or `createSignedIn` with the `Vetted` it returned: they create, mark verified, link your credential and run your own `within` work as one unit, answer every collision as `SignUp/IdentityTaken` (map it to your wire answer), and publish `auth.user.created` and run `AfterSignUp` only after the unit commits. List `SqlTransaction.SqlTransaction` among your `ports`.
- **Never** call `Sessions.issue` for a proven credential or `Users.create` for a sign-up. The compiler refuses a session or a user without a `Clearance` or a `Vetted`, and `core/test/SignInSeams.test.ts` fails on a new caller. Operator imports (`UserImport.importUser`, `awthaq seed admin`) are the named exemption.

### Answering the request with the session

An HTTP handler that mints a session answers through `SessionDelivery.respond(request, mint)` (from `@awthaq/server`): it validates `X-Awthaq-Token-Delivery` first (an unknown value is `InvalidTokenDelivery` and `mint` never runs), runs `mint`, then delivers the session as a cookie (the default) or a bearer `token` in the body with `Cache-Control: no-store`. Keep the result in a local typed `SessionContract.SessionDto` so declaration emit can name it (TS2883). Never call `SessionCookie.set` or write a body token yourself; only an endpoint that mints no session (a concealed sign-up) calls `SessionDelivery.mode`, and `server/test/SessionDelivery.seam.test.ts` fails on any other direct call. The address and user agent a session records come from the `ClientAddress` port and the request in `mint`; the host's opt-in `RequestContext.layer` fills the ambient `AuthRequestContext` for everything else (`AuthHttp.coreHandlers` warns at build when it is missing).

## Record stores and bundles

A record store is a `Context.Service` whose key has a `/records/` segment (`example/notes/records/NoteRecords`, `awthaq/scim/records/ScimRecords`), the same convention that marks a port (`/ports/`). It is what lets the compiler ask "does the plugin provide every store its layer requires?". The plugin declares its stores once, as two matched layers, on `AuthPlugin.Service`:

```ts
export class Notes extends AuthPlugin.Service<Notes, NotesShape>()("notes", {
  // ...
  records: { memory: layerMemory, sql: layerSql }, // both adapters behind one shape
  hookPoints: NotesHooksLive,                       // the points this plugin owns
}) {}
```

`Notes.records.memory` and `Notes.records.sql` are static members: a host picks one the way it picks a database, and `TestAuth.layer` selects one per composition. Three mistakes fail to compile, each naming the offending key:

- **A missing store.** `AuthPlugin.layer` refuses a layer that requires a `/records/` store neither the plugin's own bundle nor a `dependsOn` plugin's bundle provides (`declare these record stores in AuthPlugin.Service's records`). A store another plugin owns comes from its bundle through `dependsOn`.
- **A mismatched pair.** `memory` and `sql` must provide the same stores (`sql provides stores memory does not`, and the reverse).
- **A bundle that is not only records.** A port, a derived service or a config in a bundle is refused (`a records bundle provides only /records/ stores`). A test-only seam a layer also provides (a `MemoryEnvelopes` tag) is projected out of the bundle: `Layer.effect(Store, Effect.service(Store)).pipe(Layer.provide(layerMemory))`.

A hook point the plugin's layer requires and no one declares (`hookPoints`, or core's own) fails the same way (`declare these hook points`). Declaring them does not make `Auth.make` provide them in production (the host still builds the one point instance its taps register into); it lets a harness provide them once, and `awthaq plugin list` print them. A store with only derived consumers (a service always built over the plugin's own stores, like `SamlConnectionStore`) is absorbed into the plugin layer instead: `AuthPlugin.layer(...).pipe(Layer.provideMerge(derived))` keeps it in the output.

## Testing a plugin

`TestAuth.layer(Auth.make([...]), options)` (`@awthaq/test`, dev-only) is the whole pipeline over memory: it derives the host middleware the composed groups declare (`Authentication`, `CsrfProtection`, ...), selects every composed plugin's `records` bundle and `hookPoints`, and provides the core services, the test ports (a cheap argon2id hasher, `Mailer.layerMemory`, a permissive `RateLimiter`, `Encryption` over a fixed key) and the redaction guard. Its `RIn` is `never` exactly when the composition is complete.

```ts
const app = TestAuth.app(
  TestAuth.layer(Auth.make([Notes]), {
    services: Notes.config({ maxLength: 20 }), // what is genuinely the test's own
    taps: ForbiddenTap,                        // application taps, on the same point instances the plugins run
  }),
);
const cookie = (await app.signIn("a@example.com")).cookieHeader;
const response = await app.request("POST", "/notes", { cookie, json: { text: "hi" } }); // CSRF pair included
```

- `services` holds only plugin configuration, adapters (`XmlSignature`, `WebAuthn`, `TestAuth.httpClient.*`, a fake fetcher) and test doubles: never a core store, a record layer or host middleware. It is merged into the output, so a service only `services` provides is `yield*`-able and a capturing `Mailer` given there is the instance the plugin sends through. `decorate` wraps a base service in place (an outage, a spy) for the plugins and the test alike; `taps` takes application taps.
- `records: "sql", suite: "<name>"` runs the same composition over a migrated database (SQLite `:memory:`; a per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`, `pnpm run test:pg`). Run a suite in both modes with `for (const records of TestAuth.recordModes)`.
- `TestAuth.app` serves the composition and reads its context through one memo map (`run`), so the handler and the test share instances; `request` adds the double-submit CSRF pair, minted from the composition's own `CsrfConfig`.
- Hand-wire only what is under test (the middleware's own suites, a store suite built over `TestAuth.memoryFoundation`): a header comment says so (`// Hand-wired on purpose: ...`).
- Every plugin class has a call to `TestAuth.runPluginContractTests` in its package's `test/Contract.test.ts`; `pnpm check:contract-tests` (part of `pnpm check`) fails otherwise. `host` defaults to the plugin's `dependsOn` closure, the contract suite checks that `records.memory` and `records.sql` build and provide the same stores, and `build: { services }` additionally builds the composition over both modes.

## House rules

- No type assertions in library source: no `as`, `as unknown as`, `as any`. Use `Schema` decoding, `Brand.nominal` for witnesses, or a typed helper.
- No return-type annotations on `Effect`/`Layer` consts; let inference infer. (Annotating an _interface method_ type, as `NotesShape` does, is the contract and is fine.)
- A plugin's own tests run against the built `lib`; run `pnpm build` (or `tsc -b`) before `pnpm test` after changing a dependency package.

## Checklist for a new plugin

1. `AuthPlugin.Service` with `apiVersion`, `contract`, `tables`, `migrations` (and `dependsOn` only if needed), `rateLimitRules` when it throttles (and `RateLimits.budget(Self)` in `make`), and `ports` on `AuthPlugin.layer` for every port it requires.
2. Errors typed and status-mapped; `HookAborted` on every vetoable endpoint.
3. Config as a `Context.Reference` with a default.
4. Record stores keyed `<pkg>/records/<Name>`, each with `layerMemory` and `layerSql` (the template ships both), every method failing with `StoreUnavailable`, never a defect, declared as `records: { memory, sql }` on `AuthPlugin.Service` (the compiler rejects a missing or mismatched bundle).
5. Hook points with a `.layer` each, merged into one layer declared as `hookPoints`.
6. `test/Contract.test.ts` calls `TestAuth.runPluginContractTests` for every plugin class in the package (`pnpm check:contract-tests` enforces it; pass `hooks: [{ point: Hooks.AfterSignUp, input }]` to run the plugin's declared taps against a stub input: an observe tap must not try to abort, a veto tap may only abort with `HookAbort`; BEH-EA-200), plus a suite built with `TestAuth.layer` that runs the real migrations, exercises an endpoint over a real handler, aborts a veto, and runs in both `TestAuth.recordModes`.
7. A package README stating what it ships (`pnpm check:readmes` enforces the status banner).
8. A flow that signs a person in or creates a user goes through `SignIn`/`SignUp`, never `Sessions.issue`/`Users.create` (ADR-EA-038).
9. Every event declared with `defineEvent`, its actor chosen and its free-text fields in `pii`.
10. Every table's tenancy declared, its records filtered through `TenantScoped`, and `TestAuth.runTenantIsolationTests` (and `runSealedColumnTests` for each sealed column) run over both adapters.
