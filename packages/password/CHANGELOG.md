# @awthaq/password

## 0.2.0

### Minor Changes

- Administrator account deletion and credential changes (`AdminAccounts`), and a mailed change-email flow in the password plugin.
  
  - `@awthaq/admin`: the opt-in `AdminAccounts` plugin (`Auth.make([Admin, AdminAccounts])`, group `admin.accounts`) adds `DELETE /admin/users/:userId` (the one `AccountErasure` cascade), `POST /admin/users/:userId/email` (mails a `change-email` token to the new address; the owner confirms) and `POST /admin/users/:userId/password` (through the `PasswordHasher` port, revoking every session), each behind its own fail-closed predicate (`canDeleteUsers`, `canManageCredentials`) with audited `auth.admin.*` events. `AdminConfig` gains those predicates, `passwordPolicy` and `links.changeEmail`; `@awthaq/ports` is now a dependency.
  - `@awthaq/password`: `POST /change-email` (authenticated) and `POST /change-email/confirm` (public), typed `EmailDeliveryFailed`/`EmailChangeNotSupported`, rate limits per requester, per target inbox and per token, `auth.user.emailChanged`, a notice to the previous address, `PasswordConfig.links.changeEmail`.
  - `@awthaq/core`: `EmailChange` (the shared `change-email` purpose) and the events `auth.user.emailChanged`, `auth.admin.userDeleted`, `auth.admin.userEmailChangeRequested`, `auth.admin.userPasswordSet` (a new `AuthEvent` union member).
  
  Migration: none required (all additive). A host that switches on `AdminAccounts` provides `PasswordHasher`, `Mailer` and `AccountErasure`, and the password plugin must be composed for an admin-requested email change to be confirmed. BEH-EA-221/222/224 (amended), BEH-EA-118.
- fe9dc94: Sign-in completion is one core module, `SignIn` (BEH-EA-322, ADR-EA-038). Every first factor (password, passkey, OAuth, SAML, device authorization, magic link, email OTP) and the second factor now finish through it: `clear` returns a branded `Clearance` (user lookup, suspension gate, `BeforeSignIn`, `BeforeSessionIssue`), `issue` is the only way to mint a session from it, `complete` is both, and `resume` is the divert owner's entry.
  
  - A suspended account's refusal publishes `auth.user.signInFailed { reason: "suspended" }` for every strategy, not only password.
  - A SAML sign-in completed by a second factor now keeps `fed` in its `amr`, is recorded for Single Logout, is role-mapped, and keeps its connection's tenant: the SAML Single Logout record and role mapping are a sign-in continuation (`SignIn.continuation`) that crosses the divert.
  - A user erased between credential proof and session issue is refused with the flow's own uniform error (OAuth: `OAuthCallbackFailed`; SAML: `SamlAssertionRejected`; password and passkey: `InvalidCredentials`) instead of a 500.
  - `Hooks.BeforeSessionIssue`'s input now always carries `amr` (required) and may carry a `handoff` (`{ tenantId?, continuation? }`); the second-factor challenge stores it.
  - `@awthaq/test` gains `SignInProbe`, recording taps for the sign-in and sign-up hook points.
  
  Migration: a custom `BeforeSessionIssue.run` caller must pass `amr`. A custom divert tap that later completes the sign-in itself must return the `handoff` it received to `SignIn.resume`. A detector counting `signInFailed` gains suspended refusals from every strategy. Plugin authors: finish a sign-in with `SignIn.make` (`complete`, or `clear`/`issue`), never `Sessions.issue`.
- 2c3c400: `CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.
  
  Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` -> `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- cb155d4: Confirming an email change ends every session of the account (BEH-EA-053, REQ-EA-686).
  
  `POST /change-email/confirm` (`Password.confirmEmailChange`) is a public, token-authenticated request, so it has no caller session to rotate. It now calls `Sessions.revokeAll(userId, "emailChanged")` in the same transaction that replaces and verifies the address; `auth.session.revoked` carries the new `SessionRevocationReason` `"emailChanged"`.
  
  Migration: a client that stayed signed in across an email change is signed out when the change is confirmed and signs in again under the new address; an exhaustive `switch` over `SessionRevocationReason` gains an `"emailChanged"` case.
- Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.
  
  Migration:
  
  - `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-266, ADR-EA-020.
  - `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-271.
  - `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-258.
  - `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-259, BEH-EA-261.
  - `AdminAccounts.setUserPassword` now consults `Hooks.BeforeCredentialReset` (with no second-factor code) and can fail with `HookAborted` (403); for a user protected by `@awthaq/two-factor` an administrator can no longer silently replace the password. BEH-EA-259.
- 2babe84: `PasswordCredential` (exposed by `Password.layer`, ADR-EA-040, key `awthaq/plugin/password/Credential`) is the one module that verifies a password against the stored credential: `verify` resolves the claimant, reads its password credential and runs exactly one real verify (against the boot-time dummy hash when there is none), the whole effect held to the timing floor in force; `rehashIfStale` upgrades the credential on the branded `Proof` only `verify` mints. `accept` is the one policy (minimum length, breach screening, per-tenant overrides) and mints the branded `Accepted` every write takes; `linkFor` hashes an accepted password for the sign-up unit; `set` replaces or links the credential and `replace` rewrites an existing one, never linking one (both inside the caller's unit of work, the KDF at most once and only once a write is certain), and `has` answers whether there is one. Sign-up, reset and change accept through it; `signIn`, `changePassword` and `reauthenticate` verify through it, so the timing floor now covers the account lookup of the last two as well as their verify. `changePassword` now commits the new hash, the revocation of the caller's other sessions and the rotated session as one unit, and its transaction failing is `StoreUnavailable` (503).
  
  `@awthaq/test`: `StoreContract.accounts` gains the case "insertIfAbsent that loses a race inside an enclosing transaction leaves it usable"; its cases now require `SqlTransaction` (the `Ref` runner provides `SqlTransaction.layerNoop`).
  
  Migration: none in the API. `Password.config`, `Password.PasswordConfig` and `Password.PasswordConfigShape` are unchanged; they now live in `PasswordConfig.ts` and are re-exported. A host whose layer type is emitted in a declaration file must name the exposed service, or TypeScript reports TS2883: add `export type PasswordServices = PasswordCredential.PasswordCredential` beside the layer, as the examples do.
- bc68e19: `POST /reset-password/confirm` is rate limited per source (`confirmResetByIp`, 30 per 15 minutes) before the token is decoded, so a flood of forged tokens no longer reaches the breach check (BEH-EA-117, APS-003). A reset, verify-email or change-email token whose row names no user is now spent rather than left live (BEH-EA-118).
  
  Migration: `Password.confirmReset` takes an optional `ip`; a host calling it in-process passes the client address to keep the per-source budget meaningful. Tune with `RateLimits.tune(Password, { confirmResetByIp: { limit: 10 } })`.
- d286327: Password sign-up creates through `SignUp` (ADR-EA-038): the address is vetted by `BeforeSignUp` before the hash is computed, the user, password account and first session are one unit, and the first session is a cleared sign-in, so `BeforeSignIn`/`BeforeSessionIssue` run and `auth.user.signedIn` is published for it. `signUp` can now fail with `TwoFactorRequired` when a tap diverts the first session.
  
  Migration: handle `TwoFactorRequired` from `signUp`; a `BeforeSessionIssue` tap now also sees the sign-up's first session.
- ef9846c: `@awthaq/password` owns its events (ADR-EA-049): the four definitions `auth.user.emailVerified`, `auth.user.emailChanged`, `auth.password.resetRequested` and `auth.password.resetCompleted` moved from `@awthaq/core` to `PasswordEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. `auth.password.changed` stays in core: `@awthaq/admin` publishes it too.
  
  Migration: `AuthEvents.UserEmailVerifiedEvent`, `AuthEvents.UserEmailChangedEvent`, `AuthEvents.PasswordResetRequestedEvent` and `AuthEvents.PasswordResetCompletedEvent` → `PasswordEvents.<same name>` from `@awthaq/password`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include these four tags: subscribe with `AuthEvents.on(PasswordEvents.UserEmailVerifiedEvent, …)`, narrow the stream with `AuthEvents.is(PasswordEvents.UserEmailVerifiedEvent)`, decode an audit row with `AuditLog.payloadAs(PasswordEvents.UserEmailVerifiedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(PasswordEvents.UserEmailVerifiedEvent)(e)`. ADR-EA-049, BEH-EA-101.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 09ae967: `Password` reads no request facts (ADR-EA-047). `signUp`, `signUpConcealed`, `signIn`, `requestReset`, `resendVerification`, `confirmReset`, `verifyEmail`, `confirmEmailChange` and `changePassword` take no `ip` or `userAgent` and require `Api.AuthRequestContext`, which the `RequestContext` middleware provides per request: the session records the request's address and user agent, the per-source rules key on its address, and `auth.user.signInFailed` is published through core's `SignIn.failed`. The plugin layer no longer requires `ClientAddress`.
  
  Migration: drop `ip` and `userAgent` from calls to `Password.signUp`, `signUpConcealed`, `signIn`, `requestReset`, `resendVerification`, `confirmReset`, `verifyEmail`, `confirmEmailChange` and `changePassword`. An in-process caller provides the context: `Effect.provideService(Api.AuthRequestContext, Api.AuthRequestContext.noRequest)` for a job, `RequestContext.capture(request)` for a host route, or `TestAuth.withRequest`/`withoutRequest` in a test.
- 401a719: Every endpoint that changes the caller's session declares it on the contract, and every credential change goes through `SessionDelivery` (ADR-EA-045, BEH-EA-343).
  
  - `@awthaq/server` implements the server half of the `SessionLifecycle` markers (`SessionLifecycle.layer`, re-exported as `AuthHttp.sessionLifecycle`; derived by `AuthHttp.middlewareFor`). A declared endpoint resolves `X-Awthaq-Token-Delivery` before its handler runs, answers `Cache-Control: no-store`, and dies `SessionLifecycleUnsettled` when a successful response neither delivered nor declined. `SessionDelivery.respond(mint)` takes no request; `mode` and `deliver` are gone; `redirect`, `deliverBearer`, `deliverExchanged`, `end`, `swapIn`, `swapOut` and `decline` cover the rest, each requiring the grant its marker provides. A bearer delivery names the token in `set-auth-token` too (a bearer `changePassword` no longer logs the client out everywhere); an ended session answers `x-awthaq-session-ended` and drops a rotation's `set-auth-token` (both exposed by `AuthHttp.cors`).
  - `@awthaq/api`: core's `session.signOut`/`revoke`/`revokeAll` and `account.deleteUser` declare `SessionLifecycle.Ends`.
  - `@awthaq/core`: `SessionCookie.set`/`expire`/`expireImpersonation` moved into `@awthaq/server` (behind `SessionDelivery`); `SessionCookie.baseOptions` is exported.
  - Plugins: `password` (`signUp`/`signIn` `Mints`, `changePassword` `Rotates`, `reauthenticate` `Refreshes`), `passkey` (`authenticateVerify` `Mints`, `reauthenticateVerify` `Refreshes`), `magic-link` (`magicLink.verify`, `emailOtp.verify`), `two-factor` (`verify`, `verifyRecovery`), `device-authorization` (`token`), `oauth` (`callback`, `exchange.token`), `saml` (`acs` `Mints`, `logout` `Ends`), `admin` (`impersonate`/`stopImpersonating`/`forceStop` `Swaps`: a bearer request answers `400` before anything is minted), `organization` (`setActive`, `setActiveTeam`, `leave`, `acceptInvitation` `Refreshes`). Their hand-written `InvalidTokenDelivery` error entries are gone (the marker declares it).
  
  Migration: add `.middleware(SessionLifecycle.<Kind>)` to your endpoint and drop `Api.InvalidTokenDelivery` from its errors; replace `SessionDelivery.respond(request, mint)` with `SessionDelivery.respond(mint)` and `SessionDelivery.mode(request)` (mint nothing) with `SessionDelivery.decline(SessionLifecycle.MintGrant)`; replace `SessionCookie.set`/`expire`/`expireImpersonation` with the `SessionDelivery` function for your declared kind. A composition that wires host middleware by hand provides `AuthHttp.sessionLifecycle`. Never write the session cookie yourself. ADR-EA-045, BEH-EA-343, BEH-EA-066.
- b0b6a4d: One fresh-session gate, `Sessions.requireFresh`, replaces the copies in passkey, two-factor and qadi; `POST /change-email` now uses it.
  
  - `@awthaq/core`: new `Sessions.requireFresh(userId, id, maxAge)` and the `SessionStale` error (`Sessions/Stale`, with `maxAgeSeconds` and a `reason` of `notLive` or `stale`). Both layers share one implementation built on `findOwned` (BEH-EA-320).
  - `@awthaq/passkey`, `@awthaq/two-factor`, `@awthaq/qadi`: enrolment, enable/disable/regenerate and the `reauth` obligation call `requireFresh` and map `SessionStale` to their existing wire errors (`PasskeyReauthRequired`, `TwoFactorReauthRequired`, `Api.ReauthRequired`); the wire contracts do not change.
  - `@awthaq/password`: `POST /change-email` needs a session that proved a credential within the new `PasswordConfig.reauthMaxAge` (default 5 minutes), else `403 PasswordReauthRequired { maxAgeSeconds }`. `PasswordShape["requestEmailChange"]` takes `currentSessionId`.
  
  Migration: a hand-written `Sessions` test double adds a `requireFresh` member. A client of `POST /change-email` handles `PasswordReauthRequired` by running `POST /password/reauthenticate` (or a passkey step-up) and retrying, or the host sets `reauthMaxAge: Duration.infinity` to keep the old behaviour. Callers of `Password.requestEmailChange` pass `currentSessionId`.
- a25c52e: `Password.confirmReset`, `verifyEmail` and `confirmEmailChange` redeem their tokens through `Verification.redeem` (ADR-EA-039, BEH-EA-058). In an in-memory composition a failed attempt (a `BeforeCredentialReset` veto, `SecondFactorRequired`, a crash) now leaves the token usable, exactly as over SQL (BEH-EA-259): retry the same token with `secondFactorCode`. A database failure while committing one of them is now the typed `StoreUnavailable` (503) instead of a defect (ADR-EA-028).
  
  Migration: none for callers. A host that implemented its own `VerificationShape` (a test double) must add `redeem`; see the `@awthaq/core` changeset for `Verification.redeem`.

### Patch Changes

- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 6d23ed9: A store outage while reading or writing a password credential is `StoreUnavailable` (503) in `change-password`, `reauthenticate`, `confirm-reset` and the administrator's `setUserPassword`, and a retryable usage error (exit 2) in `awthaq seed admin`, instead of a 500 defect (ADR-EA-028). A `confirm-reset` that fails this way does not spend its token. A password credential unlinked between the read and the write now answers `WrongPassword` (`change-password`) or `TokenConsumed` (`confirm-reset`), and a `seed admin` that loses a race to link the password treats it as already linked.
  
  Migration: none (compatible). Alerting that keyed on 500s from these endpoints sees 503s instead.
- 1cef4be: Passkey and password handlers read the domain caller from `CurrentUser.current` instead of re-branding the wire principal.
  
  Migration: PasskeyShape session parameters take Sessions.SessionId; pass the issued session's id or Sessions.SessionId(raw).
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- bba890e: The password plugin declares its 17 rate-limit rules as a `rateLimitRules` table and spends them through `RateLimits.budget` (plan 06). The limits and windows are unchanged, and `plugin list --rules` now also prints each rule's key strategy and mode. Any shipped rule can be tuned or opted into escalation with `RateLimits.overrides(RateLimits.tune(Password, { signIn: { limit: 3 } }))`.
  
  - `PasswordConfig.rateLimitEmailKey` now defaults to `RateLimits.Key.emailKey`, which also trims whitespace (it only lower-cased and stripped `+tag` before).
  - `changePassword`, `reauthenticate` and `changeEmail` breaches report `dimension: "principal"` (was `"identity"`): they key on the signed-in user.
  
  Migration: rate-limit buckets are renamed (`password:signin:<email>` becomes `ratelimit:password.signIn:email:<email>`, `password:signin:ip:<ip>` becomes `ratelimit:password.signInByIp:ip:<ip>`, and likewise for every rule), so a deploy resets the live counters of these rules once; entries in a shared store expire within one hour. Dashboards that filter `auth.rateLimit.exceeded` on `dimension: "identity"` for those three rules should also match `"principal"`.
- 5859d43: A store outage while minting the replacement session in `changePassword`, or the impersonation session in `Admin.impersonate`, is now the typed `StoreUnavailable` the Shape already declared instead of a defect (ADR-EA-028). OAuth answers a concurrent first login that linked the same provider identity as the one opaque callback failure instead of a defect.
- a232d8e: `SessionDelivery.respond(request, mint)` is the one call a session-minting handler makes: it validates `X-Awthaq-Token-Delivery`, runs `mint` only after that, then delivers the session as a cookie or a bearer body (plan 01 phase 6).
  
  - `@awthaq/server`: adds `SessionDelivery.respond`; `AuthHttp.coreHandlers` logs one warning at layer build when `RequestContext.layer` is not merged on the router (sessions would record no address or user agent), silenced by providing `RequestContext.warnWhenAbsent` as `false`; `RequestContext.layer` stays opt-in. `README.md` documents both.
  - `@awthaq/password`, `@awthaq/two-factor`, `@awthaq/magic-link`, `@awthaq/passkey`: every handler that mints a session goes through `respond`; behaviour on the wire is unchanged (a concealed sign-up still refuses a bad delivery header first).
  - `@awthaq/test`: `TestAuth` silences the new warning, since the in-process harness serves without `RequestContext.layer`.
- 6d797b0: `Sessions.reauthenticate` advances only a live session the caller owns.
  
  - `@awthaq/core`: `reauthenticate(id, amr?)` becomes `reauthenticate(userId, id, amr?)`. A tombstoned (superseded), expired, foreign or absent session fails `SessionNotFound` and is left unchanged, in both layers (BEH-EA-319).
  - `@awthaq/sql`: `SessionsRepository.reauthenticate(id, userId, now, amr?)` guards owner, tombstone and both expiries in the one `UPDATE`'s `WHERE`.
  - `@awthaq/password`, `@awthaq/passkey`: `POST /password/reauthenticate` and `POST /passkey/reauthenticate/verify` answer 401 `Unauthenticated` when the session ended during the request (it used to be a 500 defect). `PasswordShape["reauthenticate"]` and `PasskeyShape["reauthenticateVerify"]` gain `Api.Unauthenticated` in their error channel.
  
  Migration: call `sessions.reauthenticate(userId, sessionId, amr)`; a host with its own `SessionsRepository` implementation adds the `userId` and `now` parameters and the three predicates. A caller that relied on stepping up a dead or foreign session id now gets `SessionNotFound`.
- 2f56ab5: A SAML sign-in completed by a second factor now records `fed` in its `amr`, and a store outage during sign-in answers 503 `StoreUnavailable` instead of a 500 defect.
  
  - `@awthaq/saml`: the `BeforeSessionIssue` divert context carries `amr: ["fed"]`, the same methods the session is issued with, so the two-factor plugin's final session records `["fed", "otp", "mfa"]` instead of `["otp", "mfa"]`. An outage reading the user or minting the session is the typed `StoreUnavailable`.
  - `@awthaq/password`, `@awthaq/passkey`, `@awthaq/oauth`: the sign-in completions no longer `Effect.orDie` `Sessions.issue`, `Users.findById` or the credential-hash reads (ADR-EA-028); a `UserNotFound` / `AccountNotFound` impossible by construction still dies, on that tag only. No Shape or contract changes; the wire answer for an outage becomes 503.
  
  Migration: sessions minted before the fix keep `["otp", "mfa"]` until they end, so a policy gating on `fed` should not assume old two-factor SAML sessions carry it. Clients that retried sign-in only on 500 should also retry 503, and alerting keyed on 500s for sign-in outages should add 503. BEH-EA-245, BEH-EA-261, BEH-EA-088.
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
- Updated dependencies [6070f7f]
- Updated dependencies [e073887]
- Updated dependencies [a305c26]
- Updated dependencies [3917b38]
- Updated dependencies [81d4323]
- Updated dependencies [f4cf736]
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
- Updated dependencies [01b82ea]
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
- Updated dependencies [1cef4be]
- Updated dependencies
- Updated dependencies [e6c3620]
- Updated dependencies [37e5cdd]
- Updated dependencies [c0e7bd9]
- Updated dependencies [020abf8]
- Updated dependencies [9cdebdd]
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
