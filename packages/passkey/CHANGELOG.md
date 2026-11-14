# @awthaq/passkey

## 0.2.0

### Minor Changes

- fe9dc94: Sign-in completion is one core module, `SignIn` (BEH-EA-322, ADR-EA-038). Every first factor (password, passkey, OAuth, SAML, device authorization, magic link, email OTP) and the second factor now finish through it: `clear` returns a branded `Clearance` (user lookup, suspension gate, `BeforeSignIn`, `BeforeSessionIssue`), `issue` is the only way to mint a session from it, `complete` is both, and `resume` is the divert owner's entry.
  
  - A suspended account's refusal publishes `auth.user.signInFailed { reason: "suspended" }` for every strategy, not only password.
  - A SAML sign-in completed by a second factor now keeps `fed` in its `amr`, is recorded for Single Logout, is role-mapped, and keeps its connection's tenant: the SAML Single Logout record and role mapping are a sign-in continuation (`SignIn.continuation`) that crosses the divert.
  - A user erased between credential proof and session issue is refused with the flow's own uniform error (OAuth: `OAuthCallbackFailed`; SAML: `SamlAssertionRejected`; password and passkey: `InvalidCredentials`) instead of a 500.
  - `Hooks.BeforeSessionIssue`'s input now always carries `amr` (required) and may carry a `handoff` (`{ tenantId?, continuation? }`); the second-factor challenge stores it.
  - `@awthaq/test` gains `SignInProbe`, recording taps for the sign-in and sign-up hook points.
  
  Migration: a custom `BeforeSessionIssue.run` caller must pass `amr`. A custom divert tap that later completes the sign-in itself must return the `handoff` it received to `SignIn.resume`. A detector counting `signInFailed` gains suspended refusals from every strategy. Plugin authors: finish a sign-in with `SignIn.make` (`complete`, or `clear`/`issue`), never `Sessions.issue`.
- 1cef4be: Passkey and password handlers read the domain caller from `CurrentUser.current` instead of re-branding the wire principal.
  
  Migration: PasskeyShape session parameters take Sessions.SessionId; pass the issued session's id or Sessions.SessionId(raw).
- 2c3c400: `CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.
  
  Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` -> `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.
  
  Migration:
  
  - `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-266, ADR-EA-020.
  - `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-271.
  - `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-258.
  - `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-259, BEH-EA-261.
  - `AdminAccounts.setUserPassword` now consults `Hooks.BeforeCredentialReset` (with no second-factor code) and can fail with `HookAborted` (403); for a user protected by `@awthaq/two-factor` an administrator can no longer silently replace the password. BEH-EA-259.
- dc3a328: The passkey signature-counter verdict is decided at the record-store write (plan 25 ticket 18, ADR-EA-041 decision 9):
  
  - Two concurrent assertions carrying the same counter can no longer both advance it unnoticed. Before, each compared its counter with the value the ceremony had read earlier, so both passed the CB-004 check. Now `PasskeyCredentials.recordUsage` decides: exactly one advances, and the others are regressions. Under `counterAnomalyPolicy: "flag"` a regression is published as `auth.passkey.counterAnomaly` and flagged. Under `"reject"` it fails with `PasskeyCounterAnomaly`, and the counter does not advance.
  - A regressed assertion stores nothing but the anomaly flag: not the counter, the backup state or the last-used time (before, under `"flag"`, it stamped the last-used time and backup state).
  - A credential deleted between the ceremony's lookup and its usage write fails the sign-in or step-up like an unknown credential. Before, the request died with a defect.
  - `ChallengeStore`, `PasskeyCredentials` and `PasskeyUserHandles` have RecordsContract suites. `ChallengeStore`'s also runs on `layerCookie`.
  
  Migration: a custom adapter through `@awthaq/passkey`'s `PasskeyCredentials` must implement `recordUsage(id, counter, backedUp)` as one conditional write that answers `"advanced"` or `"regressed"` (before, it answered `void`). It advances when `counter` is above the stored counter or both are 0, storing the counter, backup state and last-used time in that same step. Otherwise it writes nothing and answers `"regressed"`. It fails `PasskeyCredentials/NotFound` when the credential is gone. Memory: one `Ref.modify`. SQL: `UPDATE … WHERE id = $id AND (counter < $n OR (counter = 0 AND counter = $n)) RETURNING id`. BEH-EA-131, CB-004.
- 585d9cf: The stored signature counter accepts the full WebAuthn range (up to 2^32 - 1) on Postgres; a new migration `widen_passkey_credential_counter` widens the column to `BIGINT` (a no-op on SQLite) (BEH-EA-131).
  
  Migration: run the plugin migrations. On a large `passkey_credential` table the `ALTER COLUMN … TYPE BIGINT` rewrites the table under an exclusive lock; schedule it.
- 77e05bd: The remaining plugin stores fail with `StoreUnavailable` instead of dying (plan 05, ADR-EA-028).
  
  - `ApiKeyRecords`, `ApiKeyClientRecords`, `DeviceGrantRecords`, `DeviceClientRecords`, `PasskeyCredentials` (`recordUsage` included), `PasskeyUserHandles`, `ChallengeStore`, `Roles` (`assign`, `revoke`, `listRoleNames`, `holders`, `listUnknownAssignments`) and `UserClaims` (`get`, `set`, `merge`, `delete`) answer a database failure with the typed `StoreUnavailable` naming `<Records>.<method>`; the services built on them (`ApiKey`, `DeviceAuthorization`, `Passkey`, `RolesAdmin`) widen their `E` accordingly. All their tables are Global (no tenant column).
  - An API-key service-token resolver and a JWT bearer resolver let an outage through as `StoreUnavailable` (a `503`) instead of answering `401`. `@awthaq/qadi`'s `SubjectResolver.resolve` and its `AuthorizedSubject` middleware may fail with `StoreUnavailable` (a roles lookup that is down is no longer a defect), and `UserClaimsAttributes` / `OrganizationQadi` answer it as their own typed resolve error so the policy engine fails closed.
  
  Migration: handle `StoreUnavailable` on the widened methods; an application that implements `SubjectResolverShape`, `RolesShape`, `ChallengeStoreShape` or one of the records shapes adopts the wider `E`. BEH-EA-325.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- 25bcba4: `Passkey.records` is the plugin's credential, user-handle and challenge stores as one matched `{ memory, sql }` bundle, and the stores' service keys gain the `/records/` segment.
  
  - `PasskeyCredentials`, `PasskeyUserHandles` and `ChallengeStore` are keyed `awthaq/passkey/records/<Name>`; the bundle provides all three over memory and over SQL, and `AuthPlugin.layer` refuses a layer that requires a store the bundle does not provide. `WebAuthn` stays a port the host provides (tests mock it).
  
  Migration: code that built a `Context` by the old key string must use the class. A host replaces the three `layerMemory` / `layerSql` layers with `Passkey.records.memory` / `Passkey.records.sql`.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 693386f: `Passkey` reads no request facts (ADR-EA-047). `authenticateOptions` takes no `ip`, and `authenticateVerify` takes no `ip` and no second `context` argument; both require `Api.AuthRequestContext`. The session records the request's address and user agent, the per-source rules key on its address, and a refused assertion is announced through core's `SignIn.failed`. The plugin layer no longer requires `ClientAddress`.
  
  Migration: call `Passkey.authenticateOptions({ email? })` and `Passkey.authenticateVerify(payload)` without `ip` or the `{ userAgent }` argument, and provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest`, `RequestContext.capture(request)`, or `TestAuth.withRequest`).
- 401a719: Every endpoint that changes the caller's session declares it on the contract, and every credential change goes through `SessionDelivery` (ADR-EA-045, BEH-EA-343).
  
  - `@awthaq/server` implements the server half of the `SessionLifecycle` markers (`SessionLifecycle.layer`, re-exported as `AuthHttp.sessionLifecycle`; derived by `AuthHttp.middlewareFor`). A declared endpoint resolves `X-Awthaq-Token-Delivery` before its handler runs, answers `Cache-Control: no-store`, and dies `SessionLifecycleUnsettled` when a successful response neither delivered nor declined. `SessionDelivery.respond(mint)` takes no request; `mode` and `deliver` are gone; `redirect`, `deliverBearer`, `deliverExchanged`, `end`, `swapIn`, `swapOut` and `decline` cover the rest, each requiring the grant its marker provides. A bearer delivery names the token in `set-auth-token` too (a bearer `changePassword` no longer logs the client out everywhere); an ended session answers `x-awthaq-session-ended` and drops a rotation's `set-auth-token` (both exposed by `AuthHttp.cors`).
  - `@awthaq/api`: core's `session.signOut`/`revoke`/`revokeAll` and `account.deleteUser` declare `SessionLifecycle.Ends`.
  - `@awthaq/core`: `SessionCookie.set`/`expire`/`expireImpersonation` moved into `@awthaq/server` (behind `SessionDelivery`); `SessionCookie.baseOptions` is exported.
  - Plugins: `password` (`signUp`/`signIn` `Mints`, `changePassword` `Rotates`, `reauthenticate` `Refreshes`), `passkey` (`authenticateVerify` `Mints`, `reauthenticateVerify` `Refreshes`), `magic-link` (`magicLink.verify`, `emailOtp.verify`), `two-factor` (`verify`, `verifyRecovery`), `device-authorization` (`token`), `oauth` (`callback`, `exchange.token`), `saml` (`acs` `Mints`, `logout` `Ends`), `admin` (`impersonate`/`stopImpersonating`/`forceStop` `Swaps`: a bearer request answers `400` before anything is minted), `organization` (`setActive`, `setActiveTeam`, `leave`, `acceptInvitation` `Refreshes`). Their hand-written `InvalidTokenDelivery` error entries are gone (the marker declares it).
  
  Migration: add `.middleware(SessionLifecycle.<Kind>)` to your endpoint and drop `Api.InvalidTokenDelivery` from its errors; replace `SessionDelivery.respond(request, mint)` with `SessionDelivery.respond(mint)` and `SessionDelivery.mode(request)` (mint nothing) with `SessionDelivery.decline(SessionLifecycle.MintGrant)`; replace `SessionCookie.set`/`expire`/`expireImpersonation` with the `SessionDelivery` function for your declared kind. A composition that wires host middleware by hand provides `AuthHttp.sessionLifecycle`. Never write the session cookie yourself. ADR-EA-045, BEH-EA-343, BEH-EA-066.
- 4cd6174: A bounded session-rotation grace window, an `SmsSender` port with an E.164 rate-limit key, and passkey Related Origin Requests.
  
  - **Rotation grace (RRS-005, RRC-006).** The secret a throttled touch replaces keeps verifying for `SessionConfig.rotationGrace` (default 30 seconds, `Duration.zero` disables it). Presenting it inside the window succeeds, re-rotates and hands back a fresh secret in `rotated`, so a lost `Set-Cookie` or `set-auth-token` no longer strands the client; it is per session, never a reuse signal (no family revocation, no `auth.session.reuse`), and `auth.session.rotated` carries `viaGrace` for those recoveries. New sessions columns `previousSecretHash`/`previousSecretExpiresAt` (core migration 29); `SessionsRepository.touch` takes them (optional).
  - **`SmsSender` port (SOS-002).** `@awthaq/ports` exports `SmsSender` (`send`/`sent`, `layerNoop`/`layerMemory`/`layerConsole`, a typed `SmsDeliveryFailed`), mirroring `Mailer`. `RateLimits.phoneKey(read, options?)` (SOS-007) is a key strategy that normalises the destination to E.164 first, so an SMS endpoint gets a per-recipient cap alongside `"ip"` and `"principal"`.
  - **Related Origin Requests (TC-008).** `PasskeyConfig.relatedOrigins` (default `[]`) lists exact https origins outside `rpId` that may use its passkeys; every ceremony accepts them and a new anonymous `GET /.well-known/webauthn` (group `passkey.wellKnown`) serves the list (404 while empty).
  
  Migration: a deployment that relied on the replaced session secret dying instantly sets `SessionConfig.rotationGrace: Duration.zero`. Apply core migration 29 (two nullable columns). A hand-built `Sessions` table in tests needs `previousSecretHash TEXT, previousSecretExpiresAt TEXT`. `Auth.make([Passkey])` lists a fifth group, `passkey.wellKnown`. BEH-EA-052, BEH-EA-133.

### Patch Changes

- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- d89bc87: `register/verify` and `reauthenticate/verify` now spend the ceremony's challenge before checking the origin, and every ceremony (sign-in included) spends it when the browser's `clientDataJSON` cannot be read, so no refused verification attempt leaves its challenge usable (BEH-EA-132). A missing or spent challenge now outranks an origin refusal at registration and step-up (`PasskeyChallengeInvalid`, as sign-in already answered).
  
  Migration: a client that presented the same challenge again after `PasskeyOriginMismatch` or `PasskeyRpIdMismatch` must request fresh options first (`@awthaq/client`'s `passkeyClient` never retries). Requests refused before verification (rate-limited, stale session, bad token-delivery header) are unaffected: their challenge stays usable.
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- 3c23d53: Passkey declares its three anonymous-ceremony rate-limit rules as a `rateLimitRules` table and spends them through `RateLimits.budget` (plan 06).
  
  - TMS-006 tightening: the per-email `authenticateOptions` budget (10 per 15 minutes) now normalises case, whitespace and `+tag` through `RateLimits.Key.emailKey`, like password and magic link. Before, `victim+1@x.com` through `victim+N@x.com` each got a fresh budget, so an attacker could probe one address indefinitely.
  - The registry now reports the keys that are actually enforced (the IP rules used to register the generic `"ip"` strategy while enforcing a different key).
  
  Migration: rate-limit buckets are renamed (`passkey:authenticate-options:ip:<ip>` becomes `ratelimit:passkey.authenticate.authenticateOptionsByIp:ip:<ip>`, and likewise for the other two), so a deploy resets the live counters of these rules once; entries in a shared store expire within 15 minutes.
- 7e9834e: Plugins contribute their own retention rules to `Retention.sweep`.
  
  - `@awthaq/core`: new `Retention.contribute({ id, order?, make })` and `Retention.RetentionRegistry` (provided by `Hooks.HooksLive`, like the erasure registry). `Retention.sweep` runs every contribution after the core purges, isolates a failing one, and reports `SweepReport.plugins: ReadonlyArray<{ id, deleted, failed }>`; its requirements gain `RetentionRegistry`. ADR-EA-031 Decision 6 amended (revision 1.4); BEH-EA-337.
  - `@awthaq/saml`: contributes `saml.sessions` and no longer prunes session records inside every sign-in.
  - `@awthaq/device-authorization`: contributes `device_authorization.grants`. `@awthaq/jwt`: contributes `jwt.revocations` (`RevocationStore` gains `purgeExpired`). `@awthaq/organization`: contributes `organization.invitations` (new `invitationRetention`, default 30 days; `InvitationRecords` gains `purgeExpired`). `@awthaq/passkey`: contributes `passkey.challenges`. `@awthaq/webhooks`: contributes `webhooks.deliveries` (the worker keeps its hourly prune).
  
  Migration: a composition that installs one of these plugins must provide `Retention.RetentionRegistry`; every `Auth.make` composition and `Hooks.HooksLive` already do. A host with its own `RevocationStore` or `InvitationRecords` implements `purgeExpired`. SAML session records now age out only when the host runs `Retention.sweep` or `Retention.layerScheduled`; a host that relied on the inline prune must schedule the sweep.
- a232d8e: `SessionDelivery.respond(request, mint)` is the one call a session-minting handler makes: it validates `X-Awthaq-Token-Delivery`, runs `mint` only after that, then delivers the session as a cookie or a bearer body (plan 01 phase 6).
  
  - `@awthaq/server`: adds `SessionDelivery.respond`; `AuthHttp.coreHandlers` logs one warning at layer build when `RequestContext.layer` is not merged on the router (sessions would record no address or user agent), silenced by providing `RequestContext.warnWhenAbsent` as `false`; `RequestContext.layer` stays opt-in. `README.md` documents both.
  - `@awthaq/password`, `@awthaq/two-factor`, `@awthaq/magic-link`, `@awthaq/passkey`: every handler that mints a session goes through `respond`; behaviour on the wire is unchanged (a concealed sign-up still refuses a bad delivery header first).
  - `@awthaq/test`: `TestAuth` silences the new warning, since the in-process harness serves without `RequestContext.layer`.
- 6d797b0: `Sessions.reauthenticate` advances only a live session the caller owns.
  
  - `@awthaq/core`: `reauthenticate(id, amr?)` becomes `reauthenticate(userId, id, amr?)`. A tombstoned (superseded), expired, foreign or absent session fails `SessionNotFound` and is left unchanged, in both layers (BEH-EA-319).
  - `@awthaq/sql`: `SessionsRepository.reauthenticate(id, userId, now, amr?)` guards owner, tombstone and both expiries in the one `UPDATE`'s `WHERE`.
  - `@awthaq/password`, `@awthaq/passkey`: `POST /password/reauthenticate` and `POST /passkey/reauthenticate/verify` answer 401 `Unauthenticated` when the session ended during the request (it used to be a 500 defect). `PasswordShape["reauthenticate"]` and `PasskeyShape["reauthenticateVerify"]` gain `Api.Unauthenticated` in their error channel.
  
  Migration: call `sessions.reauthenticate(userId, sessionId, amr)`; a host with its own `SessionsRepository` implementation adds the `userId` and `now` parameters and the three predicates. A caller that relied on stepping up a dead or foreign session id now gets `SessionNotFound`.
- b0b6a4d: One fresh-session gate, `Sessions.requireFresh`, replaces the copies in passkey, two-factor and qadi; `POST /change-email` now uses it.
  
  - `@awthaq/core`: new `Sessions.requireFresh(userId, id, maxAge)` and the `SessionStale` error (`Sessions/Stale`, with `maxAgeSeconds` and a `reason` of `notLive` or `stale`). Both layers share one implementation built on `findOwned` (BEH-EA-320).
  - `@awthaq/passkey`, `@awthaq/two-factor`, `@awthaq/qadi`: enrolment, enable/disable/regenerate and the `reauth` obligation call `requireFresh` and map `SessionStale` to their existing wire errors (`PasskeyReauthRequired`, `TwoFactorReauthRequired`, `Api.ReauthRequired`); the wire contracts do not change.
  - `@awthaq/password`: `POST /change-email` needs a session that proved a credential within the new `PasswordConfig.reauthMaxAge` (default 5 minutes), else `403 PasswordReauthRequired { maxAgeSeconds }`. `PasswordShape["requestEmailChange"]` takes `currentSessionId`.
  
  Migration: a hand-written `Sessions` test double adds a `requireFresh` member. A client of `POST /change-email` handles `PasswordReauthRequired` by running `POST /password/reauthenticate` (or a passkey step-up) and retrying, or the host sets `reauthMaxAge: Duration.infinity` to keep the old behaviour. Callers of `Password.requestEmailChange` pass `currentSessionId`.
- 2f56ab5: A SAML sign-in completed by a second factor now records `fed` in its `amr`, and a store outage during sign-in answers 503 `StoreUnavailable` instead of a 500 defect.
  
  - `@awthaq/saml`: the `BeforeSessionIssue` divert context carries `amr: ["fed"]`, the same methods the session is issued with, so the two-factor plugin's final session records `["fed", "otp", "mfa"]` instead of `["otp", "mfa"]`. An outage reading the user or minting the session is the typed `StoreUnavailable`.
  - `@awthaq/password`, `@awthaq/passkey`, `@awthaq/oauth`: the sign-in completions no longer `Effect.orDie` `Sessions.issue`, `Users.findById` or the credential-hash reads (ADR-EA-028); a `UserNotFound` / `AccountNotFound` impossible by construction still dies, on that tag only. No Shape or contract changes; the wire answer for an outage becomes 503.
  
  Migration: sessions minted before the fix keep `["otp", "mfa"]` until they end, so a policy gating on `fed` should not assume old two-factor SAML sessions carry it. Clients that retried sign-in only on 500 should also retry 503, and alerting keyed on 500s for sign-in outages should add 503. BEH-EA-245, BEH-EA-261, BEH-EA-088.
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
- Updated dependencies [85c9e47]
- Updated dependencies [8dd72b6]
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
- Updated dependencies [a305c26]
- Updated dependencies [3917b38]
- Updated dependencies [81d4323]
- Updated dependencies [f4cf736]
- Updated dependencies [05c2ef7]
- Updated dependencies
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
- Updated dependencies
- Updated dependencies [9a04906]
- Updated dependencies [38ca611]
- Updated dependencies [4d9fed1]
- Updated dependencies [1371d7b]
- Updated dependencies [6a28c4d]
- Updated dependencies [1c0d1a7]
- Updated dependencies [6cebb31]
- Updated dependencies [d82b7a4]
- Updated dependencies [28a78b0]
- Updated dependencies [0e74d59]
- Updated dependencies [36951f5]
- Updated dependencies [7e9834e]
- Updated dependencies [71a4af0]
- Updated dependencies [01b82ea]
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
- Updated dependencies [1cef4be]
- Updated dependencies
- Updated dependencies [e6c3620]
- Updated dependencies [37e5cdd]
- Updated dependencies [c0e7bd9]
- Updated dependencies [020abf8]
- Updated dependencies [9cdebdd]
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/sql@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
