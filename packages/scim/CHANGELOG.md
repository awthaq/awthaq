# @awthaq/scim

## 0.2.0

### Minor Changes

- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- a305c26: Deleting an organization removes the connections that hang off it, in its own transaction (ADR-EA-040, BEH-EA-235). `OrganizationDeletion` is an aggregating registry (like `Erasure.contribute`), exposed by `Organization.layer`; `OrganizationDirectory.delete` runs every contribution's `inTransaction` after its own cascade and every `afterCommit` once the transaction has committed, so a failing contribution rolls the deletion back instead of leaving rows behind. OIDC/OAuth2 connections (`connectionsOnOrganizationDelete`), SAML connections (their domains, SP keys and Single Logout sessions) and SCIM connections (and their mappings, through the new `ScimRecords.removeAllForOrganization`) previously outlived the organization. The OIDC `OrganizationConnectionStore` now refuses an unknown or suspended organization (`InvalidConnection`) and takes an `Actor` on `create`, `update` and `remove`, publishing the new core events `auth.organization.connectionCreated` / `connectionUpdated` / `connectionDeleted` (identifiers only, with the acting user's id when the actor names one; `@awthaq/core`).
  
  Migration: `OrganizationConnections.cleanupOnOrganizationDelete` (an opt-in observe tap whose failures were swallowed) is replaced by `connectionsOnOrganizationDelete`; provide it where the store is. `OrganizationConnectionStore.create(input)` becomes `create(actor, input)`, `update(organizationId, connectionId, patch)` becomes `update(actor, organizationId, connectionId, patch)` and `remove(organizationId, connectionId)` becomes `remove(actor, organizationId, connectionId)` (use `OrganizationActor.application("...")` for application code). `OrganizationConnections.layerStore` now requires the exposed `OrganizationDirectory` and `AuthEvents`. `Saml.layer` and `Scim.layer` now require the `OrganizationDeletion` registry that `Organization.layer` exposes. A custom `ScimRecords` implements `removeAllForOrganization(organizationId)`. A new tenancy table is not needed: no migration.
- 161d66c: `@awthaq/scim` owns its events (ADR-EA-049): the five `auth.scim.*` definitions moved from `@awthaq/core` to `ScimEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads, actors, personal-data fields and attempt lanes are unchanged.
  
  Migration: `AuthEvents.ScimUserProvisionedEvent`, `AuthEvents.ScimUserDeactivatedEvent`, `AuthEvents.ScimUserReactivatedEvent`, `AuthEvents.ScimUserDeletedEvent` and `AuthEvents.ScimGroupChangedEvent` → `ScimEvents.<same name>` from `@awthaq/scim`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.scim.*`: subscribe with `AuthEvents.on(ScimEvents.ScimUserProvisionedEvent, …)`, narrow the stream with `AuthEvents.is(ScimEvents.ScimUserProvisionedEvent)`, decode an audit row with `AuditLog.payloadAs(ScimEvents.ScimUserProvisionedEvent)`, and replace `AuthEvents.payloadOf(e)` with `Schema.decodeUnknownSync(ScimEvents.ScimUserProvisionedEvent)(e)`. ADR-EA-049, BEH-EA-101.
- 3d00f58: Every plugin declares its tables' tenancy (plan 05, BEH-EA-005, BEH-EA-328).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `tables` is a record keyed by table name (each `<id>_...`) whose values are `AuthPlugin.Table.partitioned | keyed | derived | global`. A table with no declaration does not compile. The class keeps `tables` (the names) and gains `tenancy`. `Auth.make` validates the declarations (`Auth/TenancyDeclarationInvalid`) and exposes `auth.tenancy` and `manifest.plugins[].tenancy`; pass `auth.tenancy` to `TenantScope.enableRls({ plugins })`.
  - `@awthaq/cli`: `awthaq plugin list` prints each table with its tenancy.
  - Every first-party plugin declares its tables (see ADR-EA-018 decision 10).
  
  Migration: `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("why") }`. Pick the kind: `partitioned()` for a table with a nullable `"tenantId"` column stamped from the ambient tenant; `keyed("organizationId")` for a table keyed by an organization id; `derived(parentTable, "joinColumn")` for a child scoped through its parent; `global(reason)` for a deliberately tenant-blind table, with the reason. `tables: []` becomes `tables: {}`. A hand-built `AuthPlugin.Any` may still use `tables: [..]` and omit `tenancy`.
- 2a12e24: `Scim.records` is the plugin's record store as one matched `{ memory, sql }` bundle, and `Scim.layer` now provides its bearer authentication and connection store itself.
  
  - `ScimRecords` is keyed `awthaq/scim/records/ScimRecords`; the bundle provides it over memory and over SQL.
  - `Scim.layer` absorbs `ScimConnections.ScimAuthenticationLive` (the plugin-owned `ScimAuthentication` middleware its group declares) and `ScimConnections.layerStore` (always required, built over `ScimRecords`); both stay in its output.
  
  Migration: remove your own `ScimConnections.ScimAuthenticationLive` and `ScimConnections.layerStore` from the host graph (keeping them is harmless but redundant). Code that built a `Context` by the old record key string must use the class. A host replaces `ScimRecords.layerMemory` / `ScimRecords.layerSql` with `Scim.records.memory` / `Scim.records.sql`.
- d82b7a4: The request context is required, by the type (ADR-EA-047). Every awthaq group declares `Api.RequestContext` as its last (outermost) middleware; `AuthHttp.middlewareFor` (so `AuthHost.layer` and `TestAuth`) derives its implementation, `RequestContext.RequestContextLive`, which reads the `ClientAddress` port, `x-request-id`/`traceparent` and `User-Agent` once per request. The four authentication middlewares `require` the context, so declaring them outside it is a compile error, and credential claims receive it. The global `RequestContext.layer`, its build-time warning and `AuthHost`'s `requestContext` dial are gone. qadi's Path B extractor reads the context when its group declares it and captures the same facts itself otherwise. The OpenAPI document and the derived clients are unchanged.
  
  Migration: delete `RequestContext.layer` from your server layer and `requestContext` from `AuthHost.layer`'s options (the context is derived with the middleware; it needs a `ClientAddress` layer, and `ClientAddress.layerDirect` keeps the socket-peer behaviour); remove any provision of `RequestContext.warnWhenAbsent`. If you build host middleware by hand, provide `RequestContext.RequestContextLive`. On your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware (qadi's `withAuthorizedSubject`/`withOptionalAuthorizedSubject` do it for you). A custom credential resolver may read `Api.AuthRequestContext`; `Credentials.httpScope(request, context)` takes the context. `SubjectExtractorLive` now requires `ClientAddress` and `SecureRandom`.
- 01b82ea: SCIM `DELETE /Users/:id` with `deleteBehavior: "erase"` now runs the account erasure (ADR-EA-031, BEH-EA-250): every plugin's rows (organization memberships and invitations, passkeys, roles, ...), linked accounts, sessions, verification tokens, the user and the audit pseudonymization, in one transaction, announced by `auth.user.deleted` with `deletedBy: "directory"`. It previously deleted only the user row and its sessions, leaving memberships (a taken seat), linked accounts (a SAML sign-in for the same NameID then failed) and the audit trail behind. `@awthaq/scim` also takes part in every erasure (`scimErasure`: the user's `scim_resource` rows) and in the data-subject export (`scimExport`), and adds a `scim_resource(kind, "resourceId")` index migration.
  
  Migration: `AccountErasure.eraseAccount(userId, options?)` is now `eraseAccount(userId, initiator)` with a required `Erasure.ErasureInitiator`: `{ deletedBy: "self" }` becomes `ErasureInitiator.Self()`, `{ deletedBy: "admin" }` becomes `ErasureInitiator.Admin({ adminUserId })`, and a call with no options (which meant "self") becomes `ErasureInitiator.Self()`. `auth.user.deleted.deletedBy` gains `"directory"` and optional `adminUserId`/`connectionId`/`organizationId`: an exhaustive switch on `deletedBy` needs a `"directory"` case. A composition of `Scim.layer` must now provide `Erasure.AccountErasure` (`Erasure.layer`; `AuthHttp` compositions already do). A SCIM `DELETE` racing another erasure of the same user now answers 404 instead of 204. Run the new SCIM migration.
- 1a598bf: SCIM Groups are written through `OrganizationTeams` with a `Directory` actor (ADR-EA-040, BEH-EA-251) instead of the team records. A directory is now subject to what a member is subject to: `teams.enabled`, `maximumTeams`, `maximumMembersPerTeam`, `allowRemovingAllTeams`, the team veto points and the team observe points. The team, its initial members and the mapping are one transaction (the hand-made compensation for a link race is gone), a delete removes the team, its memberships, every session's active pointer to it and the mapping in one, and a PATCH or PUT roster change is one `applyRoster` unit. Group changes now publish the organization's `auth.organization.team*` events and fire `AfterAddTeamMember` / `AfterRemoveTeamMember`, so a long-lived qadi `DecisionCache` is cleared when a directory off-boards a member. `@awthaq/qadi`'s `DecisionCacheInvalidationLive` also taps `AfterMoveTeam` and `AfterUpdateTeamMemberRole`.
  
  Migration: SCIM Groups need `OrganizationConfig.teams.enabled: true` (otherwise `403`). A directory-driven deployment that deletes every group sets `teams.allowRemovingAllTeams: true` (otherwise deleting the last team is `409`). `POST`/`PUT`/`PATCH`/`DELETE` on `/Groups` may now answer `403` (a quota, a veto, teams off) and `DELETE` also `403`; `ScimShape["deleteGroup"]` gains `ScimForbidden`. `Scim.layer` no longer requires `ActiveContextRecords` or `TeamRecords`; it requires the `OrganizationTeams` service that `Organization.layer` exposes.
- 93edeb7: The SCIM records are scoped by their organization and fail with `StoreUnavailable` (plan 05).
  
  - `ScimRecords.findConnectionByTokenHash` (the bearer token is the capability that finds a connection before any tenant is known), `linksOfResource` and `unlinkResource` (erasure and export read a person's links in every connection) take a `TenantScoped.CrossTenant` as their first argument and run under `TenantScoped.lift`. `scim_connection` is Keyed by `organizationId`; `scim_resource` is Derived through it.
  - Every `ScimRecords` and `ScimConnectionStore` method fails with `StoreUnavailable` instead of dying; the SCIM bearer middleware declares it, so an outage while authenticating answers `503` rather than a `401` that would make a directory service discard a working token.
  
  Migration: pass a witness (`TenantScoped.crossTenant("<why>")` from `@awthaq/sql`) to `findConnectionByTokenHash`, `linksOfResource` and `unlinkResource`; handle `StoreUnavailable` on the widened methods. `@awthaq/api` moves from `devDependencies` to `dependencies` (its `ScimApi` imports it). BEH-EA-246.
- 197eef2: SCIM provisioning is a sign-up (ADR-EA-038): `POST /Users` consults `BeforeSignUp` with strategy `scim:<organizationId>:<connectionId>` (a veto answers 403), the user, mapping and membership commit as one unit, and `auth.user.created` and `AfterSignUp` run after it commits, alongside `auth.scim.userProvisioned`. A failed provisioning is abandoned through `SignUp.createWith`, with no delete a legal-hold tap could veto.
  
  Migration: the `Scim` layer now requires the `SqlTransaction` port. A host `BeforeSignUp` tap now sees directory provisioning; a tap that must not apply to a directory exempts strategies starting with `scim:`.
- 37e5cdd: A user can only be deleted by `Erasure.AccountErasure.eraseAccount` (BEH-EA-046, ADR-EA-031). `Users` no longer has `delete`; the row store primitive is the new `Users.UserRemoval` service, whose `remove` takes an `Erasure.ErasureClearance` that only `AccountErasure` can mint, after the `BeforeUserDelete` veto passes. The veto therefore runs exactly once per erasure (it ran twice). New: `Users.createWith(input, complete)` creates a user and abandons it (no veto, no event) if `complete` fails; `@awthaq/scim`'s provisioning uses it, so a refused `POST` no longer consults the delete veto nor sweeps invitations addressed to the same email in other organizations.
  
  Migration: replace `users.delete(id)` with `erasure.eraseAccount(id, Erasure.ErasureInitiator.…)`; a caller that deleted a user it had just created as a rollback uses `users.createWith`. `Users.layerMemory` / `layerSql` now provide `Users | UserRemoval` and no longer require `Hooks.BeforeUserDelete`; a test double of `Users` built as `Layer.effect(Users.Users, …).pipe(Layer.provide(Users.layerMemory))` must use `Layer.provideMerge` so the real `UserRemoval` comes along, and a hand-written `UsersShape` replaces `delete` with `createWith`. A `BeforeUserDelete` tap no longer needs to be idempotent across one erasure. A test that needs an orphaned row (a plugin row whose user is gone) erases through `Erasure.layer` over a fresh, empty `Erasure.registryLayer`.

### Patch Changes

- 1cef4be: `GET /admin/config` under a tenant now shows that tenant's configuration in force, not the build value. Each item carries a `scope` (`tenant` or `deployment`) and `source` may be `"tenant"` (BEH-EA-355, BEH-EA-356). Descriptors now also exist for MagicLink, EmailOtp, Scim, Sso, `AccountsPolicy` and `RateLimitOverrides`.
  
  For plugin authors, each configuration key declares its scope next to its reference: `Tenant.perTenant(Reference, { boot })` or `Tenant.perDeployment(Reference)` (ADR-EA-018 decision 8, revision 1.7). A module reads the key with `Tenant.inForce(declared)`, `config(...)` returns the declaration's `layer`, and a `ConfigDescriptor` is made from the declaration. A per-deployment `config(...)` provides `Tenant.DeploymentConfigApplied`, so a `TenantConfig` lookup that carries one does not type-check. `TwoFactorConfig` and `RolesConfig` are per-deployment too, so a `TenantConfig` lookup carrying either no longer type-checks (Migration: provide them once through `TwoFactor.config(...)` / `Roles.config(...)`); `ConfigDescriptor.make` takes a declaration only, not a bare `Context.Reference`.
  
  Migration: a plugin's `Tenant.configInForce(Ref, built)` (removed) becomes a declaration `const RefScoped = Tenant.perTenant(Ref)` (or `Tenant.perDeployment(Ref)`) and `const now = yield* Tenant.inForce(RefScoped)`; its `config(...)` returns `RefScoped.layer(value)`, and `ConfigDescriptor.make(RefScoped, …)` replaces `ConfigDescriptor.make(Ref, …)`. A `TenantConfig` lookup that merged a per-deployment `config(...)` (magic link, email OTP, api-key, device authorization, SAML, SSO, SCIM, or a host-level key such as `SessionCookie.config`) no longer compiles: that setting was never applied per tenant; move it to the deployment's composition. `GET /admin/config` items carry `scope`, `source` may be `"tenant"`, and under a tenant the items show that tenant's values. `EffectiveConfig.snapshot` takes the build context as its first argument.
- 1cef4be: SCIM tokens, organization invitation tokens and verification values are now hashed through `SecretHash.digest`, and every hex encoding goes through `Hmac.toHex`. The stored hashes are byte-identical (pinned by known-answer tests), so existing tokens, invitations and imported scrypt passwords keep working.
  
  Migration: none.
- a5927c3: The organization row is a system module, `OrganizationDirectory` (`find`, `findActive`, `requireActive`, `isSlugAvailable`, `listForUser`, `listPage`, `create`, `update`, `delete`, `suspend`, `reinstate`), exposed by `Organization.layer` (ADR-EA-040). `create` writes the organization and its creator's membership in one transaction (a failed creation leaves neither) and the creator's membership now fires `AfterAddMember`. `suspend` and `reinstate` take a `PlatformAdminActor`, run the new `BeforeSuspendOrganization` / `AfterSuspendOrganization` and `BeforeReinstateOrganization` / `AfterReinstateOrganization` hook points, and still publish `auth.admin.organizationSuspended` / `organizationUnsuspended`. `AdminTenants` suspends, reinstates and lists through the Directory instead of writing `OrganizationRecords`, so a platform suspension is observable and `@awthaq/qadi`'s `DecisionCacheInvalidationLive` now clears a long-lived decision cache on suspension, reinstatement, a team move and a team-role change. The SAML and SCIM token and connection gates read `OrganizationDirectory.findActive` / `find`. `OrganizationQadi.relationships` reads the Directory.
  
  Migration: `AdminTenantsShape["suspendOrganization"]` and `["unsuspendOrganization"]` (and the `/admin/organizations/:id/suspend` and `/unsuspend` endpoints) can now answer `HookAborted` (`403`) when a `BeforeSuspendOrganization` / `BeforeReinstateOrganization` tap vetoes. `AdminTenants`, `SamlConnections.layerStore`, `Saml.layer` and `ScimAuthenticationLive` require the exposed `OrganizationDirectory` instead of `OrganizationRecords`. A host that installs `DecisionCacheInvalidationLive` must provide `OrganizationHooksLive` (as before) which now includes the four new points. `OrganizationLive` compositions are unchanged. The tenant middleware still reads `OrganizationRecords` directly (a raw read of a suspended organization is deliberate).
- 41f57a0: Membership is a system module, `OrganizationMembers` (`add`, `setRoles`, `remove`, `find`, `list`, `listForUser`), exposed by `Organization.layer` (ADR-EA-040, BEH-EA-330). It owns the owner invariant, `membershipLimit`, role names, the grant `Bound`, MTI-003 uniqueness, the veto, the removal cascade (membership, active context, team memberships in one transaction) and the events and observe points, for every caller. The SAML role mapping is `setRoles` with an `IdentityProvider` actor and `ceilingOf` as its `Bound`; SCIM provisioning is `add` with a `Directory` actor and `Unbounded`; the authorized `removeMember`, `updateMemberRole`, `leave` and `listMembers` delegate. `Organization.addMember`, `syncMemberRoles`, `checkRoleCeiling` and `attributesFor` leave `OrganizationShape` (the interface has 41 methods): they are `OrganizationMembers.add`, `OrganizationMembers.setRoles({ ifAbsent: "add" })`, and `OrganizationAuthority.checkRoleCeiling` / `attributesFor`.
  
  Migration: `organization.addMember({ organizationId, userId, role })` becomes `OrganizationMembers.add(OrganizationActor.application("..."), { organizationId, userId, role, bound: OrganizationActor.Bound.Unbounded() })`; `syncMemberRoles({ roles, ceiling })` becomes `OrganizationMembers.setRoles(actor, { roles, bound: yield* OrganizationAuthority.ceilingOf(organizationId, ceiling), ifAbsent: "add" })`. Behaviour: a caller without `member:delete` / `member:update` is now answered `403` before the owner invariant (it was `409` for the last owner, which leaked that fact); setting a member's roles to exactly what they hold is a no-op for HTTP too (no write, veto, event or observer); a veto tap that rewrites the roles is bounded on what is stored. `@awthaq/saml` and `@awthaq/scim` require the exposed `OrganizationMembers` / `OrganizationAuthority` instead of `Organization`'s removed methods.
- 05c2ef7: The organization records are scoped by their organization key, a cross-organization method takes a witness, the client secret is a sealed column, and every store failure is `StoreUnavailable` (plan 05).
  
  - Every method that reads or writes across organizations takes a `TenantScoped.CrossTenant` as its first argument (`OrganizationRecords.listByIds/listPage/setSuspended`, `MembershipRecords.listByUser/deleteAllByUser`, `InvitationRecords.findById/findByTokenHash/listByEmail/listByInviter/countPendingByInviter/removeAllForUser`, `TeamRecords.findTeamByIdAnyOrg/removeUserFromAllTeams`, `ConnectionRecords.findByEmailDomain`, `ActiveContextRecords.deleteAllByUser`); its statement runs under `TenantScoped.lift`, so it still sees every organization inside a request's Postgres RLS transaction. `InvitationRecords.setTokenHash/updateStatus` and the connection-domain deletes now also filter by `organizationId`.
  - `ConnectionRecord.clientSecret` is `Option<SealedColumn.Sealed<string>>` (and `secretRevision` is the compare-only ciphertext fingerprint); `ConnectionInput`/`ConnectionPatch` take a `Redacted` secret. Secrets sealed under the old `organization-oauth-connection:` AAD still open and re-seal on read. `ConnectionRecords.layerMemory/layerSql` require `Encryption`; `OrganizationConnections` and its store no longer do.
  - The records modules, `OrganizationShape`, `OrganizationConnectionStore`, `AdminTenants` and the SAML/SCIM services fail with `StoreUnavailable` instead of dying; the tenant middleware answers it `503`; the SCIM bearer middleware and the SAML metadata/SSO endpoints declare it. `@awthaq/sql` adds `StoreFailure.orConflict` and `TenantScoped.liftOn`, and `orStoreUnavailable` accepts a `RETURNING` that returned no row (a defect).
  
  Migration: pass a witness (`TenantScoped.crossTenant("<why>")` from `@awthaq/sql`) to the methods above, and pass `organizationId` to `InvitationRecords.setTokenHash/updateStatus`; open a connection's secret with `SealedColumn.option(record.clientSecret.value.open)`; provide `Encryption` to `ConnectionRecords`; handle `StoreUnavailable` on the widened service methods. BEH-EA-284, BEH-EA-328.
- 1cef4be: A SCIM `PUT` or `PATCH` is applied whole or not at all, and group listing has no cap (BEH-EA-348, BEH-EA-349).
  
  - A group `PATCH` or `PUT` is interpreted and checked in full before any write, then runs in one unit of work: a team veto, a member limit, an `externalId` conflict or a store outage leaves the name, roster and mapping as they were.
  - A SCIM deactivation commits the suspension and the session revocation together.
  - A path-less `PATCH` object (`{ "displayName": "x", "members": [...] }`) applies every managed attribute, not just the first.
  - A `PATCH` with several member operations changes the roster once, by its net effect.
  - `GET /Groups` pages in the store; `displayName eq` and `externalId eq` find a group past the ten-thousandth, and only groups this connection provisioned.
  
  Migration: none for most hosts. A host whose tap or subscriber counts `auth.organization.teamMember*` events or `After*TeamMember` calls per SCIM `PATCH` operation now sees one per net change. A host that relied on a partially applied `PATCH` now sees nothing applied. A `PATCH` `displayName` over 255 characters is now `400`.
- be69920: `ScimRecords` has a RecordsContract suite (plan 25 ticket 23, ADR-EA-041 decision 9, BEH-EA-246/247):
  
  - Linking a resource the connection already links (the same connection, kind and resource id) is `ScimLinkConflict` (`field: "name"`, the field Postgres reports for the primary key) on every adapter. Before, the memory adapter added a second row (plan 24's SCIM link item).
  - `removeAllForOrganization` deletes the mappings and their connections in one transaction (a savepoint inside the organization deletion's).
  - A revocation outage is labelled `ScimRecords.revokeConnection` (was `ScimRecords.row`).
  - Every operation carries a verdict; `link`, `setExternalId` and `revokeConnection` are proven atomic by 8-way race cases on memory and SQL, Postgres included under `pnpm test:pg`.
  
  Migration: a custom adapter through `@awthaq/scim`'s `ScimRecords` must refuse `link` of an already linked resource with `ScimLinkConflict` rather than storing a second row.
- Updated dependencies
- Updated dependencies [a95959c]
- Updated dependencies [09d61ca]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [d7351b7]
- Updated dependencies [b97c8c2]
- Updated dependencies [9416e17]
- Updated dependencies [fe9dc94]
- Updated dependencies [2706762]
- Updated dependencies [50a23f8]
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
- Updated dependencies [401a719]
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
  - @awthaq/sql@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0
  - @awthaq/organization@0.2.0
