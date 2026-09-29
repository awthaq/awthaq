# @awthaq/core

## 0.2.0

### Minor Changes

- Administrator account deletion and credential changes (`AdminAccounts`), and a mailed change-email flow in the password plugin.
  
  - `@awthaq/admin`: the opt-in `AdminAccounts` plugin (`Auth.make([Admin, AdminAccounts])`, group `admin.accounts`) adds `DELETE /admin/users/:userId` (the one `AccountErasure` cascade), `POST /admin/users/:userId/email` (mails a `change-email` token to the new address; the owner confirms) and `POST /admin/users/:userId/password` (through the `PasswordHasher` port, revoking every session), each behind its own fail-closed predicate (`canDeleteUsers`, `canManageCredentials`) with audited `auth.admin.*` events. `AdminConfig` gains those predicates, `passwordPolicy` and `links.changeEmail`; `@awthaq/ports` is now a dependency.
  - `@awthaq/password`: `POST /change-email` (authenticated) and `POST /change-email/confirm` (public), typed `EmailDeliveryFailed`/`EmailChangeNotSupported`, rate limits per requester, per target inbox and per token, `auth.user.emailChanged`, a notice to the previous address, `PasswordConfig.links.changeEmail`.
  - `@awthaq/core`: `EmailChange` (the shared `change-email` purpose) and the events `auth.user.emailChanged`, `auth.admin.userDeleted`, `auth.admin.userEmailChangeRequested`, `auth.admin.userPasswordSet` (a new `AuthEvent` union member).
  
  Migration: none required (all additive). A host that switches on `AdminAccounts` provides `PasswordHasher`, `Mailer` and `AccountErasure`, and the password plugin must be composed for an admin-requested email change to be confirmed. BEH-EA-221/222/224 (amended), BEH-EA-118.
- d7351b7: `runPluginContractTests` checks a plugin's own hook taps (PV-260, BEH-EA-200).
  
  - `plugin.taps` entries (`AuthPlugin.DeclaredTap`) now carry, beside `point` and `order`, the tap's `kind`, its `owner` (the plugin id), the `handler` itself and `exercise(input)`/`install(owner)` (`HookPoint.TapDeclaration` gained `kind`, `handler` and `exercise`). `exercise` runs the handler against a stub validated against the point's input schema and returns its `Exit`, unfiltered by any point's failure semantics.
  - `runPluginContractTests` always verifies that each declared tap registers at its point under the plugin's id and declared order, and takes an opt-in `hooks: [{ point, input }]` that runs the plugin's actual handlers: an observe tap must not try to abort (`HookAbort`) and must not fail the observed operation, a veto tap may only abort with `HookAbort`, a divert tap must not fail.
  
  Migration: a hand-built `AuthPlugin.Any` may still omit `taps`; code that builds a `DeclaredTap` by hand must supply the new fields (build it from `Point.declareTap(...)` and add `owner`).
- 3514b28: The OAuth 2.0 device authorization grant (RFC 8628) ships as `@awthaq/device-authorization`, and `awthaq login` uses it (DAG-002, DAG-004, DAG-005; BEH-EA-299 to BEH-EA-307).
  
  - `@awthaq/device-authorization`: `POST /device/code` and `POST /device/token` (the polling states `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, at-most-once redemption), `POST /device/verify` / `approve` / `deny` for the page a signed-in user approves on, public clients from configuration or an operator's `registerClient`, hashed user and device codes, per-address, per-session and per-client rate limits, a `BeforeDeviceApproval` veto, erasure and export contributions, and `purgeExpired`. The minted session is an ordinary bearer session carrying the approving session's `amr`. Tables `device_authorization_grant` and `device_authorization_client` (append-only migrations); Postgres-tested.
  - `@awthaq/cli`: `awthaq login` without a token runs the device flow (a code and URL on stderr, a browser opened unless `--no-browser`, polling with +5 seconds on every `slow_down`); `--client-id` names the client (default `awthaq-cli`, which the plugin registers by default). A server without the plugin exits 9 naming it; a denied or expired request exits 8. `--token` and `AWTHAQ_TOKEN` are unchanged.
  - `@awthaq/core`: two audit events, `auth.deviceAuthorization.approved` and `.denied`.
  - `@awthaq/two-factor`: the session gate no longer diverts an `amr` that already records `mfa` (only this plugin's own completed challenge writes it), so a device approved from a session that proved a second factor is not asked again.
  - `@awthaq/api`: `Api.BackChannel`, an annotation for credential-in-the-request endpoints called by non-browser clients (`apikey.token`, the device `code`/`token` pair): they deliberately carry no `CsrfProtection`, and `awthaq doctor` no longer flags them as unprotected mutating endpoints (`@awthaq/api-key` annotates its token group).
- cb155d4: Confirming an email change ends every session of the account (BEH-EA-053, REQ-EA-686).
  
  `POST /change-email/confirm` (`Password.confirmEmailChange`) is a public, token-authenticated request, so it has no caller session to rotate. It now calls `Sessions.revokeAll(userId, "emailChanged")` in the same transaction that replaces and verifies the address; `auth.session.revoked` carries the new `SessionRevocationReason` `"emailChanged"`.
  
  Migration: a client that stayed signed in across an email change is signed out when the change is confirmed and signs in again under the new address; an exhaustive `switch` over `SessionRevocationReason` gains an `"emailChanged"` case.
- f831b6c: Finishes `@awthaq/webhooks` and `@awthaq/saml` (BEH-EA-308 through 318, ADR-EA-036).
  
  **Webhooks.** The event envelope and `AuditLogRecord` carry `tenantId` (the value the audit row already stored); endpoints belong to a tenant, hear only that tenant's events and are administered inside that tenant's scope (`platformEndpointsHearAllTenants` opts the platform's own endpoint into every tenant's); `POST .../endpoints/:id/test` sends a signed synthetic `webhook.test` event through the real delivery path (one attempt, never counted against the endpoint); every successful administrative mutation publishes an `auth.webhooks.*` audit event of identifiers; per-endpoint custom headers (values sealed, never returned); and the connection is pinned to the address that was checked (`HostResolver.pin`, `PinnedHttp` in `@awthaq/ports`, `WebhookTransport.layerNodePinned`), closing DNS rebinding.
  
  **SAML.** Signed AuthnRequests with an SP key stored sealed (`SamlSpKeys`); Single Logout in both directions over Redirect and POST, revoking with the new session reason `federatedLogout`; the `saml.admin` group (fail-closed, tenant-scoped connection CRUD, IdP metadata import from XML or a URL through the pinned fetcher, refresh, SP key rotation) and `saml.account` (`POST /auth/saml/logout`); role mapping under a `canGrant` ceiling (`Organization.checkRoleCeiling`/`syncMemberRoles`); and the `Sso` dispatcher. IdP-initiated login and encrypted assertions stay refused (ADR-EA-036).
  
  Migration: `Webhooks.Webhooks.background()` requires a `WebhookTransport` instead of an `HttpClient` (provide `WebhookTransport.layerNodePinned`, or `WebhookTransport.layerHttpClient` over your client, which cannot pin); `EventMetadata`/`Published` gain a required `tenantId: Option<string>` (hand-built envelopes add `tenantId: Option.none()`); `AuditLogRecord` gains `tenantId`; `EndpointRecord` gains `tenantId`, `headers` and `headerNames`, and `EndpointDto` gains `tenantId` and `headerNames`; the plugin migrations `add_webhooks_endpoint_tenant`, `add_webhooks_endpoint_headers`, `add_saml_connection_signing_logout_roles`, `create_saml_sp_key` and `create_saml_session` are appended; `SamlConnections.layerStore` now requires `SamlSpKeys` (which requires `Encryption`) and the `Organization` service, and `Saml.Saml.layer` requires `SamlSpKeys`, `SamlMetadataFetcher` and the admin/user authentication; `SamlConfig.rateLimits` gains `slo` and `sso`; `SessionRevocationReason` gains `federatedLogout`; `OrganizationShape` gains `checkRoleCeiling` and `syncMemberRoles`; `HostResolver.refusal` is now `HostResolver.pin` underneath.
- e073887: The OAuth callback lands through a same-site interstitial while the session cookie is `SameSite=Strict` (PV-016).
  
  A `Strict` session cookie set on a redirect chain the provider began cross-site is stored but withheld from the first landing request, so a server-rendered landing page saw an anonymous request once. `OAuthConfig.bounce` (default `true`) makes a browser callback answer `200 text/html`, a small `no-store` page that meta-refreshes to the `callbackURL`, in place of the `302`; the session cookie is set on that response as before and the follow-up navigation (initiated by a page of your own site) carries it. The native deep-link return (`mode=native`) and `Lax`/`None` session cookies never bounce. `@awthaq/core` exports `SessionCookie.isStrict`; the callback's declared success type is now `302` or `text/html`; the native outcome of `OAuth.callback` gains `native: true`.
  
  Migration: a host or test that asserted the callback's `302` under the default `Strict` cookie now sees a `200` interstitial with the same `Set-Cookie`; set `OAuth.config({ bounce: false })` to keep the plain `302`. BEH-EA-122, BEH-EA-055.
- Add TOTP two-factor authentication (`@awthaq/two-factor`), passwordless sign-in by a POST-only magic link and a six-digit email code (`@awthaq/magic-link`), and session authentication assurance. Verification can mint numeric values with a per-token attempt budget; sessions record RFC 8176 `amr`, which reaches qadi policies and principal JWTs (`amr`, `auth_time`); `Hooks.BeforeCredentialReset` lets a second factor guard password reset; an opt-in admin layer notifies the owner when impersonation starts.
  
  Migration:
  
  - `RateLimiter.of(...)` implementations must now provide `check` (a read-only peek; `layerPermissive` is a no-op). BEH-EA-266, ADR-EA-020.
  - `VerificationRepository.upsertLive` and the `VerificationToken` model gain `maxAttempts` and `attempts`; run core migration 28. BEH-EA-271.
  - `Sessions.AuthMethod` gains `"sms"`; `UserPrincipal` gains `authenticatedAt`. Exhaustive matches over either must handle the new member. BEH-EA-258.
  - `Password.confirmReset` consults `Hooks.BeforeCredentialReset` and answers `SecondFactorRequired` (401) for a user with a confirmed second factor when `secondFactorCode` is missing; composing `@awthaq/two-factor` requires `TwoFactor.sessionGate` and either `TwoFactor.credentialResetGate` or `TwoFactor.noCredentialReset`. BEH-EA-259, BEH-EA-261.
  - `AdminAccounts.setUserPassword` now consults `Hooks.BeforeCredentialReset` (with no second-factor code) and can fail with `HookAborted` (403); for a user protected by `@awthaq/two-factor` an administrator can no longer silently replace the password. BEH-EA-259.
- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- The `userFields` extension point (SAM-004): a plugin declares typed scalar fields on `users`, and the rest is derived.
  
  - `AuthPlugin.Service` takes `userFields: { plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])), nickname: UserFields.field(Schema.String) }`. `Auth.make` generates a `NNNN_<plugin>_add_user_field_<field>` migration per field (`ALTER TABLE users ADD COLUMN "<plugin id>_<field>"`, nullable, dialect-neutral), returns the composed `userFields` (typed by `Auth.UserFieldsOf<P>`) and `userFieldsLayer`, and lists them in `manifest.userFields`.
  - `Users.getFields`/`setFields` (validated, `source: "client" | "server"` gated per BEH-EA-048) and the typed `Users.typedFields(auth.userFields)`; `UserFields.client(auth.userFields)` for the browser; `UsersRepository.readFields`/`writeFields` in `@awthaq/sql`.
  - `PATCH /user` accepts `fields` (client-writable fields only: 403 `UserFieldNotWritable` for a `serverOnly` one, 422 `UnknownUserField`/`InvalidUserField`), and `AccountDto` carries `fields`. `TestAuth.layer` provides the registry.
  
  Migration: `AccountDto` now has a required `fields` (`{}` when none are declared); a hand-built `UsersShape` implements `getFields`/`setFields`; a hand-built `Manifest` has `userFields: []`; provide `auth.userFieldsLayer` to `Users` when a composition declares fields. ADR-EA-035, BEH-EA-040/048.
- 4cd6174: A bounded session-rotation grace window, an `SmsSender` port with an E.164 rate-limit key, and passkey Related Origin Requests.
  
  - **Rotation grace (RRS-005, RRC-006).** The secret a throttled touch replaces keeps verifying for `SessionConfig.rotationGrace` (default 30 seconds, `Duration.zero` disables it). Presenting it inside the window succeeds, re-rotates and hands back a fresh secret in `rotated`, so a lost `Set-Cookie` or `set-auth-token` no longer strands the client; it is per session, never a reuse signal (no family revocation, no `auth.session.reuse`), and `auth.session.rotated` carries `viaGrace` for those recoveries. New sessions columns `previousSecretHash`/`previousSecretExpiresAt` (core migration 29); `SessionsRepository.touch` takes them (optional).
  - **`SmsSender` port (SOS-002).** `@awthaq/ports` exports `SmsSender` (`send`/`sent`, `layerNoop`/`layerMemory`/`layerConsole`, a typed `SmsDeliveryFailed`), mirroring `Mailer`. `RateLimits.phoneKey(read, options?)` (SOS-007) is a key strategy that normalises the destination to E.164 first, so an SMS endpoint gets a per-recipient cap alongside `"ip"` and `"principal"`.
  - **Related Origin Requests (TC-008).** `PasskeyConfig.relatedOrigins` (default `[]`) lists exact https origins outside `rpId` that may use its passkeys; every ceremony accepts them and a new anonymous `GET /.well-known/webauthn` (group `passkey.wellKnown`) serves the list (404 while empty).
  
  Migration: a deployment that relied on the replaced session secret dying instantly sets `SessionConfig.rotationGrace: Duration.zero`. Apply core migration 29 (two nullable columns). A hand-built `Sessions` table in tests needs `previousSecretHash TEXT, previousSecretExpiresAt TEXT`. `Auth.make([Passkey])` lists a fifth group, `passkey.wellKnown`. BEH-EA-052, BEH-EA-133.
- `AuditLog` fails with the typed `StoreUnavailable` instead of dying on an outage, `AuthEvents.publish` applies an explicit `AuditWritePolicy`, and hot session writes retry transient SQL failures.
  
  - Every `AuditLog` method (`record`, `list`, `replay`, `pseudonymizeActor`, `purge`) carries `StoreUnavailable` in its error channel; `DataExport`, `Retention` and `EventRelay` propagate it.
  - `AuthEvents.publish` stays `Effect<void>`. When the audit row cannot be written it now logs, counts `awthaq_audit_write_failed_total{tag}` and lets the operation succeed (`"bestEffort"`, the new default), or dies with the `StoreUnavailable` (`"required"`, the previous behaviour) when the layer is built with `AuthEvents.auditWritePolicy("required")`.
  - `Errors.retryTransient` bounds a jittered-exponential retry of a retryable `SqlError` (`SQLITE_BUSY`, deadlock, serialization failure); `Sessions.issue` and the idle-refresh touch in `Sessions.verify` use it (SEA-002).
  
  Migration: a caller of `AuditLog.list`/`replay`/`record`/`pseudonymizeActor`/`purge` handles (or lets propagate) `StoreUnavailable`. A deployment that must never complete an operation without its audit row provides `AuthEvents.auditWritePolicy("required")`. ADR-EA-028 (revision 1.1), BEH-EA-100.

### Patch Changes

- Updated dependencies [3514b28]
- Updated dependencies [f831b6c]
- Updated dependencies
- Updated dependencies
- Updated dependencies [4cd6174]
- Updated dependencies [5d5b3c6]
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0
  - @awthaq/sql@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/sql@0.1.0
