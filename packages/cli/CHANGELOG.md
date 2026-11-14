# @awthaq/cli

## 0.2.0

### Minor Changes

- 1be1af1: `awthaq seed admin` sets a password through the application's Password plugin (its exposed `PasswordCredential`, ADR-EA-048): the password must pass `Password.config`'s policy (minimum length, breach screening) before anything is written, and a refusal is a usage error (exit 2) carrying the policy's hints. A password over an account that already has one now replaces it instead of being silently dropped, and `auth.password.changed` is published when a password is set. The CLI's own 12-character minimum (`MIN_PASSWORD_LENGTH`) is removed.
  
  Migration: an application without the Password plugin can still seed an account, but not with a password (`ApplicationUnavailable`, exit 9). An operator script that relied on a re-run leaving an existing password alone should omit the password. A seeded password now reaches the breach-check provider unless the application sets `Password.config({ breachCheck: false })`.
- 90feda3: Windows credential backend: `awthaq login` keeps its token as a DPAPI blob (`%APPDATA%\awthaq\credential.dpapi`) protected through PowerShell, with the secret on stdin and never argv. A Windows without PowerShell still falls back to the 0600 file with the warning.
- 3514b28: The OAuth 2.0 device authorization grant (RFC 8628) ships as `@awthaq/device-authorization`, and `awthaq login` uses it (DAG-002, DAG-004, DAG-005; BEH-EA-299 to BEH-EA-307).
  
  - `@awthaq/device-authorization`: `POST /device/code` and `POST /device/token` (the polling states `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, at-most-once redemption), `POST /device/verify` / `approve` / `deny` for the page a signed-in user approves on, public clients from configuration or an operator's `registerClient`, hashed user and device codes, per-address, per-session and per-client rate limits, a `BeforeDeviceApproval` veto, erasure and export contributions, and `purgeExpired`. The minted session is an ordinary bearer session carrying the approving session's `amr`. Tables `device_authorization_grant` and `device_authorization_client` (append-only migrations); Postgres-tested.
  - `@awthaq/cli`: `awthaq login` without a token runs the device flow (a code and URL on stderr, a browser opened unless `--no-browser`, polling with +5 seconds on every `slow_down`); `--client-id` names the client (default `awthaq-cli`, which the plugin registers by default). A server without the plugin exits 9 naming it; a denied or expired request exits 8. `--token` and `AWTHAQ_TOKEN` are unchanged.
  - `@awthaq/core`: two audit events, `auth.deviceAuthorization.approved` and `.denied`.
  - `@awthaq/two-factor`: the session gate no longer diverts an `amr` that already records `mfa` (only this plugin's own completed challenge writes it), so a device approved from a session that proved a second factor is not asked again.
  - `@awthaq/api`: `Api.BackChannel`, an annotation for credential-in-the-request endpoints called by non-browser clients (`apikey.token`, the device `code`/`token` pair): they deliberately carry no `CsrfProtection`, and `awthaq doctor` no longer flags them as unprotected mutating endpoints (`@awthaq/api-key` annotates its token group).
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- 273f910: `AuthPlugin.layer` takes an `exposes` option (ADR-EA-040, BEH-EA-329): a plugin may expose namespaced domain services (`awthaq/plugin/<id>/<name>`) beside its own service, so trusted callers reach its invariants through an interface of their own instead of its records. The exposed services join the layer's `ROut`, `Auth.make`'s fold discharges a dependent's requirement on them, and `Validate<P>` refuses a dependent that requires one without listing the exposer in `dependsOn`. `Manifest.exposes` lists them and `awthaq plugin list --graph` prints an `exposes:` line; `AuthPlugin.Class` gains the static `exposes`.
  
  Migration: additive. A hand-built `Manifest` value (a test fixture) gains `exposes: []`; a `GraphNode` consumer sees a new `exposes` array.
- 40c84f1: Plugins declare the events they publish, and `Auth.make` composes them (ADR-EA-049). `AuthPlugin.Service(id, { events })` takes the plugin's event definitions (each made with `EventDefinition.define`), read statically like `userFields`. `Auth.make` composes core's definitions with every composed plugin's into `auth.events` (an `EventDefinition.Registry` typed by the tuple: `Auth.EventsOf<P>`), lists them in `manifest.events` (tag, owner, actor, personal-data fields, attempt), provides them through `auth.eventsLayer` (`AuthEvents.EventRegistry`), and refuses a tag declared twice, core's included, or the reserved `"awthaq.foreignEvent"`, with `Auth/EventTagConflict` naming both owners. `AuthEvents.typed(auth.events)` gives the composition-typed `is`, `subscribe` and `on(tag, handler)`. `AuthHost.layer` provides `auth.eventsLayer` (so `TestAuth.layer` does), and `TestAuth.layer` sets `AuthEvents.UndeclaredEventPolicy` to `"die"`. `awthaq plugin list --events` prints `manifest.events` (text or JSON); config loading and `awthaq doctor` report `Auth/EventTagConflict`, `UndeclaredTableDependency`, `Auth/TenancyDeclarationInvalid`, `Auth/SealedColumnDeclarationInvalid`, `Auth/MigrationDeclarationInvalid` and `UserFieldConflict` as link problems with their code instead of a generic load failure.
  
  Migration: a host that composes without `AuthHost.layer` and serves webhooks, configures Retention rules for plugin tags, or relies on the undeclared-event check provides `auth.eventsLayer` last, like `auth.userFieldsLayer`. A hand-written `Auth.Manifest` gains `events`. ADR-EA-049, BEH-EA-101, BEH-EA-016.
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- b8fb23c: Requires `@qadi/core`, `@qadi/http` and `@qadi/react` `^0.8.0` (was `^0.7.0`).
  
  `@qadi/http` 0.8.0 answers the `RequirePermission` refusals with typed bodies instead of empty ones so a generated `HttpApiClient` can decode them: a 403 `AccessDenied` carries qadi's public denial view (`subjectId`, `policyTag`, `reason`; never the evaluation trace), a 403 `UndischargedObligation` its tag, a 502 resolver outage its tag plus at most one identifying attribute (never the cause or the resolver's own message); the wiring-mistake 500 stays empty. BEH-EA-157 / REQ-EA-440 (PV-230).
  
  Migration: bump the three `@qadi/*` dependencies to `^0.8.0` together; a host that asserted an empty 403 or 502 body from `RequirePermission` now sees the typed view.
- 38ca611: The pre-budget rate-limit path is removed (plan 06): every shipped plugin now declares a `rateLimitRules` table and spends it through `RateLimits.budget`.
  
  Migration:
  - Removed from `@awthaq/core`: `RateLimits.enforce`, `EnforceInput`, `EnforceMeta`, `RuleInput`, `RateLimitKey`, `registerDeclared`, `declarationDrift`/`DeclarationDrift`, `RateLimitsRegistry.register`, `AuthPlugin.declareRateLimits` and the `AuthPlugin.Service` option `rateLimits`. Declare rules with `rateLimitRules` and enforce with `RateLimits.budget(Self)` (`spend`, `guard`, `charge`); `docs/plugin-authoring.md` and `examples/plugin-template` show the shape. A plugin that declares rules and never opens its budget now fails at layer build (`RateLimitBudgetNotOpened`), and `spend`/`guard`/`charge` accept only declared names.
  - `RateLimitsRegistry.registered` rows change: `key` is now the key strategy name (`"ip"`, `"email"`, `"user"`, ...) rather than a function, and rows gain `name`, `dimension`, `mode` and `bucket` (all required); `order` is a required number. A test that called `entry.key(input)` reads the consumed bucket through `RateLimits.bucketKey(rule, input)` instead.
  - `RateLimitDeclaration` (and so `Manifest.rateLimits`) gains required `key` and `mode`.
  - `awthaq plugin list --rules` prints KEY and MODE columns, and its JSON rows carry `key` and `mode`.
  - Bucket keys are renamed to `ratelimit:<group>.<rule>:<strategy>:<value>` for every rule (see the per-plugin changesets for the old and new spellings). A deploy resets live counters once: rows in `RateLimiterStoreSql` expire within their window, at most one hour. Second-factor lockouts in progress are lifted (they last at most the 15-minute failure window).
- 64c4798: `awthaq doctor` warns about an endpoint whose last (outermost) middleware is not `RequestContext` (`request-context-missing`, ADR-EA-047): such a group compiles when nothing in it reads the request context, but its events and audit rows carry no correlation id, address or user agent.
  
  Migration: declare `.middleware(Api.RequestContext)` last on your own groups (`extraGroups`) to clear the warning.

### Patch Changes

- 09d61ca: README recipes point at `AuthHost.layer`: the CLI's `app` is the served composition with `migrations: "verify"` (a `seed admin` or `import` run never migrates behind `migration apply --yes`), the Next adapter's in-process handler serves an `AuthHost` layer, and the SQL package's "Two ledgers" note says `AuthHost` and `awthaq migration apply` run core then plugins through `Migrations.apply`, refusing a drifted ledger.
  
  Migration: none (documentation only).
- 1cef4be: `Auth.LinkError`, `Auth.linkErrorTags` and `Auth.isLinkError` name every error the composition path raises, and the CLI loader classifies with them instead of keeping its own list. `awthaq doctor` now reports an invalid user field, a conflicting `dependsOn`, an invalid sealed column and an endpoint with two session lifecycles as `link-<code>` findings. The last is a tagged `SessionLifecycle.Conflict` (was a plain `Error`).
  
  Migration: a script that matched exit 9 from `doctor` for these misconfigurations now sees exit 3 and a `link-<code>` finding; other commands still exit 9, with the error tag `LinkProblem` instead of `ConfigUnavailable`.
- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 6d23ed9: A store outage while reading or writing a password credential is `StoreUnavailable` (503) in `change-password`, `reauthenticate`, `confirm-reset` and the administrator's `setUserPassword`, and a retryable usage error (exit 2) in `awthaq seed admin`, instead of a 500 defect (ADR-EA-028). A `confirm-reset` that fails this way does not spend its token. A password credential unlinked between the read and the write now answers `WrongPassword` (`change-password`) or `TokenConsumed` (`confirm-reset`), and a `seed admin` that loses a race to link the password treats it as already linked.
  
  Migration: none (compatible). Alerting that keyed on 500s from these endpoints sees 503s instead.
- 6070f7f: `Migrations.status`, `apply`, `verify` and `onBuild` run core's and the composition's migrations with the ledger-drift refusal `awthaq migration apply` already had (BEH-EA-204, BEH-EA-039); new errors `Migrations/LedgerDrift`, `Migrations/Pending`, `Migrations/MigrationFailed`. `apply` calls no `Migrator` when nothing is pending; `verify` applies nothing and refuses a pending migration. The CLI now reads and writes the ledgers through them; its output and exit codes are unchanged.
  
  Migration: code that ran `Migrator.make({})({ loader: CoreMigrations.coreMigrations })` and then `Migrations.run(auth.migrations)` at boot should call `Migrations.apply(auth.migrations)` (or let `AuthHost` do it): the two-step form silently skips a plugin migration that sorts before an applied one. `Migration.inspect`, `diff`, `tableExists`, `pluginKnown`, `coreLedgerTable` and `pluginLedgerTable` are no longer exported from `@awthaq/cli`'s `Migration` module; use `Migrations.status`, `diff`, `tableExists`, `pluginKnown` and `coreMigrationsTable`/`pluginMigrationsTable` from `@awthaq/core`.
- 1a9b666: `seed admin`: a store outage while marking the seeded administrator's email verified is now the retryable usage error (exit 2, "the database is unavailable") like every other store failure of the command, instead of a defect (ADR-EA-028).
- 1cef4be: Test observation leaves the production ports (ADR-EA-054, BEH-EA-354).
  
  - `@awthaq/ports`: `MailerShape` and `SmsSenderShape` are `send` plus the optional `development` flag; `sent` is removed. `Mailer.layerMemory` and `SmsSender.layerMemory` are removed. `layerConsole` logs each message and no longer keeps it.
  - `@awthaq/test`: `TestMailbox` (`layer`, `Mailbox`, `secret`) records every mail and SMS; `Mailbox.mail.waitFor` waits for a matching message by subscription with a real-clock deadline, `refute` fails if one arrives within a window. `TestAuth.layer` provides it in place of `Mailer.layerMemory`; its output now also holds `SmsSender` and `TestMailbox.Mailbox`.
  - `@awthaq/cli`: the `mailer-development` finding names `layerNoop`, `layerConsole` or a test mailbox.
  
  Migration: a provider adapter drops `sent` (`Mailer.Mailer.of({ send })`; the same for `SmsSender`). A test that composed `Mailer.layerMemory` composes `TestMailbox.layer` from `@awthaq/test` (or `Mailer.layerNoop` when nothing is sent) and reads `TestMailbox.Mailbox` instead of `mailer.sent`: `waitFor({ to, template })` replaces a read after cooperative yields, `refute` replaces a "nothing was sent" read, `TestMailbox.secret(mail)` replaces unwrapping `data.token`. A double that only fails or never answers is `Layer.mock(Mailer.Mailer)({ send })`.
- e6c3620: A unit of work releases state-change events on commit and attempt events either way (ADR-EA-037, BEH-EA-321).
  
  - `@awthaq/ports`: `SqlTransaction.UnitOfWork`, `SqlTransaction.onCommit`, `SqlTransaction.afterUnit` and `SqlTransaction.transactional(sql)`. `SqlTransaction.layerSql` is built on `transactional`, so every transaction opened through the port buffers two lanes: `onCommit` work runs after the outermost unit commits (never on rollback), `afterUnit` work runs after it ends either way. With no transaction (or on `layerNoop`) both run immediately.
  - `@awthaq/core`: `AuthEvents.publish` writes a state-change event's audit row inside the transaction and releases its bus copy on commit; an attempt event (`defineEvent(..., { attempt: true })`: `auth.user.signInFailed`, `auth.token.replay`, `auth.twoFactor.challengeFailed`, `auth.twoFactor.locked`, `auth.rateLimit.exceeded`, `auth.admin.actionDenied`, `auth.admin.impersonationDenied`, `auth.authz.denied`, `auth.organization.permissionDenied`, `auth.deviceAuthorization.denied`) records its audit row and bus copy after the unit ends, committed or not. `AuthEvents.isAttemptEvent(tag)` is new. `HookPoint.observe` taps run after the enclosing unit commits and not at all if it rolls back. `Verification.consume`'s `deferMiss` option and `Verification.recordMiss` are removed: a miss is recorded through the `afterUnit` lane. Core's own raw `sql.withTransaction` calls (`Sessions.issue`, `Accounts.unlink`) now go through `transactional`.
  - `@awthaq/sql`: the per-request Postgres tenant transaction (`TenantScope.withTenant`) is a unit of work, so a failed tenanted request delivers no state-change event. `AuditLogRepository.insert` runs in a savepoint inside a transaction, so a failed audit write under the `"bestEffort"` policy no longer aborts the surrounding Postgres transaction.
  - `@awthaq/admin`, `@awthaq/cli`, `@awthaq/organization`, `@awthaq/qadi`, `@awthaq/two-factor`: raw `sql.withTransaction` replaced by `SqlTransaction.transactional(sql)`.
  - `@awthaq/password`: `confirmReset`, `verifyEmail` and `confirmEmailChange` drop the `TokenMissed`/`settleMiss` dance; a wrong second-factor code during `confirmReset` is now audited although the reset rolls back (BEH-EA-266).
  - `pnpm check:transactions` (part of `pnpm check`) fails on a bare `sql.withTransaction(` in `packages/*/src`.
  
  Migration: an `AuthEvents.on` handler or observe tap for an operation that runs in a transaction now runs after the commit, and not at all when the operation rolls back; failure and attempt events are now recorded even when the operation rolls back. `Verification.consume(identifier, value, { deferMiss })` becomes `consume(identifier, value)` and `Verification.recordMiss` is gone (a custom `Verification` implementation drops it). Host code that opens its own `sql.withTransaction` around awthaq calls should use `SqlTransaction.transactional(sql)` from `@awthaq/ports`. A custom `SqlTransaction` implementation is unchanged (`withTransaction` is still the whole interface); to give its transactions a unit of work, build it on `transactional`.
- Updated dependencies
- Updated dependencies [a95959c]
- Updated dependencies [89fb48c]
- Updated dependencies [f810dcd]
- Updated dependencies [a06b7c5]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [d7351b7]
- Updated dependencies [b97c8c2]
- Updated dependencies [9416e17]
- Updated dependencies [fe9dc94]
- Updated dependencies [2706762]
- Updated dependencies [50a23f8]
- Updated dependencies [6d23ed9]
- Updated dependencies [85c9e47]
- Updated dependencies [8dd72b6]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [2c3c400]
- Updated dependencies [9950d93]
- Updated dependencies [3514b28]
- Updated dependencies [349acb4]
- Updated dependencies [cb155d4]
- Updated dependencies [3b99770]
- Updated dependencies [14bc1bc]
- Updated dependencies [2dff755]
- Updated dependencies [f831b6c]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [6070f7f]
- Updated dependencies [e073887]
- Updated dependencies [a305c26]
- Updated dependencies [3917b38]
- Updated dependencies [81d4323]
- Updated dependencies [f4cf736]
- Updated dependencies
- Updated dependencies [2babe84]
- Updated dependencies [bc68e19]
- Updated dependencies [d286327]
- Updated dependencies [7f3f6bf]
- Updated dependencies [1cef4be]
- Updated dependencies [273f910]
- Updated dependencies [8eef209]
- Updated dependencies [5a3998d]
- Updated dependencies [8fda479]
- Updated dependencies [40c84f1]
- Updated dependencies [4f65d9e]
- Updated dependencies [6355450]
- Updated dependencies [fcdb168]
- Updated dependencies [f0f2f3e]
- Updated dependencies [2e56459]
- Updated dependencies [ef9846c]
- Updated dependencies [72a2e78]
- Updated dependencies [ae1175d]
- Updated dependencies [161d66c]
- Updated dependencies [d3a548f]
- Updated dependencies [93f2469]
- Updated dependencies [f005a91]
- Updated dependencies [75cc655]
- Updated dependencies [4379a62]
- Updated dependencies [9e6302f]
- Updated dependencies [4688890]
- Updated dependencies [77e05bd]
- Updated dependencies [3d00f58]
- Updated dependencies
- Updated dependencies [1cef4be]
- Updated dependencies [b8fb23c]
- Updated dependencies [38ca611]
- Updated dependencies [4d9fed1]
- Updated dependencies [e012560]
- Updated dependencies [bba890e]
- Updated dependencies [1371d7b]
- Updated dependencies [058aafe]
- Updated dependencies [c76f03c]
- Updated dependencies [6a28c4d]
- Updated dependencies [1c0d1a7]
- Updated dependencies [6f54095]
- Updated dependencies [6cebb31]
- Updated dependencies [d82b7a4]
- Updated dependencies [09ae967]
- Updated dependencies [28a78b0]
- Updated dependencies [0e74d59]
- Updated dependencies [36951f5]
- Updated dependencies [7e9834e]
- Updated dependencies [80c465c]
- Updated dependencies [01b82ea]
- Updated dependencies [5859d43]
- Updated dependencies [1a206af]
- Updated dependencies [1cef4be]
- Updated dependencies [401a719]
- Updated dependencies [a232d8e]
- Updated dependencies [fc20f74]
- Updated dependencies [2be1097]
- Updated dependencies [4cd6174]
- Updated dependencies [6a06f06]
- Updated dependencies [6d797b0]
- Updated dependencies [b0b6a4d]
- Updated dependencies [2f56ab5]
- Updated dependencies [5d5b3c6]
- Updated dependencies [f58b51f]
- Updated dependencies [0304c39]
- Updated dependencies [79909fa]
- Updated dependencies [e3cf8fe]
- Updated dependencies [896a1de]
- Updated dependencies [1c01e7f]
- Updated dependencies [942e1d8]
- Updated dependencies [2f1b966]
- Updated dependencies [b4ab289]
- Updated dependencies [2ab9920]
- Updated dependencies [b4b0de9]
- Updated dependencies [40a32a1]
- Updated dependencies [40a32a1]
- Updated dependencies [1cef4be]
- Updated dependencies
- Updated dependencies [e6c3620]
- Updated dependencies [37e5cdd]
- Updated dependencies [c0e7bd9]
- Updated dependencies [a25c52e]
- Updated dependencies [020abf8]
- Updated dependencies [9cdebdd]
  - @awthaq/password@0.2.0
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/client@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0
  - @awthaq/device-authorization@0.2.0
  - @awthaq/roles@0.2.0
  - @awthaq/migrate-better-auth@0.2.0
  - @awthaq/migrate-firebase@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/qadi@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
