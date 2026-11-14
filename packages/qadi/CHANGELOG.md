# @awthaq/qadi

## 0.2.0

### Minor Changes

- 85c9e47: `@awthaq/server`'s `Credentials` module is the one place a request's credentials are read, ordered, resolved, admitted and their rotation handed off (ADR-EA-042). `Authentication`, `SubjectExtractorLive` and `getSession` are adapters over it. A tier now also refuses a session-derived principal it does not admit. A claimed credential (API key, JWT) is resolved at most once per request.
  
  Migration: `Authentication.PrincipalResolver*`, `Authentication.contribute`, `Authentication.CredentialResolvers*` -> `Credentials.*` (same names; `Authentication.CredentialCarrier` is `Credentials.ClaimCarrier`). `Authentication.resolvePrincipal`/`resolveSession`/`ResolvedSession` are gone: use `Credentials.make` and `step`/`resolve` with `Credentials.httpScope(request)`, and `Sessions.VerifiedSession`. Web: `verifySessionToken`/`VerifySessionToken` -> `resolveSessionCookies`/`ResolveSessionCookies` (the whole cookie header is the dedup unit); `Session.principal` is `Api.UserPrincipal`.
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
- 2e56459: `@awthaq/qadi` owns its events (ADR-EA-049): the `auth.user.claimsUpdated` definition moved from `@awthaq/core` to `UserClaimsEvents`, is declared on the `UserClaims` plugin's `events`, and is published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged. `auth.authz.denied`, which qadi's decision logging publishes, stays in core.
  
  Migration: `AuthEvents.UserClaimsUpdatedEvent` → `UserClaimsEvents.UserClaimsUpdatedEvent` from `@awthaq/qadi`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.user.claimsUpdated`: subscribe with `AuthEvents.on(UserClaimsEvents.UserClaimsUpdatedEvent, …)`, narrow the stream with `AuthEvents.is(UserClaimsEvents.UserClaimsUpdatedEvent)`, decode an audit row with `AuditLog.payloadAs(UserClaimsEvents.UserClaimsUpdatedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(UserClaimsEvents.UserClaimsUpdatedEvent)(e)`. ADR-EA-049, BEH-EA-101.
- 77e05bd: The remaining plugin stores fail with `StoreUnavailable` instead of dying (plan 05, ADR-EA-028).
  
  - `ApiKeyRecords`, `ApiKeyClientRecords`, `DeviceGrantRecords`, `DeviceClientRecords`, `PasskeyCredentials` (`recordUsage` included), `PasskeyUserHandles`, `ChallengeStore`, `Roles` (`assign`, `revoke`, `listRoleNames`, `holders`, `listUnknownAssignments`) and `UserClaims` (`get`, `set`, `merge`, `delete`) answer a database failure with the typed `StoreUnavailable` naming `<Records>.<method>`; the services built on them (`ApiKey`, `DeviceAuthorization`, `Passkey`, `RolesAdmin`) widen their `E` accordingly. All their tables are Global (no tenant column).
  - An API-key service-token resolver and a JWT bearer resolver let an outage through as `StoreUnavailable` (a `503`) instead of answering `401`. `@awthaq/qadi`'s `SubjectResolver.resolve` and its `AuthorizedSubject` middleware may fail with `StoreUnavailable` (a roles lookup that is down is no longer a defect), and `UserClaimsAttributes` / `OrganizationQadi` answer it as their own typed resolve error so the policy engine fails closed.
  
  Migration: handle `StoreUnavailable` on the widened methods; an application that implements `SubjectResolverShape`, `RolesShape`, `ChallengeStoreShape` or one of the records shapes adopts the wider `E`. BEH-EA-325.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- 1cef4be: Built against `@qadi/core`, `@qadi/http` and `@qadi/react` 0.12 (the peer ranges move from `^0.11.0` to `^0.12.0`). `@awthaq/qadi`'s `ObligationHandlers.reauth` is an `ObligationHandler` of 0.12, so it takes the `{ question, decision }` discharge and reads `decision.obligations`; `onObligations: ObligationHandlers.reauth` is unchanged. `@awthaq/react` re-exports the new `useQuestions` hook (the devtools dock feed, `useDevtoolsFeed` and `runtimeLayer`, stays on `@qadi/react`).
  
  Migration: a host with an endpoint that declares neither `RequiredPermission` nor `publicEndpoint` (or that `RequirePermission` does not cover) now fails at startup, when `guardApi` is built, with `AccessNotDeclared` or `RequirePermissionNotAttached`, instead of serving a 500 per request: annotate the endpoint. A direct call `ObligationHandlers.reauth([...obligations])` becomes `ObligationHandlers.reauth({ question, decision })`; guard a Path B `HttpApi` with `guardApi(Api)` (replaces `RequirePermissionLive` and `registerApi`, provide `PermissionRegistryLive` once where the stack is composed) and see the `@qadi/http` 0.12 changelog for the rest.
- b8fb23c: Requires `@qadi/core`, `@qadi/http` and `@qadi/react` `^0.8.0` (was `^0.7.0`).
  
  `@qadi/http` 0.8.0 answers the `RequirePermission` refusals with typed bodies instead of empty ones so a generated `HttpApiClient` can decode them: a 403 `AccessDenied` carries qadi's public denial view (`subjectId`, `policyTag`, `reason`; never the evaluation trace), a 403 `UndischargedObligation` its tag, a 502 resolver outage its tag plus at most one identifying attribute (never the cause or the resolver's own message); the wiring-mistake 500 stays empty. BEH-EA-157 / REQ-EA-440 (PV-230).
  
  Migration: bump the three `@qadi/*` dependencies to `^0.8.0` together; a host that asserted an empty 403 or 502 body from `RequirePermission` now sees the typed view.
- 5aef03e: `UserClaims` persists through a record store, `UserClaimsRecords`, declared as `UserClaims.records` (a matched `{ memory, sql }` bundle), and `UserClaims.layerSql` is removed.
  
  - New record store `UserClaimsRecords` (key `awthaq/qadi/records/UserClaims`) with `layerMemory` and `layerSql`, the `read`/`modify` pair the two copies of `UserClaims` already shared internally. `UserClaims.layer` requires it.
  
  Migration: `UserClaims.layer` now requires `UserClaimsRecords`: provide `UserClaims.records.memory` beneath it. `UserClaims.layerSql` is gone: use `UserClaims.layer` with `UserClaims.records.sql`. A composition served through `Auth.make` and `TestAuth.layer` needs nothing: the harness selects the bundle.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.

### Patch Changes

- a5927c3: The organization row is a system module, `OrganizationDirectory` (`find`, `findActive`, `requireActive`, `isSlugAvailable`, `listForUser`, `listPage`, `create`, `update`, `delete`, `suspend`, `reinstate`), exposed by `Organization.layer` (ADR-EA-040). `create` writes the organization and its creator's membership in one transaction (a failed creation leaves neither) and the creator's membership now fires `AfterAddMember`. `suspend` and `reinstate` take a `PlatformAdminActor`, run the new `BeforeSuspendOrganization` / `AfterSuspendOrganization` and `BeforeReinstateOrganization` / `AfterReinstateOrganization` hook points, and still publish `auth.admin.organizationSuspended` / `organizationUnsuspended`. `AdminTenants` suspends, reinstates and lists through the Directory instead of writing `OrganizationRecords`, so a platform suspension is observable and `@awthaq/qadi`'s `DecisionCacheInvalidationLive` now clears a long-lived decision cache on suspension, reinstatement, a team move and a team-role change. The SAML and SCIM token and connection gates read `OrganizationDirectory.findActive` / `find`. `OrganizationQadi.relationships` reads the Directory.
  
  Migration: `AdminTenantsShape["suspendOrganization"]` and `["unsuspendOrganization"]` (and the `/admin/organizations/:id/suspend` and `/unsuspend` endpoints) can now answer `HookAborted` (`403`) when a `BeforeSuspendOrganization` / `BeforeReinstateOrganization` tap vetoes. `AdminTenants`, `SamlConnections.layerStore`, `Saml.layer` and `ScimAuthenticationLive` require the exposed `OrganizationDirectory` instead of `OrganizationRecords`. A host that installs `DecisionCacheInvalidationLive` must provide `OrganizationHooksLive` (as before) which now includes the four new points. `OrganizationLive` compositions are unchanged. The tenant middleware still reads `OrganizationRecords` directly (a raw read of a suspended organization is deliberate).
- 1cef4be: Each table's migrations moved into its records module and are written once for both dialects. Migration names and order are unchanged; an already-migrated database applies nothing new and `awthaq migration status` reports no drift. Plugin indexes are created `IF NOT EXISTS` (SSMS-006), so an index built `CONCURRENTLY` beforehand no longer fails the deploy.
  
  Migration: none.
- 80c465c: Concurrent `UserClaims` merges keep every key (plan 24 C7, plan 25 ticket 24, BEH-EA-161). Before, on Postgres, two merges each read the same claims document inside their own transaction and the second upsert dropped the first one's key, while both published `auth.user.claimsUpdated`. The SQL `UserClaimsRecords.modify` now runs under the user's `SqlStore.atomically` lock (`qadi_claims:user:<id>`), so each merge sees the one before it and each event names the keys its own write changed. The store has a RecordsContract suite (ADR-EA-041 decision 9). `@awthaq/qadi` now depends on `@awthaq/sql`.
  
  Migration: a custom adapter through `@awthaq/qadi`'s `UserClaimsRecords` must make `modify` atomic per user (memory: one `Ref.modify`; SQL: the read and the write under a per-user lock), so that concurrent changes never lose one another.
- ce106db: `SubjectExtractorLive` falls through to the next credential when one does not resolve, as `Authentication` does: a stale session cookie beside a valid bearer token, or an unresolvable `x-api-key` beside one, is now the bearer's subject instead of anonymous (BEH-EA-153). An impersonation cookie is judged on its session's `actingAs`.
- 1a598bf: SCIM Groups are written through `OrganizationTeams` with a `Directory` actor (ADR-EA-040, BEH-EA-251) instead of the team records. A directory is now subject to what a member is subject to: `teams.enabled`, `maximumTeams`, `maximumMembersPerTeam`, `allowRemovingAllTeams`, the team veto points and the team observe points. The team, its initial members and the mapping are one transaction (the hand-made compensation for a link race is gone), a delete removes the team, its memberships, every session's active pointer to it and the mapping in one, and a PATCH or PUT roster change is one `applyRoster` unit. Group changes now publish the organization's `auth.organization.team*` events and fire `AfterAddTeamMember` / `AfterRemoveTeamMember`, so a long-lived qadi `DecisionCache` is cleared when a directory off-boards a member. `@awthaq/qadi`'s `DecisionCacheInvalidationLive` also taps `AfterMoveTeam` and `AfterUpdateTeamMemberRole`.
  
  Migration: SCIM Groups need `OrganizationConfig.teams.enabled: true` (otherwise `403`). A directory-driven deployment that deletes every group sets `teams.allowRemovingAllTeams: true` (otherwise deleting the last team is `409`). `POST`/`PUT`/`PATCH`/`DELETE` on `/Groups` may now answer `403` (a quota, a veto, teams off) and `DELETE` also `403`; `ScimShape["deleteGroup"]` gains `ScimForbidden`. `Scim.layer` no longer requires `ActiveContextRecords` or `TeamRecords`; it requires the `OrganizationTeams` service that `Organization.layer` exposes.
- b0b6a4d: One fresh-session gate, `Sessions.requireFresh`, replaces the copies in passkey, two-factor and qadi; `POST /change-email` now uses it.
  
  - `@awthaq/core`: new `Sessions.requireFresh(userId, id, maxAge)` and the `SessionStale` error (`Sessions/Stale`, with `maxAgeSeconds` and a `reason` of `notLive` or `stale`). Both layers share one implementation built on `findOwned` (BEH-EA-320).
  - `@awthaq/passkey`, `@awthaq/two-factor`, `@awthaq/qadi`: enrolment, enable/disable/regenerate and the `reauth` obligation call `requireFresh` and map `SessionStale` to their existing wire errors (`PasskeyReauthRequired`, `TwoFactorReauthRequired`, `Api.ReauthRequired`); the wire contracts do not change.
  - `@awthaq/password`: `POST /change-email` needs a session that proved a credential within the new `PasswordConfig.reauthMaxAge` (default 5 minutes), else `403 PasswordReauthRequired { maxAgeSeconds }`. `PasswordShape["requestEmailChange"]` takes `currentSessionId`.
  
  Migration: a hand-written `Sessions` test double adds a `requireFresh` member. A client of `POST /change-email` handles `PasswordReauthRequired` by running `POST /password/reauthenticate` (or a passkey step-up) and retrying, or the host sets `reauthMaxAge: Duration.infinity` to keep the old behaviour. Callers of `Password.requestEmailChange` pass `currentSessionId`.
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
- Updated dependencies [1371d7b]
- Updated dependencies [8665a4a]
- Updated dependencies [6a28c4d]
- Updated dependencies [1c0d1a7]
- Updated dependencies [0a0059f]
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
  - @awthaq/organization@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
