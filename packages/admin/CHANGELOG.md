# @awthaq/admin

## 0.2.0

### Minor Changes

- Administrator account deletion and credential changes (`AdminAccounts`), and a mailed change-email flow in the password plugin.
  
  - `@awthaq/admin`: the opt-in `AdminAccounts` plugin (`Auth.make([Admin, AdminAccounts])`, group `admin.accounts`) adds `DELETE /admin/users/:userId` (the one `AccountErasure` cascade), `POST /admin/users/:userId/email` (mails a `change-email` token to the new address; the owner confirms) and `POST /admin/users/:userId/password` (through the `PasswordHasher` port, revoking every session), each behind its own fail-closed predicate (`canDeleteUsers`, `canManageCredentials`) with audited `auth.admin.*` events. `AdminConfig` gains those predicates, `passwordPolicy` and `links.changeEmail`; `@awthaq/ports` is now a dependency.
  - `@awthaq/password`: `POST /change-email` (authenticated) and `POST /change-email/confirm` (public), typed `EmailDeliveryFailed`/`EmailChangeNotSupported`, rate limits per requester, per target inbox and per token, `auth.user.emailChanged`, a notice to the previous address, `PasswordConfig.links.changeEmail`.
  - `@awthaq/core`: `EmailChange` (the shared `change-email` purpose) and the events `auth.user.emailChanged`, `auth.admin.userDeleted`, `auth.admin.userEmailChangeRequested`, `auth.admin.userPasswordSet` (a new `AuthEvent` union member).
  
  Migration: none required (all additive). A host that switches on `AdminAccounts` provides `PasswordHasher`, `Mailer` and `AccountErasure`, and the password plugin must be composed for an admin-requested email change to be confirmed. BEH-EA-221/222/224 (amended), BEH-EA-118.
- d0e8f8e: `AdminAccounts` lists `Password` in `dependsOn` (ADR-EA-048): an administrator-set password goes through `Password`'s exposed `PasswordCredential`, so it passes `Password.config`'s policy in force for the request's tenant (minimum length, breach screening with its `onUnavailable` posture, per-tenant overrides) before anything is written, and `AdminWeakPassword` may now carry `"appears in known breaches"`. The credential is replaced, or linked for a user who had none, inside the same transaction that revokes the user's sessions; `AdminAccounts` no longer requires the `PasswordHasher` port. `AdminConfig.passwordPolicy` is removed.
  
  Migration: compose `Auth.make([Admin, Password, AdminAccounts])` (a tuple without `Password` no longer compiles) and provide the `HttpClient` the breach check uses, or set `Password.config({ breachCheck: false })` to opt out of screening. Move a custom `passwordPolicy` to `Password.config({ minLength, breachCheck })`, per tenant if needed; an administrator-only extra rule is no longer supported. An administrator's password hash is now computed inside the transaction. A host whose layer type is emitted in a declaration file names `PasswordCredential.PasswordCredential` (TS2883 otherwise), as for any composition with `Password`.
- 79a2cce: `Admin.AdminConfig` (the `Context.Reference`) is no longer exported: the admin plugins read it only per operation, through their gate (ADR-EA-018 Decision 8, rev 1.5).
  
  Migration: provide configuration with `Admin.config({ … })` (build time: `Layer.provide`; per tenant: a `TenantConfig` lookup; per request: `Effect.provide(Admin.config({ … }))`), and read the effective configuration with `GET /admin/config` / `EffectiveConfig` (BEH-EA-229). `Admin.AdminConfigShape` and the gate input types are unchanged.
- 157b18d: Impersonation records are tenant-scoped by the store and cross-tenant access is a witness (plan 05).
  
  - `ImpersonationRecords`: `findBySessionId`, `endEpisode` and `list` take an optional `TenantScoped.CrossTenant` instead of `{ anyTenant: true }`; `closeExpired(grant, now)` and `verifyChain(grant)` are maintenance and take a witness, and their statements run under `TenantScoped.lift`, so they still see every tenant inside a request's Postgres RLS transaction. The SQL predicate is `"tenantId" = $1` / `IS NULL` (index-friendly) instead of `IS NOT DISTINCT FROM`; inserts stamp through `Tenant.stamp`.
  - Every records method fails with `StoreUnavailable` (503) instead of dying; `Admin.list` and `Admin.sweepExpired` widen accordingly.
  
  Migration: `ImpersonationRecords.TenantScope` is removed; replace `{ anyTenant: true }` with `TenantScoped.crossTenant("<why>")` (from `@awthaq/sql`), and pass a witness to `closeExpired` and `verifyChain`. A host that implements `ImpersonationRecordsShape` adopts the same signatures. BEH-EA-326/327.
- a95959c: `auth.admin.actionDenied` carries `targetUserId` or `organizationId` when the refused call named one, like `auth.admin.impersonationDenied` (IDS-006, BEH-EA-224).
  
  Migration: none for publishers (both fields are optional). A consumer that validates the event with a closed schema accepts the two optional keys.
- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 1cef4be: Migration: Admin, AdminAccounts and AdminTenants operations take CurrentUser.Caller; pass CurrentUser.of(principal) or yield* CurrentUser.current.
- 2c3c400: `CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.
  
  Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` -> `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- a5927c3: The organization row is a system module, `OrganizationDirectory` (`find`, `findActive`, `requireActive`, `isSlugAvailable`, `listForUser`, `listPage`, `create`, `update`, `delete`, `suspend`, `reinstate`), exposed by `Organization.layer` (ADR-EA-040). `create` writes the organization and its creator's membership in one transaction (a failed creation leaves neither) and the creator's membership now fires `AfterAddMember`. `suspend` and `reinstate` take a `PlatformAdminActor`, run the new `BeforeSuspendOrganization` / `AfterSuspendOrganization` and `BeforeReinstateOrganization` / `AfterReinstateOrganization` hook points, and still publish `auth.admin.organizationSuspended` / `organizationUnsuspended`. `AdminTenants` suspends, reinstates and lists through the Directory instead of writing `OrganizationRecords`, so a platform suspension is observable and `@awthaq/qadi`'s `DecisionCacheInvalidationLive` now clears a long-lived decision cache on suspension, reinstatement, a team move and a team-role change. The SAML and SCIM token and connection gates read `OrganizationDirectory.findActive` / `find`. `OrganizationQadi.relationships` reads the Directory.
  
  Migration: `AdminTenantsShape["suspendOrganization"]` and `["unsuspendOrganization"]` (and the `/admin/organizations/:id/suspend` and `/unsuspend` endpoints) can now answer `HookAborted` (`403`) when a `BeforeSuspendOrganization` / `BeforeReinstateOrganization` tap vetoes. `AdminTenants`, `SamlConnections.layerStore`, `Saml.layer` and `ScimAuthenticationLive` require the exposed `OrganizationDirectory` instead of `OrganizationRecords`. A host that installs `DecisionCacheInvalidationLive` must provide `OrganizationHooksLive` (as before) which now includes the four new points. `OrganizationLive` compositions are unchanged. The tenant middleware still reads `OrganizationRecords` directly (a raw read of a suspended organization is deliberate).
- Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.
  
  Migration:
  
  - `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-266, ADR-EA-020.
  - `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-271.
  - `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-258.
  - `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-259, BEH-EA-261.
  - `AdminAccounts.setUserPassword` now consults `Hooks.BeforeCredentialReset` (with no second-factor code) and can fail with `HookAborted` (403); for a user protected by `@awthaq/two-factor` an administrator can no longer silently replace the password. BEH-EA-259.
- f005a91: `@awthaq/admin` owns its events (ADR-EA-049): the nine definitions `auth.admin.{impersonationStarted, impersonationStopped, userUpdated, sessionRevoked, userBanned, userUnbanned, userDeleted, userEmailChangeRequested, userPasswordSet}` moved from `@awthaq/core` to `AdminEvents`, are declared on the plugins' `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. `Admin` declares six (`AdminEvents.events`) and `AdminAccounts`, composable without `Admin`, declares the three it publishes (`AdminEvents.accountsEvents`). `ImpersonationOwnerNotice` subscribes with `AuthEvents.on(AdminEvents.AdminImpersonationStartedEvent, …)`. A row these definitions write records `meta.pii: ["reason"]` for the impersonation and ban events; rows written before keep falling back to `AuditLog.PRE_ADR_049_PII`. `auth.admin.{impersonationDenied, actionDenied, seeded, seedRefused}` stay in core; `auth.admin.organization{Suspended, Unsuspended}` move with `@awthaq/organization`'s events.
  
  Migration: `AuthEvents.AdminImpersonationStartedEvent`, `AuthEvents.AdminImpersonationStoppedEvent`, `AuthEvents.AdminUserUpdatedEvent`, `AuthEvents.AdminSessionRevokedEvent`, `AuthEvents.AdminUserBannedEvent`, `AuthEvents.AdminUserUnbannedEvent`, `AuthEvents.AdminUserDeletedEvent`, `AuthEvents.AdminUserEmailChangeRequestedEvent` and `AuthEvents.AdminUserPasswordSetEvent` → `AdminEvents.<same name>` from `@awthaq/admin`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include these nine tags: subscribe with `AuthEvents.on(AdminEvents.AdminImpersonationStartedEvent, …)`, narrow the stream with `AuthEvents.is(AdminEvents.AdminImpersonationStartedEvent)`, decode an audit row with `AuditLog.payloadAs(AdminEvents.AdminImpersonationStartedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(AdminEvents.AdminImpersonationStartedEvent)(e)`. ADR-EA-049, BEH-EA-101.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- b8fb23c: Requires `@qadi/core`, `@qadi/http` and `@qadi/react` `^0.8.0` (was `^0.7.0`).
  
  `@qadi/http` 0.8.0 answers the `RequirePermission` refusals with typed bodies instead of empty ones so a generated `HttpApiClient` can decode them: a 403 `AccessDenied` carries qadi's public denial view (`subjectId`, `policyTag`, `reason`; never the evaluation trace), a 403 `UndischargedObligation` its tag, a 502 resolver outage its tag plus at most one identifying attribute (never the cause or the resolver's own message); the wiring-mistake 500 stays empty. BEH-EA-157 / REQ-EA-440 (PV-230).
  
  Migration: bump the three `@qadi/*` dependencies to `^0.8.0` together; a host that asserted an empty 403 or 502 body from `RequirePermission` now sees the typed view.
- 1911193: `Admin.records` is the plugin's impersonation store as one matched `{ memory, sql }` bundle, and the store's service key gains the `/records/` segment.
  
  - `ImpersonationRecords` is keyed `awthaq/admin/records/ImpersonationRecords`; the bundle provides it over memory and over SQL. `AdminAccounts` and `AdminTenants` own no stores (the latter reads organization state through `dependsOn`).
  
  Migration: code that built a `Context` by the old key string must use the class. A host replaces `ImpersonationRecords.layerMemory` / `ImpersonationRecords.layerSql` with `Admin.records.memory` / `Admin.records.sql`.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 0e74d59: The request context is required by core (ADR-EA-047). `Sessions.issue` takes no `request` and requires `Api.AuthRequestContext`, recording the facts of the request that minted the session (none under `noRequest`); `SignIn.clear`, `resume`, `issue`, `complete` and `failed` and `SignUp.createSignedIn` take no request facts and require it too; `SignIn.SessionRequest` is gone. `Admin.impersonate` requires it (the impersonation session records the administrator's request). `TestAuth.signInAs` provides it itself.
  
  Migration: drop `request` from `Sessions.issue` calls and the second argument of `SignIn.issue`/`complete` and the third of `SignUp.createSignedIn`; provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest` for a job, `RequestContext.capture(request)` on a host route, `TestAuth.withRequest`/`withoutRequest` in a test).
- 01b82ea: SCIM `DELETE /Users/:id` with `deleteBehavior: "erase"` now runs the account erasure (ADR-EA-031, BEH-EA-250): every plugin's rows (organization memberships and invitations, passkeys, roles, ...), linked accounts, sessions, verification tokens, the user and the audit pseudonymization, in one transaction, announced by `auth.user.deleted` with `deletedBy: "directory"`. It previously deleted only the user row and its sessions, leaving memberships (a taken seat), linked accounts (a SAML sign-in for the same NameID then failed) and the audit trail behind. `@awthaq/scim` also takes part in every erasure (`scimErasure`: the user's `scim_resource` rows) and in the data-subject export (`scimExport`), and adds a `scim_resource(kind, "resourceId")` index migration.
  
  Migration: `AccountErasure.eraseAccount(userId, options?)` is now `eraseAccount(userId, initiator)` with a required `Erasure.ErasureInitiator`: `{ deletedBy: "self" }` becomes `ErasureInitiator.Self()`, `{ deletedBy: "admin" }` becomes `ErasureInitiator.Admin({ adminUserId })`, and a call with no options (which meant "self") becomes `ErasureInitiator.Self()`. `auth.user.deleted.deletedBy` gains `"directory"` and optional `adminUserId`/`connectionId`/`organizationId`: an exhaustive switch on `deletedBy` needs a `"directory"` case. A composition of `Scim.layer` must now provide `Erasure.AccountErasure` (`Erasure.layer`; `AuthHttp` compositions already do). A SCIM `DELETE` racing another erasure of the same user now answers 404 instead of 204. Run the new SCIM migration.
- 401a719: Every endpoint that changes the caller's session declares it on the contract, and every credential change goes through `SessionDelivery` (ADR-EA-045, BEH-EA-343).
  
  - `@awthaq/server` implements the server half of the `SessionLifecycle` markers (`SessionLifecycle.layer`, re-exported as `AuthHttp.sessionLifecycle`; derived by `AuthHttp.middlewareFor`). A declared endpoint resolves `X-Awthaq-Token-Delivery` before its handler runs, answers `Cache-Control: no-store`, and dies `SessionLifecycleUnsettled` when a successful response neither delivered nor declined. `SessionDelivery.respond(mint)` takes no request; `mode` and `deliver` are gone; `redirect`, `deliverBearer`, `deliverExchanged`, `end`, `swapIn`, `swapOut` and `decline` cover the rest, each requiring the grant its marker provides. A bearer delivery names the token in `set-auth-token` too (a bearer `changePassword` no longer logs the client out everywhere); an ended session answers `x-awthaq-session-ended` and drops a rotation's `set-auth-token` (both exposed by `AuthHttp.cors`).
  - `@awthaq/api`: core's `session.signOut`/`revoke`/`revokeAll` and `account.deleteUser` declare `SessionLifecycle.Ends`.
  - `@awthaq/core`: `SessionCookie.set`/`expire`/`expireImpersonation` moved into `@awthaq/server` (behind `SessionDelivery`); `SessionCookie.baseOptions` is exported.
  - Plugins: `password` (`signUp`/`signIn` `Mints`, `changePassword` `Rotates`, `reauthenticate` `Refreshes`), `passkey` (`authenticateVerify` `Mints`, `reauthenticateVerify` `Refreshes`), `magic-link` (`magicLink.verify`, `emailOtp.verify`), `two-factor` (`verify`, `verifyRecovery`), `device-authorization` (`token`), `oauth` (`callback`, `exchange.token`), `saml` (`acs` `Mints`, `logout` `Ends`), `admin` (`impersonate`/`stopImpersonating`/`forceStop` `Swaps`: a bearer request answers `400` before anything is minted), `organization` (`setActive`, `setActiveTeam`, `leave`, `acceptInvitation` `Refreshes`). Their hand-written `InvalidTokenDelivery` error entries are gone (the marker declares it).
  
  Migration: add `.middleware(SessionLifecycle.<Kind>)` to your endpoint and drop `Api.InvalidTokenDelivery` from its errors; replace `SessionDelivery.respond(request, mint)` with `SessionDelivery.respond(mint)` and `SessionDelivery.mode(request)` (mint nothing) with `SessionDelivery.decline(SessionLifecycle.MintGrant)`; replace `SessionCookie.set`/`expire`/`expireImpersonation` with the `SessionDelivery` function for your declared kind. A composition that wires host middleware by hand provides `AuthHttp.sessionLifecycle`. Never write the session cookie yourself. ADR-EA-045, BEH-EA-343, BEH-EA-066.

### Patch Changes

- 9848e5e: `AdminAccounts` reads `AdminConfig` per operation, like `Admin` and `AdminTenants` (ADR-EA-018 Decision 8, BEH-EA-236): a tenant's `canDeleteUsers`, `canManageCredentials`, `passwordPolicy` and `links.changeEmail` now apply to that tenant's requests. Before, they were read once at layer build, so a tenant could not refuse a deletion or credential change the deployment-wide configuration allowed.
  
  Migration: a `TenantConfig` lookup that returns `Admin.config({ … })` for a tenant now also governs that tenant's `deleteUser`, `setUserEmail` and `setUserPassword`. `config(partial)` fills the fields it does not name with the deny-all defaults, so a lookup that names only `canManageUsers` turns deletion and credential administration off in that tenant, and resets its `passwordPolicy` and `links`. Name every capability the tenant keeps.
- b71a2a6: Every admin gate (user, ban, deletion, credentials, tenant administration, impersonation, episodes) is one internal module that reads the configuration in force, publishes the denial and loads the target only after the gate (BEH-EA-221, BEH-EA-236). No behavior change.
  
  Migration: none.
- d3609d2: The impersonation audit ledger never reports a break that is only a write in flight (plan 25, ALF-005, BEH-EA-215). `ImpersonationRecords.layerMemory` writes an episode row and its ledger link as one uninterruptible critical section (`create`, `endEpisode`, `closeExpired`), and `verifyChain` reads rows and ledger under the same lock, so a `verifyChain` racing a write no longer answers `row-unledgered`, and an interrupted write leaves both or neither. `layerSql`'s `verifyChain` now reads both tables in one transaction under the chain lock, so a writer committing between its two reads is no longer reported as `row-unledgered` or `row-missing`.
- 1cef4be: An in-process `limit` outside 1..200 on the impersonation listing and `AdminTenants.listOrganizations` is normalised (truncated, clamped, 50 when absent or non-finite) instead of answering an empty page or a store failure.
  
  Migration: none.
- 6d23ed9: A store outage while reading or writing a password credential is `StoreUnavailable` (503) in `change-password`, `reauthenticate`, `confirm-reset` and the administrator's `setUserPassword`, and a retryable usage error (exit 2) in `awthaq seed admin`, instead of a 500 defect (ADR-EA-028). A `confirm-reset` that fails this way does not spend its token. A password credential unlinked between the read and the write now answers `WrongPassword` (`change-password`) or `TokenConsumed` (`confirm-reset`), and a `seed admin` that loses a race to link the password treats it as already linked.
  
  Migration: none (compatible). Alerting that keyed on 500s from these endpoints sees 503s instead.
- 05c2ef7: The organization records are scoped by their organization key, a cross-organization method takes a witness, the client secret is a sealed column, and every store failure is `StoreUnavailable` (plan 05).
  
  - Every method that reads or writes across organizations takes a `TenantScoped.CrossTenant` as its first argument (`OrganizationRecords.listByIds/listPage/setSuspended`, `MembershipRecords.listByUser/deleteAllByUser`, `InvitationRecords.findById/findByTokenHash/listByEmail/listByInviter/countPendingByInviter/removeAllForUser`, `TeamRecords.findTeamByIdAnyOrg/removeUserFromAllTeams`, `ConnectionRecords.findByEmailDomain`, `ActiveContextRecords.deleteAllByUser`); its statement runs under `TenantScoped.lift`, so it still sees every organization inside a request's Postgres RLS transaction. `InvitationRecords.setTokenHash/updateStatus` and the connection-domain deletes now also filter by `organizationId`.
  - `ConnectionRecord.clientSecret` is `Option<SealedColumn.Sealed<string>>` (and `secretRevision` is the compare-only ciphertext fingerprint); `ConnectionInput`/`ConnectionPatch` take a `Redacted` secret. Secrets sealed under the old `organization-oauth-connection:` AAD still open and re-seal on read. `ConnectionRecords.layerMemory/layerSql` require `Encryption`; `OrganizationConnections` and its store no longer do.
  - The records modules, `OrganizationShape`, `OrganizationConnectionStore`, `AdminTenants` and the SAML/SCIM services fail with `StoreUnavailable` instead of dying; the tenant middleware answers it `503`; the SCIM bearer middleware and the SAML metadata/SSO endpoints declare it. `@awthaq/sql` adds `StoreFailure.orConflict` and `TenantScoped.liftOn`, and `orStoreUnavailable` accepts a `RETURNING` that returned no row (a defect).
  
  Migration: pass a witness (`TenantScoped.crossTenant("<why>")` from `@awthaq/sql`) to the methods above, and pass `organizationId` to `InvitationRecords.setTokenHash/updateStatus`; open a connection's secret with `SealedColumn.option(record.clientSecret.value.open)`; provide `Encryption` to `ConnectionRecords`; handle `StoreUnavailable` on the widened service methods. BEH-EA-284, BEH-EA-328.
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- 1cef4be: Built against `@qadi/core`, `@qadi/http` and `@qadi/react` 0.12 (the peer ranges move from `^0.11.0` to `^0.12.0`). `@awthaq/qadi`'s `ObligationHandlers.reauth` is an `ObligationHandler` of 0.12, so it takes the `{ question, decision }` discharge and reads `decision.obligations`; `onObligations: ObligationHandlers.reauth` is unchanged. `@awthaq/react` re-exports the new `useQuestions` hook (the devtools dock feed, `useDevtoolsFeed` and `runtimeLayer`, stays on `@qadi/react`).
  
  Migration: a host with an endpoint that declares neither `RequiredPermission` nor `publicEndpoint` (or that `RequirePermission` does not cover) now fails at startup, when `guardApi` is built, with `AccessNotDeclared` or `RequirePermissionNotAttached`, instead of serving a 500 per request: annotate the endpoint. A direct call `ObligationHandlers.reauth([...obligations])` becomes `ObligationHandlers.reauth({ question, decision })`; guard a Path B `HttpApi` with `guardApi(Api)` (replaces `RequirePermissionLive` and `registerApi`, provide `PermissionRegistryLive` once where the stack is composed) and see the `@qadi/http` 0.12 changelog for the rest.
- 28a78b0: Core reads the request context first (ADR-EA-047). `Sessions.issue` records the address and user agent of the request that minted the session from `Api.AuthRequestContext` (an explicit `request` field still wins until the plugins stop passing one), so admin impersonation sessions now record the administrator's address and user agent; a migrated legacy session keeps its own facts. The `ip` rate-limit strategy keys on the request context's address when the call passes none. `SignIn.failed` is the one publisher of `auth.user.signInFailed`, its `clientIp` read from the context. `TestAuth` gains `withRequest`, `withoutRequest`, a `clientAddress` option, `app(…, { request })` (`run` answers no request by default) and `signInAs({ request })`.
  
  Migration: `Sessions.MAX_USER_AGENT_LENGTH` becomes `Api.MAX_USER_AGENT_LENGTH`. A custom `RateLimits.Key.KeyContext` now carries `request` (`Api.AuthRequestContext.noRequest` when there is none).
- 5859d43: A store outage while minting the replacement session in `changePassword`, or the impersonation session in `Admin.impersonate`, is now the typed `StoreUnavailable` the Shape already declared instead of a defect (ADR-EA-028). OAuth answers a concurrent first login that linked the same provider identity as the one opaque callback failure instead of a defect.
- e6c3620: A unit of work releases state-change events on commit and attempt events either way (ADR-EA-037, BEH-EA-321).
  
  - `@awthaq/ports`: `SqlTransaction.UnitOfWork`, `SqlTransaction.onCommit`, `SqlTransaction.afterUnit` and `SqlTransaction.transactional(sql)`. `SqlTransaction.layerSql` is built on `transactional`, so every transaction opened through the port buffers two lanes: `onCommit` work runs after the outermost unit commits (never on rollback), `afterUnit` work runs after it ends either way. With no transaction (or on `layerNoop`) both run immediately.
  - `@awthaq/core`: `AuthEvents.publish` writes a state-change event's audit row inside the transaction and releases its bus copy on commit; an attempt event (`defineEvent(..., { attempt: true })`: `auth.user.signInFailed`, `auth.token.replay`, `auth.twoFactor.challengeFailed`, `auth.twoFactor.locked`, `auth.rateLimit.exceeded`, `auth.admin.actionDenied`, `auth.admin.impersonationDenied`, `auth.authz.denied`, `auth.organization.permissionDenied`, `auth.deviceAuthorization.denied`) records its audit row and bus copy after the unit ends, committed or not. `AuthEvents.isAttemptEvent(tag)` is new. `HookPoint.observe` taps run after the enclosing unit commits and not at all if it rolls back. `Verification.consume`'s `deferMiss` option and `Verification.recordMiss` are removed: a miss is recorded through the `afterUnit` lane. Core's own raw `sql.withTransaction` calls (`Sessions.issue`, `Accounts.unlink`) now go through `transactional`.
  - `@awthaq/sql`: the per-request Postgres tenant transaction (`TenantScope.withTenant`) is a unit of work, so a failed tenanted request delivers no state-change event. `AuditLogRepository.insert` runs in a savepoint inside a transaction, so a failed audit write under the `"bestEffort"` policy no longer aborts the surrounding Postgres transaction.
  - `@awthaq/admin`, `@awthaq/cli`, `@awthaq/organization`, `@awthaq/qadi`, `@awthaq/two-factor`: raw `sql.withTransaction` replaced by `SqlTransaction.transactional(sql)`.
  - `@awthaq/password`: `confirmReset`, `verifyEmail` and `confirmEmailChange` drop the `TokenMissed`/`settleMiss` dance; a wrong second-factor code during `confirmReset` is now audited although the reset rolls back (BEH-EA-266).
  - `pnpm check:transactions` (part of `pnpm check`) fails on a bare `sql.withTransaction(` in `packages/*/src`.
  
  Migration: an `AuthEvents.on` handler or observe tap for an operation that runs in a transaction now runs after the commit, and not at all when the operation rolls back; failure and attempt events are now recorded even when the operation rolls back. `Verification.consume(identifier, value, { deferMiss })` becomes `consume(identifier, value)` and `Verification.recordMiss` is gone (a custom `Verification` implementation drops it). Host code that opens its own `sql.withTransaction` around awthaq calls should use `SqlTransaction.transactional(sql)` from `@awthaq/ports`. A custom `SqlTransaction` implementation is unchanged (`withTransaction` is still the whole interface); to give its transactions a unit of work, build it on `transactional`.
- c0e7bd9: A client-held `Verification` token has a typed purpose (`VerificationLink.forUser`/`forAddress`), minted with `VerificationLink.issue(deps, purpose, input)` and redeemed through `VerificationLink.redeemer(purpose, { verification, budget })`, which owns the per-source and per-token budgets, the purpose check, the foreign-row refusal and one `VerificationLink/Refused` (ADR-EA-039 decision 9, BEH-EA-057).
  
  Migration: `VerificationLink.issue(deps, { purpose: "x", ttl, userId, payload })` -> declare `const X = VerificationLink.forUser({ name: "x", payload })` and call `VerificationLink.issue(deps, X, { ttl, userId, payload })`. `VerificationLink.decode(raw, "x")` -> `decode(raw, X)`. `EmailChange.newEmailOf` is gone: decode with `EmailChange.Payload`, or redeem `EmailChange.Link`.
- Updated dependencies
- Updated dependencies [a95959c]
- Updated dependencies [89fb48c]
- Updated dependencies [09d61ca]
- Updated dependencies [f810dcd]
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
- Updated dependencies [1cef4be]
- Updated dependencies [2c3c400]
- Updated dependencies [3514b28]
- Updated dependencies [349acb4]
- Updated dependencies [cb155d4]
- Updated dependencies [3b99770]
- Updated dependencies [14bc1bc]
- Updated dependencies [2dff755]
- Updated dependencies [f831b6c]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [bb72df5]
- Updated dependencies [6070f7f]
- Updated dependencies [e073887]
- Updated dependencies [95c6c09]
- Updated dependencies [bf60ccb]
- Updated dependencies [8fa8c43]
- Updated dependencies [c2a6bfe]
- Updated dependencies [a305c26]
- Updated dependencies [a5927c3]
- Updated dependencies [3917b38]
- Updated dependencies [81d4323]
- Updated dependencies [1cef4be]
- Updated dependencies [41f57a0]
- Updated dependencies [1a621ba]
- Updated dependencies [fd06299]
- Updated dependencies [c1e437d]
- Updated dependencies [23ec85b]
- Updated dependencies [f4cf736]
- Updated dependencies [05c2ef7]
- Updated dependencies [273f910]
- Updated dependencies
- Updated dependencies [2babe84]
- Updated dependencies [bc68e19]
- Updated dependencies [d286327]
- Updated dependencies [7f3f6bf]
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
- Updated dependencies [3d00f58]
- Updated dependencies [22cbfcf]
- Updated dependencies
- Updated dependencies [9a04906]
- Updated dependencies [1cef4be]
- Updated dependencies [b8fb23c]
- Updated dependencies [38ca611]
- Updated dependencies [4d9fed1]
- Updated dependencies [bba890e]
- Updated dependencies [1371d7b]
- Updated dependencies [8665a4a]
- Updated dependencies [6a28c4d]
- Updated dependencies [1c0d1a7]
- Updated dependencies [0a0059f]
- Updated dependencies [6cebb31]
- Updated dependencies [d82b7a4]
- Updated dependencies [09ae967]
- Updated dependencies [28a78b0]
- Updated dependencies [0e74d59]
- Updated dependencies [36951f5]
- Updated dependencies [7e9834e]
- Updated dependencies [71a4af0]
- Updated dependencies [01b82ea]
- Updated dependencies [5859d43]
- Updated dependencies [7dc7f4b]
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
- Updated dependencies [6b68edc]
- Updated dependencies [cf2742e]
- Updated dependencies [be42578]
- Updated dependencies [0a44931]
- Updated dependencies [ed1ac91]
- Updated dependencies [1141658]
- Updated dependencies [79909fa]
- Updated dependencies [6d3a955]
- Updated dependencies [5f11353]
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
  - @awthaq/sql@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0
  - @awthaq/organization@0.2.0

## 0.1.0

### Minor Changes

- Add the `Admin` plugin: config-gated, fail-closed-by-default user
  impersonation with a durable, queryable audit trail
  (`admin.impersonate`/`stopImpersonating`/`forceStop`/`list`). Impersonation
  sessions carry a hard expiry with no idle refresh and never touch the
  target user's own sessions.

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
