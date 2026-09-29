# Authoring a plugin

Every plugin in this repo (`password`, `admin`, `organization`, ...) follows the same conventions. They used to live only in file header comments; this guide is the one place they are written down, and [`examples/plugin-template/`](../examples/plugin-template/) is the working code it points at. The template has a test suite that runs with `pnpm test`, so what follows cannot silently drift from what builds.

To start a plugin: copy `examples/plugin-template/`, rename `Notes` / `notes_note` / `TemplateApi`, and keep reading.

## The shape of a plugin

A plugin is a class extending `AuthPlugin.Service` (ADR-EA-008) plus the pieces it contributes (ADR-EA-001):

| Piece              | Template file                                         | Rule                                                                                                                         |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Contract           | `TemplateApi.ts`                                      | One `HttpApiGroup` whose id is the plugin id, wrapped in `HttpApi.make("auth")`.                                             |
| Config             | `Template.ts` (`NotesConfig`)                         | A `Context.Reference` with a default plus a `config(partial)` layer (ADR-EA-011). Policy knobs are never a required service. |
| Persistence        | `Template.ts` (`NoteRecords`, `layerSql`)             | The plugin owns its tables; the table prefix is the plugin id.                                                               |
| Migrations         | `Template.ts` (`notesMigrations`)                     | Append-only, dialect-branched with `sql.onDialectOrElse`.                                                                    |
| Hooks              | `Template.ts` (`BeforeCreateNote`, `AfterCreateNote`) | One veto (before) and one observe (after) point per mutating operation.                                                      |
| Service + handlers | `Template.ts` (`Notes`, `NotesHandlers`)              | `AuthPlugin.layer(Notes, { handlers, make })`.                                                                               |

`Auth.make([Notes])` composes the plugin into one `api`, one `layer` and a manifest (BEH-EA-009 to 016); the template's first test shows it.

## Contract

- Endpoint errors are `Schema.TaggedError`s with an `httpApiStatus`; anything a client should match on is one of them. Do not make a client parse a message.
- Wire DTOs are plain strings and numbers (`createdAt` is an ISO string), never a domain object.
- Behind a session, declare `.middleware(Api.Authentication)` on the group, then `.middleware(Api.CsrfProtection)` last. The last-declared middleware runs first, so a forged request is rejected before any credential work.
- A veto hook can abort an endpoint, so list `HookPoint.HookAborted` in that endpoint's `error` array.
- Non-members and unknown resources must be indistinguishable: answer `404` for both, and reserve `403` for a caller who is a member but lacks the permission (BEH-EA-147).

## Dependencies: `dependsOn` versus a direct `yield*`

Core domain services (`Sessions`, `Users`, `AuthEvents`, `AuditLog`) and the plugin's own records are simply `yield*`ed inside `make`; nothing is declared. Declare `dependsOn: [OtherPlugin]` only when your plugin needs _another plugin's_ contribution to be composed first (it also orders migrations and makes `Auth.make` refuse cycles, BEH-EA-016). `admin/src/Admin.ts` explains why it needs no `dependsOn` despite using three core services. If your plugin also reads a table another plugin owns, list it in `readsTables` on `AuthPlugin.Service`; `Auth.make` then refuses the composition unless that plugin is in `dependsOn` (JH-007). Order the plugin tuple dependencies-first (`Auth.make([Password, TwoFactor])`): a dependent listed before its dependency does not type-check (JH-006). A plugin's layer may only _require_ ports (`PasswordHasher`, `Mailer`, ...), never provide one (JH-008), and two plugins overriding one slot fail the composed layer with `SlotConflict` (MA-005).

## Ports are required, never provided (ADR-EA-010)

A plugin that needs a mailer, a crypto source, a rate limiter or a transaction boundary declares it in its layer's requirements and never builds one. The application provides the implementation. The template requires `Crypto` and `SqlClient` and provides neither. Inside a records service, do not reach into another plugin's tables.

## Hooks

- `HookPoint.veto` taps can amend the input or abort with `new HookPoint.HookAbort({ code })`; `observe` taps run afterwards and a failing observer can never fail the operation (BEH-EA-089 to 093).
- Translate a veto abort where the point is run, into the typed `HookAborted` naming the point (BEH-EA-090). The template's `veto` helper is five lines; copy it.
- The tap registry lives in the point's own built layer, so it is **per composition** (ELC-001), and it **freezes at the first run of a point** in that composition (BEH-EA-024). A tap layer built after its point has already run fails with `HookPointFrozen`; two compositions built from one module never share taps.
- A tap's layer **requires its point**: `Point.tap(...)` is a `Layer<never, never, Point>`, so tapping a point nobody provides fails to compile (BEH-EA-094). Provide the point to the tap in the same layer graph: `Tap.pipe(Layer.provideMerge(NotesHooksLive))`.
- A plugin can declare its taps statically with `AuthPlugin.layer(Self, { taps: [Point.declareTap(handler, { order })] })`. They run in dependency order, then `order`, then plugin id (BEH-EA-091), `Auth.make(...).manifest.hooks` prints that order without building anything (BEH-EA-096), and the point requirements join the plugin layer's `RIn`.
- Tap outputs are checked against the point's schema (a veto tap's amended value, a divert tap's diverted value); observe taps run sequentially in resolved order, so keep them cheap.
- Provide each point's own `.layer` once; `NotesHooksLive` merges them.

## Declaring ports and rate limits

Two facts about a plugin are read by tooling without building its layer, so the plugin **declares** them (PV-241):

- **`ports`.** `AuthPlugin.layer(Self, { ports: [Mailer.Mailer, RateLimiter.RateLimiter], ... })` lists the port classes (`@awthaq/ports`) the layer requires. They join the layer's `RIn` like `dependsOn`, and the compiler checks the list is complete: a service whose key is `.../ports/...` that `make`, the handlers or `contributes` require but `ports` omits fails to type-check, naming the missing key. `awthaq plugin list --graph` prints them (`Manifest.ports`). Core services, effect's own (`Crypto`, `SqlClient`) and your own records need no entry.
- **`rateLimits`.** `AuthPlugin.Service(id, { rateLimits: [{ group, endpoint, name, dimension, limit, window }] })` declares each rule's defaults; `group` is confined to your contract's groups at compile time (BEH-EA-107). Register from the same declaration with `RateLimits.registerDeclared(Self, { key })` (or keep a rule table and build the declaration with `AuthPlugin.declareRateLimits(groups, rules)`), and add a test asserting `RateLimits.declarationDrift(Self, registered)` is empty so the list `awthaq plugin list --rules` prints (`Manifest.rateLimits`) cannot drift from what is enforced. Config-tuned numbers are the defaults there.

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
- Install both with `AuthPlugin.layer(Self, { contributes: Layer.mergeAll(erasure, export) })`. Test each against the registry (`packages/organization/test/OrganizationErasure.test.ts`, `OrganizationExport.test.ts`).

## Migrations

- Append only. Never edit a migration that has shipped; add a new entry (BEH-EA-033 to 040). Names are re-keyed per plugin by `Auth.make`.
- Dialect-branch with `sql.onDialectOrElse({ pg, sqlite, orElse })` where a type differs; use `Effect.die` in `orElse` for an unsupported dialect.
- Use single-word lowercase column names, or quote consistently in **every** statement (DDL, queries, trigger bodies): Postgres folds unquoted identifiers to lowercase, so an unquoted camelCase column returns a lower-cased key that no row schema matches. All shipped plugins quote their camelCase columns; SQLite is indifferent.
- Row codecs follow the client's dialect: `@effect/sql-pg` returns `boolean`/`Date`, `node:sqlite` returns `0 | 1`/ISO strings. Build a store's row schemas from `Models.dialectFields(yield* Models.resolveDialect(sql))` (`@awthaq/sql`) instead of `Schema.DateTimeUtcFromString`/`BooleanFromBit`.
- Test with the real thing: `Migrations.run(Plugin.migrations)` against a database from `packages/sql/test/support/TestSql.ts` (`TestSql.layer("<suite>")`: `:memory:` SQLite by default, a real per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`/`pnpm run test:pg`), never a hand-written `CREATE TABLE`. Plugin migrations run in their own ledger table (`Migrations.pluginMigrationsTable`), separate from core's.
- A statement that touches a tenant-scoped table must filter by the tenant key; see `packages/organization/test/TenantScoping.test.ts` for a static guard you can copy.

## Multi-statement writes

An operation that is several SQL statements runs in one `sql.withTransaction` so it is all-or-nothing, even when called directly. Composing two records services stays the domain service's job (BEH-EA-035); take the `SqlTransaction` port there.

## House rules

- No type assertions in library source: no `as`, `as unknown as`, `as any`. Use `Schema` decoding, `Brand.nominal` for witnesses, or a typed helper.
- No return-type annotations on `Effect`/`Layer` consts; let inference infer. (Annotating an _interface method_ type, as `NotesShape` does, is the contract and is fine.)
- A plugin's own tests run against the built `lib`; run `pnpm build` (or `tsc -b`) before `pnpm test` after changing a dependency package.

## Checklist for a new plugin

1. `AuthPlugin.Service` with `apiVersion`, `contract`, `tables`, `migrations` (and `dependsOn` only if needed), `rateLimits` when it throttles, and `ports` on `AuthPlugin.layer` for every port it requires.
2. Errors typed and status-mapped; `HookAborted` on every vetoable endpoint.
3. Config as a `Context.Reference` with a default.
4. Records service with `layerMemory` and `layerSql` (the template ships only `layerSql`; production plugins ship both).
5. Hook points with a `.layer` each, provided once.
6. A test that builds through `Auth.make`, runs the real migrations, exercises an endpoint over a real handler, aborts a veto, and calls `TestAuth.runPluginContractTests`.
7. A package README stating what it ships (`pnpm check:readmes` enforces the status banner).
