# Plan 13: One admin gate reads the configuration in force and owns denial and target lookup

| Property | Value |
|---|---|
| Strength | Strong (architecture review of 2026-10-17). It fixes a live, security-relevant bug, and it removes three hand-copied gate implementations plus four inline variants inside `Admin` |
| Dependency category | in-process (one module inside `@awthaq/admin`, yielded by the three plugin `make`s; no port, no adapter) |
| Wave / order | Phase 0 is a hotfix. It has no dependencies and should ship first, on its own (Q6). Phases 1 to 3 and 5 have no ordering constraint against plans 11 to 24. Phase 4 runs only after plan 11 (§8) |
| Fixes live bugs | **`AdminAccounts` ignores a tenant's `AdminConfig`.** `canDeleteUsers`, `canManageCredentials`, `passwordPolicy` and `links.changeEmail` are read once, at layer build (`AdminAccounts.ts:169`). A tenant therefore cannot tighten a permissive deployment-wide deletion gate: the account is **erased** in a tenant whose own configuration denies it (repro in §2.2). A tenant also cannot open these capabilities, cannot get its own password policy, and cannot get its own confirmation link. This violates ADR-EA-018 Decision 8 ("Admin's gates are read per operation too") and BEH-EA-236. It also corrects five pieces of spec drift (§2.5) |
| Execution tickets | `.scratch/admin-gate/issues/NN-*.md`, one per phase (`docs/agents/issue-tracker.md`). `.scratch/admin/` already exists for older work, so use the new slug |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Re-check the line numbers before editing, because sibling plans 11, 15 and 22 touch the same files (§8).

---

## 1. Summary, goals, non-goals

### Summary

"May this administrator do this to that target?" is answered in **seven places** in `@awthaq/admin`, and each answer is assembled by hand:

- `Admin.authorizeUsers`/`authorizeUser` (`Admin.ts:901-938`), the user-administration gate.
- `banUser`'s inline copy of the existence half (`Admin.ts:998-1002`).
- The impersonation gate inside `impersonate` (`Admin.ts:1092-1114`), plus its `deny` helper (`:883-899`).
- The per-episode gate inside `forceStop` (`:1227-1237`).
- The per-row filter inside `list` (`:1270-1274`).
- The non-failing superadmin check `tenantScopeFor` (`:1201-1214`).
- `AdminAccounts.authorize` + `existing` (`AdminAccounts.ts:172-199`).
- `AdminTenants.authorize` + `existing` (`AdminTenants.ts:193-221`).

Each copy repeats the same steps:

1. Obtain the configuration in force.
2. Build the predicate input: an identity-only `admin` subject, the target subject, and the ambient tenant.
3. Call the predicate.
4. On refusal, publish `auth.admin.actionDenied` or `auth.admin.impersonationDenied`.
5. Fail with the matching typed error.
6. Load the target (`UserNotFound` → `AdminTargetNotFound`, or `None` → `AdminOrganizationNotFound`) only after the gate, so a refused caller cannot use 404-versus-403 as an id oracle (BEH-EA-221, IDS-003).

Which predicate guards which action is a string literal passed as an argument at 14 call sites (`"canBanUsers"` at `Admin.ts:996/1023`, `"canDeleteUsers"` at `AdminAccounts.ts:203`, …). The predicate falls back to `"canManageUsers"` by a default parameter (`Admin.ts:907`, `:930`).

Step 1 is where the copies have already drifted. `Admin` and `AdminTenants` call `Tenant.configInForce(AdminConfig, built)` (ADR-EA-018 Decision 8, EP-007). `AdminAccounts`, written later, does `yield* AdminConfig` once at layer build (`AdminAccounts.ts:169`). All four of its configuration reads are therefore build-time only. Nothing in the type system or the tests could catch it: the only per-tenant test, `AdminTenantConfig.test.ts`, exercises `canManageUsers` alone.

This plan makes the gate **one deep module**, `packages/admin/src/internal/AdminGate.ts`, which every gated admin operation calls:

- **Interface.** The module offers seven operations: `collection`, `user`, `organization`, `impersonation`, `episode`, `visibleEpisodes` and `crossTenantScope`. Each takes the caller and a **typed action name**.
- **Implementation.** The module owns everything else:
  - the action → predicate table (one place, typed against `AdminConfigShape`);
  - the per-operation read of the configuration in force;
  - the predicate input;
  - the denial event and error;
  - the target lookup.
- **What a caller gets back.** A successful gate returns a branded **clearance** that carries the configuration the decision was made with. Only the gate can mint one. A per-user clearance also carries the deferred `target` lookup, so "existence before the gate" cannot be written.
- **The type-level guard.** The `AdminConfig` `Context.Reference` becomes **module-private** to `AdminGate.ts`. No other admin module can read a build-time value, because there is nothing to read: the only path to `maxDuration`, `passwordPolicy` or `links` is a clearance. A boundary test (the `ErasureClearance.boundary.test.ts` pattern) pins it.

### Goals

1. Fix the `AdminAccounts` tenant bypass first, as a small hotfix with failing tests (Phase 0).
2. One implementation of the admin gate. All three handler sets call it, and the three `authorize` copies plus the four inline variants are deleted.
3. The action → predicate pairing lives in one typed table. A wrong pairing, a collection call given a target, or a per-user call given none does not compile.
4. No admin operation can read `AdminConfig` other than through the configuration in force. This is enforced by module privacy plus a boundary test, not by a comment.
5. One gate test suite covers every gated operation × every predicate × {default, build-time allow, tenant opens, tenant tightens}. It **replaces** 18 per-file denial tests and two partial assertions (§5.4).
6. The spec says what the code does (BEH-EA-221, 224, 236, ADR-EA-018 D8, and the drift in §2.5).

### Non-goals

- **The gates of other packages.** `SamlAdmin.authorize` (`saml/src/SamlAdmin.ts:133-152`) and `Webhooks.authorize` (`webhooks/src/Webhooks.ts:509-526`) also publish `auth.admin.actionDenied`. They live in packages that cannot depend on `@awthaq/admin`, they take different predicate inputs, and they fail with their own errors (`SamlActionDenied`, `WebhooksActionDenied`). The part they share with this gate is six lines (publish + fail), which is not a deep module. §2.4 records SAML's build-time read as a follow-up (Q4).
- **Making the build-time-only plugins per-tenant** (two-factor, magic link, email OTP, api-key, device authorization, SAML, SCIM, roles). This plan only corrects BEH-EA-236's claim that "every configurable plugin" adopts the rule (§2.4, §6).
- **The `SqlError → Effect.die` at `AdminAccounts.ts:311`.** It is an ADR-EA-028 deviation, but it shares a pattern with `core/src/Erasure.ts:178` and seven organization sites (`OrganizationDirectory.ts:262/363`, `OrganizationInvitations.ts:561`, `OrganizationTeams.ts:430/549/716`, `OrganizationMembers.ts:336`). It is noted for a separate sweep and not touched here.
- **Exporting a shared `currentUserPrincipal`.** Plan 11 owns it. This plan consumes it (Phase 4) and does not write its own.
- **Moving self-refusal into the gate.** `AdminSelfBanRefused` and `AdminSelfActionRefused` stay at their three call sites. They are validation of the request, not authorization (§3.5).
- **Changing `Admin.config(partial)` semantics.** A tenant's layer still replaces the whole configuration over the defaults (Q3).

---

## 2. Verified current state

### 2.1 Every admin gate (copy or variant)

| # | Site | Predicate(s) | Config read | Predicate input | Denial | Target lookup |
|---|---|---|---|---|---|---|
| G1 | `Admin.authorizeUsers`, `Admin.ts:903-923` | `canManageUsers` (default parameter, `:907`) or `canBanUsers` | `configNow` (per operation, `:909`) ✓ | `{ admin: subjectOf(caller), target: Option.map(target, subjectOfUserId), tenantId: TenantContext }` | `auth.admin.actionDenied { adminUserId, action }` + `AdminActionDenied` (`:915-922`) | none |
| G2 | `Admin.authorizeUser`, `Admin.ts:926-938` | as G1 (default parameter, `:930`) | via G1 | via G1 | via G1 | `users.findById`, `UserNotFound` → `AdminTargetNotFound` (`:933-937`) |
| G3 | `Admin.banUser`, `Admin.ts:996-1002` | `canBanUsers` (string argument, `:996`) | via G1 | via G1 | via G1 | **inline copy** of G2's lookup (`:998-1002`), because the self-refusal (`:997`) must sit between the gate and existence |
| G4 | `Admin.impersonate`, `Admin.ts:1092-1114` | `canImpersonate` | `configNow` (`:1092`) ✓ | `{ admin, target: subjectOfUserId(targetUserId), tenantId }` | `deny` (`:883-899`): `auth.admin.impersonationDenied { operation: "impersonate", targetUserId }` + `AdminImpersonationDenied` | inline (`:1110-1114`) |
| G5 | `Admin.forceStop`, `Admin.ts:1216-1237` | `canManageEpisode` | `configNow` (`:1217`) ✓ | `{ admin, episode }` | `deny` with `operation: "forceStop"`, `sessionId`, `targetUserId` | the episode is looked up **before** the gate (`:1223`), because the gate needs it. This is by design (IDS-001) |
| G6 | `Admin.list`, `Admin.ts:1258-1276` | `canManageEpisode` as a per-row filter | `configNow` (`:1259`) ✓ | `{ admin, episode }` | none (a filter; a deny-all gate yields an empty page) | n/a |
| G7 | `Admin.tenantScopeFor`, `Admin.ts:1201-1214` | `canAdministerTenants` as a non-failing check | `configNow` ✓ | `{ admin, organizationId: None }` | none: `None` leaves the tenant confinement in place | n/a |
| G8 | `AdminAccounts.authorize` + `existing`, `AdminAccounts.ts:172-199` | `canDeleteUsers`, `canManageCredentials` (string argument at `:203/229/261`) | **`yield* AdminConfig` once at build (`:169`) ✗** | like G1 (`:179-183`) | like G1 (`:184-191`) | like G2 (`:194-199`) |
| G9 | `AdminTenants.authorize` + `existing`, `AdminTenants.ts:193-221` | `canAdministerTenants` | `configNow` (`:188-190`, `:198`) ✓ | `{ admin, organizationId }`, **no target subject, no `tenantId`** | like G1 (`:203-210`) | `directory.find`, `None` → `AdminOrganizationNotFound` (`:213-221`); `suspend`/`reinstate` map `OrganizationNotFound` themselves (`:261-263`, `:276-278`) |

Supporting copies in `Admin.ts`: `subjectOfUserId` (`:155`), `subjectOf` (`:213-214`), and the IDS-001 default that derives `canManageEpisode` from `canImpersonate` (`episodeGateFrom`, `:157-165`, applied in `config`, `:194-201`).

**Corrections to the candidate description.**

- "Each copy evaluates `adminConfig[gate]({ admin, target, tenantId })` and maps `UserNotFound` → `AdminTargetNotFound`" is true of G1, G2 and G8 only.
  - G9 calls `canAdministerTenants({ admin, organizationId })` and has no target subject and no `tenantId`. Its existence half is `directory.find` with `None` → `AdminOrganizationNotFound`.
  - G4 and G5 publish a different event (`impersonationDenied`) and fail with a different error.
  - G6 and G7 never fail.
- The candidate counted three gates. There are three *named* copies (G1+G2, G8, G9) and four inline variants (G3 to G7). The target design covers all of them.
- Line ranges: `Admin.ts` ~865-941 is accurate (the gate code is `:866-938`). `AdminTenants.ts` 189-222 and `configInForce` at `:190` are accurate.

The three `currentUserPrincipal` copies in admin are `Admin.ts:431-440`, `AdminAccounts.ts:103-112` and `AdminTenants.ts:103-112`. They are byte-identical apart from the group name in the message. The other five named copies are `organization/src/OrganizationHandlers.ts:103`, `passkey/src/Passkey.ts:617`, `saml/src/Saml.ts:694`, `two-factor/src/TwoFactor.ts:294` and `webhooks/src/Webhooks.ts:365`. `@awthaq/server` already has an internal `currentUser` (`server/src/internal/CurrentUser.ts:15-30`). Plan 11 exports one helper; Phase 4 here only deletes the admin copies, if plan 11 left them.

### 2.2 The live bug: `AdminAccounts` reads its configuration at build

`AdminAccounts.ts:169`, `const adminConfig = yield* AdminConfig;`, is evaluated once, when `AdminAccounts.layer` is built. Every later use reads that captured value:

| `AdminConfig` field | Read at | Per operation? |
|---|---|---|
| `canDeleteUsers` | `AdminAccounts.ts:179` (`deleteUser`, via `authorize(…, "canDeleteUsers")` at `:203`) | **no** |
| `canManageCredentials` | `AdminAccounts.ts:179` (`setUserEmail` `:229`, `setUserPassword` `:261`) | **no** |
| `passwordPolicy` | `AdminAccounts.ts:270` | **no** |
| `links.changeEmail` | `AdminAccounts.ts:244` | **no** |
| `maxDuration` | `Admin.ts:1092` → `:1119` | yes |
| `canImpersonate` | `Admin.ts:1102` | yes |
| `canManageEpisode` | `Admin.ts:1227`, `:1272` (and derived from a tenant's `canImpersonate` by `config`, `:198-200`) | yes |
| `canManageUsers` | `Admin.ts:910` | yes |
| `canBanUsers` | `Admin.ts:910` | yes |
| `canAdministerTenants` | `Admin.ts:1204`, `AdminTenants.ts:199` | yes |

These ten fields are every field of `AdminConfigShape` (`Admin.ts:73-138`). Nothing outside `packages/admin/src` reads `AdminConfig` as a value: `grep -rn AdminConfig packages/*/src features examples` finds only comments and the `AdminConfigShape` type.

**Repro (run, red at HEAD).** This is a throwaway vitest file in the scratchpad, not in the repo. Its cases are Phase 0's tests.

```ts
class TenantConfig extends LayerMap.Service<TenantConfig>()("repro/TenantConfig", {
  lookup: (tenantId: string) =>
    Layer.merge(
      Admin.config({
        canDeleteUsers: () => Effect.succeed(tenantId === "ops"),
        canManageCredentials: () => Effect.succeed(tenantId === "ops"),
      }),
      Tenant.configApplied(tenantId),
    ),
  idleTimeToLive: "1 minute",
}) {}
// Build time: deletion allowed everywhere. Tenant "other" denies it for its own requests.
const exit = yield* accounts
  .deleteUser(caller(admin.id), target.id)
  .pipe(Effect.provide(TenantConfig.get("other")), Effect.exit);
// HEAD: Exit.Success. The target was ERASED through AccountErasure, in a tenant whose configuration denies it.
// And the reverse: build-time deny-all, tenant "ops" allows → AdminActionDenied instead of AdminTargetNotFound.
```

Observed at HEAD: `deleteUser in tenant other: {"_id":"Exit","_tag":"Success"}`, and `deleteUser in tenant ops: … {"_tag":"AdminActionDenied"}`.

- **Severity.** It needs a deployment-wide permissive `canDeleteUsers` or `canManageCredentials` and a tenant that tightens it. In that setup, an irreversible act (erasure) or a credential takeover (`setUserPassword` revokes every session and sets a password of the admin's choosing) runs against the tenant's stated policy.
- **The other direction.** Open-by-tenant fails closed, so it is a capability gap, not a hole.
- **Silent drift.** `passwordPolicy` and `links.changeEmail` drift silently: a tenant's stricter policy is never applied, and a tenant's link builder is never used.

### 2.3 Every `Tenant.configInForce` user, and the admin package's place in it

`configInForce` is defined at `ports/src/Tenant.ts:82-85` and re-exported at `core/src/Tenant.ts:14`. Its callers:

- organization: `OrganizationDirectory.ts:166`, `OrganizationMembers.ts:147`, `OrganizationAuthority.ts:103`, `OrganizationInvitations.ts:189`, `OrganizationRoles.ts:106` and `OrganizationTeams.ts:267`. `Organization.ts:155-158` hand-inlines the same expression instead of calling the helper.
- jwt: `Jwt.ts:259`, `:347` and `:600`.
- password: `Password.ts:658` and `:949`.
- oauth: `OAuth.ts:471`, `:765` and `OAuthTokenAccess.ts:158`.
- core: `RateLimits.ts:345`, `Accounts.ts:229` and `Sessions.ts:678`.
- passkey: `Passkey.ts:1092`.
- webhooks: `Webhooks.ts:502`.
- admin: `Admin.ts:871` and `AdminTenants.ts:190`.

**`AdminAccounts` is the only module that ADR-EA-018 D8 names as an adopter (admin) and that does not read per operation.** Every other build-time read inside the named adopters is a value the ADR or BEH-EA-236 lists as boot-scoped, or one that is boot-scoped by construction:

- **Listed:** Password's rate-limit rules, digest key and timing floor; OAuth's provider registry (`OAuthProviders.ts:61`); Jwt's key ring (`KeyRing.ts`).
- **Boot-scoped by construction:**
  - Jwt's `acceptAsBearer` (`Jwt.ts:430`), which decides whether a credential resolver is contributed at all.
  - Organization's `invitationRetention` (`OrganizationPersonalData.ts:117`), a background retention sweep that is deployment-wide like the webhooks worker.

  Neither is named in the boot-scoped list. §6 adds them.

### 2.4 Build-time-only configuration outside the adopters (not this plan's bug, recorded)

`grep -rnE 'yield\* [A-Za-z.]*(Config|Settings)\b' packages/*/src`, with each hit read in context, finds that these plugins read their configuration once in `make` (or in a layer) and never per operation:

- two-factor: `TwoFactor.ts:188`, `:509` and `SecondFactor.ts:198`.
- magic link: `MagicLink.ts:237`.
- email OTP: `EmailOtp.ts:242`.
- api-key: `ApiKey.ts:606`, `:801`.
- device authorization: `DeviceAuthorization.ts:524`, `:773`.
- saml: `Saml.ts:435/570/795/846`, `SamlAdmin.ts:131`, `SamlConnections.ts:217`, `SamlSpKeys.ts:92`, `SamlMetadataFetcher.ts:45` and `Sso.ts:181-182`.
- scim: `Scim.ts:518`, `:625`.
- roles: `Roles.ts:130/240`, `RolesAdmin.ts:95`.

None of them is in ADR-EA-018 D8's adopter list, so none is a D8 violation. BEH-EA-236 (`28-tenancy.md:127`), however, says "**Every** configurable plugin adopts the per-operation rule … organization, password, sessions, oauth, passkey, jwt and admin". That overclaims, and it omits webhooks, which does adopt it. §6 corrects the sentence.

Only one of these is an *admin gate*: `SamlAdmin`'s `canManageSaml` (`SamlAdmin.ts:131`, `:138`). A tenant cannot tighten it. That is a candidate follow-up (Q4), not this plan.

No per-operation plain `yield* Reference` (the inverse bug, which would ignore `Layer.provide(Plugin.config(...))`) was found: every hit above is inside a `make`, a `Layer.unwrap` or a handler-group builder.

The plugin template teaches the build-time read: `examples/plugin-template/src/Template.ts:342` (`const settings = yield* NotesConfig` in `make`, used per call at `:352`). `docs/plugin-authoring.md` never mentions per-tenant configuration (its Config row is `:14`). Phase 5 fixes both, because `AGENTS.md` names the template as the conventions source.

### 2.5 Spec and documentation drift found while verifying

| Where | Says | Code at `fc990c88` |
|---|---|---|
| BEH-EA-221, `27-admin-impersonation.md:320-333` (the `ts` block) | `canManageUsers`/`canBanUsers` take `{ admin, target }` | They also take `tenantId` (`Admin.ts:141-146`). `canDeleteUsers` and `canManageCredentials` exist and have the same shape |
| BEH-EA-221, `:352` (last sentence) | "It does not yet consult `Hooks.BeforeCredentialReset`" | It does (ARF-005, `AdminAccounts.ts:279-282`). The package header (`AdminAccounts.ts:21-26`) is right |
| BEH-EA-224, `:408-…` | `actionDenied` is published "when `canManageUsers` resolves `false`" | It is also published by `canBanUsers`, `canDeleteUsers`, `canManageCredentials` and `canAdministerTenants` (and by SAML/webhooks with a prefix) |
| BEH-EA-236, `28-tenancy.md:127` | "Every configurable plugin adopts…" | See §2.4 |
| ADR-EA-018 D8, `018-tenancy-is-an-organization.md:48` | "Admin's gates are read per operation too, so a tenant may tighten its own `canImpersonate`/`canManageUsers`" | False for `AdminAccounts` (§2.2) |
| `packages/admin/README.md:26` | "for `canImpersonate`/`canManageUsers`, the request's ambient `tenantId`" | Every user-administration predicate receives it |
| `core/src/AuthEventSchemas.ts:462-468` (doc of `AdminActionDeniedEvent`) | "an admin capability other than impersonation (`AdminConfig.canManageUsers`)" | Five predicates in admin, plus SAML and webhooks |

### 2.6 Tests that exercise the gate today (the ones §5 replaces)

| File | Test (line) | What it pins |
|---|---|---|
| `admin/test/AdminUsers.test.ts` | "every capability is fail-closed by default and publishes actionDenied" (`:60`) | G1/G2 default deny + event per action |
| | "the gate sees the target, so a host can protect an account; list sees none" (`:87`) | predicate input |
| | "listUsers pages with a keyset cursor and getUser resolves 404 only past the gate" (`:122`) | paging (stays) + gate→existence (`:144-145`, moves) |
| | "banUser and unbanUser are fail-closed by default — even for an administrator of users" (`:253`) | predicate separation |
| | "the ban gate sees the target, so a host can protect a superadmin" (`:364`) | predicate input |
| `admin/test/AdminAccounts.test.ts` | "every capability is fail-closed by default and publishes actionDenied" (`:120`) | G8 default deny + event |
| | "the predicates are separate: managing users grants neither deleting nor credentials" (`:149`) | separation |
| | "the gate runs before existence: only a gate-passing caller learns a user is unknown" (`:174`) | gate→existence |
| `admin/test/AdminTenants.test.ts` | "every operation is denied by default, and the denial is audited" (`:41`) | G9 default deny + audit row |
| | "a denied caller cannot tell whether an organization id exists" (`:67`) | gate→existence |
| `admin/test/AdminConfig.test.ts` | "is fail-closed by default and publishes actionDenied" (`:39`) | `effectiveConfig` gate |
| `admin/test/AdminTenantConfig.test.ts` (whole file, 69 lines) | "a tenant's gate applies to its own requests, the default stays deny-all" (`:41`), "a tenant may tighten a permissive build-time gate" (`:57`) | per-tenant `canManageUsers` only |
| `admin/test/Admin.test.ts` | "BEH-EA-212/218: a denied gate produces AdminImpersonationDenied, no session issued" (`:63`) | G4 deny + IDS-006 event + no session |
| | "forceStop is gated: a gate that refuses the episode's target denies the stop" (`:258`) | G5 |
| | "IDS-001: list under a deny-all gate exposes no episodes (fail-closed)" (`:309`) | G6 |
| | "IDS-001: canImpersonate receives the target and can refuse a protected target" (`:327`) | G4 input |
| | "IDS-001: forceStop/list are filtered by canManageEpisode" (`:364`) | G5/G6 |
| | "IDS-003: a gate-refused caller gets 403, not 404, for an unknown target (no existence oracle)" (`:431`) | G4 gate→existence |
| | "the gate sees the ambient tenant and the episode is stamped with it" (`:617`) | G4 `tenantId` input (moves) + stamping (stays) |

That is 18 tests that re-test the gate, plus 2 partial assertions. Over HTTP, the status-mapping tests stay: `AuthHttp.test.ts:161` (403), `:621` (IDS-003 404 vs 403 over the wire), and `AdminAccountsHttp.test.ts:61` (403 per endpoint). They test the error → status mapping, a different seam. The BDD rules under BEH-EA-212/221 (`27-admin-impersonation.feature`, REQ-EA-631, 702-707, …) stay, because they are the specification.

---

## 3. Target design

### 3.1 Where the seam sits

```
 HTTP handler group (Admin / AdminAccounts / AdminTenants)
   │  caller = principal helper (plan 11)
   ▼
 plugin operation (deleteUser, banUser, impersonate, getOrganization, …)
   │  gate.user(caller, "deleteUser", userId)            ← the only authorization step
   ▼
┌──────────────────────── internal/AdminGate.ts (deep) ───────────────────────────────┐
│ AdminConfig (Context.Reference, MODULE-PRIVATE) ── configInForce ── per operation    │
│ actions table: action → predicate (typed against AdminConfigShape)                   │
│ predicate input (identity-only subjects, ambient tenantId)                           │
│ denial: auth.admin.actionDenied | auth.admin.impersonationDenied + typed error       │
│ clearance (branded; carries the config in force; deferred `target` lookup)           │
└───────────────────────────────────────────────────────────────────────────────────────┘
   │  clearance.config.passwordPolicy / .links / .maxDuration ;  yield* clearance.target
   ▼
 domain operation (AccountErasure, Users, Sessions, OrganizationDirectory, …)
```

What stays **outside** the gate:

- **Self-refusal** (`AdminSelfBanRefused`, `AdminSelfActionRefused`) and impersonation's validation refusals (self, nested, BEH-EA-214/218). They are request validation, they run without the configuration, and BEH-EA-218 requires that the latter never reach the gate.
- **The episode lookup before `forceStop`'s gate.** The predicate needs the row (IDS-001).
- **The organization existence lookup** (`directory.find`). `Admin` composes without the organization plugin, so the gate cannot depend on `OrganizationDirectory`. `AdminTenants` keeps a three-line `existing`, which takes an `OrganizationClearance`.
- **The host's policy inside a predicate** (roles lookups and so on: ADR-EA-025's "platform admin" question is answered by `@awthaq/roles` inside the host's predicate, never by the gate).

### 3.2 The module: configuration (moved), action table, clearances

`packages/admin/src/internal/AdminGate.ts` is new. It is not re-exported from `src/index.ts`. The sketch below was type-checked against the tree, with `tsc` over the real `@awthaq/core`/`api`/`sql` sources, `effect@4.0.0-rc.116` and `@qadi/core`.

```ts
// @awthaq/admin — internal/AdminGate
//
// ADR-EA-018 Decision 8 / BEH-EA-221 / BEH-EA-236 (plan 13): the one admin gate. Every gated admin
// operation asks it, and it alone reads `AdminConfig` — per operation, through `Tenant.configInForce`.
// The reference is module-private, so no admin operation can read a build-time value: what an
// operation needs from the configuration (`maxDuration`, `passwordPolicy`, `links`) comes from the
// clearance the gate returns, i.e. from the very value that authorized it.
import { Api } from "@awthaq/api";
import { AuthEvents, ConfigDescriptor, Errors, Sessions, Tenant, Users } from "@awthaq/core";
import { TenantScoped } from "@awthaq/sql";
import type { AuthSubject } from "@qadi/core";
import { makeSubject } from "@qadi/core";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as AdminApi from "../AdminApi.ts";
import type * as ImpersonationRecords from "../ImpersonationRecords.ts";

// ---- 1. Configuration: moved verbatim from Admin.ts:54-201 -------------------------------------
// ImpersonationGateInput, EpisodeGateInput, AdminConfigShape, UserAdminGateInput,
// TenantAdminGateInput, subjectOfUserId, episodeGateFrom, defaultPasswordHints, defaultAdminConfig:
// unchanged text, doc comments included (with §6's wording fixes).

/** Module-private (plan 13): the only reader is `make` below, which reads it per operation. */
const AdminConfig = Context.Reference<AdminConfigShape>("awthaq/admin/Config", {
  defaultValue: () => defaultAdminConfig,
});

/** Unchanged from Admin.ts:194-201; `Admin.config` re-exports it. */
export const config = (partial: Partial<AdminConfigShape>) =>
  Layer.succeed(AdminConfig, {
    ...defaultAdminConfig,
    ...partial,
    canManageEpisode:
      partial.canManageEpisode ??
      episodeGateFrom(partial.canImpersonate ?? defaultAdminConfig.canImpersonate),
  });

/** EP-009: the descriptor `Admin` declares (same key, so `EffectiveConfig` output is unchanged). Precedent: `server/src/BodyLimit.ts:57`. */
export const descriptor = ConfigDescriptor.make(AdminConfig);

// ---- 2. The action table -----------------------------------------------------------------------

/** The predicates whose input is `I`. Derived from `AdminConfigShape`, so a new predicate of a known shape joins on its own. */
type GateOf<I> = {
  [K in keyof AdminConfigShape]: AdminConfigShape[K] extends (input: I) => Effect.Effect<boolean>
    ? K
    : never;
}[keyof AdminConfigShape];
/** "canManageUsers" | "canBanUsers" | "canDeleteUsers" | "canManageCredentials" (checked by AdminGate.types.test.ts). */
export type UserGate = GateOf<UserAdminGateInput>;
/** "canAdministerTenants". */
export type TenantGate = GateOf<TenantAdminGateInput>;

/**
 * BEH-EA-221 / BEH-EA-237: which predicate guards which action, and what the predicate is shown.
 * The action name is also the `action` of `auth.admin.actionDenied` (unchanged strings).
 */
const actions = {
  effectiveConfig: { gate: "canManageUsers", on: "users" },
  listUsers: { gate: "canManageUsers", on: "users" },
  getUser: { gate: "canManageUsers", on: "user" },
  updateUser: { gate: "canManageUsers", on: "user" },
  listUserSessions: { gate: "canManageUsers", on: "user" },
  revokeUserSession: { gate: "canManageUsers", on: "user" },
  revokeUserSessions: { gate: "canManageUsers", on: "user" },
  banUser: { gate: "canBanUsers", on: "user" },
  unbanUser: { gate: "canBanUsers", on: "user" },
  deleteUser: { gate: "canDeleteUsers", on: "user" },
  setUserEmail: { gate: "canManageCredentials", on: "user" },
  setUserPassword: { gate: "canManageCredentials", on: "user" },
  listOrganizations: { gate: "canAdministerTenants", on: "organizations" },
  getOrganization: { gate: "canAdministerTenants", on: "organization" },
  suspendOrganization: { gate: "canAdministerTenants", on: "organization" },
  unsuspendOrganization: { gate: "canAdministerTenants", on: "organization" },
} as const satisfies Record<
  string,
  | { readonly gate: UserGate; readonly on: "users" | "user" }
  | { readonly gate: TenantGate; readonly on: "organizations" | "organization" }
>;

type Actions = typeof actions;
type ActionOn<On> = { [K in keyof Actions]: Actions[K]["on"] extends On ? K : never }[keyof Actions];
/** The predicate sees no target: "effectiveConfig" | "listUsers" | "listOrganizations". */
export type CollectionAction = ActionOn<"users" | "organizations">;
export type UserAction = ActionOn<"user">;
export type OrganizationAction = ActionOn<"organization">;

// ---- 3. Clearances: proof the gate passed, minted only here (the SignIn `Clearance` precedent) ---

export type Clearance = {
  readonly adminUserId: Users.UserId;
  /** The configuration in force that authorized this operation. Read nothing else. */
  readonly config: AdminConfigShape;
} & Brand.Brand<"awthaq/admin/Clearance">;

export type UserClearance = {
  readonly adminUserId: Users.UserId;
  readonly config: AdminConfigShape;
  readonly userId: Users.UserId;
  /** IDS-003 / BEH-EA-221: existence second. Run it after any self-refusal, never before the gate. */
  readonly target: Effect.Effect<
    Users.UserRecord,
    AdminApi.AdminTargetNotFound | Errors.StoreUnavailable
  >;
} & Brand.Brand<"awthaq/admin/UserClearance">;

export type OrganizationClearance = {
  readonly adminUserId: Users.UserId;
  readonly config: AdminConfigShape;
  readonly organizationId: string;
} & Brand.Brand<"awthaq/admin/OrganizationClearance">;

const clearance = Brand.nominal<Clearance>();
const userClearance = Brand.nominal<UserClearance>();
const organizationClearance = Brand.nominal<OrganizationClearance>();
```

- `as const` and `satisfies` are allowed (`.oxlintrc.json` override for `as const`). There is no other assertion. The `UserGate` derivation needs `@qadi/core`'s `AuthSubject` to resolve; with it unresolved the conditional degrades. The types test (§5.3) pins the exact unions, so a regression fails there.
- `ImpersonationRecords` is a type-only import, and `AdminApi` is a value import. Neither imports `Admin.ts`, so there is no cycle (`pnpm circular` counts type-only edges too: plan 04, Decisions taken).

### 3.3 The module: the gate itself

```ts
// ---- 4. The gate. Yielded once in each plugin's `make` (precedent: `SignIn.make`, `SignUp.make`). ----
export const make = Effect.gen(function* () {
  const users = yield* Users.Users;
  const events = yield* AuthEvents.AuthEvents;
  // The one read of the built value: what `Layer.provide(Admin.config(...))` gave this layer.
  const inForce = Tenant.configInForce(AdminConfig, yield* AdminConfig);

  /** IDS-001 / BEH-EA-137: identity-only; a host needing roles looks them up by id. */
  const subject = (id: string) => makeSubject({ id });

  const targetOf = (userId: Users.UserId) =>
    users
      .findById(userId)
      .pipe(Effect.catchTag("UserNotFound", () => Effect.fail(new AdminApi.AdminTargetNotFound())));

  /** BEH-EA-224: a genuine refusal, never validation noise. An attempt event (ADR-EA-037): it survives a rollback. */
  const refuse = Effect.fnUntraced(function* (caller: Api.UserPrincipal, action: string) {
    yield* events.publish({
      _tag: "auth.admin.actionDenied",
      adminUserId: Users.UserId(caller.ref.id),
      action,
      // Phase 3 (Q2): `...targetFields` (targetUserId | organizationId) when the call named one.
    });
    return yield* Effect.fail(new AdminApi.AdminActionDenied());
  });

  const decide = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    action: keyof Actions,
    target: Option.Option<string>,
  ) {
    const config = yield* inForce;
    const entry = actions[action];
    const allowed =
      entry.gate === "canAdministerTenants"
        ? yield* config[entry.gate]({ admin: subject(caller.ref.id), organizationId: target })
        : yield* config[entry.gate]({
            admin: subject(caller.ref.id),
            target: Option.map(target, subject),
            tenantId: yield* Tenant.TenantContext,
          });
    if (!allowed) return yield* refuse(caller, action);
    return config;
  });

  /** `listUsers`, `effectiveConfig`, `listOrganizations`: the predicate sees no target. */
  const collection = (caller: Api.UserPrincipal, action: CollectionAction) =>
    Effect.map(decide(caller, action, Option.none()), (config) =>
      clearance({ adminUserId: Users.UserId(caller.ref.id), config }),
    );

  /** BEH-EA-221: per-user. The predicate sees the target; `target` loads it afterwards. */
  const user = (caller: Api.UserPrincipal, action: UserAction, userId: Users.UserId) =>
    Effect.map(decide(caller, action, Option.some(userId)), (config) =>
      userClearance({ adminUserId: Users.UserId(caller.ref.id), config, userId, target: targetOf(userId) }),
    );

  /** BEH-EA-237 / EP-003: per-organization. */
  const organization = (caller: Api.UserPrincipal, action: OrganizationAction, organizationId: string) =>
    Effect.map(decide(caller, action, Option.some(organizationId)), (config) =>
      organizationClearance({ adminUserId: Users.UserId(caller.ref.id), config, organizationId }),
    );

  /** IDS-006: the impersonation denial names the refused call and what it named. */
  const impersonationDenied = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    attempt: {
      readonly operation: "impersonate" | "forceStop";
      readonly targetUserId: Users.UserId;
      readonly sessionId?: Sessions.SessionId;
    },
  ) {
    yield* events.publish({
      _tag: "auth.admin.impersonationDenied",
      adminUserId: Users.UserId(caller.ref.id),
      operation: attempt.operation,
      targetUserId: attempt.targetUserId,
      ...(attempt.sessionId === undefined ? {} : { sessionId: attempt.sessionId }),
    });
    return yield* Effect.fail(new AdminApi.AdminImpersonationDenied());
  });

  /** BEH-EA-212/213, IDS-001/002/003. Call it after the self/nested refusals (BEH-EA-214/218 never reach the gate). */
  const impersonation = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    targetUserId: Users.UserId,
  ) {
    const config = yield* inForce;
    const allowed = yield* config.canImpersonate({
      admin: subject(caller.ref.id),
      target: subject(targetUserId),
      tenantId: yield* Tenant.TenantContext,
    });
    if (!allowed) return yield* impersonationDenied(caller, { operation: "impersonate", targetUserId });
    return userClearance({
      adminUserId: Users.UserId(caller.ref.id),
      config,
      userId: targetUserId,
      target: targetOf(targetUserId),
    });
  });

  /** BEH-EA-217 / IDS-001: `forceStop`'s per-episode gate. The episode was looked up first, because the gate needs it. */
  const episode = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    record: ImpersonationRecords.ImpersonationRecord,
  ) {
    const config = yield* inForce;
    const allowed = yield* config.canManageEpisode({ admin: subject(caller.ref.id), episode: record });
    if (!allowed) {
      return yield* impersonationDenied(caller, {
        operation: "forceStop",
        targetUserId: record.targetUserId,
        sessionId: Sessions.SessionId(record.sessionId),
      });
    }
    return clearance({ adminUserId: Users.UserId(caller.ref.id), config });
  });

  /** BEH-EA-219 / IDS-001: `list`'s per-row gate. It filters, and never publishes or fails. */
  const visibleEpisodes = (
    caller: Api.UserPrincipal,
    records: ReadonlyArray<ImpersonationRecords.ImpersonationRecord>,
  ) =>
    Effect.flatMap(inForce, (config) =>
      Effect.filter(
        records,
        (record) => config.canManageEpisode({ admin: subject(caller.ref.id), episode: record }),
        { concurrency: 8 },
      ),
    );

  /** IDS-002: a `CrossTenant` witness for a caller who passes `canAdministerTenants`, else `None` (confinement stays). */
  const crossTenantScope = (caller: Api.UserPrincipal) =>
    Effect.flatMap(inForce, (config) =>
      config
        .canAdministerTenants({ admin: subject(caller.ref.id), organizationId: Option.none() })
        .pipe(
          Effect.map((allowed) =>
            allowed
              ? Option.some(TenantScoped.crossTenant("admin: superadmin (canAdministerTenants)"))
              : Option.none(),
          ),
        ),
    );

  return { collection, user, organization, impersonation, episode, visibleEpisodes, crossTenantScope };
});

export type AdminGate = Effect.Success<typeof make>;
```

Notes for the executor:

- **No return-type annotations.** `make`, the gate operations and `AdminGate` (a derived type alias, not an annotation of a const) are all inferred.
- **One configuration per decision.** Each operation reads `inForce` once. A caller that needs another field reads it from the clearance, so the decision and the value it then uses are the same snapshot.
- **Message strings are unchanged.** `crossTenant` reasons, event `action` strings and error classes are exactly today's, so audit consumers and BDD steps see no difference until Phase 3.

### 3.4 Call sites after Phase 1 (illustrative; bodies otherwise unchanged)

```ts
// Admin.ts — make (replaces :870-871, :881-938, :1195-1214)
const gate = yield* AdminGate.make;

const effectiveConfig: AdminShape["effectiveConfig"] = Effect.fnUntraced(function* (caller) {
  yield* gate.collection(caller, "effectiveConfig");
  return EffectiveConfig.read(builtIn, catalog);
});
const getUser: AdminShape["getUser"] = (caller, userId) =>
  Effect.flatMap(gate.user(caller, "getUser", userId), (cleared) => cleared.target);

const banUser: AdminShape["banUser"] = Effect.fnUntraced(function* (caller, userId, input) {
  const cleared = yield* gate.user(caller, "banUser", userId); // gate first
  if (caller.ref.id === userId) return yield* Effect.fail(new AdminApi.AdminSelfBanRefused()); // then self
  yield* cleared.target; // then existence (replaces the inline copy at :998-1002)
  // … setStatus / revokeAll / userBanned unchanged
});

const impersonate: AdminShape["impersonate"] = Effect.fnUntraced(function* ({ caller, targetUserId, reason }) {
  if (caller.ref.id === targetUserId) return yield* Effect.fail(new AdminApi.AdminSelfImpersonationRefused());
  if (caller.actingAs !== undefined) return yield* Effect.fail(new AdminApi.AdminAlreadyImpersonating());
  const cleared = yield* gate.impersonation(caller, targetUserId);
  yield* cleared.target;
  const issued = yield* sessions.issue({
    userId: targetUserId,
    actingAs: { type: caller.ref.type, id: caller.ref.id },
    absoluteDuration: cleared.config.maxDuration,
  });
  // … records.create / impersonationStarted unchanged
});

const forceStop: AdminShape["forceStop"] = Effect.fnUntraced(function* (caller, sessionId) {
  yield* sweepExpired;
  const scope = Option.getOrUndefined(yield* gate.crossTenantScope(caller));
  const episode = yield* records.findBySessionId(sessionId, scope);
  if (Option.isNone(episode)) return yield* Effect.fail(new AdminApi.AdminImpersonationNotFound());
  yield* gate.episode(caller, episode.value);
  // … revokeQuietly / endEpisode / impersonationStopped unchanged
});

const list: AdminShape["list"] = Effect.fnUntraced(function* (caller, input) {
  yield* sweepExpired;
  const page = yield* records.list(input, Option.getOrUndefined(yield* gate.crossTenantScope(caller)));
  return { items: yield* gate.visibleEpisodes(caller, page.items), nextCursor: page.nextCursor };
});
```

```ts
// AdminAccounts.ts — make (replaces :169, :172-199)
const gate = yield* AdminGate.make;

const deleteUser: AdminAccountsShape["deleteUser"] = Effect.fnUntraced(function* (caller, userId) {
  const cleared = yield* gate.user(caller, "deleteUser", userId);
  if (caller.ref.id === userId) return yield* Effect.fail(new AdminAccountsApi.AdminSelfActionRefused());
  yield* cleared.target;
  yield* erasure.eraseAccount(userId, Erasure.ErasureInitiator.Admin({ adminUserId: cleared.adminUserId })) // …
});
// setUserEmail:    const cleared = yield* gate.user(caller, "setUserEmail", userId); const user = yield* cleared.target;
//                  … link: cleared.config.links.changeEmail
// setUserPassword: const cleared = yield* gate.user(caller, "setUserPassword", userId); self-refusal;
//                  const user = yield* cleared.target; … yield* cleared.config.passwordPolicy(input.password)
```

```ts
// AdminTenants.ts — make (replaces :188-211; `existing` keeps its body, takes the clearance)
const gate = yield* AdminGate.make;
const existing = (cleared: AdminGate.OrganizationClearance) =>
  directory.find(cleared.organizationId).pipe(/* None → AdminOrganizationNotFound, unchanged */);

// listOrganizations:     yield* gate.collection(caller, "listOrganizations");
// getOrganization:       existing(yield* gate.organization(caller, "getOrganization", organizationId))
// suspendOrganization:   const cleared = yield* gate.organization(caller, "suspendOrganization", organizationId);
//                        directory.suspend(OrganizationActor.platformAdmin(cleared.adminUserId), {
//                          organizationId: cleared.organizationId, reason: input.reason })
```

`Admin.ts` keeps the public configuration surface by re-exporting it (precedent: `core/src/SignIn.ts:35-36`):

```ts
// Admin.ts (replaces :54-201)
export {
  config,
  type AdminConfigShape,
  type EpisodeGateInput,
  type ImpersonationGateInput,
  type TenantAdminGateInput,
  type UserAdminGateInput,
} from "./internal/AdminGate.ts";
// … and in the class declaration (:843-844): config: [AdminGate.descriptor, ConfigDescriptor.make(AuditChain.AuditChainConfig, …)]
```

Removed from `Admin.ts`: `AdminConfig` (Phase 2, Q1), `subjectOf`, `subjectOfUserId`, `episodeGateFrom`, `deny`, `authorizeUsers`, `authorizeUser`, `tenantScopeFor` and the `configNow` read. Removed from `AdminAccounts.ts`: `authorize`, `existing` and the `AdminConfig` import. Removed from `AdminTenants.ts`: `authorize` and the `AdminConfig`/`configNow` reads. The `Admin.ts` header comment (`:10-21`, the identity-only subject rationale) moves to `AdminGate.ts`, where `subject` now lives.

### 3.5 Why this shape (alternatives considered)

- **A Context service (`AdminGate` tag + layer) instead of a `make` effect.** Rejected. It would be one more service in every composition. The precedent for an in-package module shared by several plugin `make`s is a `make` effect (`SignIn.make`, `SignUp.make`, `Channel.make`). Each plugin captures its own built value, exactly as today.
- **Keep `AdminConfig` exported and add a lint rule against `yield* AdminConfig`.** Rejected. A private reference is a compile-time guarantee, the lint rule would be a convention, and nothing outside `admin/src` reads the reference (§2.2). A string-equal `Context.Reference("awthaq/admin/Config")` recreated elsewhere would still read the slot, so the boundary test (§5.2) also pins the key string to `AdminGate.ts`.
- **Self-refusal in the action table** (`banUser: { gate, refuseSelf: AdminSelfBanRefused }`). Rejected. It mixes request validation into authorization and needs per-action error classes in the table. Three call sites, each one line.
- **One core `AdminGate` for admin, SAML and webhooks.** Rejected (non-goals): the predicate inputs and errors differ, and the shared part is shallow.
- **A per-request `Effect` (`inForce`) on the interface instead of clearances.** Rejected. It would let a caller read the configuration without passing a gate, which is the exact path the bug took.

---

## 4. Phased migration

Every phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. The plan gate is `pnpm check`. No SQL adapter changes, so `pnpm test:pg` is not required. One ticket per phase goes under `.scratch/admin-gate/issues/` when work starts.

### Phase 0: pin and hotfix the `AdminAccounts` tenant bypass (independent; ship first)

1. **Tests first (red at HEAD).** In `packages/admin/test/AdminTenantConfig.test.ts`, add a second composition `Auth.make([Admin.Admin, AdminAccounts.AdminAccounts])` and a `LayerMap` `AccountsTenantConfig`. Its lookup gives tenant `"ops"`:
   - `canDeleteUsers` and `canManageCredentials` → `true`;
   - `passwordPolicy` → `["must contain a digit"]` when the password has no digit;
   - `links.changeEmail: (t) => \`https://ops.example/confirm?token=${t}\``.

   Every other tenant gets `Admin.config({})`. Then add four tests, worded as BDD:
   - "a tenant may tighten a permissive build-time canDeleteUsers: the account survives". Build `{ canDeleteUsers: allow }`; in tenant `"other"`, `deleteUser` → `AdminActionDenied`, and `users.findById(target)` still succeeds.
   - "a tenant may open canManageCredentials over a deny-all build". Build `{}`; in tenant `"ops"`, `setUserPassword(caller, ghost, …)` → `AdminTargetNotFound`, which means past the gate.
   - "a tenant's passwordPolicy governs an administrator-set password". Build `{ canManageCredentials: allow }`; in `"ops"`, a 30-character password without digits → `AdminWeakPassword` with `["must contain a digit"]`.
   - "a tenant's links.changeEmail builds the mailed confirmation link". In `"ops"`, `setUserEmail` → the sent mail's `data.url` starts with `https://ops.example/confirm`, using the `Mailer.sent` pattern of `AdminAccounts.test.ts:316`.
2. **Fix.** In `packages/admin/src/AdminAccounts.ts`:
   - `:169` becomes `const builtAdminConfig = yield* AdminConfig;` + `const configNow = Tenant.configInForce(AdminConfig, builtAdminConfig);`, with the `Admin.layer` comment (`Admin.ts:866-869`).
   - `authorize` (`:173-192`) does `const adminConfig = yield* configNow;` and **returns** `adminConfig`.
   - `setUserEmail` and `setUserPassword` bind `const adminConfig = yield* authorize(…)` and read `links.changeEmail` (`:244`) and `passwordPolicy` (`:270`) from it.
   - `Tenant` is already imported (`:40`).
3. **Changeset.** `.changeset/admin-accounts-tenant-config.md`, `"@awthaq/admin": patch` (text in §6.4).
4. **Gate.** The phase gate, plus `npx vitest run packages/admin`.

### Phase 1: the gate module; all three plugins call it; one gate suite replaces the per-file denial tests

1. Create `packages/admin/src/internal/AdminGate.ts` (§3.2, §3.3).
   - Move the configuration block from `Admin.ts:54-201` into it verbatim.
   - **Keep `AdminConfig` exported in this phase only**, so the phase is reviewable on its own. Phase 2 makes it private.
2. `Admin.ts`: re-export the configuration surface (§3.4). Replace the gate code with `gate.*` calls at every site in §2.1 G1 to G7. `ConfigDescriptor.make(AdminConfig)` becomes `AdminGate.descriptor`.
3. `AdminAccounts.ts` and `AdminTenants.ts`: the §3.4 call sites. Delete Phase 0's interim `configNow`/`authorize`.
4. New test `packages/admin/test/AdminGate.test.ts` (§5.1).
5. Delete the 18 tests and trim the 2 assertions listed in §5.4. Delete `packages/admin/test/AdminTenantConfig.test.ts`: its two original cases and Phase 0's four are rows of the new matrix.
6. `pnpm knip`: `AdminGate.ts`'s exports are each used by `Admin.ts`/`AdminAccounts.ts`/`AdminTenants.ts` or by the tests. `pnpm circular` must stay clean (§3.2 note).
7. **Declaration emit.** If `tsc -b` reports TS2883 on `Admin.layer`/`AdminAccounts.layer` (the inferred type naming an internal type), keep the needed namespace imported in that file, as plan 04 Phase 0 did (Decisions taken). Do not add an annotation.
8. **Changeset.** `.changeset/admin-gate.md`, `"@awthaq/admin": patch` (no public change in this phase; text in §6.4).

### Phase 2: the type-level guard — the configuration reference becomes private

1. `AdminGate.ts`: drop `export` from `AdminConfig` (§3.2).
2. `Admin.ts`: the re-export no longer includes `AdminConfig`. This removes the public `Admin.AdminConfig` (Q1).
   - Grep: `grep -rn "Admin\.AdminConfig\b\|AdminConfig[^S]" packages/*/src packages/*/test features examples docs` must find only `AdminGate.ts` and prose comments.
   - At `fc990c88`, no test, step definition or example reads the reference (§2.2).
3. New `packages/admin/test/AdminGate.boundary.test.ts` (§5.2) and `packages/admin/test/AdminGate.types.test.ts` (§5.3).
4. **Changeset.** `.changeset/admin-config-private.md`, `"@awthaq/admin": minor`, with `Migration:` (§6.4).

### Phase 3: the denial event names its target (Q2; recommended)

1. `packages/core/src/AuthEventSchemas.ts:469-481`, `AdminActionDeniedEvent`:
   - add `targetUserId: Schema.optionalKey(UserIdSchema)` and `organizationId: Schema.optionalKey(Schema.String)`;
   - keep `attempt: true` and `pii: []`;
   - rewrite the doc comment (§2.5).
   - SAML and webhooks keep publishing without them (both keys are optional).
2. `AdminGate.ts`: `refuse` takes the target. `decide` passes `{ targetUserId }` for `on: "user"` and `{ organizationId }` for `on: "organization"`.
3. Extend §5.1 test 1 to assert the target fields.
4. **Changeset.** `.changeset/admin-denied-target.md`, `"@awthaq/core": minor`, `"@awthaq/admin": minor` (§6.4).

### Phase 4: consume plan 11's principal helper (only after plan 11; skip if plan 11 already removed the copies)

1. Delete `currentUserPrincipal` at `Admin.ts:431-440`, `AdminAccounts.ts:103-112` and `AdminTenants.ts:103-112`. The handler groups call plan 11's exported helper. `Defects` drops from the imports where it becomes unused.
2. **No changeset** (no behavior change). If plan 11 already did this, record "no-op" in Decisions taken.

### Phase 5: spec, ADR, docs, README, template, BDD

1. The §6.1 to §6.3 edits.
2. `packages/admin/README.md`:
   - `:26`: every user-administration predicate receives `tenantId`.
   - New paragraph "Per-tenant configuration": every `AdminConfig` field is read per operation, `Admin.config(...)` in a `TenantConfig` lookup governs that tenant, and a tenant's layer fills unnamed fields with the deny-all defaults.
3. `docs/plugin-authoring.md`, `## Tenancy` (`:127`): add a paragraph "Per-tenant configuration (ADR-EA-018 D8)":

   > read a `Context.Reference` config per operation through `Tenant.configInForce(Reference, built)`; a value derived once at boot is documented at its read. When a predicate gates an operation, keep the reference module-private to the gate and hand the operation only the configuration the gate decided with (see `@awthaq/admin` `internal/AdminGate.ts`).

   Update the Config row (`:14`) to point at it.
4. `examples/plugin-template/src/Template.ts:342`: `const settingsNow = Tenant.configInForce(NotesConfig, yield* NotesConfig);` and `const settings = yield* settingsNow;` at the top of `create` (`:350`). Add one test to `examples/plugin-template/test/Template.test.ts` (its layer already provides `Template.config({ maxLength: 20 })`, `:31`): "a NotesConfig provided for the request overrides the build-time maxLength".
5. BDD (§5.5).
6. `pnpm check`, `pnpm spec:verify:strict`.

---

## 5. Test plan

**Replace, don't layer**: the gate is tested once, through the public operations of the three plugins (which also proves each call site picked the right action). Each plugin's own suite keeps only what happens after the gate.

### 5.1 `packages/admin/test/AdminGate.test.ts` (new, Phase 1)

**Composition.** One `TestAuth.layer(Auth.make([Organization, Admin, AdminAccounts, AdminTenants]), { services: Layer.mergeAll(Admin.config(build), Organization.config({}), AuditChain.config({ key })) })`, merged with a `TenantConfig` `LayerMap` whose lookup is `Admin.config(tenantConfigs.get(tenantId) ?? {})` + `Tenant.configApplied(tenantId)`. The `AdminTenantConfig.test.ts:23-31` shape.

**The operation table.** It is the test's own copy of the action table, deliberately not imported, so a wrong row in `AdminGate.ts` is caught. Each row holds:

- the operation, as an effect over `(caller, ghostUserId | ghostOrgId)`;
- its predicate;
- its expected denial (`AdminActionDenied` + `actionDenied.action`, or `AdminImpersonationDenied` + `operation`);
- its expected "past the gate" outcome for a ghost target: `AdminTargetNotFound`, `AdminOrganizationNotFound`, or success for collection calls.

It has 19 rows: 12 user-administration (incl. `effectiveConfig`), 4 tenant-administration, `impersonate`, `forceStop` and `list`. `forceStop` and `list` use a seeded episode row, not a ghost (G5/G6 look the episode up first).

Tests:

1. `BEH-EA-221/224/237, BEH-EA-212/218: every gated operation is fail-closed by default and publishes exactly one denial naming the action`.
   - Asserts the error tag per row and the ordered list of `actionDenied.action` / `impersonationDenied.operation` values.
   - Asserts `list` returns an empty page with no event.
   - The impersonate row also asserts no session was issued for the target (from `Admin.test.ts:63`) and IDS-006's `targetUserId`.
   - The `forceStop` row asserts `sessionId` and `targetUserId`, and that the episode's session is still live.
2. `BEH-EA-221: each operation opens on its own predicate and on no other`. For each of the 7 predicates, build with only that predicate allowing, run every row, and assert that exactly the rows mapped to it get past the gate. This replaces the "separate predicates" and "even for an administrator of users" tests. `canManageEpisode` is set explicitly here, so the `canImpersonate`-derived default does not couple the two.
3. `BEH-EA-221, IDS-003: the gate runs before existence`. For every targeted row with a ghost id: deny-all → the denial; allow → the not-found. This covers `AdminUsers:122`'s trimmed assertion, `AdminAccounts:174`, `AdminTenants:67` and `Admin:431`.
4. `BEH-EA-221, IDS-001/002: each predicate sees the identity-only admin, the target (None for collection calls) and the ambient tenant`.
   - Capture every input under `Tenant.withTenant("org-a")`.
   - User gates: `{ admin.id, target: Option<id>, tenantId: Some("org-a") }`.
   - `canAdministerTenants`: `{ admin.id, organizationId }`, with `None` for `listOrganizations` and for `list`/`forceStop`'s scope check.
   - `canImpersonate`: `{ admin.id, target.id, tenantId }`.
   - `canManageEpisode`: the episode row, and its own `tenantId` under the default derivation (`Admin.test.ts:617`'s assertion).
5. `ADR-EA-018 D8, BEH-EA-236: a tenant's configuration opens a deny-all build, per predicate`. For each predicate P: build `{}`, tenant `"ops"` allows only P. Under `"ops"` the P rows pass; under `"other"` and with no tenant every row is denied.
6. `ADR-EA-018 D8, BEH-EA-236: a tenant's configuration tightens a permissive build, per predicate`. For each P: the build allows everything, and tenant `"other"` is `{}`. Under `"other"` every row is denied; with no tenant every row passes. The `deleteUser` row additionally asserts that the target survives (the Phase 0 regression, now a matrix cell).
7. `BEH-EA-236: with no tenant configuration the build-time value applies exactly as before`. Build-time allows are honored with no `TenantConfig` provided, which keeps the `Layer.provide(Admin.config)` meaning.
8. `BEH-EA-236: the non-gate configuration is read per operation, from the configuration that authorized the call`:
   - Tenant `"ops"`'s `maxDuration` (5 minutes) is the impersonation session's absolute expiry.
   - Its `passwordPolicy` refuses with its hints.
   - Its `links.changeEmail` builds the mailed URL.
   - This takes Phase 0's three non-gate tests.
9. `IDS-002: only canAdministerTenants lifts the tenant confinement, and a tenant's configuration may withdraw it`. A superadmin allowed at build time but denied by tenant `"org-a"`'s configuration sees only `org-a`'s episodes from inside `org-a`. This is a new case that `Admin.test.ts:644` (kept) does not cover.

### 5.2 `packages/admin/test/AdminGate.boundary.test.ts` (new, Phase 2)

This follows `core/test/ErasureClearance.boundary.test.ts`. It scans `packages/admin/src/**/*.ts` and asserts:

1. `"awthaq/admin/Config"` and `Tenant.configInForce`/`configInForce` appear only in `internal/AdminGate.ts`.
2. `"auth.admin.actionDenied"` and `"auth.admin.impersonationDenied"` are published only in `internal/AdminGate.ts`. The gate is the only denier.
3. `src/index.ts` does not mention `internal/AdminGate`.
4. `Admin.ts`, `AdminAccounts.ts` and `AdminTenants.ts` each import `./internal/AdminGate.ts` (or `../internal/AdminGate.ts`), and no other admin source file imports it as a value.

### 5.3 `packages/admin/test/AdminGate.types.test.ts` (new, Phase 2; the `SignIn.types.test.ts` pattern)

These `@ts-expect-error` lines are checked by `tsc -p tsconfig.test.json`. All were verified to compile as expected against the §3.2/§3.3 sketch.

```ts
declare const gate: AdminGate.AdminGate;
declare const caller: Api.UserPrincipal;
const gates = () => {
  // @ts-expect-error - a collection action takes no target
  void gate.user(caller, "listUsers", Users.UserId("u"));
  // @ts-expect-error - a per-user action is not a collection call
  void gate.collection(caller, "deleteUser");
  // @ts-expect-error - an organization action is not a user action
  void gate.user(caller, "suspendOrganization", Users.UserId("u"));
  // @ts-expect-error - a structurally identical object is not a clearance: only the gate mints one
  const forged: AdminGate.UserClearance = { adminUserId: Users.UserId("a"), config: built, userId: Users.UserId("u"), target: Effect.die("x") };
};
// The derived predicate unions are exactly these (an `Equal<…>` check, as in core's types tests):
//   UserGate   = "canManageUsers" | "canBanUsers" | "canDeleteUsers" | "canManageCredentials"
//   TenantGate = "canAdministerTenants"
//   CollectionAction = "effectiveConfig" | "listUsers" | "listOrganizations"
```

`built` is a `declare const built: Admin.AdminConfigShape`. Importing `../src/internal/AdminGate.ts` from a test is allowed; the boundary test scans `src` only.

### 5.4 Tests deleted or trimmed (Phase 1), by name

- Deleted (18):
  - `AdminUsers.test.ts`: `:60`, `:87`, `:253`, `:364`.
  - `AdminAccounts.test.ts`: `:120`, `:149`, `:174`.
  - `AdminTenants.test.ts`: `:41`, `:67`.
  - `AdminConfig.test.ts`: `:39`.
  - `AdminTenantConfig.test.ts`: `:41`, `:57` (the file is deleted, with Phase 0's four cases moving into §5.1 tests 6 and 8).
  - `Admin.test.ts`: `:63`, `:258`, `:309`, `:327`, `:364`, `:431`.
  - Names are in §2.6.
- Trimmed (2):
  - `AdminUsers.test.ts:122` loses its ghost-`getUser` assertion (`:144-145`) and is renamed "listUsers pages with a keyset cursor".
  - `Admin.test.ts:617` loses the `seenTenants` assertion (`:628-630`) and its capturing predicate, and keeps the stamping assertion. It is renamed "an episode is stamped with the ambient tenant".
- Helpers that become unused after the deletions (`protectedIds`/`seenTargets` in `AdminUsers.test.ts`, `seenTenants`/`protectedIds` in `Admin.test.ts`, `collectEvents` where nothing else uses it) are deleted. `pnpm knip` and `pnpm lint` flag any that remain.
- Kept, because they test a different seam: the HTTP status mappings (`AuthHttp.test.ts:161`, `:621`; `AdminAccountsHttp.test.ts:61`), `AdminConfig.test.ts:59/83` (the effective-configuration listing), `Admin.test.ts:644` (cross-tenant visibility) and every post-gate behavior test.

### 5.5 BDD (`features/`, Phase 5)

New REQ ids are the next free ones at execution time. They are above `REQ-EA-1306` at `fc990c88`; re-check `features/traceability.md`, since sibling plans allocate too.

- `features/features/12-multi-tenancy/28-tenancy.feature`, rule `@BEH-EA-236` (`:331`), two scenarios:
  - "A tenant's administration configuration can refuse deleting a user the platform would allow". Given a composition whose build-time `canDeleteUsers` admits every administrator, and the tenant "acme" configures no deletion. When an administrator deletes a user in a request naming "acme". Then the deletion is refused with "AdminActionDenied" and the user still exists.
  - "A tenant's administration configuration supplies its own password policy". The same shape, with `setUserPassword` and `AdminWeakPassword`.
  - Steps go in `TenancyWorld.ts`: a second stack, `buildAdminAccountsStack`, built from `Auth.make([Admin, AdminAccounts])` with its own `LayerMap` of `Admin.config` per tenant. It mirrors `TenantConfig` at `TenancyWorld.ts:150-160` and is driven domain-level with `Effect.provide(TenantConfig.get(tenant))`, like REQ-EA-850.
- `features/features/09-admin-and-impersonation/27-admin-impersonation.feature`, rule `@BEH-EA-221`: no new scenario. The existing REQ-EA-631/702-707 must pass unchanged in meaning.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behavior specs (each with a Document Control revision and a change-history line)

- **`spec/behaviors/28-tenancy.md` → rev 1.8**, BEH-EA-236 (`:115-127`).
  - Rewrite the adopter sentence:

    > "Plugins that adopt the per-operation rule do so through `Tenant.configInForce(reference, built)`: organization, password, core `Sessions`, `Accounts` and rate-limit overrides, oauth, passkey, jwt, webhooks and admin. Admin reads **every** `AdminConfig` field per operation (its seven predicates, `maxDuration`, `passwordPolicy`, `links`) through one internal gate, and the configuration reference is private to it. The other plugins' configuration (two-factor, magic link, email OTP, api-key, device authorization, saml, scim, roles) is deployment-scoped."
  - Extend the boot-scoped list with Jwt's `acceptAsBearer` and Organization's `invitationRetention` (§2.3).
  - Add:

    > "A tenant's `config(...)` layer is a whole configuration: fields it does not name take the plugin's defaults, not the build-time values."
- **`spec/behaviors/27-admin-impersonation.md` → rev 1.5.**
  - **BEH-EA-221** (`:318-356`):
    - The `ts` block gains `tenantId` and shows `canDeleteUsers`/`canManageCredentials` with the same input.
    - The REQUIREMENT gains:

      > "Each operation is guarded by exactly one predicate: `canManageUsers` for `listUsers`, `getUser`, `updateUser`, `listUserSessions`, `revokeUserSession`, `revokeUserSessions` and `effectiveConfig`; `canBanUsers` for `banUser`/`unbanUser`; `canDeleteUsers` for `deleteUser`; `canManageCredentials` for `setUserEmail`/`setUserPassword`. Where a self-refusal applies it runs after the gate and before the existence check."
    - Delete the stale sentence "It does not yet consult `Hooks.BeforeCredentialReset` …" (`:352`) and replace it with "It consults `Hooks.BeforeCredentialReset` with no second-factor code (ARF-005): a user protected by a second factor is refused `HookAborted` (`TWO_FACTOR_REQUIRED`) and nothing is written."
  - **BEH-EA-224** (`:408-…`): "`auth.admin.actionDenied { adminUserId, action }` when any user- or tenant-administration predicate resolves `false`". With Phase 3 (Q2): "… and `targetUserId` or `organizationId` when the call named one."
  - **BEH-EA-212**: one sentence, "Every admin predicate is read from the configuration in force for the request ([BEH-EA-236](28-tenancy.md#…))."

### 6.2 Decisions

- **No new ADR** (none reserved for this plan).
- **ADR-EA-018 rev 1.5.** Decision 8, last sentence (`:48`), becomes:

  > "Admin reads every field of `AdminConfig` per operation (its gates, `maxDuration`, `passwordPolicy`, `links`) through one internal gate module; the configuration reference is private to that module, so no admin operation can read the build-time value *(revision 1.5, plan 13: `AdminAccounts` had read it once at build, so a tenant's `canDeleteUsers`/`canManageCredentials` were ignored)*. The deny-all default is unchanged."

  Add a "Revision note (plan 13)" paragraph after the plan 02 note, and a change-history entry.
- **ADR-EA-025**: no change. The predicates stay identity-only; the "platform admin" question stays inside the host's predicate.

### 6.3 Traceability

- **`spec/traceability.md` → rev 1.33.**
  - Add rows for `packages/admin/test/AdminGate.test.ts` (BEH-EA-212/217/219/221/224/236/237, ADR-EA-018 D8: every gated operation × predicate × {default, build-time allow, tenant opens, tenant tightens}; gate before existence; predicate inputs; non-gate configuration per operation), `AdminGate.boundary.test.ts` (the configuration reference and the denial events live only in the gate) and `AdminGate.types.test.ts` (action/predicate pairing and clearances are compile-time).
  - Update the `AdminConfig.test.ts` row (`:300`): it is no longer the gate's test.
  - Add `packages/admin/test/AdminGate.test.ts` to the ADR-EA-018 row (`:161`).
- **`features/traceability.md`**: the two new REQ rows (§5.5).

### 6.4 Changesets (ADR-EA-034)

- **Phase 0**, `.changeset/admin-accounts-tenant-config.md`, `"@awthaq/admin": patch`:

  > `AdminAccounts` reads `AdminConfig` per operation, like `Admin` and `AdminTenants` (ADR-EA-018 Decision 8, BEH-EA-236): a tenant's `canDeleteUsers`, `canManageCredentials`, `passwordPolicy` and `links.changeEmail` now apply to that tenant's requests. Before, they were read once at layer build, so a tenant could not refuse a deletion or credential change the deployment-wide configuration allowed.
  >
  > Migration: a `TenantConfig` lookup that returns `Admin.config({ … })` for a tenant now also governs that tenant's `deleteUser`, `setUserEmail` and `setUserPassword`. `config(partial)` fills the fields it does not name with the deny-all defaults, so a lookup that names only `canManageUsers` turns deletion and credential administration off in that tenant, and resets its `passwordPolicy` and `links`. Name every capability the tenant keeps.

- **Phase 1**, `.changeset/admin-gate.md`, `"@awthaq/admin": patch`:

  > Every admin gate (user, ban, deletion, credentials, tenant administration, impersonation, episodes) is one internal module that reads the configuration in force, publishes the denial and loads the target only after the gate (BEH-EA-221, BEH-EA-236). No behavior change.
  >
  > Migration: none.

- **Phase 2**, `.changeset/admin-config-private.md`, `"@awthaq/admin": minor`:

  > `Admin.AdminConfig` (the `Context.Reference`) is no longer exported: the admin plugins read it only per operation, through their gate (ADR-EA-018 Decision 8, rev 1.5).
  >
  > Migration: provide configuration with `Admin.config({ … })` (build time: `Layer.provide`; per tenant: a `TenantConfig` lookup; per request: `Effect.provide(Admin.config({ … }))`), and read the effective configuration with `GET /admin/config` / `EffectiveConfig` (BEH-EA-229). `Admin.AdminConfigShape` and the gate input types are unchanged.

- **Phase 3**, `.changeset/admin-denied-target.md`, `"@awthaq/core": minor`, `"@awthaq/admin": minor`:

  > `auth.admin.actionDenied` carries `targetUserId` or `organizationId` when the refused call named one, like `auth.admin.impersonationDenied` (IDS-006, BEH-EA-224).
  >
  > Migration: none for publishers (both fields are optional). A consumer that validates the event with a closed schema accepts the two optional keys.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **Phase 0 changes what an existing multi-tenant deployment allows** (a tenant lookup that named only `canManageUsers` silently kept deletion and credentials until now) | Fail-closed direction only. It is called out in the changeset `Migration:` line, the README paragraph and BEH-EA-236's new sentence. Q3 records the alternative (merge over the build-time value) and why it is not taken here |
| **A wrong row in the action table** silently grants a capability under the wrong predicate | The test keeps its own copy of the table (§5.1), and test 2 runs every row against every predicate in isolation. The type checks (§5.3) stop a predicate of the wrong shape |
| **Declaration emit (TS2883)** once inferred layer types reach an internal module | Phase 1 step 7: keep the namespace imported where `tsc` asks (plan 04 precedent), never an annotation |
| **Event-order regressions** in BDD steps that count `actionDenied` | Strings and event shapes are unchanged until Phase 3. Run `pnpm test:bdd` before and after Phase 1, and compare REQ-EA-631/702-707/382/400 |
| **Composition weight of the gate suite** (four plugins in one `TestAuth.layer`) | All four already compose under `TestAuth.layer` in their own suites. If one composition is too slow, split the suite per plugin and share the operation table, never by duplicating assertions |
| **A string-equal `Context.Reference("awthaq/admin/Config")` elsewhere** bypasses privacy | Boundary test §5.2 item 1 |
| **Plan 11 and Phase 4 both delete the same three functions** | Phase 4 is conditional and a no-op if plan 11 removed them (§8) |

**Rollback.** Phase 0 is a three-line revert that restores the bug, so revert it only together with its tests. Phase 1 reverts as a unit: the module, the call sites, the test replacement. Phase 2 reverts to an exported reference without touching Phase 1. Phase 3 is additive in core. Phase 5 is docs only.

---

## 8. Interactions with other plans

**Done plans (01 to 10):**

- **01 (sign-in/sign-up in core).** The `Clearance` brand idiom (`core/src/internal/signInSteps.ts:37-45`) is the precedent for `AdminGate`'s clearances. The decision taken there (the `Admin.impersonate` `orDie` on `sessions.issue` became `StoreUnavailable`) is preserved by §3.4.
- **03 (erasure).** `deleteUser` stays `AccountErasure.eraseAccount(userId, ErasureInitiator.Admin({ adminUserId }))`. Phase 0 makes the tenant's `canDeleteUsers` decide before the cascade runs. The `BeforeUserDelete` veto is independent of the gate.
- **04 (organization system modules).** `AdminTenants` keeps calling `OrganizationDirectory.find/suspend/reinstate` with `OrganizationActor.platformAdmin`. Only its gate moves.
- **08 (test composition).** The gate suite uses `TestAuth.layer` with `services`, the shape plan 08 settled.
- **09 (event definitions).** Phase 3 adds optional fields with `defineEvent` metadata (`actor`, `pii: []`, `attempt: true`).
- **10 (standalone fixes).** `actionDenied`/`impersonationDenied` are attempt events (Decisions taken, Q8). The gate publishes outside every transaction, as today.

**Sibling plans (11 to 24):**

- **11 (credential resolution).** Owns exporting one `currentUserPrincipal`/request-facts helper from `@awthaq/server` and deleting the eight named copies, three of them in admin (§2.1). This plan does **not** write its own helper. Phase 4 deletes the admin copies only if plan 11 left them. Either order merges cleanly: Phases 0 to 3 do not touch the handler groups' principal lookup.
- **15 (host composition).** It derives the servable layer, including config descriptors, from `Auth.make`. `Admin` still declares one descriptor with the key `"awthaq/admin/Config"` (`AdminGate.descriptor`), so `EffectiveConfig` and `doctor` output are unchanged. If 15 rebuilds `TestAuth.layer`, §5.1's composition follows it.
- **21 (session-minting annotation).** `impersonate` mints a session. The annotation is on the endpoint and the cookie write stays in the handler (`Admin.ts:466`). No conflict.
- **22 (table DDL locality).** It moves `adminMigrations`/`addTenantIdMigration` (`Admin.ts:576-825`) next to `ImpersonationRecords`. That is a textual neighbor of this plan's `Admin.ts` edits, with no semantic interaction. Rebase whichever lands second.
- **24 (memory records over SQLite)** and **16 (SQL store adapters).** `ImpersonationRecords` adapters may change. The gate reads no records except through `Users.findById` and the episode passed in.
- **12, 14, 17, 18, 19, 20, 23**: no interaction.
- **Follow-ups this plan creates.** SAML's `canManageSaml` per tenant (Q4). The `SqlError → die` sweep (non-goals). `Organization.ts:155-158` should call `Tenant.configInForce` instead of its inlined copy (cosmetic; for whoever next touches the file).

---

## 9. Acceptance checklist

- [ ] Phase 0's four tests were red at HEAD and are green after the fix. `deleteUser` in a tightening tenant leaves the account in place.
- [ ] `packages/admin/src/internal/AdminGate.ts` exists, is not exported from `src/index.ts`, and holds the only `AdminConfig` reference, the only `configInForce` call, and the only `actionDenied`/`impersonationDenied` publishes in `packages/admin/src` (boundary test).
- [ ] `Admin.ts`, `AdminAccounts.ts` and `AdminTenants.ts` contain no `authorize*`, `deny`, `tenantScopeFor`, `existing`-by-user or `configNow`. Every gated operation calls `gate.*` with a typed action name.
- [ ] `Admin.AdminConfig` is not exported. `Admin.config`, `Admin.AdminConfigShape` and the gate input types still are.
- [ ] `AdminGate.types.test.ts` passes: wrong action kinds and forged clearances fail to compile, and the derived unions are exact.
- [ ] `AdminGate.test.ts` covers 19 operations × 7 predicates × {default, build allow, tenant opens, tenant tightens}, plus gate-before-existence, predicate inputs and non-gate configuration.
- [ ] The 18 tests in §5.4 are deleted and the 2 assertions trimmed. `AdminTenantConfig.test.ts` is gone.
- [ ] (Phase 3, Q2) `auth.admin.actionDenied` carries `targetUserId`/`organizationId` when named.
- [ ] (Phase 4) No `currentUserPrincipal` copy remains in `packages/admin/src`.
- [ ] No `as` (other than `as const`), no return-type annotations, no new `Effect.die` in the touched source.
- [ ] BEH-EA-212/221/224/236 are updated with revision bumps (27 → 1.5, 28 → 1.8). ADR-EA-018 is at rev 1.5. `spec/traceability.md` is at rev 1.33. `features/traceability.md` has the new REQ rows. The README, `docs/plugin-authoring.md` and the template are updated.
- [ ] Every package-visible phase has a changeset with a `Migration:` line.
- [ ] `pnpm check` is green on the final commit.

---

## 10. Open questions only the user can answer

1. **Make `AdminConfig` private (Phase 2)?** It removes `Admin.AdminConfig` from the public surface. Nothing in the repo reads it, but a host could `Effect.provideService(effect, Admin.AdminConfig, …)` today.
   - **Recommended: yes.** It is the compile-time guarantee that a build-time read cannot come back. `Effect.provide(Admin.config(…))` covers per-request provision.
2. **Should `auth.admin.actionDenied` carry the target (Phase 3)?** That means `targetUserId` for user administration and `organizationId` for tenant administration, as IDS-006 already does for `impersonationDenied`. It is a core event-schema change (optional keys).
   - **Recommended: yes.** The gate has the target in hand, and a SIEM correlates refusals per target without joining request logs.
3. **Tenant configuration semantics.** A tenant's `Admin.config(partial)` replaces the whole configuration over the **defaults** (ADR-EA-018 D8, the same for every plugin). After Phase 0, a lookup naming only `canManageUsers` denies deletion and credentials in that tenant. Should admin instead offer an overlay over the build-time value (`Admin.tenantConfig(partial)`, merged in `inForce`)?
   - **Recommended: no.** Keep one rule for every plugin, fail-closed. Document it (changeset, README, BEH-EA-236). An overlay is a cross-plugin ADR change, if ever.
4. **SAML's `canManageSaml` per tenant.** It is the one other admin gate read only at build (`SamlAdmin.ts:131`). Open a follow-up plan or ticket to adopt `configInForce` there?
   - **Recommended: yes, as a separate ticket.** It is outside D8's adopter list today, so it is a feature, not a fix. The other build-time-only plugins stay deployment-scoped (BEH-EA-236 now says so).
5. **One gate for admin, SAML and webhooks?** A core helper for "publish `actionDenied` and fail" would serve five call sites.
   - **Recommended: no.** The shared part is six lines. The predicate inputs, errors and throttling differ, and a core helper would be shallow.
6. **Ship Phase 0 alone, now, as a hotfix** (Wave 0, before the refactor)?
   - **Recommended: yes.** It is the only phase that changes what a deployment allows. It closes a path to an irreversible erasure against a tenant's stated policy, and it is three lines plus four tests.

---

## Decisions taken (implementation, 2026-10-18)

Open questions took the plan's recommended default:

1. **Q1, make `AdminConfig` private: yes** (Phase 2). `Admin.AdminConfig` is no longer exported; changeset `admin-config-private` (minor) carries the `Migration:` line.
2. **Q2, `actionDenied` carries the target: yes** (Phase 3). Optional `targetUserId` / `organizationId`; SAML and webhooks publish without them.
3. **Q3, tenant configuration semantics: no overlay.** A tenant's `Admin.config(partial)` stays a whole configuration over the deny-all defaults; documented in the changeset, the README, BEH-EA-236 and ADR-EA-018 rev 1.5.
4. **Q4, SAML `canManageSaml` per tenant: separate follow-up**, not done here.
5. **Q5, shared core gate for admin/SAML/webhooks: no.**
6. **Q6, Phase 0 alone first: yes.** Phase 0 is its own commit (hotfix), before the refactor.

Implementation notes and deviations:

- **Phase 4 (consume plan 11's principal helper) was NOT done.** Plan 11 is not implemented yet, so the three `currentUserPrincipal` copies in `Admin.ts`, `AdminAccounts.ts` and `AdminTenants.ts` remain. Do it after plan 11.
- Phase 0's four tests lived in `AdminTenantConfig.test.ts`; Phase 1 deleted that file and moved the cases into `AdminGate.test.ts` (matrix tests for opens/tightens, the per-operation non-gate configuration test, and one `LayerMap` test for the production path).
- `AdminGate.test.ts` provides tenant configuration per request with `Effect.provide(Admin.config(...))` for the matrix (the mechanism `configInForce` reads), and a `LayerMap` for one end-to-end case.
- TS2883: `AdminTenants.ts` no longer yields `AuthEvents`/`Users` itself, so it keeps them type-imported through an exported `GateServices` alias so declaration emit can name them. No return-type annotation was added.
- `Admin.AdminShape` and the layer/handler call shapes are unchanged; `AdminGate.AdminGate` (type) is exported only from Phase 2 on, when the types test needs it.
- The BEH-EA-221 `Hooks.BeforeCredentialReset` stale sentence was replaced as the plan says.
- BDD: two scenarios under `@BEH-EA-236` (REQ ids allocated by `allocate-req-ea.py`); the world gained an `AdminAccounts` stack with its own `LayerMap`.
- Plugin template reads `NotesConfig` per operation (`Tenant.configInForce`); `Tenant` is imported from `@awthaq/ports` there.
