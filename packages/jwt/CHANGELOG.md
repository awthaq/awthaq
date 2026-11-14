# @awthaq/jwt

## 0.2.0

### Minor Changes

- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- 1cef4be: `@awthaq/ports` adds `Jws`, the one compact-JWS verifier (ADR-EA-057): strict base64url decoding, a `crit` header refused, the five-algorithm table, RFC 7517 key selection and one refetch on an unknown `kid`.
  
  `@awthaq/jwt` verifies through it (BEH-EA-293/298). `JwtCodec.verify` accepts an optional `refetch`, and `VerificationKey.alg` is optional. The lite verifier accepts JWKS keys without `alg` (RFC 7517 §4.4) and ignores keys with `use: "enc"` or a `key_ops` that excludes `verify`. Every verifier refuses a `crit` header (RFC 7515 §4.1.11).
  
  `@awthaq/oauth`: `id_token` verification honours `key_ops` and refuses `crit` (BEH-EA-127); the internal `Jwt` module is removed (it was never exported).
  
  Migration: no code changes. An issuer that sets `crit` on its tokens, or serves its signing key with `key_ops` that exclude `verify`, is now refused; fix the issuer's tokens or JWKS.
- 60ffc76: A signing key's `kid` names one key forever (plan 25 ticket 20, plan 24 R6 and Q3, BEH-EA-296):
  
  - `KeyRing.registerRemoteKey` and `KeyRing.importKey` with the same public key again under its `kid` (same `alg` and public JWK) are a no-op that answers the stored key: a host registering its remote key at every boot keeps working, and re-registering the current remote key rotates nothing.
  - A different key under a stored `kid` fails `SigningKeyRecords.KidTaken` (`"SigningKeyRecords/KidTaken"`), typed, and writes nothing. Before, the in-memory records overwrote the stored key (the current key and its private half included) and the SQL records reported `CurrentKeyConflict`, which `KeyRing` turned into a defect.
  - `KeyRing.registerRemoteKey` that loses a race to a concurrent registration or mint of another current key fails `CurrentKeyConflict` instead of dying.
  - `SigningKeyRecords` and `RevocationStore` run the `RecordsContract` suites (memory, SQLite, Postgres): the single-current, `markRotated`, `retire` and `purgeExpired` races are proven on every adapter.
  
  Migration: a custom adapter through `@awthaq/jwt`'s `SigningKeyRecords` must implement `findByKid(kid)` (the key under `kid` whatever its state, or `None`), and its `create` must never overwrite a stored `kid`: the same public-only key again answers the stored record unchanged, any other key fails `KidTaken` (memory: in the same `Ref.modify` as the insert; SQL: `INSERT … ON CONFLICT (kid) DO NOTHING RETURNING *`, then a read of the stored row). Migration: `SigningKeyRecordsShape.create`'s error channel adds `KidTaken`; `KeyRing.registerRemoteKey`'s adds `KidTaken` and `CurrentKeyConflict`, `KeyRing.importKey`'s adds `KidTaken`. MOD-EA-008, ADR-EA-017.
- 4353896: The JWT signing key is a sealed column, and every store failure is `StoreUnavailable` (plan 05).
  
  - `SigningKeyRecord.privateKeyJwk` is `Option<SealedColumn.Sealed<Jwk>>`; `create` still takes a `Redacted` JWK and the records seal it under `jwt_signing_key:<kid>:privateKeyJwk` (the AAD jwt already used, so no legacy spelling and no data change). `SigningKeyRecords.layerMemory` now seals too, so it requires `Encryption`; `SigningKeyRecords.MemoryEnvelopes` is its test seam. A key sealed under a retired encryption key re-seals on read: before this, rotating `AWTHAQ_ENCRYPTION_KEY_ID` left every signing key on the retired kid forever, so the old key could never be dropped.
  - `Jwt` opens the current key where it signs with `SealedColumn.orDie`: a key that does not open is the `sealedColumn.readable` defect (was `SigningKeyUndecodable`; a public key that does not decode keeps `SigningKeyUndecodable`).
  - `SigningKeyRecords`, `RevocationStore`, `KeyRing` and the `Jwt` methods (`sign`, `signJWT`, `verify`, `verifyJWT`, `introspect`, `jwks`) fail with `StoreUnavailable` instead of dying; `GET /jwt/jwks` declares it, and the bearer resolver lets it through (a store outage is no longer a `401`).
  
  Migration: provide `Encryption` to `SigningKeyRecords.layerMemory`; open `record.privateKeyJwk` with `SealedColumn.orDie(sealed.open)`; handle `StoreUnavailable` on the widened methods; run `SealedColumn.sweep` on `jwt_signing_key.privateKeyJwk` to move rows still on a retired encryption key. BEH-EA-296.
- Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.
  
  Migration:
  
  - `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-266, ADR-EA-020.
  - `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-271.
  - `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-258.
  - `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-259, BEH-EA-261.
  - `AdminAccounts.setUserPassword` now consults `Hooks.BeforeCredentialReset` (with no second-factor code) and can fail with `HookAborted` (403); for a user protected by `@awthaq/two-factor` an administrator can no longer silently replace the password. BEH-EA-259.
- 9e6302f: `AuthPlugin.Service` takes an optional `sealedColumns` (the `SealedColumn.column` declarations of the plugin's own tables), `Auth.make` refuses a column on a table the plugin does not own or declared twice (`Auth/SealedColumnDeclarationInvalid`), and `auth.sealedColumns` lists every one, so a rotation sweep cannot forget the TOTP secret or a signing key: `SealedColumn.sweepDeployed({ also: auth.sealedColumns })`. The webhooks, organization, saml, jwt and two-factor plugins declare their seven columns (ADR-EA-019 rev 1.3, BEH-EA-339).
  
  Migration: none (the field is optional). A plugin that seals a column should declare it.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- f8df2e4: `Jwt.records` is the plugin's signing-key and revocation stores as one matched `{ memory, sql }` bundle, the stores' service keys gain the `/records/` segment, and `Jwt.layer` now provides its key ring itself.
  
  - `SigningKeyRecords` and `RevocationStore` are keyed `awthaq/jwt/records/<Name>`; the bundle provides both over memory and over SQL (the `MemoryEnvelopes` test seam is not part of it).
  - `Jwt.layer` absorbs `KeyRing.KeyRing.layer` (always required, a `LayerRef` over `SigningKeyRecords`); it stays in the output. `JwtConfig` stays the host's (configuration).
  
  Migration: remove your own `KeyRing.KeyRing.layer` from the host graph (keeping it is harmless but redundant). Code that built a `Context` by the old key string must use the class. A host replaces the pair of `layerMemory` / `layerSql` layers with `Jwt.records.memory` / `Jwt.records.sql`.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 7e9834e: Plugins contribute their own retention rules to `Retention.sweep`.
  
  - `@awthaq/core`: new `Retention.contribute({ id, order?, make })` and `Retention.RetentionRegistry` (provided by `Hooks.HooksLive`, like the erasure registry). `Retention.sweep` runs every contribution after the core purges, isolates a failing one, and reports `SweepReport.plugins: ReadonlyArray<{ id, deleted, failed }>`; its requirements gain `RetentionRegistry`. ADR-EA-031 Decision 6 amended (revision 1.4); BEH-EA-337.
  - `@awthaq/saml`: contributes `saml.sessions` and no longer prunes session records inside every sign-in.
  - `@awthaq/device-authorization`: contributes `device_authorization.grants`. `@awthaq/jwt`: contributes `jwt.revocations` (`RevocationStore` gains `purgeExpired`). `@awthaq/organization`: contributes `organization.invitations` (new `invitationRetention`, default 30 days; `InvitationRecords` gains `purgeExpired`). `@awthaq/passkey`: contributes `passkey.challenges`. `@awthaq/webhooks`: contributes `webhooks.deliveries` (the worker keeps its hourly prune).
  
  Migration: a composition that installs one of these plugins must provide `Retention.RetentionRegistry`; every `Auth.make` composition and `Hooks.HooksLive` already do. A host with its own `RevocationStore` or `InvitationRecords` implements `purgeExpired`. SAML session records now age out only when the host runs `Retention.sweep` or `Retention.layerScheduled`; a host that relied on the inline prune must schedule the sweep.

### Patch Changes

- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 85c9e47: `@awthaq/server`'s `Credentials` module is the one place a request's credentials are read, ordered, resolved, admitted and their rotation handed off (ADR-EA-042). `Authentication`, `SubjectExtractorLive` and `getSession` are adapters over it. A tier now also refuses a session-derived principal it does not admit. A claimed credential (API key, JWT) is resolved at most once per request.
  
  Migration: `Authentication.PrincipalResolver*`, `Authentication.contribute`, `Authentication.CredentialResolvers*` -> `Credentials.*` (same names; `Authentication.CredentialCarrier` is `Credentials.ClaimCarrier`). `Authentication.resolvePrincipal`/`resolveSession`/`ResolvedSession` are gone: use `Credentials.make` and `step`/`resolve` with `Credentials.httpScope(request)`, and `Sessions.VerifiedSession`. Web: `verifySessionToken`/`VerifySessionToken` -> `resolveSessionCookies`/`ResolveSessionCookies` (the whole cookie header is the dedup unit); `Session.principal` is `Api.UserPrincipal`.
- 1cef4be: `GET /jwt/jwks` now names `kid` and `alg` for a key registered with `KeyRing.registerRemoteKey` from a bare public JWK (BEH-EA-292). A KMS or HSM public JWK carries neither, so the served entry used to have no `kid` and no `alg`. Downstream verifiers, including `@awthaq/jwt/verify` and `@awthaq/next/edge`, can now verify tokens signed by a remote key. Only what is served changes; what `registerRemoteKey` stores is untouched.
  
  Migration: none; a downstream verifier picks the corrected set up within its JWKS cache lifetime (`cacheTtl`, default 10 minutes).
- 1cef4be: A token whose header, payload or signature segment is not base64url is now refused like every other bad token (BEH-EA-293). `JwtCodec.verify` decodes segments with a strict `Base64Url.decode` that returns a `Result`, so malformed input is a typed `JwtInvalidError`, never a defect.
  
  - `POST /jwt/introspect` answers `{"active":false}` instead of 500.
  - An opted-in bearer request answers 401 instead of 500.
  - `verifySessionJwt` (`@awthaq/next/edge`) resolves `undefined` instead of rejecting.
  
  Migration: none.
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
