# 04 — Organization: system modules beneath the authorized interface

| Property | Value |
|---|---|
| Strength | Strong |
| Dependency category | in-process |
| Wave | C (after 05). Slice A (phases 0 to 2) may land early as the SCIM fix; see §4.0 |
| Fixes live bugs | SCIM group create/rename/delete and roster changes skip veto hooks, transactions, `teams.enabled`, `maximumTeams`, `maximumMembersPerTeam`, `allowRemovingAllTeams`, `auth.organization.team*` events and after-hooks. A long-lived qadi `DecisionCache` keeps stale answers after a SCIM roster change, a team move, a team-role change or a suspension. Organization creation and invitation acceptance are not atomic. Organization deletion leaves OIDC, SAML and SCIM connection rows behind. |
| Tickets | `.scratch/organization-system-modules/issues/NN-*.md`, one per phase (see `docs/agents/issue-tracker.md`) |

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality** (codebase-design glossary). Domain terms come from `spec/glossary.md`. The *authorized interface* is what a signed-in member calls through HTTP. A *system interface* is what trusted code calls: other plugins, application code, jobs. It takes an explicit **actor** for audit and never a request principal.

---

## 1. Summary, goals, non-goals

### 1.1 Summary

`packages/organization/src/Organization.ts` is 3,766 lines and holds one module with a single, wide interface. That interface mixes two concerns:

1. **Domain invariants** such as the owner invariant, quotas, the team forest, invitation capability tokens, cascades, transactions, hook points and events.
2. **Authorization** such as membership visibility (MTI-009), statement checks through `PermissionEngine`, `canGrant` ceilings derived from the caller and the `permissionDenied` audit event.

Every domain operation needs an `Api.UserPrincipal`, except the five caller-less methods (`checkSlug`, `addMember`, `checkRoleCeiling`, `syncMemberRoles`, `attributesFor`). Trusted callers therefore bypass the module and write the records directly:

- **SCIM** recreates `removeTeam`'s cascade (`Scim.ts:1245-1260`, copying the CWM-003 comment) and drops everything else.
- **AdminTenants** flips `suspendedAt` through `OrganizationRecords.setSuspended` (`AdminTenants.ts:247`, `:267`).
- **SAML and SCIM** read `OrganizationRecords` to check suspension (`Saml.ts:673/716`, `SamlConnections.ts:190/293`, `ScimConnections.ts:117/136`).

Every bypass is a place where an invariant, a hook or an event quietly stops applying.

This plan splits the domain into **seven deep system modules**, one per sub-domain, plus a read-only authority module and an organization-deletion registry:

- `OrganizationDirectory`
- `OrganizationMembers`
- `OrganizationTeams`
- `OrganizationInvitations`
- `OrganizationRoles`
- `OrganizationActiveContext`
- connections (`OrganizationConnectionStore`, deepened)
- `OrganizationAuthority` (read-only)
- `OrganizationDeletion` (registry)

Each module owns its invariants, its hook points, its events and its transactions. Each is a `Context.Service` taking an explicit `Actor`.

The existing `OrganizationShape` becomes a thin **authorized interface** on top: it resolves the caller, applies MTI-009 visibility, feature gates and `PermissionEngine` statements, derives a `Bound` (the caller's grant ceiling), and calls the system interface. SCIM, SAML and AdminTenants call the system interfaces and never the records.

The plugin layer **exposes** the system modules in its `ROut` through a new `AuthPlugin.layer({ exposes })` option. A dependent plugin's requirement on them is discharged by `Auth.make`'s fold. `Validate<P>` refuses a dependent that does not list `Organization` in `dependsOn`.

The local `veto(point: string, …)` helper (`Organization.ts:1897-1907`, 22 call sites, 20 distinct hand-typed ids) is replaced by core's `HookPoint.aborted(PointClass)` (`packages/core/src/HookPoint.ts:130-138`), which names the point by its class.

### 1.2 Corrections to the brief (verified)

- **SAML does not reach `ConnectionRecords`.** `SamlConnections.ts:190` yields `OrganizationRecords.OrganizationRecords` (used at `:293`). `Saml.ts:673` yields it too (used at `:716`). `Sso.ts:163` uses `OrganizationConnectionStore`, which is already a caller-less interface. No package outside `organization` touches `ConnectionRecords`.
- **Authorization of the organization's own endpoints is `PermissionEngine`, not qadi.** The original design decided that the organization's own endpoints are gated by its self-contained statement engine, "never a qadi round trip" (`.scratch/organization/issues/02-authorization-boundary.md` "Answer"; `.scratch/organization/spec.md` "Roles & permissions"; `spec/behaviors/35-organization.md` preamble). This plan keeps that decision. qadi integration stays `OrganizationQadi.relationships`/`attributes`. They move onto the same `OrganizationAuthority` the authorized layer uses, so ADR-EA-009's rule of one evaluation path holds by construction. Gating the authorized layer through qadi policies is open question Q9, not part of this plan.
- **There are 45 methods, of which 5 are caller-less, not 1.** `checkSlug` (`:191`), `addMember` (`:289`), `checkRoleCeiling` (`:307`), `syncMemberRoles` (`:322`) and `attributesFor` (`:683`) already are system methods sitting on the authorized interface.
- **The suspension check on the tenant middleware is deliberate.** `TenantMiddleware.ts:76` resolves a suspended organization on purpose: BDD `28-tenancy.feature:236` says "a suspended organization still resolves so its own gate can refuse it". It stays a raw `find`.

### 1.3 Goals

1. **G1.** Every write to an `organization_*` table goes through exactly one system module method. That method runs its veto point, writes inside one `SqlTransaction`, publishes its events and runs its observe point. Every caller gets this: HTTP members, SCIM, SAML, AdminTenants and application code.
2. **G2.** System interfaces take an `Actor`, not an `Api.UserPrincipal`. The actor reaches hook inputs and, in phase 9, event payloads, so audits name who acted: a member, a directory connection, an identity provider, a platform admin or the application.
3. **G3.** The authorized interface (`OrganizationShape`, 41 methods after the caller-less ones leave) contains only authorization: MTI-009 visibility, feature gates in PV-300 order, `requirePermission` with the PERS-005 denial event, and derivation of the caller's `Bound`.
4. **G4.** SCIM, SAML and AdminTenants depend on system interfaces through the Layer type (`exposes` plus `dependsOn`) and never on records. A static guard test enforces this.
5. **G5.** Hook points are named by class. There are no string point ids in the organization source, and `docs/plugin-authoring.md` no longer tells authors to copy a string-taking helper.
6. **G6.** `Organization.ts` shrinks to the plugin class, the authorized interface and its implementation (target ≤ 1,100 lines). Handlers, migrations, config, errors and personal-data contributions move to their own files without behaviour change.
7. **G7.** System policy is tested at the system interface without principals. Authorized-layer tests shrink to authorization concerns ("replace, don't layer").

### 1.4 Non-goals

- **No change to the HTTP contract** (`OrganizationApi`) beyond what §3.10 lists: the endpoints, DTOs and status codes stay the same. The SCIM and AdminTenants contracts gain a `403` on endpoints a veto can now abort.
- **No change to migrations.** They are append-only and move file without renaming. No new organization tables. The `organization_*` SQL stays in the `*Records.ts` files. Plan 05 owns their substrate.
- **No qadi-gated authorized layer** (see §1.2 and Q9). No change to `PermissionEngine` semantics.
- **No re-litigation of the `.scratch/organization` decisions:** default-off teams and dynamic access control, multi-role memberships, a server-only `addMember`, the self-contained statement engine, and active context keyed by session.
- **No record bundles** (`Organization.records.memory/sql`). Plan 08 owns those. This plan only moves record exports to a sub-path.
- **No change to SCIM user provisioning beyond `members.add`.** `createUser`'s sign-up path is plan 01's and its erase path is plan 03's.

---

## 2. Verified inventory

### 2.1 `Organization.ts` map (3,766 lines)

| Lines | Content | Destination |
|---|---|---|
| 1-46 | header, imports | rewritten |
| 48-171 | `OrganizationLimits`, `OrganizationConfigShape`, defaults, `homeRegionOf`, `OrganizationConfig`, `config` | `OrganizationConfig.ts` (re-exported from `Organization.ts`) |
| 175-692 | `OrganizationShape`, 45 methods | stays; drops 4 caller-less methods (§3.6) |
| 694-704 | `hexOf`, `NO_INVITATION_TOKEN_HASH` | `internal/tokens.ts` |
| 706-790 | DTO mappers (`toOrganizationDto` …) | `OrganizationHandlers.ts` |
| 792-804 | `currentUserPrincipal`, `parseIntQuery` | `OrganizationHandlers.ts` |
| 808-1256 | `OrganizationHandlers` (`HttpApiBuilder.group`, 41 handlers) | `OrganizationHandlers.ts` |
| 1258-1709 | `organizationMigrations` (array at 1291) | `OrganizationMigrations.ts` (names unchanged) |
| 1711-1717 | `tenantMiddleware*` re-exports | stay in `Organization.ts` |
| 1719-1748 | `organizationErasure` | `OrganizationPersonalData.ts` (re-exported) |
| 1750-1794 | `organizationExport` | `OrganizationPersonalData.ts` (re-exported) |
| 1798-1817 | `class Organization` (`tables` 1805-1816) | stays |
| 1819-3765 | `Organization.layer` and `make` | `make` becomes the authorized implementation; domain bodies move to modules |
| 1824-1845 | captured services, `configNow` | per module |
| 1846-1885 | 40 hook points captured (20 veto/observe pairs) | per module (§2.3) |
| 1897-1907 | local `veto(point: string, …)` | deleted; replaced by `HookPoint.aborted(Point)` |
| 1910-1932 | `statementsByRole`, `effectivePermissionsOf` | `OrganizationAuthority` |
| 1945-1971 | `teamRoleStatementsNow`, `teamRoleAuthority` | `OrganizationAuthority` |
| 1978-2014 | `requirePermission` (+ PERS-005 `permissionDenied` event) | authorized layer (`internal/authorize.ts`) |
| 2020-2096 | `requireKnownRoles`, `requireGrantable`, `requireGrantableTeamRole`, `requireOutranks` | `Bound` enforcement inside `Members`, `Teams`, `Invitations` and `Roles` (§3.3) |
| 2099-2107 | `requireMembership` | authorized layer |
| 2115-2126 | `requireOrganization` (suspension reads as not found) | `OrganizationDirectory.requireActive` |
| 2129-2146 | `limitsOf` | `internal/limits.ts` |
| 2149-2154 | `requireKnownRegion` | `OrganizationDirectory` |
| 2156-2322 | create, checkSlug, list, get, getFull, update, delete | Directory (system) + authorized |
| 2324-2645 | members: listMembers, owner invariant, `dropMembership`, `announceTeamDepartures`, removeMember, updateMemberRole, leave, addMember, checkRoleCeiling, syncMemberRoles | Members (system) + Authority + authorized |
| 2647-2746 | active context: `activeOrganizationOf`, `isSuspended`, getActiveMember(Role), setActive, `revalidateActive`, getActive | ActiveContext (system) + authorized |
| 2750-3161 | invitations: invite, token helpers, accept, reject, cancel, `mayReadInvitation`, getInvitation(ByToken), list… | Invitations (system) + authorized |
| 3165-3316 | dynamic roles | Roles (system) + authorized |
| 3320-3700 | teams | Teams (system) + authorized |
| 3702-3715 | `attributesFor` | `OrganizationAuthority.attributesFor` |
| 3717-3763 | `Organization.of({...})` | stays (41 entries) |

Other organization files and their fate:

| File | Lines | Fate |
|---|---:|---|
| `OrganizationApi.ts` | 949 | Stays the HTTP contract. The 36 domain error classes (`:22-258`) move to `OrganizationErrors.ts` and are re-exported here by name, so `OrganizationApi.TeamNotFound` keeps working. System modules import `OrganizationErrors`, never the contract. |
| `OrganizationHooks.ts` | 345 | Stays the one public home of every point. Gains `actor` on every input (phase 1) and two new pairs, `Suspend`/`Reinstate` (phase 4). `OrganizationHooksLive` (`:310`ff) grows by four layers. |
| `TeamRecords.ts`, `MembershipRecords.ts`, `OrganizationRecords.ts`, `InvitationRecords.ts`, `OrgRoleRecords.ts`, `ActiveContextRecords.ts`, `ConnectionRecords.ts` | 1212, 482, 460, 493, 354, 406, 561 | Unchanged (plan 05 owns them). Doc comments that name `Organization.delete` and `Organization.ts` are updated. Exports move to `@awthaq/organization/records` in phase 8. |
| `OrganizationConnections.ts` | 551 | `OrganizationConnectionStore` is deepened (phase 5). `cleanupOnOrganizationDelete` (`:541-551`, an opt-in observe tap whose failures are swallowed) is replaced by an `OrganizationDeletion` contribution. |
| `OrganizationMemory.ts` | 26 | Unchanged here. Plan 08 adds `ConnectionRecords` and the bundle. |
| `OrganizationQadi.ts` | 340 | Yields `OrganizationAuthority` and `OrganizationDirectory` instead of `Organization` (`:37`, `:259`) and the records (`:172-174`). |
| `TenantMiddleware.ts` | 165 | `:71` and `:76` use `OrganizationDirectory.find` (raw; resolving a suspended organization is deliberate). |
| `PermissionEngine.ts`, `TenantResolver.ts` | 133, 44 | Unchanged. |

### 2.2 The 45 `OrganizationShape` methods by sub-domain

**Legend.**

- **V/O**: the veto/observe pair it runs. Ids are `organization.<x>.before` / `.after`.
- **Tx**: whether its multi-row write runs in `sqlTransaction.withTransaction`.
- **Ev**: the `auth.organization.*` events it publishes.
- **Bypass**: external code that performs the same act without this method.

Invariant tags used below:

- **OI**: owner invariant.
- **ML / IL / TL / TML / RL**: membership, invitation, team, team-member and role limits from `limitsOf`.
- **KR**: known role names (`requireKnownRoles`).
- **CG**: the `canGrant` ceiling.
- **MTI-009**: a non-member is answered as if the organization did not exist.
- **SUSP**: a suspended organization answers as not found.

#### Organizations → `OrganizationDirectory`

| Method (line) | Caller | Invariants | V/O | Tx | Ev | Bypass |
|---|---|---|---|---|---|---|
| `create` (176; impl 2156-2217) | yes | known region; `allowUserToCreateOrganization` (authz); `organizationLimit` over the caller's owned orgs; slug unique; creator gets `creatorRole` | `create` | **no**: org row, then membership row (2182-2196). **F4** | `created`, `memberAdded` | — |
| `checkSlug` (191; 2219) | **none** | — | — | — | — | — |
| `list` (192; 2222) | yes | the caller's memberships, suspended included and flagged | — | — | — | — |
| `get` (196; 2227) | yes | SUSP, MTI-009 | — | — | — | — |
| `getFull` (200; 2233) | yes | SUSP, MTI-009; pending invitations only | — | — | — | — |
| `update` (215; 2248) | yes | SUSP, `organization:update`, region, slug unique | `update` | single write | `updated` | — |
| `delete` (233; 2281) | yes | SUSP, `disableOrganizationDeletion`, `organization:delete` | `delete` | **yes** (2297-2318): members, invitations, teams, roles, active context, org | `deleted` | OIDC, SAML and SCIM connection rows are **not** in the cascade. **F7** |
| *(suspend / reinstate)* | — | idempotent; keeps the original `suspendedAt` | **none** | — | — (AdminTenants publishes `auth.admin.*`) | **AdminTenants.ts:247, :267** writes `setSuspended` directly. **F5** |

#### Members → `OrganizationMembers` (+ `OrganizationAuthority`)

| Method | Caller | Invariants | V/O | Tx | Ev | Bypass |
|---|---|---|---|---|---|---|
| `listMembers` (243; 2324) | yes | SUSP, MTI-009 | — | — | — | — |
| `removeMember` (251; 2389) | yes | SUSP, MTI-009, target exists, OI (checked **before** permission), `member:delete` | `member.remove` | **yes** `dropMembership` (2350-2368): membership, active context, team memberships | `memberRemoved` + per team `teamMemberRemoved` and `AfterRemoveTeamMember` | — |
| `updateMemberRole` (263; 2427) | yes | SUSP, MTI-009, OI, `member:update`, CG outranks + grantable, KR (after veto) | `member.updateRole` | single write | `memberRoleUpdated` | — |
| `leave` (278; 2483) | yes | SUSP, own membership, OI | `member.remove` (PCS-002) | yes (`dropMembership`) | as `removeMember` | — |
| `addMember` (289; 2521) | **none** | SUSP, ML, KR (no CG: "trusted"), MTI-003 unique | `member.add` | single insert | `memberAdded` | SCIM uses it (`Scim.ts:584-595`) |
| `checkRoleCeiling` (307; 2560) | **none** | SUSP, KR on roles and ceiling, CG | — | — | — | SAML (`SamlConnections.ts:261`) |
| `syncMemberRoles` (322; 2578) | **none** | SUSP, KR, CG vs ceiling (before veto), outranks, OI; add path through `addMember` | `member.updateRole` or `member.add` | single write | `memberRoleUpdated` / `memberAdded` | SAML (`Saml.ts:923`) |
| `attributesFor` (683; 3702) | **none** | — (read) | — | — | — | `OrganizationQadi.ts:259` |

#### Active context → `OrganizationActiveContext`

| Method | Caller | Invariants | V/O | Tx | Ev | Bypass |
|---|---|---|---|---|---|---|
| `getActiveMember` (340; 2666) | yes (session) | SUSP reads as `NoActiveOrganization` | — | — | — | — |
| `getActiveMemberRole` (343; 2682) | yes | as above | — | — | — | — |
| `setActive` (347; 2685) | yes | membership witness (MTI-001); SUSP reads as `MembershipNotFound` | — | single upsert | — | — |
| `getActive` (351; 2734) | yes | CWM-003 revalidation (clears stale pointers on read) | — | multi-write, not in tx (benign) | — | — |
| `setActiveTeam` (668; 3687) | yes | team-membership witness | — | single upsert | — | SCIM `deleteGroup` clears the team (`Scim.ts:1257`) |

#### Invitations → `OrganizationInvitations`

| Method | Caller | Invariants | V/O | Tx | Ev | Bypass |
|---|---|---|---|---|---|---|
| `invite` (354; 2750) | yes | SUSP, `invitation:create`, IL per inviter, teams enabled + team exists, CG (after veto), not already a member (cancels the stale pending one), resend rotation, `cancelPendingInvitationsOnReInvite`, mail (EEM-002) | `invitation.create` (the resend branch publishes the event but runs **no** after-hook, 2836-2852) | no | `invitationCreated` (cancellations at 2799/2838 publish **nothing**, F9) | — |
| `acceptInvitation` (379; 2928) | yes (invitee) | veto **first**; token (MTI-010); expiry (expires silently, 2936); email owner; EP-010 verification; already member; ML; TML | `invitation.accept` | **no**: membership, status, team membership (2986-3026). **F4** | `invitationAccepted`, `memberAdded`, `teamMemberAdded` (no `AfterAddMember` or `AfterAddTeamMember`, F10) | — |
| `rejectInvitation` (395; 3036) | yes (invitee) | veto first; token; email | `invitation.reject` | single | `invitationRejected` | — |
| `cancelInvitation` (406; 3056) | yes | veto **first**, then MTI-009, pending, `invitation:cancel` | `invitation.cancel` | single | `invitationCanceled` | — |
| `getInvitation` (420; 3116) | yes | invitee, or a member holding `invitation:create` | — | — | — | — |
| `getInvitationByToken` (428; 3127) | yes | invitee only | — | — | — | — |
| `listInvitationsForOrganization` (435; 3142) | yes | SUSP, MTI-009 | — | — | — | — |
| `listInvitationsForUser` (442; 3151) | yes | the caller's email (FAMS-002) | — | — | — | — |

#### Dynamic roles → `OrganizationRoles`

| Method | Caller | Invariants | V/O | Tx | Ev | Bypass |
|---|---|---|---|---|---|---|
| `createRole` (445; 3171) | yes | SUSP, DAC enabled, `role:create`, reserved names (RZS-005), CG on statements, RL | `role.create` | single | `roleCreated` | — |
| `listRoles` (460; 3219) | yes | SUSP, DAC, `role:read` | — | — | — | — |
| `getRole` (469; 3238) | yes | SUSP, DAC, `role:read` | — | — | — | — |
| `updateRole` (480; 3247) | yes | SUSP, DAC, `role:update`, exists, CG | `role.update` | single | `roleUpdated` | — |
| `deleteRole` (494; 3289) | yes | SUSP, DAC, `role:delete`, exists | `role.delete` | single | `roleDeleted` | — |

#### Teams → `OrganizationTeams`

| Method | Caller | Invariants | V/O | Tx | Ev | Bypass |
|---|---|---|---|---|---|---|
| `createTeam` (507; 3343) | yes | SUSP, MTI-009 → teams enabled (PV-300 order), `team:create` (on the parent when nested), parent in org, **TL** (3357-3360) | `team.create` | single (records keep the closure table atomic) | `teamCreated` | **SCIM `createGroup` `Scim.ts:1064-1066`**: no teams-enabled check, no TL, no veto, no event, no after-hook; compensates a link race by hand at `:1075-1082` |
| `moveTeam` (522; 3387) | yes | `team:update` on the team **and** the destination, cycle | `team.move` | single | `teamMoved` | — |
| `listTeamAncestors` (537; 3430) | yes | member-only | — | — | — | — |
| `listTeamDescendants` (549; 3440) | yes | member-only | — | — | — | — |
| `listTeams` (561; 3450) | yes | member-only (MTI-002) | — | — | — | SCIM `listGroups` reads `findTeamById` (`:1012`) (read, acceptable) |
| `listUserTeams` (570; 3462) | yes | — | — | — | — | — |
| `updateTeam` (577; 3470) | yes | `team:update` | `team.update` | single | `teamUpdated` | **SCIM `renameGroup` `Scim.ts:1120-1129`**: no veto, event or after-hook |
| `removeTeam` (590; 3502) | yes | `team:delete`, **`allowRemovingAllTeams` / `LastTeamCannotBeRemoved`** (3514-3517), `TeamHasChildren` before the veto | `team.delete` | **yes** (3525-3543): team + `clearTeam` | `teamDeleted` | **SCIM `deleteGroup` `Scim.ts:1245-1260`**: no veto, **no tx** (`removeTeam` and `clearTeam` are separate), no last-team rule, no event, no after-hook |
| `listTeamMembers` (605; 3549) | yes | member-only | — | — | — | SCIM `provisionedMembers` (`:929`) (read) |
| `addTeamMember` (616; 3562) | yes | `team:update` (team authority), known team roles + CG, target is an org member, **TML**, unique (OHS-003) | `team.member.add` | single (atomic `memberCount`) | `teamMemberAdded` | **SCIM `addToTeam` `Scim.ts:978-981`**: no TML, no veto, no event, no after-hook |
| `updateTeamMemberRole` (636; 3608) | yes | `team:update`, CG (requested and current) | `team.member.updateRole` | single | `teamMemberRoleUpdated` | — |
| `removeTeamMember` (653; 3654) | yes | `team:update` | `team.member.remove` | single | `teamMemberRemoved` | **SCIM `removeFromTeam` `Scim.ts:983-986`**: no veto, event or after-hook |
| `setActiveTeam` | (above, active context) | | | | | |

Counts: 7 (directory) + 8 (members) + 5 (active context, including `setActiveTeam`) + 8 (invitations) + 5 (roles) + 12 (teams) = **45** (21 reads, 24 mutations).

### 2.3 Hook points: the 20 pairs and their owning modules

| Module | Veto / observe class pairs (`OrganizationHooks.ts`) | Ids |
|---|---|---|
| Directory | `Before/AfterCreateOrganization`, `…UpdateOrganization`, `…DeleteOrganization`, **new** `…SuspendOrganization`, `…ReinstateOrganization` | `organization.{create,update,delete,suspend,reinstate}.{before,after}` |
| Members | `Before/AfterAddMember`, `…RemoveMember`, `…UpdateMemberRole` | `organization.member.{add,remove,updateRole}.*` |
| Invitations | `Before/AfterCreateInvitation`, `…AcceptInvitation`, `…RejectInvitation`, `…CancelInvitation` | `organization.invitation.{create,accept,reject,cancel}.*` |
| Roles | `Before/AfterCreateRole`, `…UpdateRole`, `…DeleteRole` | `organization.role.{create,update,delete}.*` |
| Teams | `Before/AfterCreateTeam`, `…UpdateTeam`, `…MoveTeam`, `…DeleteTeam`, `…AddTeamMember`, `…UpdateTeamMemberRole`, `…RemoveTeamMember` | `organization.team.*`, `organization.team.member.*` |

The local `veto` is called at 22 sites with 20 distinct string ids. `organization.member.remove.before` and `organization.member.updateRole.before` appear twice each, from `leave` and `syncMemberRoles`.

External tap consumer: `packages/qadi/src/DecisionCacheInvalidation.ts:52-66` taps 12 observe points. It does **not** tap `AfterMoveTeam` (a move changes `team-role:<name>`, which walks ancestors), `AfterUpdateTeamMemberRole` (changes `team-role:<name>`) or suspension (changes every relation of the organization, BEH-EA-237). This is F2.

### 2.4 Every place outside `packages/organization` that touches organization state

Library source (`packages/*/src`):

| File:line | What | Through | Skips |
|---|---|---|---|
| `scim/src/Scim.ts:33-38` | imports `ActiveContextRecords`, `MembershipRecords`, `Organization`, `TeamRecords` | — | — |
| `scim/src/Scim.ts:421` | `dependsOn: [Organization.Organization]`; no `readsTables` | — | JH-007 sees nothing (`Auth.ts:545-560`) |
| `scim/src/Scim.ts:528-532` | yields `Organization`, `MembershipRecords`, `TeamRecords`, `ActiveContextRecords` | — | — |
| `scim/src/Scim.ts:584-595` | `organization.addMember` (`membershipAdded`) | system method | nothing (uses the module) |
| `scim/src/Scim.ts:916`, `:1012-1014`, `:1094` | `teams.findTeamById` | records read | (read) |
| `scim/src/Scim.ts:929` | `teams.listTeamMembers` | records read | (read) |
| `scim/src/Scim.ts:967` | `members.findByUserAndOrg` | records read | SUSP not checked (the token gate covers it) |
| `scim/src/Scim.ts:978-981` | `teams.addTeamMember` | **records write** | teams enabled, TML, target role defaults, `BeforeAddTeamMember`, `teamMemberAdded`, `AfterAddTeamMember` (→ cache) |
| `scim/src/Scim.ts:983-986` | `teams.removeTeamMember` | **records write** | `BeforeRemoveTeamMember`, `teamMemberRemoved`, `AfterRemoveTeamMember` (→ **stale `team-member` decisions after off-boarding**) |
| `scim/src/Scim.ts:1064-1066` | `teams.createTeam` | **records write** | teams enabled, `maximumTeams`, `BeforeCreateTeam`, `teamCreated`, `AfterCreateTeam` |
| `scim/src/Scim.ts:1075-1082` | `teams.removeTeam` compensation on `ScimLinkConflict` | **records write**, outside any tx | (compensation instead of a transaction) |
| `scim/src/Scim.ts:1127-1129` | `teams.updateTeam` | **records write** | `BeforeUpdateTeam`, `teamUpdated`, `AfterUpdateTeam` |
| `scim/src/Scim.ts:1247-1257` | `teams.removeTeam` + `activeContext.clearTeam` | **records writes**, two statements, no tx | `BeforeDeleteTeam`, `LastTeamCannotBeRemoved`, tx, `teamDeleted`, `AfterDeleteTeam` |
| `scim/src/ScimConnections.ts:18, :117, :136-139` | `OrganizationRecords.findById` + `suspendedAt` | records read | (read; becomes `Directory.findActive`) |
| `admin/src/AdminTenants.ts:19, :173, :177` | `dependsOn: [Organization]`, yields `OrganizationRecords` | — | — |
| `admin/src/AdminTenants.ts:204, :217` | `orgs.findById`, `orgs.listPage` | records read | (read) |
| `admin/src/AdminTenants.ts:247`, `:267` | `orgs.setSuspended(Some(now))` / `(None)` | **records write** | no veto, no observe → `DecisionCacheInvalidation` never clears on suspension |
| `saml/src/Saml.ts:46, :664, :673-674` | `dependsOn: [Organization]`, yields `OrganizationRecords` + `Organization` | — | — |
| `saml/src/Saml.ts:709-722` | `usableConnection`: `orgs.findById` + `suspendedAt` | records read | (read) |
| `saml/src/Saml.ts:923` | `organization.syncMemberRoles` | system method | — |
| `saml/src/SamlConnections.ts:25, :190-191` | yields `OrganizationRecords` + `Organization` | — | — |
| `saml/src/SamlConnections.ts:261` | `organization.checkRoleCeiling` | system method | — |
| `saml/src/SamlConnections.ts:293` | `orgs.findById` (existence) | records read | (read) |
| `saml/src/Sso.ts:18, :163, :205` | `OrganizationConnectionStore.discover`, `parseProviderId` | system interface | — |
| `qadi/src/DecisionCacheInvalidation.ts:13, :52-66` | taps 12 `OrganizationHooks` observe points | hooks (correct seam) | missing points (F2) |
| `oauth/src/OAuthConnections.ts:7`, `core/src/{Users,Hooks}.ts`, `roles/src/Roles.ts:18`, `qadi/src/{Resolvers,AttributeResolvers}.ts` | comments only | — | — |

Tests, BDD and examples that write records directly. These are migrated to system interfaces where they arrange state; record reads in assertions may stay until phase 8:

- `packages/scim/test/ScimGroups.test.ts:36, 97, 124, 194, 226`
- `packages/scim/test/ScimHttp.test.ts`, `ScimUsers.test.ts`
- `packages/saml/test/{Saml,Sso,SamlRoleMapping}.test.ts`
- `packages/qadi/test/DecisionCacheInvalidation.test.ts`
- `packages/admin/test/AdminTenants.test.ts`
- `features/step-definitions/{ScimWorld,ScimSteps,SamlWorld,SamlFederationSteps,TenancyWorld,TenancySteps,OrganizationSteps}.ts`. For example, `ScimSteps.ts:406-430` creates a "hand-made" team and adds members through `TeamRecords`.

### 2.5 Findings (bugs and gaps this plan fixes)

| # | Finding | Evidence | Fixed in |
|---|---|---|---|
| F1 | SCIM group writes skip the team module entirely: veto, transaction, teams enabled, TL/TML, last-team rule, five event types, five after-hooks | §2.4 | P2 |
| F2 | A long-lived `DecisionCache` keeps stale answers. SCIM roster and team changes fire no observe point. Move, team-role change and suspend/reinstate are not tapped | `DecisionCacheInvalidation.ts:52-66`; `AdminTenants.ts:247`; §2.4 | P2 (SCIM, move, team role), P4 (suspension) |
| F3 | The local `veto` duplicates `HookPoint.aborted` with 22 hand-typed strings; the docs tell authors to copy it | `Organization.ts:1897`; `HookPoint.ts:130`; `docs/plugin-authoring.md:41`; `examples/plugin-template/src/Template.ts:211-227` | P0 |
| F4 | Organization creation (org then membership) and invitation acceptance (membership, status, team membership) are not atomic | `Organization.ts:2182-2196`, `:2986-3026` | P4, P6 |
| F5 | Suspension bypasses the organization module: no hooks, no cache invalidation | `AdminTenants.ts:247`, `:267` | P4 |
| F6 | `readsTables` is empty on SCIM, SAML and AdminTenants although they read `organization_*`, so the manifest hides the coupling | `Scim.ts:414-419`, `Saml.ts:651-656`, `AdminTenants.ts:165-171` | P2-P4 (removed, not declared), P8 guard |
| F7 | Organization deletion orphans `organization_oauth_connection*` (unless the opt-in observe tap is installed; its failure is swallowed, BEH-EA-092), `saml_connection*` and `scim_connection` + `scim_resource` rows | `Organization.ts:2297-2318`; `OrganizationConnections.ts:541-551` | P5 |
| F8 | Stale comments still describe module-level tap registries that freeze process-wide; ADR-EA-033 replaced them | `OrganizationConnections.ts:536-540`; `DecisionCacheInvalidation.ts:33-37` | P2/P5 |
| F9 | Pending invitations cancelled by `invite` (OHS-006 and re-invite) and invitations expired on accept publish no event | `Organization.ts:2799, 2838, 2936` | P6 |
| F10 | A membership created by accepting an invitation does not fire `AfterAddMember`/`AfterAddTeamMember`; the creator's membership does not fire `AfterAddMember` | `:2986-3031`, `:2190-2214` | P3/P4/P6 (decision D7) |
| F11 | Organization events carry no actor. `AuditLog.actorOf` records the *subject* as actor for `memberAdded`/`memberRemoved`/… (`AuditLog.ts:181-188`), so "who removed X" is lost | `AuthEventSchemas.ts:586-760` | P9 |

---

## 3. Target design

### 3.1 Module map

```
 HTTP (OrganizationHandlers)         SCIM          SAML / Sso        AdminTenants      app code / jobs
          │                            │               │                  │                  │
          ▼                            │               │                  │                  │
 ┌────────────────────────────────┐    │               │                  │                  │
 │ Organization (authorized)      │    │               │                  │                  │
 │ OrganizationShape, 41 methods  │    │               │                  │                  │
 │ visibility · gates ·           │    │               │                  │                  │
 │ PermissionEngine · Bound       │    │               │                  │                  │
 └──────────────┬─────────────────┘    │               │                  │                  │
                │  Actor.User          │ Actor.Directory│ Actor.IdP        │ Actor.Platform    │ Actor.Application
                ▼                      ▼               ▼                  ▼                  ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ system interfaces (Context.Service, exposed in Organization.layer ROut)                        │
 │ Directory · Members · Teams · Invitations · Roles · ActiveContext · ConnectionStore · Deletion │
 │ each: invariants → veto (HookPoint.aborted) → SqlTransaction{writes, attach} → events → observe│
 └───────────────┬────────────────────────────────────────────────────────────────────────────────┘
                 │ reads                                 ▲ reads
                 ▼                                       │
        OrganizationAuthority (read-only: statementsByRole, effective, team authority,
                               attributesFor, checkRoleCeiling, ceilingOf)
                 │                                       ▲
                 ▼                                       │ OrganizationQadi.relationships/attributes
        *Records (package-private store seam; plan 05 substrate)
```

Depth and leverage come from the same place. Each system interface is small: Teams has 16 methods, and its callers see neither records nor hook classes. Behind it sit the guard, veto, transaction, event and observe protocol, the backend differences and the cascades. One implementation now serves five callers.

### 3.2 `Actor` (`src/OrganizationActor.ts`, new)

```ts
// @awthaq/organization — OrganizationActor
// Who performs a system operation, for audit and for hook taps. Never an authorization input:
// the authorized layer has already decided; a system interface only records who acted.
import { Api } from "@awthaq/api";
import { Users } from "@awthaq/core";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

export const ActorSchema = Schema.TaggedUnion({
  User: { userId: Schema.String, sessionId: Schema.optional(Schema.String) },
  Directory: { connectionId: Schema.String },              // @awthaq/scim
  IdentityProvider: { connectionId: Schema.String },       // @awthaq/saml role mapping
  PlatformAdmin: { adminUserId: Schema.String },           // @awthaq/admin AdminTenants
  Application: { label: Schema.String },                   // trusted application code, jobs, seeds
});
export type Actor = typeof ActorSchema.Type;
export type PlatformAdminActor = typeof ActorSchema.cases.PlatformAdmin.Type;

export const user = (principal: Api.UserPrincipal) =>
  ActorSchema.cases.User.make({ userId: principal.ref.id, sessionId: principal.sessionId });
export const directory = (connectionId: string) => ActorSchema.cases.Directory.make({ connectionId });
export const identityProvider = (connectionId: string) =>
  ActorSchema.cases.IdentityProvider.make({ connectionId });
export const platformAdmin = (adminUserId: Users.UserId) =>
  ActorSchema.cases.PlatformAdmin.make({ adminUserId });
export const application = (label: string) => ActorSchema.cases.Application.make({ label });

/** The user an actor names, when it names one. Feeds `AuditLog.actorOf` (P9). */
export const userIdOf = (actor: Actor) =>
  actor._tag === "User" ? Users.UserId(actor.userId)
  : actor._tag === "PlatformAdmin" ? Users.UserId(actor.adminUserId)
  : undefined;

/**
 * The grant ceiling of a role-conferring operation (RRM-001, OHS-004, BEH-EA-288/316).
 * `Ceiling` carries the statements the source holds; `Unbounded` is the deliberate,
 * greppable choice of a trusted source (the application, a directory's configured role).
 */
export type Bound = Data.TaggedEnum<{
  Unbounded: {};
  Ceiling: { readonly statements: PermissionEngine.Statements };
}>;
export const Bound = Data.taggedEnum<Bound>();
```

The constructors carry no return-type annotations and no `as`. Before writing, check `Schema.TaggedUnion` (`../effect/packages/effect/src/Schema.ts:6557`) and `cases.X.make` (`:224`). `make` must fill `_tag`. If it does not, write the `_tag` literal in the call.

Two rules:

- An actor is **never** used for authorization inside a system module. The single exception is §3.4.1: `suspend` and `reinstate` require a `PlatformAdminActor` **type**, which restricts who can *construct a call*, not what a call may do.
- A veto tap may return an amended input with a different `actor`. The module ignores it and always uses its own actor. Today the module already ignores an amended `organizationId`.

### 3.3 `Bound` enforcement in one place

Today there are three guards (`requireGrantable` at 2033, `requireOutranks` at 2084, `requireGrantableTeamRole` at 2053) plus their re-implementation inside `syncMemberRoles` (2585-2613). They collapse into one internal helper, `internal/bound.ts`:

```ts
/** RRM-001: `requested` (and, when re-roling, what the target holds now) must fit the bound. */
export const requireWithin = (bound: OrganizationActor.Bound, requested: PermissionEngine.Statements, current?: PermissionEngine.Statements) =>
  OrganizationActor.Bound.$match(bound, {
    Unbounded: () => Effect.void,
    Ceiling: ({ statements }) =>
      PermissionEngine.canGrant(requested, statements) &&
      (current === undefined || PermissionEngine.canGrant(current, statements))
        ? Effect.void
        : Effect.fail(new OrganizationErrors.RolePermissionEscalation()),
  });
```

| Caller | Bound passed |
|---|---|
| authorized `updateMemberRole`, `invite`, `createRole`, `updateRole` | `Ceiling(Authority.effectivePermissions(org, callerMembership))` |
| authorized `addTeamMember`, `updateTeamMemberRole` | `Ceiling(merge(orgEffective, Authority.teamAuthority(caller, org, team)))` |
| SAML role mapping | `Ceiling(Authority.ceilingOf(org, connection.roleMapping.ceiling))` |
| SCIM `members.add` (configured `memberRole`), SCIM roster (`member` team role) | `Unbounded` (the deployment configured it) |
| application `members.add` (today's "trusted" `addMember`) | `Unbounded` |

### 3.4 System interfaces (TypeScript sketches)

Common conventions for every module:

- Each module is a `Context.Service` class with key `awthaq/plugin/organization/<Name>`, and `static readonly layer = Layer.effect(Self, make)`.
- `make` yields every record store, hook point, `AuthEvents`, `SqlTransaction` and `Users` it needs **once, at the top**. This is ticket 19's rule: a service captured inside a handler closure leaks into `HttpApiBuilder`'s `Requires` marker.
- Configuration is read per operation with `Tenant.configInForce(OrganizationConfig, built)`, the ADR-EA-018 Decision 8 hybrid.
- Implementations are `Effect.fnUntraced(function* (actor: OrganizationActor.Actor, input: …) {…})`. Parameters are typed; **return types are never annotated**. Conformance is checked by `Self.of({ … })`.
- Errors come from `OrganizationErrors` (§2.1). `HookPoint.HookAborted` comes from core. When plan 05 gives the records typed infrastructure errors, every union gains `Errors.StoreUnavailable` (ADR-EA-028). Until then the records' `orDie` stays as it is.

**The mutation protocol** is the same in every module. It lives in `internal/protocol.ts` as documentation and a helper, not as a framework.

1. Guards (pure reads).
2. `HookPoint.aborted(BeforeX)(beforeX.run({ …input, actor }))`.
3. Checks that depend on the vetoed value (KR, `Bound`).
4. `sqlTransaction.withTransaction(Effect.gen(function* () { writes; const attached = yield* attach(result) }))`, with `SqlError` → defect, as today.
5. Events.
6. `afterX.run(…)`.

Events and observe points run **only after the module's own transaction commits**, exactly like `delete` (2294-2296) today.

**`attach` continuations.** `create` and `remove` accept `options.attach`: an effect that runs **inside** the module's transaction after the module's own writes and before any event. If it fails, the transaction rolls back and nothing is published. On a backend whose `SqlTransaction` is `layerNoop`, the module undoes its own write with the records layer (no hooks, no events) before re-failing, so "a failed create leaves nothing behind" holds on both backends. `attach` may only touch the caller's own tables. Calling a system interface inside `attach` is forbidden: its events would escape the outer transaction. Plan 10 and its "events from a rolled-back tx" item own any generalisation.

#### 3.4.1 `OrganizationDirectory` (`src/OrganizationDirectory.ts`)

```ts
export type Organization = OrganizationRecords.OrganizationRecord;

export interface OrganizationDirectoryShape {
  /** Raw: an unknown id is `None`; a suspended organization is `Some` (tenant middleware, AdminTenants, SAML admin). */
  readonly find: (organizationId: string) => Effect.Effect<Option.Option<Organization>>;
  /** `None` for an unknown OR suspended organization (BEH-EA-237) — SCIM/SAML token gates, qadi, active context. */
  readonly findActive: (organizationId: string) => Effect.Effect<Option.Option<Organization>>;
  /** `findActive`, failing with the MTI-009 answer. */
  readonly requireActive: (organizationId: string) => Effect.Effect<Organization, OrganizationErrors.OrganizationNotFound>;
  readonly isSlugAvailable: (slug: string) => Effect.Effect<boolean>;
  /** A user's organizations (suspended ones flagged by `suspendedAt`), for `list`. */
  readonly listForUser: (userId: Users.UserId) => Effect.Effect<ReadonlyArray<Organization>>;
  /** EP-003: the platform listing, keyset on `(createdAt, id)`. */
  readonly listPage: (input: {
    readonly after: Option.Option<{ readonly createdAt: DateTime.Utc; readonly id: string }>;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<Organization>>;

  /** BEH-EA-283: region, `organizationLimit` over `owner`'s owned organizations, slug; org + creator membership in ONE tx. */
  readonly create: (
    actor: OrganizationActor.Actor,
    input: {
      readonly owner: Users.UserId;
      readonly name: string;
      readonly slug: string;
      readonly logo?: string | undefined;
      readonly metadata?: string | undefined;
      readonly homeRegion?: string | undefined;
    },
  ) => Effect.Effect<
    Organization,
    | OrganizationErrors.OrganizationSlugTaken
    | OrganizationErrors.OrganizationLimitReached
    | OrganizationErrors.UnknownRegion
    | HookPoint.HookAborted
  >;
  readonly update: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly name?: string | undefined;
      readonly slug?: string | undefined;
      readonly logo?: string | null | undefined;
      readonly metadata?: string | null | undefined;
      readonly homeRegion?: string | null | undefined;
    },
  ) => Effect.Effect<
    Organization,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.OrganizationSlugTaken
    | OrganizationErrors.UnknownRegion
    | HookPoint.HookAborted
  >;
  /** `disableOrganizationDeletion`; ONE tx: members, invitations, teams, roles, active context, every
   *  `OrganizationDeletion` contribution (P5), the row; after commit: `deleted`, contributions' `afterCommit`, observe. */
  readonly delete: (
    actor: OrganizationActor.Actor,
    input: { readonly organizationId: string },
  ) => Effect.Effect<
    void,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.OrganizationDeletionDisabled
    | HookPoint.HookAborted
  >;
  /** EP-003/BEH-EA-237: idempotent (keeps the first `suspendedAt`); veto + observe; publishes
   *  `auth.admin.organizationSuspended` (event tag kept, Q6). Only a platform admin may be the actor. */
  readonly suspend: (
    actor: OrganizationActor.PlatformAdminActor,
    input: { readonly organizationId: string; readonly reason?: string | undefined },
  ) => Effect.Effect<Organization, OrganizationErrors.OrganizationNotFound | HookPoint.HookAborted>;
  readonly reinstate: (
    actor: OrganizationActor.PlatformAdminActor,
    input: { readonly organizationId: string },
  ) => Effect.Effect<Organization, OrganizationErrors.OrganizationNotFound | HookPoint.HookAborted>;
}

export class OrganizationDirectory extends Context.Service<OrganizationDirectory, OrganizationDirectoryShape>()(
  "awthaq/plugin/organization/Directory",
) {}
```

#### 3.4.2 `OrganizationMembers` (`src/OrganizationMembers.ts`)

```ts
export type Membership = MembershipRecords.MembershipRecord;

export interface OrganizationMembersShape {
  /** RRC-003 decision read (primary). */
  readonly find: (organizationId: string, userId: Users.UserId) => Effect.Effect<Option.Option<Membership>>;
  readonly list: (organizationId: string, page?: MembershipRecords.ListMembersInput) =>
    Effect.Effect<ReadonlyArray<Membership>, OrganizationErrors.OrganizationNotFound>;
  readonly listForUser: (userId: Users.UserId) => Effect.Effect<ReadonlyArray<Membership>>;

  /** SUSP, ML (limitsFor), KR, Bound, MTI-003 unique. */
  readonly add: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly userId: Users.UserId;
      readonly role: ReadonlyArray<string>;
      readonly bound: OrganizationActor.Bound;
    },
  ) => Effect.Effect<
    Membership,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.MembershipLimitReached
    | OrganizationErrors.AlreadyMember
    | OrganizationErrors.UnknownOrgRole
    | OrganizationErrors.RolePermissionEscalation
    | HookPoint.HookAborted
  >;
  /**
   * Makes the member's roles exactly `roles` — the one implementation behind `updateMemberRole`
   * and the SAML mapping (old `syncMemberRoles`). Order: target (or add when `ifAbsent: "add"`),
   * "unchanged" short-circuit (D5), KR, OI, veto, Bound on the VETOED roles and on the current
   * roles (outranks), write, `memberRoleUpdated`, observe.
   */
  readonly setRoles: (
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly userId: Users.UserId;
      readonly roles: ReadonlyArray<string>;
      readonly bound: OrganizationActor.Bound;
      readonly ifAbsent: "fail" | "add";
    },
  ) => Effect.Effect<
    { readonly membership: Membership; readonly change: "added" | "updated" | "unchanged" },
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.MembershipLimitReached
    | OrganizationErrors.AlreadyMember
    | OrganizationErrors.UnknownOrgRole
    | OrganizationErrors.RolePermissionEscalation
    | OrganizationErrors.OwnerInvariantViolation
    | HookPoint.HookAborted
  >;
  /** OI; ONE tx: membership, active context, team memberships (CWM-003); then `memberRemoved`,
   *  per team `teamMemberRemoved` + `AfterRemoveTeamMember`, then `AfterRemoveMember`. `leave` is this with actor = the user. */
  readonly remove: (
    actor: OrganizationActor.Actor,
    input: { readonly organizationId: string; readonly userId: Users.UserId },
  ) => Effect.Effect<
    void,
    | OrganizationErrors.OrganizationNotFound
    | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.OwnerInvariantViolation
    | HookPoint.HookAborted
  >;
}
// key "awthaq/plugin/organization/Members"
```

#### 3.4.3 `OrganizationTeams` (`src/OrganizationTeams.ts`), first to land

```ts
export type Team = TeamRecords.TeamRecord;
export type TeamMembership = TeamRecords.TeamMembershipRecord;

type TeamGate = OrganizationErrors.OrganizationNotFound | OrganizationErrors.TeamsDisabled;

export interface OrganizationTeamsShape {
  /** `teams.enabled` in force for this fiber (per-tenant config). The authorized layer calls it after MTI-009 (PV-300). */
  readonly requireEnabled: Effect.Effect<void, OrganizationErrors.TeamsDisabled>;
  readonly find: (organizationId: string, teamId: string) => Effect.Effect<Option.Option<Team>>;
  readonly list: (organizationId: string) => Effect.Effect<ReadonlyArray<Team>>;
  readonly listForUser: (organizationId: string, userId: Users.UserId) => Effect.Effect<ReadonlyArray<Team>>;
  readonly ancestors: (organizationId: string, teamId: string) => Effect.Effect<ReadonlyArray<Team>, OrganizationErrors.TeamNotFound>;
  readonly descendants: (organizationId: string, teamId: string) => Effect.Effect<ReadonlyArray<Team>, OrganizationErrors.TeamNotFound>;
  readonly members: (organizationId: string, teamId: string) =>
    Effect.Effect<ReadonlyArray<TeamMembership>, OrganizationErrors.TeamNotFound>;
  readonly membership: (teamId: string, userId: Users.UserId) => Effect.Effect<Option.Option<TeamMembership>>;

  /**
   * SUSP, enabled, parent in org, TL; `initialMembers` (each an org member, TML on the final count,
   * `member` team role) are added in the SAME tx; veto `BeforeCreateTeam` then one `BeforeAddTeamMember`
   * per initial member, all before any write; `attach` runs inside the tx (§3.4).
   */
  readonly create: <A = void, E = never, R = never>(
    actor: OrganizationActor.Actor,
    input: {
      readonly organizationId: string;
      readonly name: string;
      readonly parentId?: string | undefined;
      readonly initialMembers?: ReadonlyArray<Users.UserId> | undefined;
    },
    options?: { readonly attach?: (team: Team) => Effect.Effect<A, E, R> },
  ) => Effect.Effect<
    { readonly team: Team; readonly attached: A | undefined },
    | TeamGate
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.TeamLimitReached
    | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.TeamMemberLimitReached
    | HookPoint.HookAborted
    | E,
    R
  >;
  readonly rename: (actor: OrganizationActor.Actor, input: { readonly organizationId: string; readonly teamId: string; readonly name: string }) =>
    Effect.Effect<Team, TeamGate | OrganizationErrors.TeamNotFound | HookPoint.HookAborted>;
  readonly move: (actor: OrganizationActor.Actor, input: { readonly organizationId: string; readonly teamId: string; readonly parentId: Option.Option<string> }) =>
    Effect.Effect<Team, TeamGate | OrganizationErrors.TeamNotFound | OrganizationErrors.TeamHierarchyCycle | HookPoint.HookAborted>;
  /** `allowRemovingAllTeams`, `TeamHasChildren` (before the veto, re-checked atomically); ONE tx: team, its
   *  memberships, `clearTeam`, then `attach`; after commit `teamDeleted` + `AfterDeleteTeam`. */
  readonly remove: <E = never, R = never>(
    actor: OrganizationActor.Actor,
    input: { readonly organizationId: string; readonly teamId: string },
    options?: { readonly attach?: () => Effect.Effect<void, E, R> },
  ) => Effect.Effect<
    void,
    | TeamGate
    | OrganizationErrors.TeamNotFound
    | OrganizationErrors.LastTeamCannotBeRemoved
    | OrganizationErrors.TeamHasChildren
    | HookPoint.HookAborted
    | E,
    R
  >;
  /** Target is an org member; TML; known team role names; Bound over requested team-role statements; unique (OHS-003). */
  readonly addMember: (actor: OrganizationActor.Actor, input: {
    readonly organizationId: string; readonly teamId: string; readonly userId: Users.UserId;
    readonly role?: ReadonlyArray<string> | undefined; readonly bound: OrganizationActor.Bound;
  }) => Effect.Effect<
    TeamMembership,
    | TeamGate | OrganizationErrors.TeamNotFound | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.TeamMemberLimitReached | OrganizationErrors.AlreadyTeamMember
    | OrganizationErrors.UnknownTeamRole | OrganizationErrors.RolePermissionEscalation | HookPoint.HookAborted
  >;
  readonly setMemberRole: (actor: OrganizationActor.Actor, input: {
    readonly organizationId: string; readonly teamId: string; readonly userId: Users.UserId;
    readonly role: ReadonlyArray<string>; readonly bound: OrganizationActor.Bound;
  }) => Effect.Effect<
    TeamMembership,
    | TeamGate | OrganizationErrors.TeamNotFound | OrganizationErrors.TeamMembershipNotFound
    | OrganizationErrors.UnknownTeamRole | OrganizationErrors.RolePermissionEscalation | HookPoint.HookAborted
  >;
  readonly removeMember: (actor: OrganizationActor.Actor, input: {
    readonly organizationId: string; readonly teamId: string; readonly userId: Users.UserId;
  }) => Effect.Effect<void, TeamGate | OrganizationErrors.TeamNotFound | OrganizationErrors.TeamMembershipNotFound | HookPoint.HookAborted>;
  /**
   * A roster change as one unit (SCIM PUT/PATCH members): idempotent per user (adding a member already
   * on the team, or removing one who is not, is skipped, not an error); every veto first; TML against
   * the FINAL count; ONE tx; then one `teamMemberAdded`/`Removed` + observe per user actually changed.
   */
  readonly applyRoster: (actor: OrganizationActor.Actor, input: {
    readonly organizationId: string; readonly teamId: string;
    readonly add: ReadonlyArray<Users.UserId>; readonly remove: ReadonlyArray<Users.UserId>;
    readonly role?: ReadonlyArray<string> | undefined; readonly bound: OrganizationActor.Bound;
  }) => Effect.Effect<
    { readonly added: ReadonlyArray<Users.UserId>; readonly removed: ReadonlyArray<Users.UserId> },
    | TeamGate | OrganizationErrors.TeamNotFound | OrganizationErrors.MembershipNotFound
    | OrganizationErrors.TeamMemberLimitReached | OrganizationErrors.UnknownTeamRole
    | OrganizationErrors.RolePermissionEscalation | HookPoint.HookAborted
  >;
}
// key "awthaq/plugin/organization/Teams"
```

The interface methods `create` and `remove` are generic. The implementation is `Effect.fnUntraced(function* <A, E, R>(actor, input, options?: { readonly attach?: … }) { … })`, which needs no annotation beyond its parameters. If the inferred generator type does not unify with the interface, split the method: `create(actor, input)` plus `createAttached(actor, input, attach)`. Do not add a cast.

#### 3.4.4 `OrganizationInvitations` (`src/OrganizationInvitations.ts`)

```ts
export type Invitation = InvitationRecords.InvitationRecord;

export interface OrganizationInvitationsShape {
  readonly find: (invitationId: string) => Effect.Effect<Option.Option<Invitation>>;
  readonly findByToken: (token: string) => Effect.Effect<Option.Option<Invitation>, Errors.StoreUnavailable>;
  readonly listForOrganization: (organizationId: string) => Effect.Effect<ReadonlyArray<Invitation>>;
  readonly listPendingForOrganization: (organizationId: string) => Effect.Effect<ReadonlyArray<Invitation>>;
  readonly listForUser: (userId: Users.UserId) => Effect.Effect<ReadonlyArray<Invitation>>;     // FAMS-002
  readonly listForEmail: (email: string) => Effect.Effect<ReadonlyArray<Invitation>>;
  /** true iff the token hashes to this invitation's stored hash (constant time; MTI-010). */
  readonly holdsToken: (invitation: Invitation, token: string) => Effect.Effect<boolean>;

  /** SUSP, IL per `inviterId`, teams/team, veto, Bound (after veto), member check (stale pending
   *  cancelled WITH `invitationCanceled`, F9), resend rotation (runs the after-hook, F-resend), mail. */
  readonly create: (actor: OrganizationActor.Actor, input: {
    readonly organizationId: string; readonly inviterId: Users.UserId; readonly email: string;
    readonly role: ReadonlyArray<string>; readonly teamId?: string | undefined;
    readonly resend?: boolean | undefined; readonly bound: OrganizationActor.Bound;
  }) => Effect.Effect<Invitation,
    | OrganizationErrors.OrganizationNotFound | OrganizationErrors.InvitationLimitReached
    | OrganizationErrors.InvitationDeliveryFailed | OrganizationErrors.AlreadyMember
    | OrganizationErrors.TeamsDisabled | OrganizationErrors.TeamNotFound
    | OrganizationErrors.RolePermissionEscalation | OrganizationErrors.UnknownOrgRole
    | HookPoint.HookAborted | Errors.StoreUnavailable>;
  /** The invitee's act. Veto first (unchanged order); token; expiry (publishes the expiry, F9); email owner;
   *  EP-010; ML; TML; ONE tx: membership + status + team membership (F4); events; observe (D7). */
  readonly accept: (input: { readonly invitationId: string; readonly token: string; readonly userId: Users.UserId }) =>
    Effect.Effect<MembershipRecords.MembershipRecord,
      | OrganizationErrors.InvitationNotFound | OrganizationErrors.InvitationNotPending
      | OrganizationErrors.InvitationExpired | OrganizationErrors.InvitationEmailMismatch
      | OrganizationErrors.MembershipLimitReached | OrganizationErrors.AlreadyMember
      | OrganizationErrors.EmailVerificationRequired | OrganizationErrors.TeamMemberLimitReached
      | HookPoint.HookAborted>;
  readonly reject: (input: { readonly invitationId: string; readonly token: string; readonly userId: Users.UserId }) =>
    Effect.Effect<void, OrganizationErrors.InvitationNotFound | OrganizationErrors.InvitationNotPending
      | OrganizationErrors.InvitationEmailMismatch | HookPoint.HookAborted>;
  /** Pending only. Authorization (MTI-009 + `invitation:cancel`) is the caller's (D6). */
  readonly cancel: (actor: OrganizationActor.Actor, input: { readonly invitationId: string }) =>
    Effect.Effect<void, OrganizationErrors.InvitationNotFound | OrganizationErrors.InvitationNotPending | HookPoint.HookAborted>;
}
// key "awthaq/plugin/organization/Invitations"; accept/reject derive the actor (User) from `userId`.
```

#### 3.4.5 `OrganizationRoles` (`src/OrganizationRoles.ts`): dynamic access control

```ts
export interface OrganizationRolesShape {
  readonly requireEnabled: Effect.Effect<void, OrganizationErrors.DynamicAccessControlDisabled>;
  readonly list: (organizationId: string) => Effect.Effect<ReadonlyArray<OrgRoleRecords.OrgRoleRecord>, OrganizationErrors.DynamicAccessControlDisabled>;
  readonly find: (organizationId: string, roleId: string) =>
    Effect.Effect<OrgRoleRecords.OrgRoleRecord, OrganizationErrors.DynamicAccessControlDisabled | OrganizationErrors.OrgRoleNotFound>;
  /** RZS-005 reserved names, Bound over `permission`, RL, unique name. */
  readonly create: (actor: OrganizationActor.Actor, input: {
    readonly organizationId: string; readonly role: string; readonly permission: PermissionEngine.Statements;
    readonly bound: OrganizationActor.Bound;
  }) => Effect.Effect<OrgRoleRecords.OrgRoleRecord,
    | OrganizationErrors.OrganizationNotFound | OrganizationErrors.DynamicAccessControlDisabled
    | OrganizationErrors.ReservedOrgRoleName | OrganizationErrors.RolePermissionEscalation
    | OrganizationErrors.RoleLimitReached | OrganizationErrors.OrgRoleNameTaken | HookPoint.HookAborted>;
  readonly update: (actor: OrganizationActor.Actor, input: {
    readonly organizationId: string; readonly roleId: string; readonly permission: PermissionEngine.Statements;
    readonly bound: OrganizationActor.Bound;
  }) => Effect.Effect<OrgRoleRecords.OrgRoleRecord,
    | OrganizationErrors.OrganizationNotFound | OrganizationErrors.DynamicAccessControlDisabled
    | OrganizationErrors.OrgRoleNotFound | OrganizationErrors.RolePermissionEscalation | HookPoint.HookAborted>;
  readonly remove: (actor: OrganizationActor.Actor, input: { readonly organizationId: string; readonly roleId: string }) =>
    Effect.Effect<void, OrganizationErrors.OrganizationNotFound | OrganizationErrors.DynamicAccessControlDisabled
      | OrganizationErrors.OrgRoleNotFound | HookPoint.HookAborted>;
}
// key "awthaq/plugin/organization/Roles"
```

#### 3.4.6 `OrganizationActiveContext` (`src/OrganizationActiveContext.ts`)

```ts
export interface SessionRef { readonly sessionId: string; readonly userId: Users.UserId }
export const sessionOf = (principal: Api.UserPrincipal) => ({ sessionId: principal.sessionId, userId: Users.UserId(principal.ref.id) });

export interface OrganizationActiveContextShape {
  /** CWM-003: re-validated on read; stale pointers are cleared for real. */
  readonly get: (session: SessionRef) => Effect.Effect<ActiveContextRecords.ActiveContextRecord>;
  /** `None` unsets. Membership witness (MTI-001); a suspended organization is `MembershipNotFound` (BEH-EA-237). */
  readonly setOrganization: (session: SessionRef, organizationId: Option.Option<string>) =>
    Effect.Effect<ActiveContextRecords.ActiveContextRecord, OrganizationErrors.MembershipNotFound>;
  readonly setTeam: (session: SessionRef, teamId: Option.Option<string>) =>
    Effect.Effect<ActiveContextRecords.ActiveContextRecord, OrganizationErrors.TeamMembershipNotFound>;
  readonly activeMembership: (session: SessionRef) =>
    Effect.Effect<MembershipRecords.MembershipRecord, OrganizationErrors.NoActiveOrganization>;
}
// key "awthaq/plugin/organization/ActiveContext". The cascade writes (`clearOrganization`, `clearTeam`,
// `clearOrganizationForUser`) stay records calls inside Directory/Teams/Members transactions.
```

#### 3.4.7 `OrganizationAuthority` (`src/OrganizationAuthority.ts`): read-only

```ts
export interface OrganizationAuthorityShape {
  readonly statementsByRole: (organizationId: string) => Effect.Effect<ReadonlyMap<string, PermissionEngine.Statements>>;
  readonly effectivePermissions: (organizationId: string, membership: MembershipRecords.MembershipRecord) => Effect.Effect<PermissionEngine.Statements>;
  /** OHS-004: team-role statements held on `teamId` or any ancestor. */
  readonly teamAuthority: (userId: Users.UserId, organizationId: string, teamId: string) => Effect.Effect<PermissionEngine.Statements>;
  readonly teamRoleStatements: Effect.Effect<ReadonlyMap<string, PermissionEngine.Statements>>;
  /** The old `Organization.attributesFor` — `OrganizationQadi.relationships`' `<resource>:<action>` source (one evaluation path). */
  readonly attributesFor: (organizationId: string, userId: Users.UserId) =>
    Effect.Effect<Option.Option<{ readonly role: ReadonlyArray<string>; readonly permissions: PermissionEngine.Statements }>>;
  /** The old `Organization.checkRoleCeiling` (BEH-EA-316). */
  readonly checkRoleCeiling: (input: { readonly organizationId: string; readonly roles: ReadonlyArray<string>; readonly ceiling: ReadonlyArray<string> }) =>
    Effect.Effect<Option.Option<"unknownRole" | "unknownCeiling" | "exceedsCeiling">, OrganizationErrors.OrganizationNotFound>;
  /** `Ceiling(effective(ceilingRoles))` for a source with no membership (SAML). */
  readonly ceilingOf: (organizationId: string, ceiling: ReadonlyArray<string>) =>
    Effect.Effect<OrganizationActor.Bound, OrganizationErrors.UnknownOrgRole>;
}
// key "awthaq/plugin/organization/Authority"
```

#### 3.4.8 Connections: `OrganizationConnectionStore` deepened (`OrganizationConnections.ts`)

This stays the system interface for per-organization OIDC/OAuth2 connections. It is **opt-in** and is not exposed by `Organization.layer`, because it requires `Encryption` and `@awthaq/oauth`'s `OAuthConnections`. Changes:

1. `create`/`update` refuse an organization that is unknown or suspended (`Directory.findActive` → `InvalidConnection({ reason: "the organization does not exist" })`). The SAML store already words it this way (`SamlConnections.ts:293-295`).
2. `create`/`update`/`remove` take an `actor` and publish `auth.organization.connectionCreated` / `connectionUpdated` / `connectionDeleted` (ids only), mirroring `auth.saml.connection*`. This part is recommended but **deferrable** (Q8).
3. `cleanupOnOrganizationDelete` becomes `connectionsOnOrganizationDelete = OrganizationDeletion.contribute({ id: "organization.oauthConnections", make })`. `inTransaction` calls `records.removeAllForOrganization` and `afterCommit` calls `map.invalidate`. A failure now rolls the deletion back instead of being swallowed.

#### 3.4.9 `OrganizationDeletion` (`src/OrganizationDeletion.ts`): organization-dependent rows

This is an aggregating registry (ADR-EA-012) shaped like `Erasure.contribute` (`packages/core/src/Erasure.ts`, ADR-EA-031). It is ordered by `order` then id and frozen at first read. `Directory.delete` runs every contribution's `inTransaction(organizationId)` inside the delete transaction and every `afterCommit` after it.

```ts
export interface OrganizationDeletionHandler {
  readonly inTransaction: (organizationId: string) => Effect.Effect<void>;
  readonly afterCommit?: ((organizationId: string) => Effect.Effect<void>) | undefined;
}
export const contribute = <R>(contribution: {
  readonly id: string; readonly order?: number | undefined;
  readonly make: Effect.Effect<OrganizationDeletionHandler, never, R>;
}) => /* Layer<never, never, OrganizationDeletion | R> — inferred, not annotated */ …;
// key "awthaq/plugin/organization/Deletion"
```

Contributors:

- OIDC connections (above).
- `@awthaq/saml` deletes `saml_connection`, `saml_connection_domain`, its SP keys and SLO sessions for the organization, through a new `SamlRecords.removeAllForOrganization`.
- `@awthaq/scim` revokes and removes `scim_connection` and the `scim_resource` mappings, through `ScimRecords.removeAllForOrganization`.

Each contributes through its own `AuthPlugin.layer({ contributes })`. The registry requirement is discharged by `Organization.layer`'s `exposes`.

### 3.5 Hook points: typed handles

- Delete `veto` (`Organization.ts:1897-1907`). Every call site becomes `HookPoint.aborted(OrganizationHooks.BeforeX)(beforeX.run(input))`. The point id comes from the class's literal static `id` (`HookPoint.ts:461-468`), so a misspelt id cannot compile.
- Every `OrganizationHooks` input schema gains `actor: OrganizationActor.ActorSchema` (phase 1, all 20 pairs at once). Payload fields are unchanged. `CreateOrganizationInput.callerId` stays for compatibility and holds the `owner`.
- New pairs: `BeforeSuspendOrganization` / `AfterSuspendOrganization` (`organization.suspend.*`), and `BeforeReinstateOrganization` / `AfterReinstateOrganization` (`organization.reinstate.*`). Their inputs are `{ organizationId, actor, reason? }`. They are added to `OrganizationHooksLive`.
- Guard test (in `OrganizationHooks.test.ts`): no `organization\.[a-zA-Z.]+\.before"` string literal appears in `packages/organization/src/**/*.ts` except in `OrganizationHooks.ts`.
- `docs/plugin-authoring.md:41` and `examples/plugin-template/src/Template.ts:211-227` switch to `HookPoint.aborted(BeforeCreateNote)`.

### 3.6 The authorized interface on top

`OrganizationShape` loses `addMember`, `checkRoleCeiling`, `syncMemberRoles` and `attributesFor`, leaving **41 methods**. `checkSlug` stays because it backs an endpoint, and delegates to `Directory.isSlugAvailable`. Signatures and error unions of the remaining 41 are **unchanged**, so `OrganizationHandlers` does not change.

The authorization helpers move to `src/internal/authorize.ts`. It is built once in `make` and is not exported from the index:

```ts
export const makeAuthorize = Effect.gen(function* () {
  const directory = yield* OrganizationDirectory.OrganizationDirectory;
  const members = yield* OrganizationMembers.OrganizationMembers;
  const authority = yield* OrganizationAuthority.OrganizationAuthority;
  const events = yield* AuthEvents.AuthEvents;
  /** MTI-009 + BEH-EA-237: unknown, suspended and not-a-member all answer `OrganizationNotFound`. */
  const visibleMembership = Effect.fnUntraced(function* (callerId: Users.UserId, organizationId: string) {
    yield* directory.requireActive(organizationId);
    const membership = yield* members.find(organizationId, callerId);
    if (Option.isNone(membership)) return yield* new OrganizationErrors.OrganizationNotFound();
    return membership.value;
  });
  /** PERS-005: every denial leaves a durable who/what/why (moved verbatim from Organization.ts:1978-2014). */
  const requirePermission = Effect.fnUntraced(function* (
    callerId: Users.UserId, organizationId: string, resource: string, action: string, teamId?: string,
  ) { /* …as today, over authority.effectivePermissions / teamAuthority… returns { membership, statements } */ });
  const ceilingFor = (statements: PermissionEngine.Statements) => OrganizationActor.Bound.Ceiling({ statements });
  return { visibleMembership, requirePermission, ceilingFor };
});
```

Example authorized methods after the refactor:

```ts
removeTeam: Effect.fnUntraced(function* (caller: Api.UserPrincipal, organizationId: string, teamId: string) {
  const callerId = Users.UserId(caller.ref.id);
  yield* authorize.visibleMembership(callerId, organizationId);                     // MTI-009, SUSP
  yield* teams.requireEnabled;                                                      // PV-300 order
  yield* authorize.requirePermission(callerId, organizationId, "team", "delete", teamId);
  yield* teams.remove(OrganizationActor.user(caller), { organizationId, teamId });  // everything else
}),

updateMemberRole: Effect.fnUntraced(function* (caller: Api.UserPrincipal, organizationId: string, targetUserId: Users.UserId, role: ReadonlyArray<string>) {
  const callerId = Users.UserId(caller.ref.id);
  yield* authorize.visibleMembership(callerId, organizationId);
  const granter = yield* authorize.requirePermission(callerId, organizationId, "member", "update");
  const { membership } = yield* members.setRoles(OrganizationActor.user(caller), {
    organizationId, userId: targetUserId, roles: role, bound: authorize.ceilingFor(granter.statements), ifAbsent: "fail",
  });
  return membership;
}),
```

Authorized-layer responsibilities, exhaustively:

1. MTI-009 visibility.
2. Feature gates in PV-300 order.
3. `requirePermission` together with `permissionDenied`.
4. `allowUserToCreateOrganization` (authorization of *who* may create).
5. `mayReadInvitation`: the invitee or a member holding `invitation:create`.
6. The invitee-only rule on `getInvitationByToken` / `listInvitationsForUser`.
7. Mapping `principal` → `Actor.User` / `SessionRef`.
8. Remapping errors where MTI-009 requires it, for example `cancelInvitation`'s `OrganizationNotFound` → `InvitationNotFound` (3080-3085).

### 3.7 Exposure: `AuthPlugin.layer({ exposes })` and the Layer type

**Decision.** A plugin may expose **namespaced domain services** beside its own service. They are added to the plugin layer's `ROut`, and `Auth.make`'s left fold (`Auth.ts:830`, `provideMerge` in topological order) discharges a dependent's requirement on them.

Core change in `packages/core/src/AuthPlugin.ts`, both overloads at `:435-496` and the implementation at `:497`:

```ts
readonly exposes?: {
  readonly services: Exposed;                         // the tags, for the manifest (static, no layer built)
  readonly layer: Layer.Layer<XOut, XE, XR>;          // built once, below `make`
} & ExposesComplete<Id, XOut, Exposed>;               // compile error if a key is outside `awthaq/plugin/${Id}/` or the list is incomplete
// ROut: Self | ToService<…> | XOut
// RIn : Exclude<R, Scope.Scope | XOut> | Exclude<HR, Self | XOut> | XR | InstanceOf<Deps[number]> | …
// impl: const own = Layer.effect(plugin, options.make);
//       const base = options.exposes === undefined ? own : Layer.provideMerge(own, options.exposes.layer);
```

`ExposesComplete` mirrors `PortsComplete` (`AuthPlugin.ts:394-398`). It has two checks:

- every key of `XOut` matches `` `awthaq/plugin/${Id}/${string}` ``, which means two plugins can never expose the same tag, so no implicit slot can appear;
- `Exposed[number]["key"]` equals `XOut`'s keys.

`Validate<P>` (`Auth.ts:233-262`) gains a fifth problem, `ExposerNotDependedOn`. If a plugin's layer `RIn` contains a key `` `awthaq/plugin/${Other}/${string}` `` and `Other` is not in its `dependsOn` ids, the error reads `plugin "scim" requires "awthaq/plugin/organization/Teams" exposed by "organization" — add Organization to dependsOn`.

The JH-008 port check is untouched and still refuses an exposed port. `Manifest` (`Auth.ts:304-327`) gains `exposes: ReadonlyArray<{ plugin; key }>`, and `awthaq plugin list --graph` (`packages/cli/src/Plugin.ts:60, :112`) prints `exposes:`.

Organization wiring:

```ts
// src/OrganizationSystem.ts
export const services = [
  OrganizationDirectory.OrganizationDirectory, OrganizationMembers.OrganizationMembers,
  OrganizationTeams.OrganizationTeams, OrganizationInvitations.OrganizationInvitations,
  OrganizationRoles.OrganizationRoles, OrganizationActiveContext.OrganizationActiveContext,
  OrganizationAuthority.OrganizationAuthority, OrganizationDeletion.OrganizationDeletion,
] as const;
export const layer = Layer.mergeAll(
  OrganizationDirectory.layer, OrganizationMembers.layer, OrganizationTeams.layer,
  OrganizationInvitations.layer, OrganizationRoles.layer, OrganizationActiveContext.layer,
).pipe(Layer.provideMerge(OrganizationAuthority.layer), Layer.provideMerge(OrganizationDeletion.layer));

// src/Organization.ts
static readonly layer = AuthPlugin.layer(Organization, {
  ports: [Mailer.Mailer, SqlTransaction.SqlTransaction],
  exposes: { services: OrganizationSystem.services, layer: OrganizationSystem.layer },
  handlers: OrganizationHandlers,
  contributes: Layer.mergeAll(organizationErasure, organizationExport),
  make: makeAuthorized,            // requires the exposed services; discharged by `exposes`
});

// packages/scim/src/Scim.ts — dependsOn unchanged, records gone from RIn
const teams = yield* OrganizationTeams.OrganizationTeams;   // RIn: "awthaq/plugin/organization/Teams" — netted out by the fold
```

Alternatives considered:

- **(a) The application provides `OrganizationSystem.layer` itself**, the way it provides records. This needs no core change, but it is a second thing to wire, the plugin and SCIM could be given different instances, and the plugin graph cannot see the dependency (ADR-EA-002).
- **(b) Hang the system interfaces off the plugin shape** (`organization.system.teams`). This needs no core change, but SCIM would depend on the whole authorized interface, a module could not be tested or substituted alone, and the shape becomes the wide interface again.
- **(c) `exposes`**, chosen. It is type-checked, read off the Layer graph as ADR-EA-001/002 require, and it costs one option plus one `Validate` rule.

The plugin must still never provide a port (ADR-EA-010). Domain services are not ports, and the namespace rule keeps the two apart. A new ADR records this (§6).

### 3.8 File layout after the plan (`packages/organization/src/`)

| File | New/changed | Content |
|---|---|---|
| `Organization.ts` | changed (≤ 1,100 lines) | `class Organization`, `OrganizationShape` (41), `makeAuthorized`, re-exports (`config`, `OrganizationConfig`, `homeRegionOf`, `OrganizationHandlers`, `organizationErasure`, `organizationExport`, `tenantMiddleware*`) so `Organization.*` callers compile unchanged |
| `OrganizationConfig.ts` | new | lines 48-171 moved |
| `OrganizationErrors.ts` | new | `OrganizationApi.ts:22-258` moved; `OrganizationApi.ts` re-exports by name |
| `OrganizationActor.ts` | new | §3.2 |
| `OrganizationSystem.ts` | new | `services`, `layer` (§3.7) |
| `OrganizationDirectory.ts`, `OrganizationMembers.ts`, `OrganizationTeams.ts`, `OrganizationInvitations.ts`, `OrganizationRoles.ts`, `OrganizationActiveContext.ts`, `OrganizationAuthority.ts`, `OrganizationDeletion.ts` | new | §3.4 |
| `OrganizationHandlers.ts` | new | lines 706-1256 moved verbatim |
| `OrganizationMigrations.ts` | new | lines 1258-1709 moved verbatim (same names, same order) |
| `OrganizationPersonalData.ts` | new | lines 1719-1794 moved verbatim |
| `internal/authorize.ts`, `internal/bound.ts`, `internal/limits.ts`, `internal/tokens.ts`, `internal/cascade.ts`, `internal/protocol.ts` | new, package-private (not in `index.ts`) | helpers; `cascade.ts` holds `dropMembership`/`announceTeamDepartures` (2350-2387) |
| `OrganizationHooks.ts` | changed | `actor` on inputs; suspend/reinstate pairs |
| `OrganizationQadi.ts` | changed | Authority + Directory instead of `Organization` + records |
| `OrganizationConnections.ts` | changed | §3.4.8 |
| `TenantMiddleware.ts` | changed | `Directory.find` |
| `index.ts` | changed | adds the new namespaces; P8 removes `*Records` (moved to `records.ts`) |
| `records.ts` | new (P8) | `export * as TeamRecords …` for the `@awthaq/organization/records` sub-path |

**Migrations stay in the organization plugin.** `OrganizationMigrations.ts` is imported by the class's `migrations:` field. Ledger names are unchanged, so no deployed database sees a difference. Plan 05 may re-home them onto its substrate.

### 3.9 Records boundary (P8)

- `packages/organization/package.json` `exports` gains `"./records"` (types/bun/import/default, like `packages/oauth/package.json:21-26`). `tsconfig.base.json` `paths` gains `"@awthaq/organization/records"`. `index.ts` stops exporting the seven `*Records` namespaces. `OrganizationMemory` stays at the root, since it is composition, not access.
- A new static guard, `packages/organization/test/RecordsBoundary.test.ts`, scans `packages/*/src/**/*.ts` outside `packages/organization` and fails on any import of `@awthaq/organization/records` or of a `*Records` name from `@awthaq/organization`. Tests, `features/` and `examples/` may still import the sub-path.
- Module doc comments state who owns which writes:

  | Table | Writer |
  |---|---|
  | `organization_org` | Directory |
  | `organization_membership` | Members (and Directory/Invitations through the shared internal insert, D7) |
  | `organization_team*` | Teams (and Members/Directory cascades) |
  | `organization_invitation` | Invitations (Directory cascade, erasure) |
  | `organization_role` | Roles (Directory cascade) |
  | `organization_active_context` | ActiveContext (cascades) |
  | `organization_oauth_connection*` | ConnectionStore (Deletion contribution) |

### 3.10 Behaviour changes (each named in a changeset)

| # | Change | Why |
|---|---|---|
| D1 | SCIM groups enforce `teams.enabled`, `maximumTeams`, `maximumMembersPerTeam`, `allowRemovingAllTeams`, and run team vetoes, events and observers. New SCIM answers: `403` (`TeamsDisabled`, a limit, a veto, an unavailable organization) and `409` (last team). `ScimApi` `deleteGroup` gains `ScimForbidden` (`ScimApi.ts:412`, `Scim.ts:167`) | F1; Q1-Q3 |
| D2 | Suspension runs `Before/AfterSuspendOrganization` (and reinstate). AdminTenants `suspend`/`unsuspend` can answer `403 HookAborted` (`AdminTenantsApi.ts:102, :112` error arrays) | F5 |
| D3 | Org creation and invitation acceptance are atomic | F4 |
| D4 | Authorized order: the statement check now precedes the owner-invariant check in `removeMember`/`updateMemberRole`. Today OI is checked before permission (2404-2411, 2440-2452). A non-privileged member trying to remove the last owner gets `403` instead of `409`, which also stops leaking "this is the last owner" | locality; information hygiene |
| D5 | `setRoles` with identical roles is a no-op: no write, veto, event or observer, for HTTP too (it was SAML-only, 2599-2604) | one implementation |
| D6 | `cancelInvitation`'s veto runs after authorization (it was first, 3058). `accept`/`reject` keep veto-first | the system layer cannot authorize |
| D7 | Every membership row created fires `AfterAddMember` (invitation accept and creator membership included); every team membership created fires `AfterAddTeamMember` (invitation team join, SCIM, initial members). Each operation still runs only its own entry veto | F10; observers see every add |
| D8 | Invitations cancelled by re-invite/member check and expired on accept publish `invitationCanceled` / a new `invitationExpired` | F9 |
| D9 | `OrganizationShape` loses `addMember`, `checkRoleCeiling`, `syncMemberRoles`, `attributesFor` → `OrganizationMembers.add`, `OrganizationAuthority.checkRoleCeiling`, `OrganizationMembers.setRoles({ ifAbsent: "add" })`, `OrganizationAuthority.attributesFor` | G3 |
| D10 | `DecisionCacheInvalidationLive` taps `AfterMoveTeam`, `AfterUpdateTeamMemberRole`, `AfterSuspendOrganization`, `AfterReinstateOrganization` | F2 |
| D11 | Organization deletion removes OIDC/SAML/SCIM connection rows in the delete transaction (when those plugins are installed) | F7 |

---

## 4. Phased migration

**Gate for every phase:** `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Run `pnpm test:pg` too where a phase notes it. **Gate for the plan:** `pnpm check` and `pnpm test:pg`.

**Commit order inside each phase:**

1. Tests that pin current behaviour, or failing tests for the fix.
2. Code.
3. Test moves and deletions.
4. Spec and changeset.

### 4.0 Should the SCIM fix land as a hotfix first?

**Yes, as a vertical slice and not as a patch to `Scim.ts`.**

The README places 04 after 05 in Wave C. F1 and F2 are live, and they are security-relevant: off-boarding through SCIM leaves `team-member` decisions cached, and veto policies plus quotas are bypassed.

Patching `Scim.ts` to call more records and copy `removeTeam`'s veto/tx/event logic would deepen the duplication this plan removes, and it would still not be transactional across the link. **Slice A = P0 + P1 + P2** (core `exposes`, the mechanical split, `HookPoint.aborted`, `Actor`, `Authority`, `Teams`, SCIM groups). It changes no record signature and no SQL, so it can land right after Wave A. If plan 05 lands first, the rebase is limited to the Teams module's calls into `TeamRecords`.

If the user prefers strict wave order, slice A simply becomes the first three phases of Wave C. Q10 asks.

### P0: Mechanical split, `HookPoint.aborted`, core `exposes` (no behaviour change)

Ticket `01-split-and-exposes.md`.

1. **Mechanical split.**
   - Create `OrganizationConfig.ts`, `OrganizationErrors.ts`, `OrganizationHandlers.ts`, `OrganizationMigrations.ts`, `OrganizationPersonalData.ts` and `internal/tokens.ts` by moving the line ranges in §2.1 verbatim.
   - Re-export from `Organization.ts` and `OrganizationApi.ts` so no import site changes.
   - Confirm `pnpm circular` and that `knip` reports no new unused export. The re-exports are used by the namespace import.
2. **Typed hook handles.** Replace the 22 `veto("…", x.run(...))` calls with `HookPoint.aborted(OrganizationHooks.BeforeX)(x.run(...))`, then delete `veto` (1897-1907). Add the string-id guard test (§3.5). Update `docs/plugin-authoring.md:41` and `examples/plugin-template/src/Template.ts:211-227` (the template's test `examples/plugin-template/test/*` must stay green).
3. **Core `exposes`.**
   - Change `AuthPlugin.ts` (§3.7), `Auth.ts` (`Validate` `ExposerNotDependedOn`, `Manifest.exposes`) and `packages/cli/src/Plugin.ts` (print `exposes`).
   - Tests: `packages/core/test/AuthPlugin.test.ts` (an exposed service is in `ROut` and reachable by a dependent in the fold); a `*.types.test.ts` with `// @ts-expect-error` for a key outside the namespace, an incomplete `services` list, and a dependent missing `dependsOn`; `packages/cli/test` manifest print.
   - Behaviour file: new BEH in `spec/behaviors/02-plugin-composition-validate.md` (§6).
4. Gate, plus `pnpm test:pg` because migrations moved file. `OrganizationSql.test.ts` and `packages/sql` migration ledger tests must be unchanged.
5. Changesets:
   - `.changeset/plugin-exposes.md`: `@awthaq/core` minor, `@awthaq/cli` minor. Migration: none (additive).
   - `.changeset/organization-typed-hook-handles.md`: `@awthaq/organization` patch. `HookAborted.point` values are unchanged.

### P1: `Actor`, `Authority`, `Teams` system module

Ticket `02-teams-module.md`.

1. `OrganizationActor.ts` (§3.2), `internal/bound.ts` (§3.3) and `internal/limits.ts` (2129-2146).
2. Add `actor` to **every** `OrganizationHooks` input schema (20 pairs). In `Organization.ts`, every `.run({...})` passes `actor: OrganizationActor.user(caller)` for now. Caller-less methods pass `OrganizationActor.application("organization.addMember")` until P3 moves them.
3. `OrganizationAuthority.ts`: move 1910-1971 and 3702-3715, and `checkRoleCeiling` 2560-2576. `Organization.ts` keeps delegating stubs for `attributesFor`/`checkRoleCeiling` until P3, and `OrganizationQadi.ts:259` switches to `OrganizationAuthority.attributesFor`.
4. `OrganizationTeams.ts` (§3.4.3). Implement by moving the bodies of 3320-3700 minus authorization:
   - `requireTeamsEnabled` becomes `requireEnabled`;
   - `requireGrantableTeamRole`'s name check and `canGrant` become `Bound`;
   - `removeTeam` keeps its tx (3525-3543) and adds `attach`;
   - `addTeamMember` checks the target membership through `MembershipRecords.findByUserAndOrg`, since records are package-shared;
   - add `applyRoster`, `initialMembers` and the noop-backend undo for `attach`.
5. `OrganizationSystem.ts` with Directory/Members/Invitations/Roles/ActiveContext **not yet** present; `services` lists Teams + Authority. Wire `exposes` on `Organization.layer`.
6. The authorized team methods (`createTeam` … `removeTeamMember`; `setActiveTeam` waits for P7) become guard-plus-delegate (§3.6). Their public signatures do not change.
7. Tests (§5.1): new `OrganizationTeams.test.ts` and `OrganizationAuthority.test.ts`. Move or delete the team tests listed in §5.4.
8. Changeset `.changeset/organization-teams-module.md` (`@awthaq/organization` minor). Migration: hook inputs carry `actor`. A tap that constructs inputs (tests, `runPluginContractTests({ hooks })`) must add `actor`. New exports: `OrganizationActor`, `OrganizationAuthority`, `OrganizationTeams`, `OrganizationSystem`.

### P2: SCIM groups onto `OrganizationTeams` (fixes F1, part of F2)

Ticket `03-scim-groups.md`.

`packages/scim/src/Scim.ts`:

- `:33-38`: import `OrganizationActor`, `OrganizationTeams`; drop `ActiveContextRecords` and `TeamRecords`. `MembershipRecords` stays until P3.
- `:531-532`: `const teams = yield* OrganizationTeams.OrganizationTeams` and drop `activeContext`. Add `const actorOf = (connection: Connection) => OrganizationActor.directory(connection.id)`.
- `ownedGroup` (`:913-922`) and `listGroups` (`:1012`): `teams.find`. `provisionedMembers` (`:929`): `teams.members(...)`, with `TeamNotFound` → stale-mapping handling, as `ownedGroup` does.
- `addToTeam`/`removeFromTeam`/`replaceProvisioned` (`:978-1005`) are replaced by one `teams.applyRoster(actorOf(connection), { organizationId, teamId, add, remove, bound: OrganizationActor.Bound.Unbounded() })`. In `patchGroup` (`:1220-1237`), `add` → `{ add: ids, remove: [] }` and `remove` → `{ add: [], remove: toRemove }`.
- `createGroup` (`:1062-1098`): one `teams.create(actorOf(connection), { organizationId, name: displayName, initialMembers: memberIds }, { attach: (team) => records.link({...}) })`. This deletes the hand compensation at `:1075-1082`.
- `renameGroup` (`:1120-1129`): `teams.rename(actorOf(connection), …)`.
- `deleteGroup` (`:1245-1260`): `teams.remove(actorOf(connection), { organizationId, teamId: id }, { attach: () => records.unlink(connection.id, "Group", id) })`. This deletes the CWM-003 copy (`:1256-1257`).
- Error mapping, one helper `teamFailure`:

  | Error | SCIM answer |
  |---|---|
  | `TeamsDisabled` | `forbidden("Teams are not enabled for this organization")` |
  | `TeamLimitReached` | `forbidden("The organization's team limit is reached")` |
  | `TeamMemberLimitReached` | `forbidden("The team's member limit is reached")` |
  | `HookAborted` | `forbidden(aborted.message)` (as at `:776-777`) |
  | `OrganizationNotFound` | `forbidden("The organization is not available")` |
  | `LastTeamCannotBeRemoved` | `conflict("The organization's last team cannot be removed")` |
  | `TeamHasChildren` | the existing conflict |
  | `MembershipNotFound` | `badRequest(…, "invalidValue")` (already pre-checked by `requireMembers`) |
  | `TeamNotFound` on delete | converge to `void` |
  | `UnknownTeamRole` / `RolePermissionEscalation` | `Effect.die` (impossible under `Unbounded` + `member`) |

- `ScimShape.deleteGroup` (`Scim.ts:164-167`) and `ScimApi.ts:412` gain `ScimForbidden`.

`packages/qadi/src/DecisionCacheInvalidation.ts:52-66`: add `AfterMoveTeam` and `AfterUpdateTeamMemberRole` taps, and fix the stale comment at `:33-37` (F8).

Tests and BDD:

- Tests per §5.2.
- `packages/scim/test/support.ts:40-45` sets `teams: { enabled: true, allowRemovingAllTeams: true, … }`, or whatever Q1/Q2 decide, so the existing BEH-EA-251 scenarios keep their meaning.
- `features/step-definitions/ScimWorld.ts:97` does the same.
- `ScimSteps.ts:406-430` ("made by hand" team and hand-added member) goes through `OrganizationTeams` with `OrganizationActor.application("test")`.

Changesets: `.changeset/scim-groups-through-teams.md` (`@awthaq/scim` minor, `@awthaq/qadi` patch). Migration notes:

- SCIM Groups need `OrganizationConfig.teams.enabled: true`.
- Directory-driven deployments that delete every group set `teams.allowRemovingAllTeams: true`.
- `deleteGroup` may now answer `403`.
- Group writes now publish `auth.organization.team*` events naming the directory connection (from P9 on) and fire team observers.

Spec: BEH-EA-251 rev 1.1, BEH-EA-287 rev 1.1 (§6). Gate.

### P3: Members (+ SAML role mapping, SCIM membership)

Ticket `04-members-module.md`.

1. `OrganizationMembers.ts` (§3.4.2). Move from 2324-2645:
   - `wouldViolateOwnerInvariant` and `dropMembership` / `announceTeamDepartures` go to `internal/cascade.ts`, shared with Directory;
   - `setRoles` unifies `updateMemberRole` and `syncMemberRoles` (D5);
   - `add` absorbs `addMember` with `bound`.
   The shared internal insert fires `AfterAddMember` (D7).
2. Authorized `listMembers`, `removeMember`, `updateMemberRole` and `leave` delegate (D4). Remove `addMember`, `syncMemberRoles`, `checkRoleCeiling` and `attributesFor` from `OrganizationShape` (D9).
3. SAML:
   - `Saml.ts:673-674` yields `OrganizationMembers`, `OrganizationAuthority` and `OrganizationDirectory`, which replaces the `OrganizationRecords` use once P4 lands.
   - `applyRoleMapping` (`:915-938`) becomes `members.setRoles(OrganizationActor.identityProvider(connection.id), { organizationId, userId, roles, bound: yield* authority.ceilingOf(organizationId, connection.roleMapping.ceiling), ifAbsent: "add" })`. A `UnknownOrgRole` from `ceilingOf` is logged and skipped like the others.
   - `SamlConnections.ts:191, :261` uses `OrganizationAuthority.checkRoleCeiling`.
4. SCIM:
   - `membershipAdded` (`Scim.ts:584-595`) becomes `members.add(actorOf(connection), { …, bound: Unbounded() })`.
   - `requireMembers` (`:967`) uses `members.find`.
   - Drop `MembershipRecords` (`:35`, `:530`) and `Organization` (`:528`). `dependsOn` stays.
5. Tests per §5.1/§5.4. `packages/saml/test/SamlRoleMapping.test.ts` assertions read through `OrganizationMembers.find`.
6. Changeset `.changeset/organization-members-module.md`. Migration:
   - `Organization.addMember` → `OrganizationMembers.add(actor, { …, bound: OrganizationActor.Bound.Unbounded() })`;
   - `syncMemberRoles` → `setRoles({ ifAbsent: "add", bound })`;
   - `checkRoleCeiling` and `attributesFor` → `OrganizationAuthority`;
   - D4, D5, D7.

   `@awthaq/saml` and `@awthaq/scim` get patch changesets.

### P4: Directory, with suspension (+ AdminTenants, SAML/SCIM organization reads, TenantMiddleware, qadi)

Ticket `05-directory-module.md`.

1. `OrganizationDirectory.ts` (§3.4.1):
   - `create` (2156-2217) puts the org and creator membership in one tx (D3);
   - `update` (2248-2279);
   - `delete` (2281-2322) is unchanged except for the actor and the P5 registry hook point;
   - `suspend`/`reinstate` are new, with the logic moved from `AdminTenants.ts:240-280`, publish `auth.admin.organizationSuspended`/`Unsuspended` with `adminUserId` from the actor (Q6), and run the new hook pairs;
   - `find`/`findActive`/`requireActive`/`listPage`/`listForUser`/`isSlugAvailable`.
2. Authorized `create` (keeps `allowUserToCreateOrganization`), `checkSlug`, `list`, `get`, `getFull` (reads members, plus `Invitations.listPendingForOrganization` once P6 lands; until then records), `update` and `delete` delegate.
3. AdminTenants (`packages/admin/src/AdminTenants.ts`):
   - `:19` imports `OrganizationActor`, `OrganizationDirectory`;
   - `:177` `const directory = yield* OrganizationDirectory.OrganizationDirectory`;
   - `existing` (`:203-211`) → `directory.find`;
   - `listOrganizations` (`:217`) → `directory.listPage`;
   - `suspendOrganization`/`unsuspendOrganization` (`:240-280`) → `directory.suspend(OrganizationActor.platformAdmin(Users.UserId(caller.ref.id)), { organizationId, reason })`, mapping `OrganizationNotFound` → `AdminOrganizationNotFound` and passing `HookAborted` through. The event publish moves into the module;
   - `OrganizationRecords.OrganizationRecord` types (`:35`, `:53`, …) → `OrganizationDirectory.Organization`;
   - `AdminTenantsApi.ts:102, :112` error arrays gain `HookPoint.HookAborted` (D2).
4. SAML: `Saml.ts:709-722` `usableConnection` → `directory.findActive`; `SamlConnections.ts:190, :293` → `directory.find`. Drop `OrganizationRecords` (`Saml.ts:46`, `SamlConnections.ts:25`).
5. SCIM: `ScimConnections.ts:18, :117, :136-139` → `directory.findActive`. Its doc comment `:111` becomes "requires … `OrganizationDirectory`".
6. `TenantMiddleware.ts:39, :71, :76` → `directory.find` (raw, deliberate).
7. `OrganizationQadi.ts:172-174` (`isSuspended`, `notRelated`) → `directory.findActive` / `find`.
8. `DecisionCacheInvalidation.ts`: tap `AfterSuspendOrganization` and `AfterReinstateOrganization` (D10).
9. `TenantScoping.test.ts` allowlist `why` strings: `setSuspended` becomes "written only by `OrganizationDirectory.suspend`, whose actor type is `PlatformAdminActor`", and the update/delete rows become "after `OrganizationDirectory.update/delete`". The regexes stay.
10. Tests per §5; `packages/admin/test/AdminTenants.test.ts` (§5.2). Changeset `.changeset/organization-directory-module.md` (organization minor, admin minor, saml/scim patch, qadi patch).

### P5: Connections and the organization-deletion registry

Ticket `06-connections-and-deletion.md`.

1. `OrganizationDeletion.ts` (§3.4.9), modelled on `packages/core/src/ErasureRegistry.ts` + `Erasure.contribute`. `Directory.delete` runs contributions inside its tx (after the five built-in cascades, before `orgs.delete`) and their `afterCommit` after the event.
2. `OrganizationConnections.ts` (§3.4.8):
   - `layerStore` (`:400-532`) requires `OrganizationDirectory`;
   - replace `cleanupOnOrganizationDelete` (`:541-551`) with `connectionsOnOrganizationDelete` and fix the stale comment (F8);
   - optionally add actor and events (Q8).
3. `@awthaq/saml`: `SamlRecords.removeAllForOrganization` (new records method, plus a `TenantScoping`-style statement review) and `contributes: OrganizationDeletion.contribute({ id: "saml.connections", … })` on `Saml.layer`.
4. `@awthaq/scim`: `ScimRecords.removeAllForOrganization` and a contribution on `Scim.layer`.
5. Tests: `OrganizationDeletion.test.ts`, covering order, freeze, a failing contribution rolling back the delete (SQL) and `afterCommit` only after commit. Port `OrganizationConnections.test.ts:253-290` (`cleanupOnOrganizationDelete (BEH-EA-235)`) to the contribution. `ScimHttp.test.ts`/`Saml.test.ts`: deleting the organization removes their connection rows.
6. Gate plus `pnpm test:pg` (new SQL in saml/scim records). Changeset `.changeset/organization-deletion-registry.md` (organization minor, saml minor, scim minor). Migration: `OrganizationConnections.cleanupOnOrganizationDelete` → `connectionsOnOrganizationDelete`; the SAML/SCIM plugin layers now require the registry, which `Organization.layer` exposes.

### P6: Invitations

Ticket `07-invitations-module.md`.

1. `OrganizationInvitations.ts` (§3.4.4), moving 2750-3161:
   - tokens via `internal/tokens.ts`;
   - accept in one tx (D3);
   - the shared membership insert (D7);
   - the cancel/expire events (D8): add `OrganizationInvitationExpiredEvent` to `packages/core/src/AuthEventSchemas.ts` and to `AuditLog.actorOf`'s exhaustive switch (`AuditLog.ts:163ff`);
   - resend runs `AfterCreateInvitation`.
2. Authorized `invite` (`requirePermission("invitation","create")` → `Ceiling`), `acceptInvitation`/`rejectInvitation` (`userId` from the caller), `cancelInvitation` (D6), `getInvitation` (`mayReadInvitation` stays authorized), `getInvitationByToken`, `listInvitationsForOrganization` and `listInvitationsForUser` delegate. `getFull` uses `listPendingForOrganization`.
3. Tests per §5. Changeset `.changeset/organization-invitations-module.md` (organization minor, core minor for the new event).

### P7: Roles (dynamic) and ActiveContext

Ticket `08-roles-and-active-context.md`.

1. `OrganizationRoles.ts` (§3.4.5), moving 3165-3316. Authorized `createRole`/`listRoles`/`getRole`/`updateRole`/`deleteRole` delegate with `Ceiling(callerEffective)`.
2. `OrganizationActiveContext.ts` (§3.4.6), moving 2647-2746 and 3687-3700. Authorized `getActiveMember`, `getActiveMemberRole`, `setActive`, `getActive` and `setActiveTeam` delegate through `OrganizationActiveContext.sessionOf(caller)`.
3. `OrganizationSystem.services` is now complete (8 tags). `Organization.ts` should contain only `makeAuthorized`. Check the ≤ 1,100-line target and grep for any remaining `*Records` yield in `Organization.ts`; the expected count is 0.
4. Tests per §5. Changeset `.changeset/organization-roles-active-context.md` (patch; additive exports).

### P8: Close the records boundary

Ticket `09-records-boundary.md`.

1. Add `records.ts`, the package.json `"./records"` export and the `tsconfig.base.json` path. Remove the `*Records` namespaces from `index.ts`.
2. Update every importer: `features/step-definitions/*`, `packages/*/test/*`, `examples/*` and `OrganizationMemory.ts` (internal relative imports are unaffected).
3. Add `RecordsBoundary.test.ts` (§3.9).
4. Confirm that SCIM, SAML and AdminTenants have **no** `organization_*` access, so `readsTables` stays correctly empty. Add an assertion in each plugin's `AuthComposition.test.ts` that `Auth.make([...]).manifest` lists `exposes` for organization and that their `dependsOn` includes it.
5. Run `pnpm package:smoke` (the sub-path must resolve from `lib`). Changeset `.changeset/organization-records-subpath.md` (organization minor). Migration: `import { TeamRecords } from "@awthaq/organization"` → `from "@awthaq/organization/records"`.

### P9: Actor in organization events and the audit log

Ticket `10-audit-actor.md`. Coordinate with plan 09.

1. `packages/core/src/AuthEventSchemas.ts:586-760`: every `auth.organization.*` event gains `actor: Schema.optional(ActorSchemaCore)`. The core copy of the actor schema is structurally identical to `OrganizationActor.ActorSchema`. Core cannot import a plugin, so the schema lives in core (`packages/core/src/Actor.ts`) and `OrganizationActor` re-exports it. If plan 01/03 already introduced a core actor, use theirs (Q7).
2. `AuditLog.actorOf` (`AuditLog.ts:163-255`): for organization events, `actorUserId` = the actor's user (`User.userId` / `PlatformAdmin.adminUserId`) when present, else the current mapping. `auth.scim.*` events (`:246-249`, which have no actor today) are unchanged.
3. Every system module publishes `actor`.
4. Tests: `packages/core/test/AuditLog.test.ts` (actor mapping) and an organization test asserting that `memberRemoved` by an admin records the admin as actor (F11). Changeset `.changeset/organization-event-actor.md` (core minor, organization patch). Migration: event subscribers decoding organization events see an optional `actor`.

### P10: Spec, docs and acceptance

Ticket `11-spec-and-docs.md`. Covers §6 in full, `pnpm check` and `pnpm test:pg`, and closes the tickets.

---

## 5. Test plan

**Principles.**

- System policy is tested at the system interface, with no `Api.UserPrincipal` anywhere in those suites.
- The authorized layer is tested only for authorization.
- SCIM, SAML and AdminTenants tests assert that hooks and events fire through their paths.
- Tests move; old copies are deleted, not kept alongside.

Every new suite runs over `OrganizationMemory.layer` + `SqlTransaction.layerNoop`. Atomicity cases also run over `TestSql.layer` + `SqlTransaction.layerSql`, using the `OrganizationSql.test.ts` pattern, so `pnpm test:pg` covers Postgres.

### 5.1 New system-level suites (`packages/organization/test/`)

| Suite | Cases (each one `it.effect`) |
|---|---|
| `OrganizationTeams.test.ts` | teams disabled → `TeamsDisabled` for every mutator; `maximumTeams` (static and `limitsFor` override, EP-006); parent in another org → `TeamNotFound`; `initialMembers` non-member → `MembershipNotFound` and nothing written; `initialMembers` over TML → nothing written; veto on create aborts with `point === BeforeCreateTeam.id` and nothing written; observe failure never surfaces; `teamCreated` + `AfterCreateTeam` carry the actor; `attach` failure rolls back (SQL) and undoes (memory) with no event; move cycle → `TeamHierarchyCycle`; remove last team (default) → `LastTeamCannotBeRemoved`, allowed with `allowRemovingAllTeams`; remove with children → `TeamHasChildren` before the veto runs (tap counter = 0); remove clears every session's `activeTeamId` in the same tx (SQL rollback case); `addMember` requires org membership, TML, `AlreadyTeamMember`, unknown team role, `Ceiling` refuses `lead` beyond the bound and `Unbounded` admits it; `setMemberRole` checks the current role against the bound; `applyRoster`: idempotent skips, every veto before any write, TML on the final count, one event + observe per changed user, actor recorded; a suspended organization → `OrganizationNotFound`; per-tenant config (EP-007) applies per call |
| `OrganizationMembers.test.ts` | `add`: ML (+ `limitsFor`), KR, `AlreadyMember`, veto, `memberAdded` + `AfterAddMember`; `setRoles`: OI for update and add, KR after veto, a veto tap amending roles is bounded (ceiling checked on the vetoed value), outranks, `unchanged` publishes nothing (D5), `ifAbsent: "fail"` → `MembershipNotFound`, `ifAbsent: "add"` → `added`; `remove`: OI, cascade in one tx (team memberships, active context), `teamMemberRemoved` + `AfterRemoveTeamMember` per team, then `AfterRemoveMember` (order asserted); suspended → `OrganizationNotFound` |
| `OrganizationDirectory.test.ts` | `create`: region, `organizationLimit` for the owner (incl. `creatorRole: "admin"`), slug, org + membership atomic (SQL: a failing membership insert leaves no org), `created` + `memberAdded` + `AfterAddMember` (D7); `update`; `delete`: disabled, five-table cascade + contributions in one tx, events after commit; `suspend`/`reinstate`: idempotent (first `suspendedAt` kept), veto aborts, observe fires, events carry `adminUserId`; `// @ts-expect-error` calling `suspend` with `Actor.User`; `find` vs `findActive` on a suspended org |
| `OrganizationInvitations.test.ts` | moved invitation cases (§5.4) plus: accept atomic (SQL: failing team insert leaves invitation pending and no membership); `AfterAddMember` + `AfterAddTeamMember` on accept (D7); cancelled-by-re-invite publishes `invitationCanceled` (D8); expired publishes `invitationExpired`; resend runs `AfterCreateInvitation` |
| `OrganizationRoles.test.ts` | DAC disabled; reserved names (built-in, static custom); `Ceiling` on statements; RL; name taken; veto/observe/events |
| `OrganizationActiveContext.test.ts` | `setOrganization` requires membership (MTI-001) and refuses suspended; `None` unsets; two sessions independent; `get` revalidates and clears stale pointers for real (CWM-003); `setTeam` requires team membership; `activeMembership` → `NoActiveOrganization` |
| `OrganizationAuthority.test.ts` | `statementsByRole` with/without DAC; team authority flows down, never up or sideways; `attributesFor`; `checkRoleCeiling` three verdicts; `ceilingOf` unknown role |
| `OrganizationDeletion.test.ts` | ordering, freeze, rollback, `afterCommit` |
| `RecordsBoundary.test.ts` | static import guard (§3.9) |

### 5.2 SCIM, SAML and AdminTenants: hooks and events fire through their paths

`packages/scim/test/ScimGroups.test.ts`. Add, using `ScimLive(…, hooks)` and taps provided with `OrganizationHooks.OrganizationHooksLive`:

1. "POST runs the team veto: an aborting `BeforeCreateTeam` tap is 403 and creates neither team nor mapping".
2. "POST publishes `auth.organization.teamCreated` and one `teamMemberAdded` per member, and fires their observers".
3. "POST beyond `maximumTeams` is 403 and creates nothing" (Q3).
4. "POST with teams disabled is 403" (Q1).
5. "PATCH add beyond `maximumMembersPerTeam` is 403 and changes no member".
6. "PATCH/PUT removals fire `AfterRemoveTeamMember`, so a long-lived `DecisionCache` is cleared". This one composes `DecisionCacheInvalidationLive` with a counting `DecisionCache`, mirroring `packages/qadi/test/DecisionCacheInvalidation.test.ts`.
7. "DELETE runs `BeforeDeleteTeam`; an abort is 403 and the group stays mapped".
8. "DELETE of the last team is 409 unless `allowRemovingAllTeams`" (Q2).
9. "DELETE clears every session's active team in the same transaction" (SQL variant over `TestSql`).
10. "DELETE publishes `teamDeleted` and fires `AfterDeleteTeam`".
11. "a link race on POST leaves no team" (inject a `ScimRecords` whose `link` fails `ScimLinkConflict`).

Rewrite these existing cases to arrange state through `OrganizationTeams` / authorized `Organization`, not `TeamRecords`:

- `ScimGroups.test.ts:90-116` "a connection cannot see, read or delete another connection's group, or a team it did not make";
- `:118-151` "PUT renames …";
- `:220-250` "a group whose team was removed elsewhere …" (remove through `OrganizationTeams.remove(application)`).

`ScimUsers.test.ts`: "provisioning fires `AfterAddMember` with a `Directory` actor" (P3).

`packages/saml/test/SamlRoleMapping.test.ts`:

- "an applied mapping fires `AfterUpdateMemberRole` / `AfterAddMember` with an `IdentityProvider` actor";
- "a veto tap amending the roles beyond the ceiling is refused and logged";
- `:420` "a role that no longer exists is logged and skipped" now also covers `ceilingOf`'s `UnknownOrgRole`.

`packages/admin/test/AdminTenants.test.ts`:

- "suspension fires `AfterSuspendOrganization` and clears a long-lived decision cache";
- "a `BeforeSuspendOrganization` veto makes suspend 403 and leaves the organization active";
- `:158` "suspension and reinstatement are published as audited events" keeps passing, now published by the module.

`packages/qadi/test/DecisionCacheInvalidation.test.ts` gains a case for each newly tapped point (D10).

### 5.3 Authorized-layer tests: what stays in `Organization.test.ts`

Kept, rewritten to arrange state through system interfaces where they used records:

- `create is refused when allowUserToCreateOrganization denies`
- `checkSlug/list/get/getFull answer correctly`
- `getFull/listMembers/listInvitationsForOrganization are denied to a non-member`
- `update requires permission and rejects a slug collision` (rename: "update requires organization:update"; the slug half moves)
- `delete requires permission, can be disabled, and cascades memberships` (rename: "delete requires organization:delete"; the rest moves)
- `removeMember/updateMemberRole fail MembershipNotFound for a non-member`
- `removeMember/updateMemberRole succeed once another owner exists, and require permission` (permission half)
- `cancel requires invitation:cancel permission and marks it canceled` (permission half)
- the whole RRM-001/RRM-002 describe, except `updateMemberRole with an undefined role name fails UnknownOrgRole` and `invite and addMember reject an undefined role name`, which move. All of it exercises the caller-derived ceiling.
- the OHS-005 describe
- `createRole rejects granting a permission the caller doesn't hold`
- `a member holding a custom role has that role's permissions`
- `moving needs team:update; reading relatives is member-only`
- the team roles (OHS-004) describe except `team roles are canGrant-guarded and must be known` (its unknown-name half moves)
- `listTeams/listTeamMembers are denied to a non-member`
- `a stranger cannot read an invitation by id (404); the invitee and an inviter can`
- `the invitee can read by token and accept with it; a stranger cannot`
- the PERS-005 describe
- `EP-003: a suspended organization is refused everywhere, and reinstating restores it` (suspends through `OrganizationDirectory.suspend`)
- the Per-tenant configuration (EP-007) describe (one representative per module may move; keep the two-tenants case here)

Add one test per new ordering: D4 ("a member without member:delete removing the last owner gets OrganizationPermissionDenied") and D6.

`OrganizationHooks.test.ts` keeps both tests. Their `aborted.point` assertions compare with `OrganizationHooks.BeforeCreateOrganization.id`, and the string-id guard is added.

### 5.4 Tests to move or delete (by name, `packages/organization/test/Organization.test.ts`)

| Test (line) | Action |
|---|---|
| create makes the creator the owner automatically (116); create honors a custom creatorRole (129); create rejects a slug collision (139); create is refused once organizationLimit is reached (164); organizationLimit is still enforced when creatorRole is not "owner" (176) | → `OrganizationDirectory.test.ts` |
| delete cascades dynamic roles (298); delete answers OrganizationDeletionDisabled when configured off (324) | → Directory |
| the owner invariant rejects removeMember, updateMemberRole, and leave for the last owner (334) | → Members (OI half); delete the original |
| leave succeeds for a non-owner without touching the owner invariant (408); addMember respects membershipLimit (425) | → Members |
| getActiveMember/getActiveMemberRole answer NoActiveOrganization with no active org set (441); setActive then getActiveMember/getActiveMemberRole resolve against it (454); setActive rejects an organization the caller isn't a member of (471); setActive with null unsets the active organization (483) | → ActiveContext |
| invite sends an email via Mailer and creates a pending invitation (497); invite fails with InvitationDeliveryFailed when mail fails; resend succeeds once mail recovers (519); full invite -> accept round trip creates a real membership (579); reject marks the invitation rejected and creates no membership (605); re-inviting … without resend is a no-op (652); re-inviting with resend … (673); cancelPendingInvitationsOnReInvite … (695); inviting an existing member fails AlreadyMember and keeps their accepted invitation (717); accepting an expired invitation fails InvitationExpired (748); accepting with a mismatched email fails InvitationEmailMismatch (767); invitationLimit rejects … (793); getFull includes pending invitations (806 → stays, authorized read) | → Invitations (except 806) |
| createRole is rejected when dynamic access control is disabled (817); createRole/listRoles/getRole/updateRole/deleteRole round-trip (829); maximumRolesPerOrganization caps … (1166); the RZS-005/N8 describe (1040-1108) except `Organization.config refuses permissionStatements that redefine a built-in` (1098) | → Roles; 1098 → `OrganizationConfig.test.ts` (new, 1 case) |
| updateMemberRole with an undefined role name fails UnknownOrgRole (896); invite and addMember reject an undefined role name (959) | → Members / Invitations |
| createTeam is rejected when teams is disabled (1183); createTeam/listTeams/updateTeam/removeTeam round-trip (1208); nested create, ancestors/descendants, and move re-parent a subtree (1244); a cycle is TeamHierarchyCycle; a parent with children cannot be removed (1276); a parent from another organization is TeamNotFound (1293); addTeamMember requires the target already be an organization member (1537); allowRemovingAllTeams (default false) blocks removing the last team (1571) | → Teams (P1) |
| setActiveTeam round-trips and rejects a non-member (1583) | → ActiveContext |
| a team-targeted invitation joins the accepting user to that team (1605); inviting with an unknown teamId fails TeamNotFound (1630) | → Invitations |
| membership uniqueness describe (1644-1738) | split: Members (1645, 1687), Invitations (1664), Teams (1721) |
| active context lifecycle describe (1740-1835) | split: Members (1759 removeMember clears…, 1776 leave clears…), Directory (1788 delete clears…), Teams (1802 removeTeam clears…), ActiveContext (1813 getActive re-validates…) |
| invitation capability (MTI-010) describe (1836-1976) except the two kept reads | → Invitations |
| an invitation is announced without the invitee's email (2012) | → Invitations |
| EP-010 ×2 (2050, 2079); EP-005 the invitation mail carries … (2184) | → Invitations |
| EP-006 the default organizationLimit … (2102) | → Directory; EP-006 limitsFor overrides … (2116) → Members/Teams (one case each) |
| DRS-007 ×2 (2148, 2174) | → Directory |
| a tenant's own invitation policy applies to its acceptances (2301) | → Invitations |

Other organization suites:

- `OrganizationQadi.test.ts:430` "relations agree with requirePermission for every membership" stays. It is the one-evaluation-path proof, now over `OrganizationAuthority`.
- `:293` "a suspended organization confers no relationship, and reinstating restores it" suspends through Directory.
- `AuthHttp.test.ts` (wire) is unchanged except for arranging state.
- `OrganizationConnections.test.ts:253` describe → `OrganizationDeletion` contribution.
- `TenantScoping.test.ts`: only the `why` strings change.
- `AuthComposition.test.ts`: assert `manifest.exposes`.

### 5.5 BDD (`features/`)

- `features/features/13-enterprise-federation/30-scim.feature`, Rule BEH-EA-251. Add scenarios:
  - "A veto hook that refuses team creation makes POST /Groups 403 and creates nothing";
  - "A group beyond the organization's team limit is 403";
  - "Deleting a group is recorded as auth.organization.teamDeleted";
  - "Removing a member from a group is recorded as auth.organization.teamMemberRemoved";
  - "Deleting the organization's last group is 409 unless removing every team is allowed" (wording per Q2).
  
  Existing REQ-EA-952…964 keep their meaning with the composition change in `ScimWorld.ts:97`. Allocate new REQ-EA ids with `features/scripts/allocate-req-ea.py` (the next free id is above 1267 today) and regenerate `features/traceability.md`.
- `features/features/12-multi-tenancy/28-tenancy.feature`, BEH-EA-237. Add "A veto hook can refuse a suspension" and "Suspending an organization clears a long-lived decision cache".
- `features/features/10-organization/35-organization.feature`, BEH-EA-290. Add "Accepting an invitation is atomic" and "A member removed by an administrator is audited with the administrator as actor" (P9). Update D4's ordering if any scenario asserts `409` for a non-privileged last-owner removal; check `OrganizationSteps.ts`.
- Step definitions `ScimSteps.ts:266, :280, :406-430`, `TenancySteps.ts`, `OrganizationSteps.ts` and `SamlFederationSteps.ts` arrange state through system interfaces. `features/features/_guard/step-patterns.steps.test.ts` must stay green.

---

## 6. Spec, ADR, traceability, docs, changesets

**ADR (new).** **ADR-EA-040** (reserved in `.planning/README.md`). Title: "A plugin may expose namespaced domain services; dependents declare `dependsOn`". Document Control rev 1.0. It records §3.7: the decision, alternatives (a)/(b), the namespace rule, the `Validate` rule and the relation to ADR-EA-001/002/010/012. Add it to `spec/decisions/index.yaml` and to the ADR table in `spec/traceability.md`.

**ADR revisions.**

- ADR-EA-023 rev 1.2: SCIM groups are organization teams through `OrganizationTeams`, so team invariants, hooks and events apply.
- ADR-EA-018 rev 1.2: Decision 9, suspension is `OrganizationDirectory.suspend` with hooks, and AdminTenants is its caller.
- ADR-EA-033 needs no change. `HookPoint.aborted` already exists; mention it in the plugin-authoring doc.

**Behaviors** (Document Control table: bump revision, add a change-history row for each):

| File | Change |
|---|---|
| `spec/behaviors/35-organization.md` | Rev 1.1. BEH-EA-287: limits apply to every caller (directory included). BEH-EA-288: every role-assigning path is bounded by a `Bound`, and `Unbounded` is a trusted source's explicit choice. BEH-EA-290: every mutation, whoever the actor, runs its veto and observe pair and publishes its events after commit; accept and create are atomic; D7, D8. **New BEH-EA-3xx** (next free; 319+ today): "Every caller reaches organization state through one system module per sub-domain; invariants, hooks and events cannot be skipped by any caller", with a REQUIREMENT block naming the actor kinds and the protocol order (§3.4). |
| `spec/behaviors/30-scim.md` | Rev 1.1. BEH-EA-251 adds the team rules (teams enabled, limits, last team, veto → 403) and atomic create-and-link. BEH-EA-253 notes that group changes also publish `auth.organization.team*`. |
| `spec/behaviors/28-tenancy.md` | Rev 1.1. BEH-EA-237: suspension and reinstatement run veto and observe points; `DecisionCacheInvalidation` clears on both. |
| `spec/behaviors/29-saml-sp.md` | BEH-EA-316 rev: mapping through `OrganizationMembers.setRoles` with an `IdentityProvider` actor; a veto-amended role set is re-bounded. |
| `spec/behaviors/02-plugin-composition-validate.md` | **New BEH** for `exposes` and the `Validate` rule. |
| `spec/behaviors/21-qadi-resolvers-obligations.md` | BEH-EA-162 note: relations read `OrganizationAuthority`, the same computation as the plugin's gating. |
| `spec/behaviors/index.yaml` | add the new ids. |

**Models.**

- `spec/models/14-organization.md`: a module-structure section with the §3.1 diagram, the system interfaces, the table-ownership table and the actor.
- `spec/models/12-scim.md`: groups go through `OrganizationTeams`.

**Traceability** (`spec/traceability.md`):

- §1 row 35: Source module becomes `Organization.ts` (authorized) + `OrganizationDirectory/Members/Teams/Invitations/Roles/ActiveContext/Authority.ts` (system).
- Row 30: add `OrganizationTeams`.
- The test row at line 279 lists the new suites.
- §6 crosswalk adds the new REQ-EA ids.
- Run `pnpm spec:verify:strict`.

**Docs.**

- `docs/plugin-authoring.md`:
  - `:41`: "Translate a veto abort where the point is run with `HookPoint.aborted(BeforeX)(beforeX.run(input))`, which names the point by its class (BEH-EA-090); do not write a string id."
  - New section, "Exposing a system interface": when a plugin has trusted callers (other plugins, jobs), expose a namespaced `Context.Service` through `AuthPlugin.layer({ exposes })`. The interface takes an actor, owns its invariants, hooks, events and transactions, and other plugins never reach your records.
  - "Dependencies" paragraph: requiring an exposed service implies `dependsOn`, which the compiler enforces.
- `examples/plugin-template/src/Template.ts`: use `HookPoint.aborted`.
- `packages/organization/README.md`: module map and system vs authorized interfaces. `packages/scim/README.md`: teams config prerequisites (Q1/Q2). `packages/admin/README.md`: suspension hooks. Keep the README status banners (`pnpm check:readmes`).
- `AGENTS.md` "Plugin authoring" line: unchanged. The doc it points to changes.

**Changesets** (ADR-EA-034; each with a `Migration:` section naming the ADR and BEH ids):

| File | Packages | Migration note |
|---|---|---|
| `.changeset/plugin-exposes.md` | core minor, cli minor | additive; new ADR |
| `.changeset/organization-typed-hook-handles.md` | organization patch | none |
| `.changeset/organization-teams-module.md` | organization minor | hook inputs carry `actor`; new namespaces |
| `.changeset/scim-groups-through-teams.md` | scim minor, qadi patch | `teams.enabled` required for Groups; `allowRemovingAllTeams`; `deleteGroup` 403; D10 |
| `.changeset/organization-members-module.md` | organization minor, saml patch, scim patch | D4, D5, D7, D9 |
| `.changeset/organization-directory-module.md` | organization minor, admin minor, saml patch, scim patch, qadi patch | D2, D3 (create), D10 |
| `.changeset/organization-deletion-registry.md` | organization minor, saml minor, scim minor | D11; `cleanupOnOrganizationDelete` renamed |
| `.changeset/organization-invitations-module.md` | organization minor, core minor | D3 (accept), D6, D8; new `invitationExpired` event |
| `.changeset/organization-roles-active-context.md` | organization patch | — |
| `.changeset/organization-records-subpath.md` | organization minor | records import path |
| `.changeset/organization-event-actor.md` | core minor, organization patch | optional `actor` on events; audit actor mapping |

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| A behaviour drift hidden in the move (45 bodies) | Each phase moves the bodies verbatim first and then restructures. The relocated tests run against the new module before the old copy is deleted. The wire suite `AuthHttp.test.ts` (854 lines) and BDD `35-organization.feature` stay untouched as an oracle until P10. |
| `HttpApiBuilder` `Requires` leak (ticket 19) if a module yields a service inside a closure | Rule in §3.4: yield once at the top of `make`. `pnpm typecheck` (both `tsc -b` and `tsconfig.test.json`) is in every gate. |
| The generic `attach` signature does not infer through `Effect.fnUntraced` | Fallback named in §3.4.3: split into `create` and `createAttached`. Never cast. |
| `exposes` typing breaks `Auth.make`'s fold inference (`FoldLayer`) | P0 lands with type tests over a 3-plugin tuple (exposer, dependent, unrelated), `TestAuth.layer` included (`packages/test`). If `FoldLayer` cannot carry `XOut`, fall back to alternative (a) for the dependent's wiring only. The system modules are unchanged either way. |
| Events published inside a caller's outer transaction | `attach` may touch only the caller's tables, a rule stated in the module docs and checked in review. SCIM no longer wraps system calls. Plan 10 owns a general after-commit mechanism. |
| Hook taps that construct inputs break on the new `actor` field | It is in the changeset. `runPluginContractTests({ hooks })` stubs are updated in-repo (grep `OrganizationHooks.` in tests and features). |
| SCIM deployments start getting `403`/`409` after D1 | The changeset migration note, the SCIM README, and Q1-Q3 answered before P2 merges. |
| Records sub-path breaks `package:smoke` or knip | P8 is isolated and its gate includes `pnpm package:smoke`. |
| Circular imports (`Organization.ts` ↔ modules ↔ `OrganizationQadi`) | Modules never import `Organization.ts`. Config and errors live in leaf files. `pnpm circular` runs in every gate. |
| Plan 05 renames or retypes record methods mid-flight | Slice A touches only `TeamRecords` calls. Rebase P3-P7 onto 05. The system modules are the only callers left, so a records change touches one file per sub-domain (locality). |

**Rollback.**

- Each phase is one PR and revertible with `git revert`.
- P0's core `exposes` is additive and can be reverted only after reverting every phase that uses it.
- Migrations are never edited (only moved), so no database rollback is ever needed. P5's new SAML/SCIM records methods are queries, not migrations.
- If D1 must be backed out in production, set `teams.enabled: true` and `allowRemovingAllTeams: true` and raise the limits. That is configuration, not code.

---

## 8. Interactions with other plans

| Plan | Shared seam | Rule |
|---|---|---|
| **05** Plugin table substrate | `*Records.ts` (tenant scoping, RLS on `organization_*`, ADR-EA-019 re-seal of `organization_oauth_connection.clientSecret`, removal of `orDie`) | 05 lands first in Wave C (except slice A, §4.0). After 05, system interfaces add `Errors.StoreUnavailable` where records surface it. `TenantScoping.test.ts` may be superseded by 05's structural guard; this plan adds no SQL to `src` outside records. Migrations may move onto 05's substrate. Names stay. |
| **03** Erasure single cascade | `organizationErasure` (moved verbatim to `OrganizationPersonalData.ts`); SCIM `deleteUser` erase (`Scim.ts:884-906`) | Not touched here. 03 replaces `users.delete` with `AccountErasure`. Erasure stays a records-level sweep inside the erasure tx and emits no per-row organization events (BEH-EA-290's erasure clause). |
| **01** Sign-in/sign-up in core | SCIM `createUser` (`Scim.ts:681-798`) | 01 moves user creation to `SignUp`. This plan only swaps `membershipAdded` to `OrganizationMembers.add(Directory)` (P3). If 01 makes SCIM provisioning one transaction, `members.add` may need an `attach`-style option; add it then, with a real caller. |
| **08** Record bundles and `TestAuth.layer` | `OrganizationMemory.ts` (no `ConnectionRecords` today), `@awthaq/organization/records` | 08 builds `Organization.records.memory/sql` (including `ConnectionRecords`) on the P8 sub-path. Test compositions get the system modules for free from `Organization.layer`'s `exposes`. |
| **09** Event metadata | P9 `actor` on organization events | Coordinate the `actor` field with 09's metadata design. If 09 moves actor into envelope metadata, P9 becomes "publish with actor metadata" and the schema change is dropped. |
| **10** Standalone fixes | "events from rolled-back tx" | Modules publish after their own commit (§3.4). `attach` forbids nested system calls. If 10 introduces an after-commit queue, modules adopt it in one place, `internal/protocol.ts`. |
| **02** Store seam | pattern | Same shape: one domain implementation over a store seam. No shared code. |
| **06, 07** | — | none |

---

## 9. Acceptance checklist

- [ ] `grep -rn "Records\.\w*Records\b" packages/{scim,saml,admin}/src` → nothing. `RecordsBoundary.test.ts` passes.
- [ ] `grep -n "yield\* \w*Records\." packages/organization/src/Organization.ts` → nothing. `Organization.ts` ≤ 1,100 lines. `OrganizationShape` has 41 methods, unchanged signatures.
- [ ] No local `veto` helper. No string `organization.*.before` literal outside `OrganizationHooks.ts`. `docs/plugin-authoring.md` and the template use `HookPoint.aborted`.
- [ ] Every system interface method takes an `Actor` (or a `SessionRef` for active context, or the invitee's `userId`). None mentions `Api.UserPrincipal`.
- [ ] SCIM group create, rename, roster and delete each run the team veto, write in one transaction, publish `auth.organization.team*`, fire observers, and enforce `teams.enabled`, TML, TL and the last-team rule (per Q1-Q3). The tests in §5.2 pass.
- [ ] AdminTenants suspends and reinstates through `OrganizationDirectory`. Hooks fire and the decision cache clears.
- [ ] Organization creation and invitation acceptance are atomic (SQL rollback tests pass under `pnpm test:pg`).
- [ ] Organization deletion removes OIDC, SAML and SCIM connection rows in its transaction. A failing contribution rolls the delete back.
- [ ] `Auth.make([Organization, Scim])` type-checks. `Auth.make([Scim])` and a hand-built plugin requiring `OrganizationTeams` without `dependsOn` do not. `manifest.exposes` lists the eight organization keys, and `awthaq plugin list --graph` prints them.
- [ ] `OrganizationQadi.relationships` reads `OrganizationAuthority`. "relations agree with requirePermission for every membership" passes.
- [ ] `DecisionCacheInvalidationLive` taps `AfterMoveTeam`, `AfterUpdateTeamMemberRole`, `AfterSuspendOrganization` and `AfterReinstateOrganization`.
- [ ] Spec, ADR, traceability, BDD and READMEs are updated per §6. `pnpm spec:verify:strict` and `pnpm test:bdd` pass.
- [ ] Every phase has its changeset with a `Migration:` section.
- [ ] `pnpm check` and `pnpm test:pg` are green on the final commit. No `as`/`as unknown as`/`as any` was added (`as const` is allowed by `.oxlintrc.json`). No return-type annotation on a new Effect or Layer const.

---

## 10. Open questions (only the user can answer)

1. **Q1. SCIM Groups when `teams.enabled` is `false`** (the default). Today SCIM creates teams regardless. Options: (a) enforce: Groups answer `403` and the README says to enable teams (recommended; one invariant for everyone); (b) SCIM implies teams for its connection's organization; (c) hide `Group` from `/ResourceTypes` when teams are off.
2. **Q2. SCIM `DELETE` of the organization's last team** under the default `allowRemovingAllTeams: false`. Options: (a) enforce with `409` and document `allowRemovingAllTeams: true` for directory-driven deployments (recommended); (b) let a `Directory` actor bypass it, which makes the invariant actor-dependent.
3. **Q3. SCIM `POST /Groups` at `maximumTeams`** (and a PATCH beyond `maximumMembersPerTeam`): `403` with a SCIM error body (recommended, mirrors the membership-limit mapping at `Scim.ts:770-775`), or `409`/`400`? Should the directory get a separate quota?
4. **Q4. Ordering change D4.** Is it acceptable that a member without `member:delete` who targets the last owner now gets `403` rather than `409`?
5. **Q5. D7.** Should `AfterAddMember`/`AfterAddTeamMember` fire for memberships created by invitation acceptance and organization creation (recommended), or stay limited to their own operations?
6. **Q6. Suspension events.** Keep publishing `auth.admin.organizationSuspended`/`Unsuspended` from the Directory module (recommended; no audit-tag churn), or rename to `auth.organization.suspended`/`reinstated` with an actor? And may a non-admin actor (a billing job, `Application`) ever suspend? If yes, `suspend` takes `Actor` and the event's `adminUserId` must become optional.
7. **Q7. Where `Actor` lives.** In `@awthaq/organization` (this plan) or a core `Actor` shared with plans 01/03/09 (SCIM user provisioning, erasure, events)?
8. **Q8. OIDC connection events.** Add `auth.organization.connectionCreated/Updated/Deleted` with an actor (P5 step 2) now, or defer?
9. **Q9. qadi for the authorized layer.** The original design keeps `PermissionEngine` for the organization's own endpoints. Do you want a later plan that gates the authorized interface through qadi policies (`requiresPermission` / Path A), with `PermissionEngine` reduced to a resolver?
10. **Q10. Slice A timing.** Land P0-P2 (the SCIM fix) right after Wave A, ahead of plan 05 (recommended), or keep the strict wave order?
11. **Q11. RFC 7644 PATCH atomicity.** `applyRoster` makes the member part of one PATCH atomic, but a PATCH that renames *and* changes members is still two module calls. Is a fully atomic multi-operation PATCH required? Check the exact §3.5.2 wording before citing it in the spec. If it is required, `OrganizationTeams` needs a combined `applyGroupChange`.

---

## 11. Decisions taken (implementation, 2026-10-13)

Every open question took the recommended default (the one the plan or `.planning/README.md` names), recorded here and in the final report.

| Q | Decision |
|---|---|
| Q1 | Enforce: SCIM Groups answer `403` while `teams.enabled` is `false`; the SCIM README and the changeset say to enable teams. |
| Q2 | Enforce: deleting the last team is `409` under `allowRemovingAllTeams: false`; directory-driven deployments set it to `true`. The invariant is not actor-dependent. |
| Q3 | `403` with a SCIM error body for `maximumTeams` and `maximumMembersPerTeam`; no separate directory quota. |
| Q4 | Accepted: D4 (permission before the owner invariant), so a member without `member:delete` gets `403`, not `409`. |
| Q5 | Accepted: D7, `AfterAddMember` / `AfterAddTeamMember` fire for every membership created, invitation acceptance and organization creation included. |
| Q6 | Keep publishing `auth.admin.organizationSuspended` / `Unsuspended` from the Directory module; `suspend` / `reinstate` take a `PlatformAdminActor` only, so `adminUserId` stays required. |
| Q7 | `Actor` lives in `@awthaq/organization` (`OrganizationActor.ts`); phase 9 adds the structurally identical schema to core for event payloads and `OrganizationActor` re-exports it. Unifying it with `ErasureInitiator` (plan 03) is not done: no caller needs it. |
| Q8 | `auth.organization.connectionCreated/Updated/Deleted` with an actor are added with the OIDC connection store (phase 5). |
| Q9 | No: the authorized layer keeps `PermissionEngine`; no later qadi-gated plan is started here. |
| Q10 | Slice A (phases 0 to 2) landed first, as the first three commits, ahead of phase 3. |
| Q11 | `applyRoster` makes the member part of one PATCH atomic; a PATCH that renames and changes members stays two module calls. No `applyGroupChange`: no caller needs a combined operation. |

### Plan errors found while implementing

- **Phase 0, `OrganizationHandlers.ts` cannot import `Organization.ts`**: `pnpm circular` counts type-only cycles, and the plugin class imports its handlers. The authorized interface moved to a leaf, `OrganizationShape.ts`, and the handlers are a factory over the service tag (`OrganizationHandlers.make(Organization)`).
- **Phase 0, declaration emit**: after `organizationErasure` / `organizationExport` left `Organization.ts`, `Organization.layer`'s inferred type could not name `Erasure.ErasureRegistry` (TS2883) unless both namespaces stay imported there; `Organization.PersonalDataRegistries` is the type that keeps them in scope.
- **Phase 0, docs and template**: `docs/plugin-authoring.md` and `examples/plugin-template` already used `HookPoint.aborted` (plan 05 phase 13), so that step was a no-op.
- **Line numbers**: `Organization.ts` was 3,879 lines, not 3,766, at the start (plan 05 added witnesses and `StoreFailure`); every range in §2.1 was re-derived.
- **Next free BEH id** is 329 (plan 05 took 324 to 328), not "319+".
- **Phase 0, inference**: an inline `Layer.succeed(Tag, ...)` as the only `exposes.layer` infers `XOut` as `never`; bind it to a `const` (ADR-EA-040 records this).
