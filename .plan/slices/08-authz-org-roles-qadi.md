# Slice 08 — authz: organization, roles, qadi (`08-authz-org-roles-qadi`)

Validated at **`ec065a7`** on **2026-09-29** against the working tree (qadi-side findings checked against `../qadi` HEAD `dd4d247`, v0.8.0; awthaq installs `@qadi/*` 0.7.0). Manifest: `.plan/_manifests/08-authz-org-roles-qadi.tsv` — 72 issues.

## Counts (verdict × level)

| Verdict | high | medium | low | info | total |
|---|---|---|---|---|---|
| CONFIRMED | 7 | 29 | 10 | 2 | 48 |
| PARTIAL | 0 | 5 | 1 | 0 | 6 |
| ALREADY-FIXED | 2 | 2 | 0 | 0 | 4 |
| INVALID | 0 | 0 | 0 | 0 | 0 |
| DUPLICATE | 0 | 5 | 6 | 1 | 12 |
| WONTFIX-CANDIDATE | 0 | 1 | 0 | 1 | 2 |
| **total** | 9 | 42 | 17 | 4 | 72 |

**What is really wrong in this area.** The organization plugin is feature-complete but not yet trustworthy on its write and isolation paths: cascades run without transactions, `organization_membership`/`organization_team_membership` have no uniqueness, role assignment (`updateMemberRole`, `invite`) bypasses the `canGrant` guard that role *definition* enforces (with `admin` statement-identical to `owner`, this is an HTTP-reachable escalation), and non-members can tell existing tenants from missing ones (403 vs 404, an open `GET /organization/:id`, an unbound `getInvitation` whose id is also the emailed secret). Removing a member leaves their active-context pointer **and their team memberships** behind, so they keep answering `team-member` in qadi. The qadi contribution diverges from the plugin's own `PermissionEngine` (no depth-2 walk despite BEH-EA-162's MUST; custom/dynamic statements invisible; a dynamic role named `owner` can overwrite the built-in owner statements for its org). The `@awthaq/qadi` bridge is structurally sound but thin at the edges (a malformed `reauth` obligation silently passes; `ReauthRequired` is not wire-decodable; no decision sink; no cache invalidation; nothing in the repo actually enforces a permission). `@awthaq/roles` is now durable (YL-001 fixed by `1331cd5`) but silent: no catalog validation, no audit events. Several audit claims were overtaken by later commits: plugin migrations/indexes (`58ef46a`), typed veto aborts (`c648000`), Roles SQL persistence (`1331cd5`). Documentation across 16 shipped packages still claims nothing has shipped.

## Workstreams

### `org-role-escalation-guards` — Organization role-escalation guards

- **IDs:** RRM-001, RRM-002, OHS-005, RRM-007
- **Order hint:** 1 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Every role-assignment path (updateMemberRole, invite, addMember) skips the canGrant subset rule that createRole/updateRole enforce, and admin's default statements equal owner's — together an HTTP-reachable privilege escalation. One helper (requireGrantable) plus one statement change closes all of it.
- **Ordered steps:**
  1. RRM-001: add requireGrantable(orgId, granter, targetRoleNames) (unknown-name rejection + canGrant) and apply it in updateMemberRole after the veto hook; also forbid altering a more-privileged member.
  2. RRM-002: apply the same helper in invite.
  3. OHS-005: drop organization:delete from admin's default statements (better-auth parity), making owner strictly above admin.
  4. Add RolePermissionEscalation/UnknownOrgRole to the affected endpoint error arrays; document addMember as a trusted server-side primitive.
- **Test plan:** Organization.test.ts escalation cases (custom role self-promotion, inviter-as-owner, admin cannot delete org/promote to owner); AuthHttp.test.ts PATCH escalation → 403.
- **Acceptance:** No caller can assign, invite with, or promote to statements it does not hold; admin ⊂ owner.

### `org-write-atomicity-and-uniqueness` — Organization write atomicity and membership uniqueness

- **IDs:** OHS-002, MTI-003, OHS-003, OHS-006, MTI-004
- **Order hint:** 1 · **Effort:** L · **Depends on workstreams:** —
- **Why grouped:** All four open findings are the same integrity gap: multi-statement cascades with no transaction and membership tables with no uniqueness, so partial deletes, duplicate memberships and over-counted team capacity are all reachable. MTI-004 (no migrations) is already fixed and provides the migration list to append to.
- **Ordered steps:**
  1. OHS-002: require SqlTransaction in Organization.layer; wrap delete_/removeTeam cascades; make each multi-statement TeamRecords SQL op transactional; provide layerNoop/layerSql in every composition.
  2. MTI-003: append the membership dedupe + UNIQUE(userId, organizationId) migration; typed MembershipRecordAlreadyExists; AlreadyMember guard in addMember.
  3. OHS-006: invite and acceptInvitation refuse existing members (AlreadyMember).
  4. OHS-003: append the team-membership dedupe + memberCount recompute + UNIQUE(teamId, userId) migration; typed already-member errors on both team-add paths.
- **Test plan:** Rollback test for the delete cascade (sqlite composition with a failing final delete); duplicate-create tests on both records layers; Organization.test.ts AlreadyMember/AlreadyTeamMember cases; memberCount invariant test.
- **Acceptance:** Injected failures never leave partial cascades; the database rejects duplicate (user, org) and (team, user) rows; memberCount equals the row count.

### `org-active-context-lifecycle` — Active organization/team context lifecycle

- **IDs:** DRS-008, CWM-003, OHS-007, MTI-001
- **Order hint:** 2 · **Effort:** M · **Depends on workstreams:** org-write-atomicity-and-uniqueness
- **Why grouped:** organization_active_context is never cleared when the membership/team/org it points at disappears, cannot be found by user (no userId column, so erasure skipped it), and its setter accepts unvalidated ids. The same table/record changes fix all three.
- **Ordered steps:**
  1. DRS-008: add userId column + index; deleteAllByUser; extend beforeUserDeleteErasure; document sessionId keying.
  2. CWM-003 (+OHS-007): clearOrganization / clearOrganizationForUser / clearTeam; call them from removeMember, leave, delete_, removeTeam inside the OHS-002 transactions; remove the leaver's team memberships; re-validate on read.
  3. MTI-001: setOrganization/setTeam take a branded membership witness; add the TenantScoping architecture test.
- **Test plan:** ActiveContextRecords.test.ts (both layers) for new ops; Organization.test.ts for each removal path; OrganizationQadi.test.ts removed member no longer team-member; OrganizationErasure.test.ts sweep; TenantScoping.test.ts.
- **Acceptance:** GET /organization/active never names a removed org/team; user deletion leaves no active-context rows; an active-context write requires a membership record.

### `org-tenant-read-isolation` — Organization tenant read isolation (404 policy)

- **IDs:** MTI-009, MTI-008, MTI-010
- **Order hint:** 2 · **Effort:** L · **Depends on workstreams:** —
- **Why grouped:** Three read paths leak cross-tenant facts: non-member 403 vs 404 (existence oracle, contra BEH-EA-147), an unguarded GET /organization/:id, and an unbound getInvitation whose id is also the emailed secret.
- **Ordered steps:**
  1. MTI-009: non-member → OrganizationNotFound (404) in requireMembership/requirePermission; 403 only for members lacking a statement; update endpoint error arrays and tests.
  2. MTI-008: get takes the caller and requires membership.
  3. MTI-010: bind getInvitation to the invitee/org admins; add tokenHash column, email the random token, require token + email on accept/reject; add a by-token landing endpoint.
- **Test plan:** AuthHttp.test.ts: identical 404s for existing vs random ids for non-members; getInvitation stranger → 404; accept without token fails.
- **Acceptance:** A non-member cannot distinguish an existing org/invitation from a non-existent one; knowing an invitation id grants nothing.

### `qadi-bridge-hardening` — qadi bridge hardening

- **IDs:** TS-001-torin-sandall, TS-002-torin-sandall, EEM-005, AAPS-004, TS-003-torin-sandall, YL-004, YL-008, AAPS-008
- **Order hint:** 2 · **Effort:** L · **Depends on workstreams:** —
- **Why grouped:** The bridge is correct in shape but thin at its edges: a malformed reauth obligation fails open, the reauth error cannot cross the wire, resolver outages aren't typed by awthaq itself, attributes re-query per reference, no decision sink exists, nothing in the repo enforces a permission, middleware order is a trap, and the subject DTO hides resolver attributes.
- **Ordered steps:**
  1. TS-001: die on reauth duties without numeric maxAgeSeconds; strictest-wins.
  2. TS-002: catchDefect → AttributeResolveError in UserAttributes; wire REQ-EA-452/453.
  3. EEM-005: shared Schema ReauthRequired in @awthaq/api; unify PasskeyReauthRequired.
  4. YL-008: withAuthorizedSubject helpers + expectTypeOf test.
  5. AAPS-004: per-request UserRecordMemo provided by Path A/B.
  6. TS-003: DecisionSinkLog/DecisionSinkAudit + auth.authz.denied event; refresh stale header.
  7. AAPS-008: SubjectApiConfig.exposedAttributes.
  8. YL-004: example-server enforcement + auditAuthorizationAnnotations.
- **Test plan:** Resolvers.test.ts, new ReauthHttp.test.ts, AuthorizedSubject.test.ts (type test), DecisionLogging.test.ts, SubjectApi.test.ts, SubjectExtractor.test.ts, BDD REQ-EA-452/453.
- **Acceptance:** No obligation shape silently passes; reauth is decodable by clients; at least one shipped route is actually permission-guarded.

### `roles-catalog-validation` — Roles catalog validation

- **IDs:** RRM-004, RRM-003, YL-005, TS-008-torin-sandall, RRM-010
- **Order hint:** 2 · **Effort:** S · **Depends on workstreams:** —
- **Why grouped:** The roles plugin silently collapses duplicate catalog names, silently accepts/drops unknown assigned names, and silently runs with an empty catalog — all the same 'fail closed but invisibly' pattern qadi itself already fixed in resolveRoleGraph.
- **Ordered steps:**
  1. RRM-004: validate the catalog via resolveRoleGraph at layer build.
  2. RRM-003 (+YL-005, TS-008): UnknownRole on assign; resolve-time warning; listUnknownAssignments.
  3. RRM-010: empty-catalog warning at build.
- **Test plan:** Roles.test.ts/RolesSql.test.ts cases listed per issue, with a test logger for warnings.
- **Acceptance:** Every catalog/assignment mismatch is an error or a logged warning.

### `org-qadi-relationships` — Organization ↔ qadi relationship resolver

- **IDs:** RZS-001, OHS-009, RZS-005, RZS-006, RZS-004, RRC-003, PERS-005
- **Order hint:** 3 · **Effort:** L · **Depends on workstreams:** —
- **Why grouped:** The qadi contribution diverges from the plugin's own engine: no depth walk (MUST in BEH-EA-162), a closed vocabulary that answers malformed questions with Unrelated, relations that ignore custom/dynamic statements, a dynamic role able to shadow built-in statements, needless statement computation, no primary pinning, and no audit of plugin denials.
- **Ordered steps:**
  1. RZS-005: Unknown for unrecognised relations/resources; reserve built-in/static role names in createRole; harden statementsByRoleFrom.
  2. RZS-001: ResourceOrganizationLookup port (ticket 13) with layerNone; depth ≥ 1 walk; wire REQ-EA-454/455.
  3. RZS-006: relation grammar role:<name> and <resource>:<action> answered from effectivePermissionsOf; agreement test.
  4. RZS-004: member/role relations from the membership row only.
  5. PERS-005: auth.organization.permissionDenied event into AuditLog.
  6. RRC-003: once RRC-001's ReadRouting exists, pin decision reads to primary and state the bound in BEH-EA-162.
- **Test plan:** OrganizationQadi.test.ts (depth walk, Unknown, agreement with requirePermission, no OrgRoleRecords read for role relations); OrganizationQadiPolicy.test.ts real-policy parity; BDD REQ-EA-454/455.
- **Acceptance:** qadi policies and the plugin's own gating agree for every membership; depth-2 member works through the app's lookup; malformed questions are Unknown.

### `org-sql-count-queries` — Organization SQL count queries

- **IDs:** MTI-005, OHS-008, PPS-005
- **Order hint:** 3 · **Effort:** S · **Depends on workstreams:** org-write-atomicity-and-uniqueness
- **Why grouped:** Index coverage shipped with 58ef46a (PPS-005 closed, MTI-005 half-fixed); what remains is every SQL count materializing and decoding full rows on hot paths.
- **Ordered steps:**
  1. Convert MembershipRecords.countByOrganization/countOwners, TeamRecords.countTeamsByOrganization, InvitationRecords.countPendingByInviter to COUNT(*) (CAST to INTEGER; dialect-branched JSON test for owner).
- **Test plan:** Existing count tests on both layers + a mixed-role countOwners case.
- **Acceptance:** No layerSql count reads full rows.

### `roles-audit-and-admin` — Roles audit events and administration surface

- **IDs:** RRM-005, PCS-003, YL-009
- **Order hint:** 3 · **Effort:** M · **Depends on workstreams:** roles-catalog-validation
- **Why grouped:** Global role changes emit nothing to AuthEvents/AuditLog and have no operable surface; the events are a prerequisite for the opt-in admin plugin, which in turn records the actor.
- **Ordered steps:**
  1. RRM-005 (+PCS-003): auth.roles.assigned/revoked events on real state changes with actorId; Roles layers require AuthEvents.
  2. YL-009 (decision): opt-in RolesAdmin plugin with Path-B guarded endpoints.
- **Test plan:** Roles.test.ts/RolesSql.test.ts event assertions; RolesAdmin.test.ts 403/200 + actor recorded.
- **Acceptance:** Every global role change is durably audited with its actor.

### `authz-docs-truthfulness` — Authorization docs truthfulness

- **IDs:** DTWS-002, PERS-009, RRM-009, OHS-010, RRM-012, SAM-007, SAM-005, JH-009
- **Order hint:** 4 · **Effort:** L · **Depends on workstreams:** —
- **Why grouped:** Every package README and two spec banners claim nothing shipped; key contracts (relation vocabulary, claims-vs-authorization, RLS mapping, slot enforcement point, plugin authoring) live only in source comments.
- **Ordered steps:**
  1. DTWS-002: rewrite 16 banners, keep 4, add scripts/check-readme-status.mjs to pnpm check.
  2. RRM-009 / OHS-010: spec banners, quality metrics, roles/org README content (after org-qadi-relationships lands, for the vocabulary).
  3. RRM-012: BEH-EA-138 wording + feature text + roles SlotConflict test.
  4. SAM-007, SAM-005: jwt/qadi README notes; RLS→qadi appendix 04.
  5. JH-009: docs/plugin-authoring.md + tested examples/plugin-template.
- **Test plan:** check-readme-status script red→green; spec:verify:strict; template plugin test.
- **Acceptance:** No doc claims shipped code is unshipped; the listed contracts are documented outside source comments.

### `qadi-decision-cache-invalidation` — qadi DecisionCache invalidation bridge

- **IDs:** PCS-002, PCS-004
- **Order hint:** 4 · **Effort:** M · **Depends on workstreams:** org-qadi-relationships
- **Why grouped:** Ticket 12 decided per-request cache scope by default plus an opt-in invalidation bridge for app scope; PCS-002 is that bridge. PCS-004's TTL was rejected upstream (ADR-QD-031) and is mitigated by the same decision.
- **Ordered steps:**
  1. Make leave() run the remove-member hooks.
  2. Add packages/qadi/src/DecisionCacheInvalidation.ts tapping the organization observe points (incl. accept-invitation and role CRUD) → DecisionCache.clear; add the @awthaq/organization dependency; document coverage caveat and provide-once rule.
  3. Coordinate the appendix change (per-request default) with PCS-001/RZS-002 in the other slice.
- **Test plan:** packages/qadi/test/DecisionCacheInvalidation.test.ts: stale Allow without the bridge, Deny with it, for removeMember/leave/updateMemberRole.
- **Acceptance:** With the bridge provided, no org/role mutation leaves a cached Allow.

### `authz-model-boundaries` — Global roles vs organization authority (decision)

- **IDs:** MTI-007, RRM-006, YL-002
- **Order hint:** 5 · **Effort:** S · **Depends on workstreams:** org-qadi-relationships
- **Why grouped:** Three findings describe one seam: tenant-blind global Roles next to per-org PermissionEngine/relations, with no documented composition rule. It needs a product call before any code.
- **Ordered steps:**
  1. Take the decision (recommended: document the split + naming guard + ADR-EA-017).
  2. Implement docs/appendix example and the Roles.config name guard.
- **Test plan:** Roles.test.ts name-guard case (if adopted).
- **Acceptance:** Docs state which mechanism answers platform vs tenant authority.

### `org-config-and-tenancy` — Organization configuration defaults and tenancy fields

- **IDs:** EP-006, EP-010, EP-005, DRS-007, AR-004
- **Order hint:** 5 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Deployment-wide, fail-open defaults and missing tenant-level fields (per-org quotas, residency, branding in emails). The tenancy line itself was decided in ticket 18 (AR-004 → EP-001).
- **Ordered steps:**
  1. Decide defaults (EP-006, EP-010), then implement limitsFor + default flips.
  2. EP-005: org name/logo in invite email data; doc branding fields.
  3. DRS-007 (decision): optional, config-validated homeRegion column.
- **Test plan:** Organization.test.ts per-org limit override, verified-email default, invite mail data; OrganizationRecords.test.ts homeRegion round-trip.
- **Acceptance:** Operators can vary quotas per org; secure defaults documented.

### `org-team-hierarchy` — Team hierarchy and team-scoped roles

- **IDs:** OHS-001, RZS-003, OHS-004
- **Order hint:** 6 · **Effort:** XL · **Depends on workstreams:** org-write-atomicity-and-uniqueness
- **Why grouped:** Ticket 34 decided real nesting (parentId + closure table); team-scoped authority (OHS-004) was explicitly deferred to its own decision and builds on the closure table.
- **Ordered steps:**
  1. OHS-001: migrations (parentId, closure table, backfill), TeamRecords ops + cycle guard, Organization/HTTP surface, events/hooks, spec model update.
  2. OHS-004 (decision): team-membership role + team-scoped statements with subtree inheritance.
- **Test plan:** TeamRecords.test.ts closure/move/cycle on both layers; Organization/AuthHttp tests for new endpoints; team-lead scoping tests.
- **Acceptance:** Nested teams with single-query ancestor/descendant reads and no possible cycles.

### `session-assurance-channel` — Session assurance / trust channel into the subject

- **IDs:** AAPS-006, SOS-005, AAPS-009
- **Order hint:** 6 · **Effort:** L · **Depends on workstreams:** —
- **Why grouped:** authenticatedAt shipped (AAPS-001), but there is still no way for how-you-authenticated (amr/aal/MFA) to reach qadi, and ADR-EA-012's SessionViewExtension slot is undeclared; this must precede the TwoFactor/SMS plugins.
- **Ordered steps:**
  1. AAPS-006: amr on sessions + migration; SessionViewExtension slot; principal carries authenticatedAt/amr; subject attribute mapping.
  2. SOS-005: assuranceLevel(amr) pure function + aal attribute + policy recipes.
  3. AAPS-009: no work now; carry scopes requirement into the api-key design.
- **Test plan:** Sessions.test.ts amr/aal; SubjectResolver.test.ts and Roles.test.ts attribute mapping.
- **Acceptance:** Policies can require MFA/aal without per-check derivation.

### `qadi-upstream` — Upstream fixes in ../qadi

- **IDs:** PERS-002, PERS-006, PERS-007
- **Order hint:** 7 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Findings against node_modules/@qadi/core are real at ../qadi HEAD (0.8.0) and belong to the user's qadi repo; awthaq consumes them via a version bump (currently ^0.7.0).
- **Ordered steps:**
  1. PERS-002: action + context input for custom predicates; EvaluateOptions.context.
  2. PERS-006: read-only/idempotent contract + attempt number.
  3. PERS-007: danglingCustomPredicates validator + checked registry layer.
  4. Release qadi, bump @qadi/* in awthaq.
- **Test plan:** ../qadi packages/core tests per issue; awthaq `pnpm check` after the bump.
- **Acceptance:** Custom predicates get complete inputs and are validated at composition time.

### `user-claims-store` — Per-user custom claims store (decision)

- **IDs:** FAMS-004
- **Order hint:** 7 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Role claims now have a durable home (BAM-006); arbitrary custom claims still do not.
- **Ordered steps:**
  1. Decide; if adopted, ship UserClaims (memory/sql) + claims AttributeResolver via the registry + event + docs.
- **Test plan:** UserClaims.test.ts both layers + a policy on claims.plan.
- **Acceptance:** Migrated custom claims are policy-readable.

## Decisions needed

### EP-006 — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded

1. Keep better-auth-parity defaults (create allowed, unlimited orgs per user) and only add per-org overrides.
2. Finite default organizationLimit (e.g. 10), create still allowed by default, plus per-org overrides.
3. Fail-closed: allowUserToCreateOrganization defaults to false and a finite organizationLimit.

**Recommendation:** Option 2: self-serve org creation is the plugin's primary use case, but an unbounded per-user tenant count is a denial-of-service default; ship limitsFor regardless (richer, low cost).

### EP-010 — Invitations accepted from unverified emails by default

1. Keep false (better-auth parity).
2. Flip to true (fail-closed), opt-out via config.

**Recommendation:** Flip to true: membership confers tenant data access, and the flag already exists — this is a one-line secure default.

### DRS-007 — Organization record has no region/homeRegion attribute — orgs cannot be pinned to a residency zone

1. Defer until a residency ADR exists.
2. Ship an optional, config-validated homeRegion column now (no routing logic in the library).

**Recommendation:** Ship the optional column now — it is cheap, additive, and gives ticket 18's tenant model its residency key; routing stays application-side.

### OHS-004 — Team membership carries no role; no per-team permission override exists

1. No team roles (org-level statements govern all teams; document).
2. Team-membership role + team-scoped statements, org statements as inherited default, team role as additive refinement (down the subtree once OHS-001 lands).
3. Model team authority purely as qadi relations (team-admin) and leave the plugin's own gating org-level.

**Recommendation:** Option 2 — it is the 'team lead' capability both OHS-004 and ticket 34 point at, reuses PermissionEngine/canGrant, and composes with the closure table; option 3 would re-create RZS-006's split-brain.

### FAMS-004 — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent

1. Document-only: roles → Roles.layerSql; other claims → application-owned AttributeResolver.
2. Ship an opt-in UserClaims store + resolver in @awthaq/qadi (or core).

**Recommendation:** Ship the opt-in store (flexibility wins, it is additive and the registry from AAPS-002 keeps it conflict-checked); place it in @awthaq/core only if JWT claim minting must share it.

### MTI-007 — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models

1. A: Document the split (global Roles = platform authority; org authority only via Organization relations), naming guard, ADR — no new mechanism.
2. B: Add optional organization scope to Roles.assign and surface scoped roles as a Roles-contributed RelationshipResolver (role:<name> on the org resource) — duplicates organization roles.
3. C: Upstream in ../qadi: give AttributeResolver.resolve an optional resourceId (scoped attributes) so tenant facts become one mechanism — breaking qadi API change (YL-002's option).

**Recommendation:** A now (cheap, removes the confusion the three findings describe); organization roles already provide per-tenant roles, so B is duplicate infrastructure. Revisit C in ../qadi only if a second plugin needs resource-scoped attributes.

### YL-009 — Roles plugin exposes no management API surface for administration

1. Keep Roles library-only (roadmap M3 deferral; apps write their own endpoints).
2. Opt-in RolesAdmin plugin in @awthaq/roles, Path-B guarded.
3. Put setRole in @awthaq/admin (ticket 19 rejected this placement).

**Recommendation:** Option 2 — the durable store now exists (BAM-006), it respects ticket 19's placement ruling, and it gives the repo its first real RequirePermission consumer (YL-004).

## Per-issue dossiers

### Workstream `org-role-escalation-guards`

#### RRM-001 — Role-assignment paths bypass the canGrant escalation guard

`high` · `security` · `organization` · [.issues/high/RRM-001-rbac-role-modeling-specialist.md](../../.issues/high/RRM-001-rbac-role-modeling-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1598` — Assignment gated only by member:update; arbitrary role array written.

```
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "member", "update");
          const vetoed = yield* veto(
            "organization.member.updateRole.before",
            beforeUpdateRole.run({ organizationId, userId: targetUserId, role }),
          );
          const updated = yield* members
            .updateRole(targetUserId, organizationId, vetoed.role)
```

- `packages/organization/src/Organization.ts:2003` — createRole (and updateRole at 2075-2077) already enforce the subset rule.

```
          const granterPermissions = yield* effectivePermissionsOf(organizationId, membership);
          if (!PermissionEngine.canGrant(input.permission, granterPermissions)) {
            return yield* Effect.fail(new OrganizationApi.RolePermissionEscalation());
```

- `packages/organization/src/OrganizationApi.ts:210` — Any string accepted, including role names that exist nowhere.

```
export const UpdateMemberRolePayload = Schema.Struct({ role: Schema.Array(Schema.String) });
```

- `packages/organization/src/Organization.ts:1669` — addMember: no caller, no gate (Shape-only, not HTTP-reachable).

```
        const membership = yield* members.create({ userId, organizationId, role: vetoed.role });
```

**Fix plan:** Apply PermissionEngine.canGrant to every role-assignment path, reject unknown role names, and forbid modifying a member who out-privileges the caller.

Steps:
1. Organization.ts: add a private helper `requireGrantable(organizationId, granter: MembershipRecord, targetRoleNames)` = `statementsByRole(orgId)` → reject any name absent from the map with new `OrganizationApi.UnknownOrgRole` (422) → `canGrant(effectivePermissions(targetRoleNames, byRole), effectivePermissions(granter.role, byRole))` else fail RolePermissionEscalation.
2. updateMemberRole: keep the MembershipRecord returned by requirePermission(member, update); run requireGrantable on `vetoed.role` (after the veto hook, since a tap may rewrite the role) AND require canGrant(effective(target.role), granter) so a lower tier cannot demote/alter a higher one.
3. OrganizationApi.updateMemberRole endpoint: add RolePermissionEscalation and UnknownOrgRole to `error:`.
4. addMember: document in OrganizationShape as a trusted server-side primitive (no caller, bypasses PermissionEngine by design, e.g. for SCIM/import) and still reject unknown role names via the same lookup.
5. Reuse the helper from RRM-002 (invite).

Files: `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'a custom static role holding member:update cannot promote itself to owner (RolePermissionEscalation)'; 'updateMemberRole with an undefined role name fails UnknownOrgRole'; 'an admin cannot change an owner's role' (after OHS-005).
- packages/organization/test/AuthHttp.test.ts: PATCH /organization/:id/members/:userId escalation answers 403 RolePermissionEscalation.

Acceptance:
- No HTTP-reachable path lets a caller assign statements it does not itself hold.
- Only role names known to the org (built-in, static custom, dynamic) can be stored on a membership.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### OHS-005 — Admin role is permission-identical to owner, defanging the last-owner invariant

`medium` · `correctness` · `organization` · [.issues/medium/OHS-005-organization-hierarchy-specialist.md](../../.issues/medium/OHS-005-organization-hierarchy-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for RRM-007

**Evidence at HEAD:**

- `packages/organization/src/PermissionEngine.ts:25` — Owner statements…

```
  owner: {
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    role: ["create", "read", "update", "delete"],
  },
```

- `packages/organization/src/PermissionEngine.ts:32` — …identical for admin.

```
  admin: {
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    role: ["create", "read", "update", "delete"],
  },
```

- `packages/organization/src/Organization.ts:1532` — The last-owner invariant counts role names, not capability.

```
      const wouldViolateOwnerInvariant = (
        organizationId: string,
        targetHeldOwner: boolean,
        nextHeldOwner: boolean,
      ) =>
```

**Fix plan:** Make owner strictly above admin (better-auth parity: only owner may delete the organization), which also makes RRM-001's canGrant stop admins from minting owners.

Steps:
1. PermissionEngine.defaultStatements.admin.organization: `["update"]` (drop "delete"); keep member/invitation/team/role CRUD (role CRUD is already bounded by canGrant).
2. Document the tiers in the PermissionEngine.ts header and the organization README (OHS-010).
3. With RRM-001 landed, an admin can no longer grant/assign `owner` (lacks organization:delete), so the owner invariant becomes load-bearing.
4. The invite half of this finding is RRM-002.

Files: `packages/organization/src/PermissionEngine.ts`, `packages/organization/test/PermissionEngine.test.ts`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/PermissionEngine.test.ts: 'admin lacks organization:delete; owner holds it'.
- packages/organization/test/Organization.test.ts: 'an admin cannot delete the organization (OrganizationPermissionDenied)'; 'an admin cannot promote a member to owner'.

Acceptance:
- defaultStatements.admin is a strict subset of defaultStatements.owner.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: RRM-001

**Recommended status:** `ready-for-agent`

#### RRM-002 — Invitations mint any role with only invitation:create

`medium` · `security` · `organization` · [.issues/medium/RRM-002-rbac-role-modeling-specialist.md](../../.issues/medium/RRM-002-rbac-role-modeling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1740` — Only gate on invite.

```
          yield* requirePermission(callerId, organizationId, "invitation", "create");
```

- `packages/organization/src/Organization.ts:1804` — Requested role persisted verbatim, then used by members.create on accept (1885-1889).

```
          const record = yield* invitations.create({
            email: vetoed.email,
            inviterId: callerId,
            organizationId,
            teamId: input.teamId,
            role: vetoed.role,
            expiresAt,
          });
```

**Fix plan:** Run the same requireGrantable check (RRM-001) on the invitation's requested role before persisting it.

Steps:
1. Organization.invite: capture the MembershipRecord from requirePermission(invitation, create); after the veto hook, `requireGrantable(organizationId, inviter, vetoed.role)`.
2. OrganizationApi invite endpoint: add RolePermissionEscalation and UnknownOrgRole to `error:`.
3. acceptInvitation: re-validate that every role name still exists (a dynamic role may have been deleted since) — unknown names are dropped with a logWarning rather than stored.

Files: `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'an inviter holding invitation:create but not owner statements cannot invite someone as owner'; 'an admin can invite a member'.

Acceptance:
- An invitation can only confer statements the inviter holds.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: RRM-001

**Recommended status:** `ready-for-agent`

#### RRM-007 — Default admin tier is permission-identical to owner

`low` · `security` · `organization` · [.issues/low/RRM-007-rbac-role-modeling-specialist.md](../../.issues/low/RRM-007-rbac-role-modeling-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **OHS-005**

**Evidence at HEAD:**

- `packages/organization/src/PermissionEngine.ts:32` — Same admin==owner statement set OHS-005 reports.

```
  admin: {
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
```

**Fix plan:** No separate fix — closed by OHS-005's plan.

**Recommended status:** `resolved`

### Workstream `org-write-atomicity-and-uniqueness`

#### MTI-004 — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns

`high` · `architecture` · `organization` · [.issues/high/MTI-004-multi-tenant-isolation-specialist.md](../../.issues/high/MTI-004-multi-tenant-isolation-specialist.md) · current status `ready-for-agent`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `58ef46a`

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1236` — Plugin now declares its migrations (58ef46a, BAM-002).

```
    migrations: organizationMigrations,
```

- `packages/organization/src/Organization.ts:965` — All seven organization_* tables, dialect-branched, plus organizationId/userId/teamId/email/inviterId indexes.

```
const organizationMigrations: Migrations.Migrations = [
```

- `packages/organization/test/MembershipRecords.test.ts:23` — Tests now build schema from the real migrations, not inline DDL.

```
const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
```

**Note:** Residual UNIQUE-constraint gap is owned by MTI-003 (membership) and OHS-003 (team membership); core tenant columns by DRS-001/EP-001 (ticket 18).

**Fix plan:** No fix — already fixed at HEAD (see evidence).

**Recommended status:** `resolved`

#### OHS-002 — Organization deletion cascade runs five repository calls with no transaction

`high` · `correctness` · `organization` · [.issues/high/OHS-002-organization-hierarchy-specialist.md](../../.issues/high/OHS-002-organization-hierarchy-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1506` — delete_ cascade: five sequential repository calls, no transaction boundary.

```
          yield* veto("organization.delete.before", beforeDelete.run({ organizationId }));
          yield* members.removeAllForOrganization(organizationId);
          yield* invitations.removeAllForOrganization(organizationId);
          yield* teams.removeAllTeamsForOrganization(organizationId);
          yield* orgRoles.removeAllForOrganization(organizationId);
          yield* orgs
            .delete(organizationId)
```

- `packages/organization/src/TeamRecords.ts:495` — Two separate statements; the same shape in removeAllTeamsForOrganization (505-514) and addTeamMember insert + adjustMemberCount (516-527).

```
    const removeTeam: TeamRecordsShape["removeTeam"] = Effect.fnUntraced(
      function* (organizationId, id) {
        const row = yield* deleteTeamQuery({ organizationId, id }).pipe(Effect.orDie);
        if (Option.isNone(row)) return yield* Effect.fail(teamNotFound(id));
        yield* sql`DELETE FROM organization_team_membership WHERE teamId = ${id}`.pipe(
          Effect.orDie,
        );
```

- `packages/ports/src/SqlTransaction.ts:32` — The port Password/OAuth/Account already use for exactly this; `grep withTransaction|SqlTransaction packages/organization/src` = 0 hits.

```
export class SqlTransaction extends Context.Service<SqlTransaction, SqlTransactionShape>()(
  "awthaq/ports/SqlTransaction",
) {}
```

**Fix plan:** Make the organization-delete and team-delete cascades (and each multi-statement TeamRecords SQL op) commit or roll back as one unit via the existing SqlTransaction port.

Steps:
1. Organization.layer make: `const sqlTransaction = yield* SqlTransaction.SqlTransaction` (from @awthaq/ports, already a dependency).
2. delete_: keep requireOrganization/requirePermission/veto outside; wrap members.removeAllForOrganization + invitations.removeAllForOrganization + teams.removeAllTeamsForOrganization + orgRoles.removeAllForOrganization + activeContext.clearOrganization (CWM-003 workstream) + orgs.delete in `sqlTransaction.withTransaction(...)`, then `Effect.catchTag("SqlError", Effect.die)` exactly like packages/core/src/Accounts.ts:569; publish auth.organization.deleted and afterDelete.run only after commit.
3. removeTeam (Organization.ts ~2211): wrap teams.removeTeam + activeContext.clearTeam in the same way.
4. TeamRecords.layerSql: wrap removeTeam's two DELETEs, removeAllTeamsForOrganization's two DELETEs, addTeamMember (insert + adjustMemberCount) and removeTeamMember (delete + adjustMemberCount) each in `sql.withTransaction` so a records op is atomic even when called directly (nested withTransaction becomes a savepoint).
5. Provide SqlTransaction in every composition that builds Organization.layer: packages/test/src/TestAuth.ts MemoryPorts (layerNoop), organization tests, features/step-definitions worlds that build Organization, examples/memory-server.
6. Hooks stay outside the transaction boundary (the finding's own recommendation).

Files: `packages/organization/src/Organization.ts`, `packages/organization/src/TeamRecords.ts`, `packages/test/src/TestAuth.ts`, `packages/organization/test/Organization.test.ts`, `packages/organization/test/TeamRecords.test.ts`, `examples/memory-server/index.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts (SQL/sqlite composition): 'delete rolls back the whole cascade when the final organization delete fails' — wrap OrganizationRecords.layerSql so `delete` dies, assert memberships, invitations, teams and roles are all still present.
- packages/organization/test/TeamRecords.test.ts (layerSql): 'removeTeam deletes the team and its memberships atomically' — force the membership DELETE to fail and assert the team row survives.

Acceptance:
- An injected failure anywhere in the delete_ cascade leaves every organization_* row untouched.
- `grep -n SqlTransaction packages/organization/src/Organization.ts` is non-empty; no records op in TeamRecords.layerSql issues two statements outside `sql.withTransaction`.
- pnpm run test and pnpm run test:bdd green.

Spec refs: BEH-EA-035 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### OHS-003 — Duplicate team membership corrupts the durable memberCount and capacity caps

`high` · `correctness` · `organization` · [.issues/high/OHS-003-organization-hierarchy-specialist.md](../../.issues/high/OHS-003-organization-hierarchy-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/TeamRecords.ts:223` — Memory layer overwrites the key and then unconditionally does `memberCount: team.value.memberCount + 1` (233).

```
      yield* Ref.update(state, (s) => {
        const memberships = HashMap.set(
          s.memberships,
          membershipKeyOf(input.teamId, input.userId),
          record,
        );
        const team = HashMap.get(s.teams, input.teamId);
```

- `packages/organization/src/TeamRecords.ts:516` — SQL layer: fresh uuidv7 id per insert, then adjustMemberCount(+1) at 525.

```
    const addTeamMember: TeamRecordsShape["addTeamMember"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const row = yield* insertTeamMembership({
```

- `packages/organization/src/Organization.ts:1145` — The shipped migration (58ef46a) ported the test DDL verbatim — still no UNIQUE(teamId, userId).

```
          CREATE TABLE organization_team_membership (
            id TEXT PRIMARY KEY,
            teamId TEXT NOT NULL,
            userId TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL
          )
```

- `packages/organization/src/Organization.ts:2263` — No findTeamMembership guard; the invitation-accept path (1903-1905) is identical.

```
          yield* veto(
            "organization.team.member.add.before",
            beforeAddTeamMember.run({ organizationId, teamId, userId: targetUserId }),
          );
          const record = yield* teams.addTeamMember({ teamId, userId: targetUserId });
```

**Fix plan:** Back the one-membership-per-(team,user) invariant with a UNIQUE index plus typed already-member errors on both team-add paths, so memberCount can no longer over-count.

Steps:
1. Append migration `organization_team_membership_unique` to organizationMigrations (never edit shipped ones): (a) delete duplicate rows keeping MIN(id) per (teamId, userId) — uuidv7 ids sort by creation time; (b) recompute `organization_team.memberCount` from COUNT(*) of organization_team_membership; (c) `CREATE UNIQUE INDEX organization_team_membership_team_user ON organization_team_membership(teamId, userId)` (dialect-branched via sql.onDialectOrElse like the existing entries).
2. TeamRecords: add `TeamMembershipRecordAlreadyExists` (Data.TaggedError {teamId, userId}); addTeamMember's error channel gains it. layerMemory: fail if `HashMap.has(s.memberships, key)` before touching memberCount. layerSql: inside the withTransaction from OHS-002, map SqlError whose `reason._tag === "UniqueViolation"` (pattern at OrgRoleRecords.ts:275) to the typed error before adjustMemberCount runs.
3. OrganizationApi: new `AlreadyTeamMember` Schema.TaggedError (409); add to the addTeamMember endpoint's error array.
4. Organization.addTeamMember: pre-check `teams.findTeamMembership(teamId, targetUserId)` → fail AlreadyTeamMember; also catchTag the records error (race).
5. Organization.acceptInvitation team branch: skip teams.addTeamMember (and its teamMemberAdded event) when the caller is already a member of that team — accepting must stay idempotent for the team part.

Files: `packages/organization/src/TeamRecords.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/test/TeamRecords.test.ts`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/TeamRecords.test.ts (both layers): 'adding the same user to a team twice fails TeamMembershipRecordAlreadyExists and memberCount stays 1'.
- packages/organization/test/Organization.test.ts: 'addTeamMember for an existing team member fails AlreadyTeamMember'; 'accepting a team invitation while already on the team does not double-count memberCount'.

Acceptance:
- memberCount always equals the number of organization_team_membership rows for the team after any sequence of adds/removes.
- The SQL schema rejects a second (teamId, userId) row.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **M** · Depends on: OHS-002

**Recommended status:** `ready-for-agent`

#### MTI-003 — addMember can mint duplicate membership rows, corrupting the row every isolation check consults

`medium` · `correctness` · `organization` · [.issues/medium/MTI-003-multi-tenant-isolation-specialist.md](../../.issues/medium/MTI-003-multi-tenant-isolation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1660` — addMember: no findByUserAndOrg before members.create (1669).

```
        yield* requireOrganization(organizationId);
        const count = yield* members.countByOrganization(organizationId);
        if (count >= orgConfig.membershipLimit) {
          return yield* Effect.fail(new OrganizationApi.MembershipLimitReached());
        }
        const vetoed = yield* veto(
          "organization.member.add.before",
          beforeAdd.run({ organizationId, userId, role }),
```

- `packages/organization/src/MembershipRecords.ts:311` — Bare INSERT, UniqueViolation not mapped (no constraint to violate anyway).

```
      const row = yield* insert({
        id,
        userId: input.userId,
        organizationId: input.organizationId,
        role: JSON.stringify(input.role),
        createdAt: now,
      }).pipe(Effect.orDie);
```

- `packages/organization/src/Organization.ts:999` — Shipped migration (58ef46a) has no UNIQUE(userId, organizationId); its own doc comment (950-954) says new constraints were deliberately left for a later audit.

```
          CREATE TABLE organization_membership (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            organizationId TEXT NOT NULL,
            role TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL
          )
```

**Fix plan:** Add UNIQUE(userId, organizationId) to organization_membership, a typed already-member error at the records layer, and an early duplicate check in addMember.

Steps:
1. Append migration `organization_membership_unique_user_org`: dedupe (keep MIN(id) per (userId, organizationId)), then `CREATE UNIQUE INDEX organization_membership_user_org ON organization_membership(userId, organizationId)` (also becomes the composite index MTI-005 asks for).
2. MembershipRecords: add `MembershipRecordAlreadyExists` (Data.TaggedError {userId, organizationId}); `create` error channel gains it. layerMemory fails if the `${org}:${user}` key exists (instead of HashMap.set overwrite at 125); layerSql maps SqlError UniqueViolation to it (pattern: OrganizationRecords.ts:249).
3. OrganizationApi: new `AlreadyMember` Schema.TaggedError (409).
4. Organization.addMember: `members.findByUserAndOrg(userId, organizationId)` → Some ⇒ fail AlreadyMember; catchTag MembershipRecordAlreadyExists → AlreadyMember for the race. Organization.create's own members.create can keep orDie (a brand-new org cannot collide).
5. Every other members.create caller (acceptInvitation) handled by OHS-006.

Files: `packages/organization/src/MembershipRecords.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/test/MembershipRecords.test.ts`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/MembershipRecords.test.ts (both layers): 'create for an existing (userId, organizationId) fails MembershipRecordAlreadyExists and leaves the original role untouched'.
- packages/organization/test/Organization.test.ts: 'addMember for an existing member fails AlreadyMember'.

Acceptance:
- findByUserAndOrg can never observe two rows; addMember is idempotent-safe under concurrency (DB-enforced).
- Existing duplicate rows (if any) are collapsed by the migration.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### OHS-006 — Re-inviting an existing member and accepting creates duplicate/overwritten org membership

`medium` · `correctness` · `organization` · [.issues/medium/OHS-006-organization-hierarchy-specialist.md](../../.issues/medium/OHS-006-organization-hierarchy-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1772` — An existing member with no pending invitation falls through to invitations.create (1804).

```
          if (Option.isSome(alreadyMember) && Option.isSome(existing)) {
            yield* invitations.updateStatus(existing.value.id, "canceled").pipe(Effect.orDie);
          }
```

- `packages/organization/src/Organization.ts:1885` — acceptInvitation: no already-member guard.

```
          const membership = yield* members.create({
            userId: callerId,
            organizationId: record.organizationId,
            role: record.role,
          });
```

- `packages/organization/src/MembershipRecords.ts:125` — Memory layer silently replaces the member's roles with the invitation's role.

```
      yield* Ref.update(state, (s) =>
        HashMap.set(s, keyOf(input.userId, input.organizationId), record),
      );
```

**Fix plan:** Refuse to invite or admit someone who is already a member, so an invitation can never overwrite or duplicate a membership.

Steps:
1. Organization.invite: when `alreadyMember` is Some, cancel any pending invitation (existing behaviour) and then fail `OrganizationApi.AlreadyMember` (409, from MTI-003) instead of creating a new invitation; add AlreadyMember to the invite endpoint's error array.
2. Organization.acceptInvitation: after the email/verification checks, `members.findByUserAndOrg(callerId, record.organizationId)` → Some ⇒ mark the invitation `canceled`, fail AlreadyMember; never call members.create. Also catchTag MembershipRecordAlreadyExists (race with addMember).
3. Role changes for existing members stay exclusively on updateMemberRole (which RRM-001 guards with canGrant).

Files: `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'inviting an existing member fails AlreadyMember and creates no invitation'; 'accepting an invitation while already a member fails AlreadyMember and leaves the member's roles unchanged'.

Acceptance:
- No code path other than updateMemberRole changes an existing membership's role.
- Accepting a stale invitation never produces a second membership row.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: MTI-003

**Recommended status:** `ready-for-agent`

### Workstream `org-active-context-lifecycle`

#### CWM-003 — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session

`medium` · `correctness` · `organization` · [.issues/medium/CWM-003-clerk-workos-migration-specialist.md](../../.issues/medium/CWM-003-clerk-workos-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for OHS-007

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1564` — removeMember (and leave at 1640) never touches activeContext — nor the removed member's team memberships.

```
          yield* members
            .remove(targetUserId, organizationId)
            .pipe(
              Effect.catchTag("MembershipRecordNotFound", () =>
                Effect.die(new Error("awthaq: membership vanished between check and write")),
              ),
            );
```

- `packages/organization/src/Organization.ts:1721` — GET /organization/active returns the raw, possibly stale row.

```
      const getActive: OrganizationShape["getActive"] = Effect.fnUntraced(function* (caller) {
        const existing = yield* activeContext.findBySessionId(caller.sessionId);
        if (Option.isSome(existing)) return existing.value;
```

- `packages/organization/src/OrganizationQadi.ts:107` — Side-finding: team rows survive org removal, so a removed member still answers Related for team-member in qadi.

```
            case "team-member": {
              const membership = yield* teams.findTeamMembership(resourceId, userId);
              return Option.isSome(membership) ? ("Related" as const) : ("Unrelated" as const);
```

**Fix plan:** Clear active-context pointers (and team memberships) whenever the membership/team/org they point at goes away, and re-validate on read.

Steps:
1. ActiveContextRecordsShape (both layers): add `clearOrganization(organizationId)` (null activeOrganizationId + activeTeamId where activeOrganizationId matches), `clearOrganizationForUser(userId, organizationId)`, `clearTeam(teamId)` (null activeTeamId where it matches). Needs the userId column from DRS-008.
2. Organization.removeMember / leave: inside the same SqlTransaction as members.remove, call activeContext.clearOrganizationForUser and a new `teams.removeUserFromOrganizationTeams(organizationId, userId)` (deletes the user's organization_team_membership rows for that org's teams and decrements each memberCount), publishing auth.organization.teamMemberRemoved per row.
3. Organization.delete_: add activeContext.clearOrganization(organizationId) to the OHS-002 transactional cascade; removeTeam: add activeContext.clearTeam(teamId) (closes OHS-007).
4. getActive / getActiveMember: if the stored activeOrganizationId no longer resolves to a membership, return the cleared view (and lazily clear the row) instead of MembershipNotFound/stale data.
5. Document the Clerk-equivalent semantics in the ActiveContextRecords.ts header (replace the 'orphaned row is harmless' paragraph).

Files: `packages/organization/src/ActiveContextRecords.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/TeamRecords.ts`, `packages/organization/test/Organization.test.ts`, `packages/organization/test/ActiveContextRecords.test.ts`, `packages/organization/test/OrganizationQadi.test.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'removeMember clears the removed user's active organization and team'; 'leave clears the caller's active organization'; 'delete clears every session's active organization'; 'removeTeam clears activeTeamId'.
- packages/organization/test/OrganizationQadi.test.ts: 'a removed member is no longer team-member of that org's teams'.
- packages/organization/test/ActiveContextRecords.test.ts (both layers): the three clear* operations.

Acceptance:
- After removeMember/leave/delete/removeTeam, GET /organization/active never names the removed org/team.
- OrganizationQadi.relationships answers Unrelated for team-member after the user leaves the org.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **M** · Depends on: DRS-008, OHS-002

**Recommended status:** `ready-for-agent`

#### MTI-001 — Tenant scoping is call-site discipline: the records layer is structurally unguarded

`medium` · `architecture` · `organization` · [.issues/medium/MTI-001-multi-tenant-isolation-specialist.md](../../.issues/medium/MTI-001-multi-tenant-isolation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence medium)

**Evidence at HEAD:**

- `packages/organization/src/ActiveContextRecords.ts:37` — Records layer accepts any org id; no error channel.

```
  readonly setOrganization: (
    sessionId: string,
    organizationId: string | null,
  ) => Effect.Effect<ActiveContextRecord>;
```

- `packages/organization/src/Organization.ts:1709` — The only membership guard lives in Organization.setActive.

```
          if (organizationId !== null) {
            const membership = yield* members.findByUserAndOrg(
              Users.UserId(caller.ref.id),
              organizationId,
            );
            if (Option.isNone(membership))
              return yield* Effect.fail(new OrganizationApi.MembershipNotFound());
          }
```

- `packages/organization/src/index.ts:10` — Records services are public exports, so the unguarded setter is reachable by any composing code.

```
export * as ActiveContextRecords from "./ActiveContextRecords.ts";
```

**Fix plan:** Make an unvalidated active-context write unrepresentable at the type level, and pin tenant-predicate discipline in SQL with an architecture test (RLS for plugin tables follows ticket 18).

Steps:
1. ActiveContextRecords.setOrganization(sessionId, membership: MembershipRecords.MembershipRecord | null) and setTeam(sessionId, membership: TeamRecords.TeamMembershipRecord | null): derive organizationId/teamId/userId from the witness instead of taking raw ids.
2. Make the witnesses unforgeable without `as`: give MembershipRecord/TeamMembershipRecord a module-private brand (a non-exported `unique symbol` property set only inside the records modules' toRecord/constructors), so the only way to obtain one is a records lookup.
3. Update Organization.setActive/setActiveTeam to pass the looked-up record (they already have it).
4. Add packages/organization/test/TenantScoping.test.ts: read every `sql` template in src/*Records.ts, and for each statement touching an organization_* table assert it filters by organizationId/teamId/sessionId/id or is on an explicit, commented allowlist (listByUser, listByEmail, findById for invitations, erasure sweeps). A new unscoped query then fails CI.
5. Follow-up (not this issue): extend ticket 18's Postgres RLS design to organization_* tables once EP-001 lands.

Files: `packages/organization/src/ActiveContextRecords.ts`, `packages/organization/src/MembershipRecords.ts`, `packages/organization/src/TeamRecords.ts`, `packages/organization/src/Organization.ts`, `packages/organization/test/TenantScoping.test.ts`

Tests (write first):
- packages/organization/test/TenantScoping.test.ts (new, described above).
- Type-level: a `// @ts-expect-error` case in packages/organization/test/ActiveContextRecords.test.ts proving setOrganization rejects a hand-built object literal.

Acceptance:
- ActiveContextRecords cannot be pointed at an organization without a membership record in hand.
- The architecture test fails if an org-table query without a tenant predicate is added.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **M** · Depends on: DRS-008

**Recommended status:** `ready-for-agent`

#### DRS-008 — organization_active_context is keyed by sessionId, coupling core sessions to plugin tables across any future shard boundary

`low` · `architecture` · `organization` · [.issues/low/DRS-008-data-residency-sharding-specialist.md](../../.issues/low/DRS-008-data-residency-sharding-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/ActiveContextRecords.ts:3`

```
// spec.md's "Active organization/team state": persistence for
// `organization_active_context`, a plugin-owned table keyed by `sessionId`
```

- `packages/organization/src/Organization.ts:1210` — No userId column: erasure (ec065a7, CSG-001/DRS-002) explicitly scoped this table out for that reason.

```
          CREATE TABLE organization_active_context (
            sessionId TEXT PRIMARY KEY,
            activeOrganizationId TEXT,
            activeTeamId TEXT,
            updatedAt TIMESTAMPTZ NOT NULL
          )
```

**Fix plan:** Keep sessionId as the key (active org is per-session by design) but add an indexed userId column so the row can be cleared on user erasure and membership removal, and document its shard placement.

Steps:
1. Append migration: `ALTER TABLE organization_active_context ADD COLUMN userId TEXT` + `CREATE INDEX organization_active_context_user_id ON organization_active_context(userId)` (nullable for pre-existing rows).
2. ActiveContextRecords: setOrganization/setTeam take the userId (Organization passes `caller.ref.id`); ActiveContextRecord gains `userId`; add `deleteAllByUser(userId)` to both layers.
3. Organization.beforeUserDeleteErasure: also sweep `activeContext.deleteAllByUser` (resolve ActiveContextRecords at layer build like MembershipRecords today; the Layer's RIn gains ActiveContextRecords).
4. Rewrite the ActiveContextRecords.ts header: sessionId key is deliberate (per-session active org, better-auth's session.activeOrganizationId semantics); userId is the erasure/revocation index; the row co-locates with the user's session shard (tenant_id design in ticket 18 / DRS-001).

Files: `packages/organization/src/ActiveContextRecords.ts`, `packages/organization/src/Organization.ts`, `packages/organization/test/ActiveContextRecords.test.ts`, `packages/organization/test/OrganizationErasure.test.ts`

Tests (write first):
- packages/organization/test/ActiveContextRecords.test.ts (both layers): 'deleteAllByUser removes every session row for that user only'.
- packages/organization/test/OrganizationErasure.test.ts: 'user deletion sweeps organization_active_context rows'.

Acceptance:
- Deleting a user leaves zero organization_active_context rows referencing them.

Spec refs: BEH-EA-048 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### OHS-007 — Deleted teams and organizations leave dangling active-context rows

`low` · `correctness` · `organization` · [.issues/low/OHS-007-organization-hierarchy-specialist.md](../../.issues/low/OHS-007-organization-hierarchy-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CWM-003**

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1507` — Org-delete cascade never clears organization_active_context; removeTeam (2225) likewise.

```
          yield* members.removeAllForOrganization(organizationId);
          yield* invitations.removeAllForOrganization(organizationId);
          yield* teams.removeAllTeamsForOrganization(organizationId);
          yield* orgRoles.removeAllForOrganization(organizationId);
```

- `packages/organization/src/ActiveContextRecords.ts:12` — Header still declares only the session-revocation gap.

```
// Deliberately not cascade-deleted when its underlying session is revoked
// — an orphaned row is harmless (the next read simply finds no matching
```

**Fix plan:** No separate fix — closed by CWM-003's plan.

**Recommended status:** `resolved`

### Workstream `org-tenant-read-isolation`

#### MTI-008 — GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check

`medium` · `security` · `organization` · [.issues/medium/MTI-008-multi-tenant-isolation-specialist.md](../../.issues/medium/MTI-008-multi-tenant-isolation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1448`

```
      const get: OrganizationShape["get"] = (organizationId) => requireOrganization(organizationId);
```

- `packages/organization/src/Organization.ts:629` — Handler never resolves the caller.

```
      get: Effect.fnUntraced(function* ({
        params,
      }: {
        params: OrganizationApi.OrganizationIdParams;
      }) {
        const record = yield* organization.get(params.organizationId);
        return toOrganizationDto(record);
```

**Fix plan:** Require membership for GET /organization/:organizationId, answering 404 to non-members.

Steps:
1. OrganizationShape.get(caller, organizationId): requireOrganization + requireMembership (which, after MTI-009, fails OrganizationNotFound).
2. Handler: `const caller = yield* currentUserPrincipal` and pass it.
3. Invitation landing pages get the org's public name through the bound getInvitation (MTI-010) rather than an open org read.

Files: `packages/organization/src/Organization.ts`, `packages/organization/test/Organization.test.ts`, `packages/organization/test/AuthHttp.test.ts`

Tests (write first):
- packages/organization/test/AuthHttp.test.ts: 'a non-member GET /organization/:id answers 404; a member gets the DTO'.

Acceptance:
- No organization metadata is readable by a non-member.

Spec refs: BEH-EA-147 · Effort: **S** · Depends on: MTI-009

**Recommended status:** `ready-for-agent`

#### MTI-009 — Cross-tenant denials answer 403, contradicting the repo's own BEH-EA-147 enumeration guidance

`medium` · `security` · `organization` · [.issues/medium/MTI-009-multi-tenant-isolation-specialist.md](../../.issues/medium/MTI-009-multi-tenant-isolation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/OrganizationApi.ts:53`

```
export class OrganizationPermissionDenied extends Schema.TaggedError<OrganizationPermissionDenied>()(
  "OrganizationPermissionDenied",
  {},
  { httpApiStatus: 403 },
) {}
```

- `packages/organization/src/Organization.ts:1363` — Non-member of an existing org gets 403, while a non-existent org gets 404 from requireOrganization (1373-1377) — an existence oracle.

```
      const requireMembership = (callerId: Users.UserId, organizationId: string) =>
        members.findByUserAndOrg(callerId, organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.OrganizationPermissionDenied()),
```

**Fix plan:** Answer 404 OrganizationNotFound whenever the caller is not a member (BEH-EA-147); keep 403 only for members who lack a statement.

Steps:
1. Organization.ts requireMembership and requirePermission's `Option.isNone(membership)` branch: fail `OrganizationApi.OrganizationNotFound` instead of OrganizationPermissionDenied.
2. Invitation paths that resolve the org from the invitation (cancelInvitation) use the same rule.
3. OrganizationApi: ensure every endpoint that can now fail OrganizationNotFound lists it in `error:`; update the OrganizationPermissionDenied doc comment to 'member lacking a statement'.
4. Update tests that expect 403 for non-members (Organization.test.ts, AuthHttp.test.ts, MTI-002's listTeams/listTeamMembers tests).

Files: `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/test/Organization.test.ts`, `packages/organization/test/AuthHttp.test.ts`

Tests (write first):
- packages/organization/test/AuthHttp.test.ts: 'a non-member probing GET /organization/:id/full of an existing org gets the same 404 as for a random id'; 'a member without member:delete gets 403'.

Acceptance:
- For a non-member, every /organization/:organizationId/* endpoint returns byte-identical responses for existing and non-existing ids.

Spec refs: BEH-EA-147 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### MTI-010 — getInvitation serves cross-tenant invitation data with no auth binding, and the invitation id doubles as the emailed token

`medium` · `security` · `organization` · [.issues/medium/MTI-010-multi-tenant-isolation-specialist.md](../../.issues/medium/MTI-010-multi-tenant-isolation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1963` — No caller, no email binding.

```
      const getInvitation: OrganizationShape["getInvitation"] = (invitationId) =>
        invitations.findById(invitationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new OrganizationApi.InvitationNotFound()),
              onSome: Effect.succeed,
```

- `packages/organization/src/Organization.ts:1780` — The REST id doubles as the emailed capability.

```
          const sendInvite = (record: InvitationRecords.InvitationRecord) =>
            mailer.send({
              to: record.email,
              template: "organization-invite",
              data: { token: record.id, organizationId, role: record.role },
            });
```

**Fix plan:** Bind getInvitation to the invitee (or an org member with invitation rights) and split the emailed capability token from the REST id.

Steps:
1. OrganizationShape.getInvitation(caller, invitationId): allowed iff the caller's email equals the invitation email, or the caller is a member of the invitation's org holding invitation:create; otherwise fail InvitationNotFound (404, same as unknown id). Handler threads the caller.
2. Append migration: `organization_invitation.tokenHash TEXT` + unique index. invite() mints 32 random bytes (Crypto), stores SHA-256 hex in tokenHash, and mails `{ token, invitationId, organizationId, organizationName, role }`.
3. acceptInvitation/rejectInvitation take a `token` payload field and require BOTH the email match (existing) AND constant-time hash equality — email binding alone no longer carries the whole security weight.
4. Add `GET /organization/invitations/by-token/:token` (authenticated, email-bound) for landing pages; the DTO never includes tokenHash.
5. Update InvitationRecords (both layers) and OrganizationApi payloads/errors accordingly.

Files: `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/src/InvitationRecords.ts`, `packages/organization/test/Organization.test.ts`, `packages/organization/test/InvitationRecords.test.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'a stranger cannot read an invitation by id (404)'; 'accept without the emailed token fails even with a matching email'; 'the invitee can read and accept with the token'.

Acceptance:
- Knowing an invitation id grants nothing; reading or accepting requires the invitee's identity and the emailed secret.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **L** · Depends on: MTI-009

**Recommended status:** `ready-for-agent`

### Workstream `qadi-bridge-hardening`

#### AAPS-004 — One store round trip per attribute reference, no per-evaluation memoization

`medium` · `performance` · `qadi` · [.issues/medium/AAPS-004-abac-attribute-policy-specialist.md](../../.issues/medium/AAPS-004-abac-attribute-policy-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/Resolvers.ts:73` — One full user lookup per attribute reference; no memo.

```
        return users.findById(userId).pipe(
          Effect.map((user): unknown => {
            switch (attribute) {
              case "email":
                return user.email;
              case "emailVerified":
                return user.emailVerified;
```

**Fix plan:** Memoize the user record per request (not across requests), so N attribute reads cost one lookup without introducing cross-request staleness.

Steps:
1. packages/qadi/src/Resolvers.ts: add `UserRecordMemo` — a Context.Reference whose default is 'no memo' (direct lookup) and whose request-scoped implementation holds a `Ref<HashMap<UserId, Deferred<UserRecord | undefined>>>`.
2. AuthorizedSubjectLive (Path A) and SubjectExtractorLive (Path B) provide a fresh UserRecordMemo around each request's handler effect (same request boundary ticket 12 uses for the per-request DecisionCache).
3. UserAttributes resolves through the memo; concurrent reads of the same user share one Deferred.
4. Optionally apply qadi's `attributeResolverBounded` in the documented QadiLive wiring.

Files: `packages/qadi/src/Resolvers.ts`, `packages/qadi/src/AuthorizedSubject.ts`, `packages/qadi/src/SubjectExtractor.ts`, `packages/qadi/test/Resolvers.test.ts`

Tests (write first):
- packages/qadi/test/Resolvers.test.ts: 'a policy reading email and emailVerified performs one Users.findById per request' (counting Users layer); 'a new request re-reads the user'.

Acceptance:
- Users.findById is called at most once per user per request under Path A/B.

Spec refs: BEH-EA-161 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### EEM-005 — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable

`medium` · `api` · `qadi` · [.issues/medium/EEM-005-effect-error-management-specialist.md](../../.issues/medium/EEM-005-effect-error-management-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/Resolvers.ts:100` — Not a Schema error — nothing can encode it on the wire.

```
/** BEH-EA-165: the client maps this to a "confirm your password" prompt. */
export class ReauthRequired extends Data.TaggedError("ReauthRequired")<{
  readonly maxAgeSeconds: number;
}> {}
```

- `packages/passkey/src/PasskeyApi.ts:118` — The repo's own precedent for a decodable reauth error.

```
export class PasskeyReauthRequired extends Schema.TaggedError<PasskeyReauthRequired>()(
  "PasskeyReauthRequired",
  { maxAgeSeconds: Schema.Number },
  { httpApiStatus: 403 },
) {}
```

**Fix plan:** Give the reauth obligation a shared, wire-decodable error in @awthaq/api and use it from qadi's handler (Path A); document Path B's qadi-owned mapping.

Steps:
1. packages/api: new `ReauthRequired` Schema.TaggedError("ReauthRequired", { maxAgeSeconds: Schema.Number }, { httpApiStatus: 403 }) exported from the package root.
2. packages/qadi/src/Resolvers.ts: reauthHandler fails with the @awthaq/api error (re-export under the old name for continuity); ObligationHandler type param updated.
3. Document for Path A handlers: declare `Api.ReauthRequired` in the endpoint `error:` of any route whose policy carries reauth(...). Path B keeps qadi's UndischargedObligation mapping (BEH-EA-160) — state this limitation in BEH-EA-165 prose.
4. Unify PasskeyReauthRequired onto the shared error (same shape) so clients handle one tag; update PasskeyApi + @awthaq/client's passkey client.
5. @awthaq/client: expose a typed `isReauthRequired` guard / example for the 'confirm your password' prompt.

Files: `packages/api/src/Api.ts (or a new packages/api/src/Reauth.ts re-exported from index.ts)`, `packages/qadi/src/Resolvers.ts`, `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/src/Passkey.ts`, `packages/client/src/passkey/PasskeyClient.ts`, `spec/behaviors/21-qadi-resolvers-obligations.md`

Tests (write first):
- packages/qadi/test/ReauthHttp.test.ts (new): a Path A endpoint enforcing obliged(reauth(300), hasPermission(...)) with a stale session answers 403 whose body decodes via HttpApiClient to ReauthRequired{maxAgeSeconds: 300}.

Acceptance:
- A browser client can distinguish a reauth demand (with its maxAgeSeconds) from a plain permission denial.

Spec refs: BEH-EA-165, BEH-EA-160 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TS-001 — Reauth obligation handler silently discharges a malformed obligation

`medium` · `correctness` · `qadi` · [.issues/medium/TS-001-torin-sandall.md](../../.issues/medium/TS-001-torin-sandall.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/Resolvers.ts:135` — A reauth duty without a numeric maxAgeSeconds is silently discharged.

```
    const maxAgeSeconds = obligations
      .map((duty) => duty.attributes["maxAgeSeconds"])
      .find((value): value is number => typeof value === "number");
    if (maxAgeSeconds === undefined) return;
```

**Fix plan:** Fail closed on an uninterpretable reauth obligation, like the unknown-id branch already does.

Steps:
1. reauthHandler: if `obligations` is non-empty and no duty carries a finite, non-negative numeric maxAgeSeconds → `Effect.die(new Error("awthaq: reauth obligation is missing a numeric maxAgeSeconds"))` (a policy-authoring/wiring error, same class as the unknown-id die at 129-133).
2. `reauth(maxAgeSeconds)` builder: die on non-finite/negative input so the malformed obligation cannot be authored through the helper.
3. When several reauth duties are present, use the strictest (minimum) maxAgeSeconds rather than the first.

Files: `packages/qadi/src/Resolvers.ts`, `packages/qadi/test/Resolvers.test.ts`

Tests (write first):
- packages/qadi/test/Resolvers.test.ts: 'a reauth duty with attributes {} dies and never discharges'; 'two reauth duties enforce the smaller maxAgeSeconds'.

Acceptance:
- No obligation shape reaching reauthHandler results in a silent pass.

Spec refs: BEH-EA-165 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TS-002 — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable

`medium` · `architecture` · `qadi` · [.issues/medium/TS-002-torin-sandall.md](../../.issues/medium/TS-002-torin-sandall.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

**Evidence at HEAD:**

- `packages/qadi/node_modules/@qadi/core/src/Evaluate.ts:346` — OVERSTATED part: qadi 0.7.0 already converts a resolver defect (e.g. Users.layerSql's orDie'd outage) into AttributeResolveError, so the evaluator CAN tell 'source down' from 'no opinion'.

```
const catchPortDefect =
  <E>(onDefect: (cause: Cause.Cause<E>) => E) =>
  <A, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasFails(cause) || !Cause.hasDies(cause)
          ? Effect.failCause(cause)
          : Effect.fail(onDefect(cause)),
```

- `packages/qadi/src/Resolvers.ts:47` — STILL TRUE part: the resolver itself never produces the typed error REQ-EA-452/453 describe, its header is stale, and those BDD scenarios are @skip @unwired.

```
 * `Users.findById` itself has no distinguishable "the store is down" error
 * separate from `UserNotFound` today, so there is no genuine outage this
 * resolver could report through `AttributeResolveError` even if it wanted
 * to; a real SQL outage would surface as an unhandled defect, not a typed
 * failure caught here — a real, open gap, not a swallowed one.
```

**Fix plan:** Make UserAttributes itself map store failures to AttributeResolveError (mirroring OrganizationQadi.attributes) and wire REQ-EA-452/453.

Steps:
1. Resolvers.ts UserAttributes: append `Effect.catchDefect((cause) => Effect.fail(new AttributeResolveError({ attribute, cause })))` after the UserNotFound → undefined mapping (deleted user stays 'no opinion', as documented).
2. Rewrite the header paragraph at 44-51 to describe the real behaviour (and qadi's catchPortDefect backstop).
3. Wire REQ-EA-452/453 steps in features/features/06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.steps.test.ts (fake Users layer that dies) and remove their @skip @unwired tags.

Files: `packages/qadi/src/Resolvers.ts`, `packages/qadi/test/Resolvers.test.ts`, `features/features/06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.steps.test.ts`

Tests (write first):
- packages/qadi/test/Resolvers.test.ts: 'a Users outage fails AttributeResolveError naming the attribute; a deleted user resolves undefined'.

Acceptance:
- REQ-EA-452/453 pass as real BDD scenarios.

Spec refs: BEH-EA-161, BEH-EA-148 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TS-003 — No decision-sink or denial-explainability seam wired anywhere

`medium` · `architecture` · `qadi` · [.issues/medium/TS-003-torin-sandall.md](../../.issues/medium/TS-003-torin-sandall.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/Resolvers.ts:11` — Stale: AuditLog shipped in 6bd3f1d; still no decision sink/denial record wired anywhere.

```
// - BEH-EA-164 (`DecisionHistory` backed by audit events) needs a durable
//   audit-event table this repository does not have — no `AuditLog`
//   service exists anywhere in `@awthaq/core` yet.
```

- `packages/qadi/node_modules/@qadi/core/src/DecisionSink.ts:59` — The seam exists in qadi; awthaq ships no implementation.

```
export class DecisionSink extends Context.Service<DecisionSink, DecisionSinkShape>()(
```

**Fix plan:** Ship an opt-in DecisionSink implementation that logs denials (and optionally records them in AuditLog), and refresh the stale header.

Steps:
1. New packages/qadi/src/DecisionLogging.ts: `DecisionSinkLog` (a @qadi/core DecisionSink that `Effect.logWarning`s every Deny with subject id, policy/permission label, decision tag, evaluation id) and `DecisionSinkAudit` (additionally publishes an `auth.authz.denied` AuthEvent → durable AuditLog), selectable via a `QadiBridgeConfig.recordDecisions: "off" | "log" | "audit"` Context.Reference (default "off").
2. core AuthEvents: add the `auth.authz.denied` event + AuditLog.actorOf case.
3. Resolvers.ts header: AuditLog now exists — BEH-EA-164's DecisionHistory backed by auth_audit_log becomes buildable; track as follow-up rather than 'impossible'.
4. BEH-EA-167 holds by construction (sink cannot change a decision) — assert it in tests.

Files: `packages/qadi/src/DecisionLogging.ts`, `packages/qadi/src/Resolvers.ts`, `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/qadi/src/index.ts`

Tests (write first):
- packages/qadi/test/DecisionLogging.test.ts: 'a denied evaluate emits exactly one sink record and the decision is unchanged'; 'audit mode writes auth.authz.denied to AuditLog'.

Acceptance:
- An operator can see which policy denied which subject without writing their own sink.

Spec refs: BEH-EA-164, BEH-EA-167, BEH-EA-100 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### YL-004 — Zero enforcement wired anywhere: no endpoint in the repo uses RequirePermission

`medium` · `security` · `qadi` · [.issues/medium/YL-004-yang-luo.md](../../.issues/medium/YL-004-yang-luo.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/SubjectApi.ts:45` — The only middleware attached anywhere propagates a subject and enforces nothing.

```
  .middleware(AuthorizedSubject)
  .middleware(Api.OptionalAuthentication);
```

- `packages/qadi/src/SubjectExtractor.ts:6` — `grep -rn 'RequirePermission|requiresPermission|publicEndpoint' packages/*/src packages/*/test examples features` → comments only.

```
// `RequirePermission` middleware built on it (BEH-EA-154 through 160 are all
```

**Fix plan:** Dogfood enforcement on the shipped surface and make an un-annotated endpoint detectable at startup.

Steps:
1. examples/memory-server: add one Path B group guarded by @qadi/http RequirePermission with a RequiredPermission annotation per endpoint, one PublicEndpoint, and one Path A handler using enforce(...) + hideDenied→404; wire the permission registry route (BEH-EA-158) and log its contents at startup.
2. packages/qadi: `auditAuthorizationAnnotations(api)` — walks an HttpApi's endpoints and fails (typed) listing every endpoint in a RequirePermission-guarded group that carries neither annotation; call it from the example's startup and document it for apps (BEH-EA-156 is per-request; this is the composition-time counterpart).
3. If YL-009 option B is chosen, its RolesAdmin endpoints become the first in-repo RequirePermission consumers.

Files: `examples/memory-server/index.ts`, `packages/qadi/src/SubjectExtractor.ts`, `packages/qadi/src/index.ts`

Tests (write first):
- packages/qadi/test/SubjectExtractor.test.ts: 'auditAuthorizationAnnotations reports an endpoint missing both annotations'.
- An example-server smoke test: GET on the guarded route without the permission answers 403; with it, 200.

Acceptance:
- At least one shipped route is actually protected by qadi; an unannotated route in a guarded group is caught before serving.

Spec refs: BEH-EA-154, BEH-EA-155, BEH-EA-156, BEH-EA-158 · Effort: **L** · Depends on: —

**Recommended status:** `ready-for-agent`

#### AAPS-008 — SubjectDto exposes only subject-embedded attributes, hiding resolver-resolved ones from clients

`low` · `dx` · `qadi` · [.issues/low/AAPS-008-abac-attribute-policy-specialist.md](../../.issues/low/AAPS-008-abac-attribute-policy-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/SubjectApi.ts:50` — Only embedded attributes; resolver-backed ones (emailVerified, org counts) never reach the client.

```
const toDto = (subject: AuthSubject): SubjectContract.SubjectDto =>
  new SubjectContract.SubjectDto({
    id: subject.id,
    roles: Array.from(subject.roles),
    permissions: Array.from(subject.permissions),
    attributes: subject.attributes,
  });
```

**Fix plan:** Let the subject endpoint resolve a configured set of resolver-backed attributes into the DTO, and document the split.

Steps:
1. packages/qadi: `SubjectApiConfig` Context.Reference `{ exposedAttributes: ReadonlyArray<string> }` (default []), with `.config` sugar.
2. SubjectHandlers.current: for each exposed name not already embedded, `AttributeResolver.resolve(subject.id, name)`; merge defined values into `attributes` (resolver failure → 5xx, never silently omitted).
3. @awthaq/api SubjectContract.SubjectDto.attributes: schema description 'embedded attributes plus SubjectApiConfig.exposedAttributes; other resolver attributes are server-side only'.

Files: `packages/qadi/src/SubjectApi.ts`, `packages/api/src/Subject.ts`, `packages/qadi/test/SubjectApi.test.ts`

Tests (write first):
- packages/qadi/test/SubjectApi.test.ts: 'exposedAttributes ["emailVerified"] appears in GET /subject'; 'unexposed resolver attributes do not'.

Acceptance:
- Client-side gating can read exactly the attributes the operator chose to expose.

Spec refs: BEH-EA-144 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### YL-008 — Correct middleware order is counterintuitive and unenforced by types

`low` · `dx` · `qadi` · [.issues/low/YL-008-yang-luo.md](../../.issues/low/YL-008-yang-luo.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

**Evidence at HEAD:**

- `packages/qadi/src/AuthorizedSubject.ts:23` — Counterintuitive order — the DX part holds.

```
// that point. A first attempt at `AuthorizedSubject.test.ts` wrote
// `.middleware(Authentication).middleware(AuthorizedSubject)` — the textual
// order BEH-EA-145's own prose reads most naturally — and failed at runtime
// with "Service not found: CurrentPrincipal", because that declaration order
// makes `AuthorizedSubject` outermost, running *before* `Authentication` has
// provided anything.
```

- `node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/src/unstable/httpapi/HttpApiBuilder.ts:222` — OVERSTATED part: MiddlewareServices is folded in declaration order via `ApplyServices = Exclude<R, Provides<A>> | Requires<A>` (HttpApiMiddleware.ts:199), so the wrong order leaves CurrentPrincipal as an unsatisfied handler-layer requirement — the types do object, just opaquely (not verified by compiling a counter-example).

```
> =
  | HttpApiEndpoint.Middleware<Endpoint>
  | HttpApiEndpoint.MiddlewareServices<Endpoint>
```

**Fix plan:** Ship a helper that applies the pair in the proven order and pin the type-level behaviour with a test.

Steps:
1. packages/qadi/src/AuthorizedSubject.ts: `export const withAuthorizedSubject = (group) => group.middleware(AuthorizedSubject).middleware(Api.Authentication)` and `withOptionalAuthorizedSubject` (OptionalAuthentication); no return-type annotations.
2. Use it in SubjectApi.ts; update the header comment to say the misorder also surfaces as an unsatisfied `CurrentPrincipal` requirement at compile time.
3. packages/qadi/test/AuthorizedSubject.test.ts: vitest `expectTypeOf` asserting `HttpApiGroup.MiddlewareServices` of the helper-built group is `never`, and of the reversed order includes `Api.CurrentPrincipal`.

Files: `packages/qadi/src/AuthorizedSubject.ts`, `packages/qadi/src/SubjectApi.ts`, `packages/qadi/test/AuthorizedSubject.test.ts`

Tests (write first):
- The expectTypeOf test above plus the existing runtime middleware test via the helper.

Acceptance:
- Consumers never hand-order the two middlewares; the type-level guarantee is pinned.

Spec refs: BEH-EA-145 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `roles-catalog-validation`

#### RRM-003 — Assigned role names absent from the catalog are silently dropped

`medium` · `correctness` · `roles` · [.issues/medium/RRM-003-rbac-role-modeling-specialist.md](../../.issues/medium/RRM-003-rbac-role-modeling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for YL-005, TS-008-torin-sandall

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:194` — Unknown names dropped silently at resolve time.

```
        const matched = names.flatMap((name) => {
          const found = catalog.get(name);
          return found === undefined ? [] : [found];
        });
```

- `packages/roles/src/Roles.ts:41` — No error channel at assign time.

```
  readonly assign: (userId: Users.UserId, roleName: string) => Effect.Effect<void>;
```

- `packages/roles/test/Roles.test.ts:49` — The silence is pinned as correct.

```
  it.effect("an assigned role name absent from the configured catalog is silently ignored", () =>
```

**Fix plan:** Validate assignments against the catalog at assign time and make resolve-time drift observable.

Steps:
1. RolesShape.assign: `Effect.Effect<void, UnknownRole>`; `UnknownRole` Data.TaggedError { roleName } (or Schema.TaggedError if YL-009 exposes HTTP). Both rolesMake and rolesMakeSql read RolesConfig and reject names absent from the catalog before writing.
2. subjectResolverMake: for each dropped name, `Effect.logWarning("awthaq.roles.unknownAssignedRole", { userId, roleName })` (drift after a catalog rename).
3. Add `listUnknownAssignments: Effect<ReadonlyArray<{ userId; roleName }>>` (SQL: `SELECT userId, role FROM role_assignments WHERE role NOT IN (...)`) for startup/doctor checks.
4. Rewrite Roles.test.ts:49-58 to assert UnknownRole on assign and a warning on resolve (test logger).

Files: `packages/roles/src/Roles.ts`, `packages/roles/test/Roles.test.ts`, `packages/roles/test/RolesSql.test.ts`, `spec/behaviors/18-roles-subject-resolver.md`

Tests (write first):
- packages/roles/test/Roles.test.ts + RolesSql.test.ts: 'assign of a name outside the catalog fails UnknownRole'; 'a stored name later removed from the catalog logs a warning at resolve'; 'listUnknownAssignments reports it'.

Acceptance:
- A typo'd or stale role name is visible at assign time, at resolve time, and via a query.

Spec refs: BEH-EA-139 · Effort: **S** · Depends on: RRM-004

**Recommended status:** `ready-for-agent`

#### RRM-004 — Duplicate catalog role names silently collapse, last wins

`low` · `correctness` · `roles` · [.issues/low/RRM-004-rbac-role-modeling-specialist.md](../../.issues/low/RRM-004-rbac-role-modeling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:184` — Duplicate names collapse, last wins.

```
  const catalog = new Map(rolesConfig.catalog.map((role) => [role.name, role] as const));
```

- `packages/qadi/node_modules/@qadi/core/src/Role.ts:267` — qadi's own resolveRoleGraph treats this as a hard failure.

```
 * silently picking one is a guess this library should not make. It fails with
```

**Fix plan:** Fail Roles layer construction on duplicate catalog names by validating through qadi's own resolveRoleGraph.

Steps:
1. subjectResolverMake (layer build): run `resolveRoleGraph(rolesConfig.catalog)` once (or an explicit duplicate-name check) and `Effect.orDie` with a message naming the duplicates; build the lookup Map only after it passes.
2. Share the validated catalog with RRM-003's assign-time validation.

Files: `packages/roles/src/Roles.ts`, `packages/roles/test/Roles.test.ts`

Tests (write first):
- packages/roles/test/Roles.test.ts: 'Roles.layer with two catalog entries named editor fails to build, naming editor'.

Acceptance:
- A duplicate role definition can never silently win.

Spec refs: BEH-EA-139 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### RRM-010 — Empty default catalog silently disables the roles plugin

`low` · `dx` · `roles` · [.issues/low/RRM-010-rbac-role-modeling-specialist.md](../../.issues/low/RRM-010-rbac-role-modeling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:51` — Forgetting Roles.config yields a plugin that grants nothing, silently.

```
export const RolesConfig: Context.Reference<RolesConfigShape> = Context.Reference(
  "awthaq/roles/Config",
  { defaultValue: (): RolesConfigShape => ({ catalog: [] }) },
);
```

**Fix plan:** Keep the fail-closed default but make the misconfiguration loud.

Steps:
1. subjectResolverMake: if the catalog is empty, `Effect.logWarning("awthaq.roles.emptyCatalog")` once at layer build.
2. README + RolesConfig doc comment: call out `Roles.config([...])` as required for any effect.

Files: `packages/roles/src/Roles.ts`, `packages/roles/README.md`, `packages/roles/test/Roles.test.ts`

Tests (write first):
- packages/roles/test/Roles.test.ts: 'building Roles.layer without config logs awthaq.roles.emptyCatalog' (test logger).

Acceptance:
- An empty catalog is visible in logs at startup.

Spec refs: BEH-EA-017 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TS-008 — Role assignments are never validated against the policy catalog; drift is silent

`low` · `security` · `roles` · [.issues/low/TS-008-torin-sandall.md](../../.issues/low/TS-008-torin-sandall.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **RRM-003**

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:41` — Same unvalidated assign as RRM-003; the 'surface on the decision trace' idea rides TS-003-torin-sandall's sink.

```
  readonly assign: (userId: Users.UserId, roleName: string) => Effect.Effect<void>;
```

**Fix plan:** No separate fix — closed by RRM-003's plan.

**Recommended status:** `resolved`

#### YL-005 — Assigned role names missing from the catalog are dropped silently

`low` · `correctness` · `roles` · [.issues/low/YL-005-yang-luo.md](../../.issues/low/YL-005-yang-luo.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **RRM-003**

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:194` — Same silent drop as RRM-003.

```
        const matched = names.flatMap((name) => {
          const found = catalog.get(name);
          return found === undefined ? [] : [found];
```

**Fix plan:** No separate fix — closed by RRM-003's plan.

**Recommended status:** `resolved`

### Workstream `org-qadi-relationships`

#### RZS-001 — BEH-EA-162's depth-2 resource-to-organization walk is unimplemented; the depth parameter is ignored

`high` · `correctness` · `organization` · [.issues/high/RZS-001-rebac-zanzibar-specialist.md](../../.issues/high/RZS-001-rebac-zanzibar-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) — canonical for OHS-009

**Evidence at HEAD:**

- `packages/organization/src/OrganizationQadi.ts:89` — `depth` never destructured; member treats resourceId as the org id.

```
      check: ({ subjectId, relation, resourceId }) =>
        Effect.gen(function* () {
          const userId = userIdFromSubject(subjectId);
          if (userId === undefined) return "Unrelated" as const;

          switch (relation) {
            case "member":
              return yield* organization
```

- `spec/behaviors/21-qadi-resolvers-obligations.md:60`

```
REQUIREMENT: `Organization.relationships` MUST resolve a `"member"` relation
             by walking from the resource to its owning organization and
             checking membership there; a lookup failure MUST map to
             `RelationshipResolveError`, never to `"Unrelated"`.
```

- `.scratch/resolve-ready-for-human-findings/issues/13-rebac-depth-n-resource-walk.md:1` — Decision: required ResourceOrganizationLookup port with layerNone; depth>=1 walks, unresolved fails RelationshipResolveError.

```
# ReBAC depth-N resource-to-organization walk
```

**Fix plan:** Implement the ticket-13 decision: a required, app-provided ResourceOrganizationLookup port consulted for member at depth >= 1; unresolved fails closed with RelationshipResolveError.

Steps:
1. OrganizationQadi.ts: `export class ResourceOrganizationLookup extends Context.Service<ResourceOrganizationLookup, { readonly organizationOf: (resourceId: string) => Effect.Effect<Option.Option<string>, unknown> }>()("awthaq/organization/ResourceOrganizationLookup") {}` plus `static readonly layerNone` (always Option.none()). (Effect v4 uses Context.Service — the ticket's `Context.Tag` spelling is v3.)
2. `relationships` yields ResourceOrganizationLookup (so its RIn gains it — breaking, one-line `Layer.provide(ResourceOrganizationLookup.layerNone)` for existing callers).
3. check destructures `depth`. member: depth undefined/0 → unchanged (resourceId is the org). depth >= 1 → `organizationOf(resourceId)`; Some(orgId) → membership check at orgId; None or a lookup failure → `RelationshipResolveError({ relation, resourceId, cause })`, never "Unrelated". admin/owner/team-member stay depth-0 (ticket scope).
4. Rewrite the OrganizationQadi.ts header comment (the 'out of scope' paragraph at 58-69) to describe the port.
5. features/traceability.md REQ-EA-454/455 rows: mark implemented; wire REQ-EA-454/455 steps in features/features/06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.steps.test.ts (remove @skip @unwired for those scenarios).

Files: `packages/organization/src/OrganizationQadi.ts`, `packages/organization/test/OrganizationQadi.test.ts`, `packages/organization/test/OrganizationQadiPolicy.test.ts`, `features/features/06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.steps.test.ts`, `features/traceability.md`

Tests (write first):
- packages/organization/test/OrganizationQadi.test.ts: 'member at depth 2 walks project → org via ResourceOrganizationLookup (Related)'; 'depth >= 1 with layerNone fails RelationshipResolveError'; 'depth 0 behaviour is unchanged'.
- BDD: REQ-EA-454, REQ-EA-455 scenarios pass.

Acceptance:
- hasRelationship('member', {depth: 2}) on a project resolves through the app's lookup; an unconfigured walk is a 5xx-class RelationshipResolveError, never a silent deny.

Spec refs: BEH-EA-162 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### PERS-005 — Organization authorization bypasses the declarative policy layer — two parallel deny semantics

`medium` · `architecture` · `organization` · [.issues/medium/PERS-005-policy-engine-rego-specialist.md](../../.issues/medium/PERS-005-policy-engine-rego-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1308` — FIXED part (c648000, JH-001/PERS-001): hook denials are now typed HookAborted (403), not defects.

```
      const veto = <A>(
        point: string,
        effect: Effect.Effect<A, HookPoint.HookAbort>,
      ): Effect.Effect<A, HookPoint.HookAborted> =>
```

- `packages/organization/src/Organization.ts:8` — Self-contained engine is a deliberate design (.scratch/organization/spec.md:265).

```
// This plugin never depends on `@awthaq/qadi` (stratum ordering,
// mirroring `Admin.ts`'s own header comment) — its own endpoint gating is
// entirely self-contained via `PermissionEngine.ts`, not a qadi round trip.
```

- `packages/organization/src/Organization.ts:1352` — STILL OPEN: plugin authorization denials leave no durable/audit record.

```
          if (Option.isNone(membership)) {
            return yield* Effect.fail(new OrganizationApi.OrganizationPermissionDenied());
          }
          const effective = yield* effectivePermissionsOf(organizationId, membership.value);
          if (!PermissionEngine.hasPermission(effective, resource, action)) {
            return yield* Effect.fail(new OrganizationApi.OrganizationPermissionDenied());
```

**Fix plan:** Keep the self-contained engine (design decision) but make its decisions auditable: publish a denial event into the durable AuditLog, and let qadi evaluate the same statements via RZS-006's permission relations.

Steps:
1. core AuthEvents: add `OrganizationPermissionDeniedEvent { _tag: "auth.organization.permissionDenied"; organizationId; userId; resource; action; reason: "notMember" | "missingStatement" }`; AuditLog.actorOf gets its case (compile-enforced).
2. Organization.requirePermission / requireMembership: publish it on each denial branch before failing.
3. RZS-006 already lets application policies express the plugin's statements declaratively through hasRelationship('<resource>:<action>'), which puts them in qadi traces/DecisionSinks.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/organization/src/Organization.ts`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'a denied updateMemberRole publishes auth.organization.permissionDenied with reason missingStatement'; core AuditLog test records it.

Acceptance:
- Every PermissionEngine denial is durably recorded with who/what/why.

Spec refs: BEH-EA-100 · Effort: **S** · Depends on: RZS-006

**Recommended status:** `ready-for-agent`

#### RRC-003 — qadi authorization decisions read org membership through bare SELECTs with no freshness ordering against membership writes

`medium` · `security` · `organization` · [.issues/medium/RRC-003-read-replica-consistency-specialist.md](../../.issues/medium/RRC-003-read-replica-consistency-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence medium)

**Evidence at HEAD:**

- `packages/organization/src/OrganizationQadi.ts:96` — Decision reads go through the same ambient SqlClient as every other read — latent until replicas exist.

```
              return yield* organization
                .attributesFor(resourceId, userId)
                .pipe(
                  Effect.map((attrs) =>
                    Option.isSome(attrs) ? ("Related" as const) : ("Unrelated" as const),
                  ),
                );
```

- `packages/organization/src/MembershipRecords.ts:267`

```
    const findByUserAndOrgQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ userId: Schema.String, organizationId: Schema.String }),
      Result: MembershipRow,
      execute: (r) =>
        sql`SELECT * FROM organization_membership WHERE userId = ${r.userId} AND organizationId = ${r.organizationId}`,
```

**Fix plan:** When ticket 28's ReadRouting lands (RRC-001), classify every authorization-decision read as primary-pinned and state the revocation-latency bound in the spec.

Steps:
1. Mark MembershipRecords.findByUserAndOrg, TeamRecords.findTeamMembership, OrgRoleRecords.listByOrganization and ActiveContextRecords.findBySessionId as primary-pinned (they must never route through ReadRouting.forRead); only listings (listByOrganization, listTeamsByOrganization, listByEmail) may become replica-eligible.
2. Add a doc-comment classification tag on each method and a unit test that fails if a decision-path method is wired through forRead.
3. spec/behaviors/21-qadi-resolvers-obligations.md BEH-EA-162 prose: 'relationship decisions read membership from the primary; revocation latency is zero under replica topology'.

Files: `packages/organization/src/MembershipRecords.ts`, `packages/organization/src/TeamRecords.ts`, `packages/organization/src/OrgRoleRecords.ts`, `spec/behaviors/21-qadi-resolvers-obligations.md`

Tests (write first):
- Once ReadRouting exists: packages/organization/test/OrganizationQadi.test.ts 'a stale replica does not keep a removed member Related' using a fake replica client.

Acceptance:
- With replicas configured, a removed member is Unrelated on the very next decision.

Spec refs: BEH-EA-162 · Effort: **S** · Depends on: RRC-001

**Recommended status:** `ready-for-agent`

#### RZS-004 — Every relationship check re-reads the source of truth; role relations compute the full permission set they never use

`medium` · `performance` · `organization` · [.issues/medium/RZS-004-rebac-zanzibar-specialist.md](../../.issues/medium/RZS-004-rebac-zanzibar-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/OrganizationQadi.ts:76`

```
    const roleRelation = (organizationId: string, userId: Users.UserId, role: string) =>
      organization
        .attributesFor(organizationId, userId)
```

- `packages/organization/src/Organization.ts:2318` — Role/member checks pay for a full statement merge (plus orgRoles.listByOrganization when DAC is on).

```
      const attributesFor: OrganizationShape["attributesFor"] = (organizationId, userId) =>
        members
          .findByUserAndOrg(userId, organizationId)
          .pipe(
            Effect.flatMap((membership) =>
              Option.isNone(membership)
                ? Effect.succeed(Option.none())
                : effectivePermissionsOf(organizationId, membership.value).pipe(
```

**Fix plan:** Answer member and role:* relations from the membership row alone; only permission relations compute statements.

Steps:
1. OrganizationQadi.relationships: yield MembershipRecords directly; `member` and `role:<name>`/admin/owner use `members.findByUserAndOrg` only.
2. Only `<resource>:<action>` relations (RZS-006) call organization.attributesFor.
3. No cross-request cache here — per-request DecisionCache scope (ticket 12) is the sanctioned memo; note it in the header.

Files: `packages/organization/src/OrganizationQadi.ts`, `packages/organization/test/OrganizationQadi.test.ts`

Tests (write first):
- packages/organization/test/OrganizationQadi.test.ts: 'admin relation performs no OrgRoleRecords read' (count calls on a wrapped OrgRoleRecords layer with DAC enabled).

Acceptance:
- A member/admin/owner check is exactly one indexed membership lookup.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: RZS-006

**Recommended status:** `ready-for-agent`

#### RZS-005 — Schema-less hardcoded relation vocabulary conflates RBAC roles with edges and silently answers malformed questions

`medium` · `architecture` · `organization` · [.issues/medium/RZS-005-rebac-zanzibar-specialist.md](../../.issues/medium/RZS-005-rebac-zanzibar-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/OrganizationQadi.ts:111` — Unknown relation names read as an honest negative (pinned by OrganizationQadi.test.ts:166).

```
            default:
              return "Unrelated" as const;
```

- `packages/qadi/node_modules/@qadi/core/src/RelationshipResolver.ts:58` — qadi's documented answer for 'a relation it has genuinely no answer for' is "Unknown".

```
export type RelatedResult = "Related" | "Unrelated" | "Unknown";
```

- `packages/organization/src/PermissionEngine.ts:91` — Namespace collision is worse than reported: a dynamic role named 'owner' silently REPLACES the built-in owner statements for that org (createRole does not reserve names).

```
export const statementsByRoleFrom = (
  customStatements: Readonly<Record<string, Statements>>,
  dynamicStatements?: Readonly<Record<string, Statements>>,
): ReadonlyMap<string, Statements> =>
  new Map<string, Statements>([
    ...Object.entries(defaultStatements),
    ...Object.entries(customStatements),
    ...Object.entries(dynamicStatements ?? {}),
```

**Fix plan:** Fail closed and legibly on malformed relation questions, and stop dynamic/custom role names from shadowing built-ins.

Steps:
1. OrganizationQadi.check: unrecognised relation → "Unknown" (qadi's documented value, yields an accurate denial sentence); org-scoped relation whose resourceId names no organization → "Unknown"; team-member whose resourceId names no team → "Unknown" (add `TeamRecords.findTeamByIdAnyOrg(teamId)`). Update OrganizationQadi.test.ts:166's expectation.
2. Organization.createRole: reject a role name equal to a built-in (owner/admin/member) or an OrganizationConfig.permissionStatements key with new `OrganizationApi.ReservedOrgRoleName` (409); `Organization.config` dies at layer build if permissionStatements redefines a built-in name.
3. PermissionEngine.statementsByRoleFrom: build defaults last-wins-proof (defaults override nothing and are never overridden) — guard in the function itself.
4. Relation vocabulary extension (`role:<name>`, permission relations) is delivered by RZS-006.

Files: `packages/organization/src/OrganizationQadi.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/PermissionEngine.ts`, `packages/organization/src/TeamRecords.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/test/OrganizationQadi.test.ts`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/OrganizationQadi.test.ts: 'an unknown relation answers Unknown'; 'team-member against an org id answers Unknown'.
- packages/organization/test/Organization.test.ts: 'createRole named owner fails ReservedOrgRoleName'; 'a dynamic role cannot alter owner statements'.

Acceptance:
- No dynamic/custom role can change built-in statements; malformed relation questions are distinguishable from negatives in qadi traces.

Spec refs: BEH-EA-162 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### RZS-006 — Split-brain: plugin endpoint gating uses PermissionEngine statements while qadi sees only the built-in role triad

`medium` · `correctness` · `organization` · [.issues/medium/RZS-006-rebac-zanzibar-specialist.md](../../.issues/medium/RZS-006-rebac-zanzibar-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1355` — Plugin gating: statement engine over built-in + static + dynamic roles.

```
          const effective = yield* effectivePermissionsOf(organizationId, membership.value);
          if (!PermissionEngine.hasPermission(effective, resource, action)) {
```

- `packages/organization/src/OrganizationQadi.ts:76` — qadi view: only the literal role names admin/owner; custom/dynamic statements invisible.

```
    const roleRelation = (organizationId: string, userId: Users.UserId, role: string) =>
      organization
        .attributesFor(organizationId, userId)
        .pipe(
          Effect.map((attrs) =>
            Option.isSome(attrs) && attrs.value.role.includes(role)
```

**Fix plan:** Derive every org relation qadi sees from the same functions the plugin's own gating uses, so a qadi policy and requirePermission can never disagree.

Steps:
1. OrganizationQadi.relationships relation grammar: `member` (unchanged), `role:<name>` for ANY org role name (built-in, static custom, dynamic; keep `admin`/`owner` as aliases of `role:admin`/`role:owner`), and `<resource>:<action>` (e.g. `member:update`) answered by `organization.attributesFor(...).permissions` — i.e. the exact `effectivePermissionsOf` result requirePermission uses.
2. Expose the vocabulary as `OrganizationQadi.relations` (a const + type) so application policies reference it rather than string literals.
3. Document the single-source contract in the OrganizationQadi.ts header and README (OHS-010).
4. Pin it: packages/organization/test/OrganizationQadi.test.ts 'relations agree with requirePermission' — for a fixture org with a dynamic role, for every (resource, action) in PermissionEngine's vocabulary, `check(<resource>:<action>)` is Related iff requirePermission succeeds.

Files: `packages/organization/src/OrganizationQadi.ts`, `packages/organization/src/Organization.ts`, `packages/organization/test/OrganizationQadi.test.ts`, `packages/organization/test/OrganizationQadiPolicy.test.ts`

Tests (write first):
- packages/organization/test/OrganizationQadi.test.ts: the agreement test above; 'a dynamic role granting team:create makes team:create Related'.
- packages/organization/test/OrganizationQadiPolicy.test.ts: a real qadi policy `hasRelationship("member:update")` allows exactly the members the plugin's own PATCH endpoint allows.

Acceptance:
- For any membership, hasRelationship('<r>:<a>') ⇔ PermissionEngine.hasPermission(effective, r, a).

Spec refs: BEH-EA-162 · Effort: **M** · Depends on: RZS-005

**Recommended status:** `ready-for-agent`

#### OHS-009 — qadi team-member relation is a flat direct lookup; depth and org implication ignored

`info` · `architecture` · `organization` · [.issues/info/OHS-009-organization-hierarchy-specialist.md](../../.issues/info/OHS-009-organization-hierarchy-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **RZS-001**

**Evidence at HEAD:**

- `packages/organization/src/OrganizationQadi.ts:107` — Depth ignored — covered by RZS-001's ticket-13 decision; the README-vocabulary ask is folded into OHS-010; org→team implication is OHS-001/OHS-004 territory.

```
            case "team-member": {
              const membership = yield* teams.findTeamMembership(resourceId, userId);
              return Option.isSome(membership) ? ("Related" as const) : ("Unrelated" as const);
```

**Fix plan:** No separate fix — closed by RZS-001's plan.

**Recommended status:** `resolved`

### Workstream `org-sql-count-queries`

#### MTI-005 — No index exists on the tenant key; count checks materialize every member row

`medium` · `performance` · `organization` · [.issues/medium/MTI-005-multi-tenant-isolation-specialist.md](../../.issues/medium/MTI-005-multi-tenant-isolation-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) — canonical for OHS-008

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1023` — FIXED part (58ef46a): organizationId/userId indexes now ship for membership; organization_team (1127) and organization_invitation (1073) too; organization_role is covered by UNIQUE(organizationId, role).

```
        pg: () =>
          sql`CREATE INDEX organization_membership_organization_id ON organization_membership(organizationId)`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_membership_user_id ON organization_membership(userId)`,
            ),
          ),
```

- `packages/organization/src/MembershipRecords.ts:342` — STILL OPEN: counts materialize and decode every row; countOwners (348-352) additionally JSON-decodes every role array.

```
    const countByOrganization: MembershipRecordsShape["countByOrganization"] = (organizationId) =>
      listByOrganizationQuery(organizationId).pipe(
        Effect.map((rows) => rows.length),
        Effect.orDie,
      );
```

**Fix plan:** Replace every row-materializing count in the SQL layers with COUNT(*) queries (the index half of this finding already shipped).

Steps:
1. MembershipRecords.layerSql.countByOrganization: SqlSchema.findOne over `SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_membership WHERE organizationId = ${id}` with Result `Schema.Struct({ count: Schema.Number })` (the CAST keeps pg from returning a bigint string).
2. countOwners: dialect-branched via sql.onDialectOrElse — sqlite `... AND EXISTS (SELECT 1 FROM json_each(role) WHERE value = 'owner')`, pg `... AND role::jsonb ? 'owner'`.
3. TeamRecords.layerSql.countTeamsByOrganization (476-481) and InvitationRecords.layerSql.countPendingByInviter: same COUNT(*) treatment (closes OHS-008).
4. Memory layers unchanged. The (userId, organizationId) composite index arrives with MTI-003's UNIQUE index.

Files: `packages/organization/src/MembershipRecords.ts`, `packages/organization/src/TeamRecords.ts`, `packages/organization/src/InvitationRecords.ts`

Tests (write first):
- Existing count tests in packages/organization/test/{MembershipRecords,TeamRecords,InvitationRecords}.test.ts must stay green on both layers; add 'countOwners counts only memberships whose role array contains owner' for layerSql with a mixed ['admin','owner'] role row.

Acceptance:
- No layerSql count method reads full rows (`grep -n "rows.length" packages/organization/src/*Records.ts` returns only memory-layer hits).

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### PPS-005 — Plugin tables have no production DDL: index alignment for organization/passkey/admin/jwt tables is absent, not just imperfect

`medium` · `performance` · `organization` · [.issues/medium/PPS-005-postgres-performance-specialist.md](../../.issues/medium/PPS-005-postgres-performance-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `58ef46a`

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1077` — Invitation/membership/team indexes shipped.

```
        pg: () =>
          sql`CREATE INDEX organization_invitation_organization_id ON organization_invitation(organizationId)`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_email ON organization_invitation(email)`,
            ),
```

- `packages/passkey/src/Passkey.ts:504` — passkey_credential(userId) shipped in the same commit.

```
        pg: () => sql`CREATE INDEX passkey_credential_user_id ON passkey_credential(userId)`,
```

- `packages/admin/src/ImpersonationRecords.ts:232` — admin_impersonation queries filter by sessionId (indexed, Admin.ts:241), never targetUserId — that suggested index has no query to serve.

```
      execute: (sessionId) => sql`SELECT * FROM admin_impersonation WHERE sessionId = ${sessionId}`,
```

**Note:** Composite (email, organizationId, status) not added; the email index is a selective leading key. Count materialization is MTI-005.

**Fix plan:** No fix — already fixed at HEAD (see evidence).

**Recommended status:** `resolved`

#### OHS-008 — Count queries load full row sets instead of using COUNT

`low` · `performance` · `organization` · [.issues/low/OHS-008-organization-hierarchy-specialist.md](../../.issues/low/OHS-008-organization-hierarchy-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MTI-005**

**Evidence at HEAD:**

- `packages/organization/src/TeamRecords.ts:476` — Same load-then-count root cause as MTI-005; MTI-005's fix plan converts this method too.

```
    const countTeamsByOrganization: TeamRecordsShape["countTeamsByOrganization"] = (
      organizationId,
    ) =>
      listTeamsByOrganizationQuery(organizationId).pipe(
        Effect.map((rows) => rows.length),
        Effect.orDie,
      );
```

**Fix plan:** No separate fix — closed by MTI-005's plan.

**Recommended status:** `resolved`

### Workstream `roles-audit-and-admin`

#### PCS-003 — Roles plugin mutates assignments silently: no AuthEvent on assign/revoke

`medium` · `architecture` · `roles` · [.issues/medium/PCS-003-permission-caching-specialist.md](../../.issues/medium/PCS-003-permission-caching-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **RRM-005**

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:77` — Same missing-event root cause as RRM-005. (Note: qadi's DecisionCache key includes the rebuilt subject, so roles changes do not need PCS-002's cache flush.)

```
    revoke: (userId, roleName) =>
      Ref.update(state, (map) =>
        HashMap.set(
          map,
          userId,
          namesOf(map, userId).filter((name) => name !== roleName),
```

**Fix plan:** No separate fix — closed by RRM-005's plan.

**Recommended status:** `resolved`

#### RRM-005 — Roles.assign/revoke emit no audit events and take no authorization gate

`medium` · `compliance` · `roles` · [.issues/medium/RRM-005-rbac-role-modeling-specialist.md](../../.issues/medium/RRM-005-rbac-role-modeling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for PCS-003

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:70` — No event, no actor.

```
    assign: (userId, roleName) =>
      Ref.update(state, (map) => {
        const existing = namesOf(map, userId);
        return existing.includes(roleName)
          ? map
          : HashMap.set(map, userId, [...existing, roleName]);
      }),
```

- `packages/roles/src/Roles.ts:117` — layerSql (1331cd5) equally silent.

```
      assign: (userId, roleName) =>
        assignQuery({ userId, role: roleName }).pipe(Effect.orDie, Effect.asVoid),
```

**Fix plan:** Publish auth.roles.assigned/revoked (durably audited) on real state changes, recording the actor.

Steps:
1. core AuthEvents: `RolesAssignedEvent { _tag: "auth.roles.assigned"; userId; roleName; actorUserId: UserId | undefined }` and `auth.roles.revoked`; AuditLog.actorOf cases (compile-enforced exhaustiveness).
2. RolesShape.assign/revoke gain `options?: { readonly actorId?: Users.UserId }`; both layers publish only when the state actually changed (memory: compare before/after; SQL: `INSERT … ON CONFLICT DO NOTHING RETURNING userId` / `DELETE … RETURNING userId`).
3. rolesMake/rolesMakeSql now yield AuthEvents — Roles.layer/layerSql gain AuthEvents in RIn; update TestAuth.ts, roles tests, BDD world, examples.
4. The authorization gate for who may call assign lives on the HTTP surface (YL-009); the service stays a trusted primitive, documented as such.

Files: `packages/roles/src/Roles.ts`, `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/roles/test/Roles.test.ts`, `packages/roles/test/RolesSql.test.ts`, `packages/test/src/TestAuth.ts`

Tests (write first):
- packages/roles/test/Roles.test.ts + RolesSql.test.ts: 'assign publishes auth.roles.assigned once; re-assign publishes nothing'; 'revoke of an unheld role publishes nothing'; core AuditLog test records actorUserId.

Acceptance:
- Every global role change is in auth_audit_log with who/what.

Spec refs: BEH-EA-100, BEH-EA-139 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### YL-009 — Roles plugin exposes no management API surface for administration

`info` · `dx` · `roles` · [.issues/info/YL-009-yang-luo.md](../../.issues/info/YL-009-yang-luo.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:211` — No management surface; ticket 19 rejected putting setRole in @awthaq/admin (written before Roles had a durable store).

```
  // BEH-EA-018/roadmap M3: no HTTP contract of its own — this plugin's whole
  // job is the `SubjectResolver` override, per this module's own header
  // comment. `HttpApi.make("auth")` with no `.add()` call is a real,
  // zero-group `HttpApi<"auth", never>`, which contributes nothing to
```

**Fix plan:** Ship an opt-in RolesAdmin plugin (pending decision) whose endpoints are guarded by qadi Path B, dogfooding enforcement.

Steps:
1. packages/roles/src/RolesAdmin.ts: a second AuthPlugin.Service (`dependsOn` Roles) with contract group `rolesAdmin`: GET /roles/catalog, GET /roles/users/:userId, POST /roles/users/:userId/assignments, DELETE /roles/users/:userId/assignments/:roleName; errors UnknownRole (422).
2. Each endpoint annotated with @qadi/http RequiredPermission (`roles:read`/`roles:manage`) behind RequirePermission; handlers pass `actorId` from CurrentPrincipal into Roles.assign/revoke (RRM-005).
3. Roles stays contract-less by default (Auth.make([Roles]) unchanged); apps opt in with Auth.make([Roles, RolesAdmin]).

Files: `packages/roles/src/RolesAdmin.ts`, `packages/roles/src/index.ts`, `packages/roles/test/RolesAdmin.test.ts`

Tests (write first):
- packages/roles/test/RolesAdmin.test.ts: 'a subject without roles:manage gets 403'; 'with it, POST assigns and publishes auth.roles.assigned with the actor'.

Acceptance:
- Role administration is operable over HTTP and protected by qadi, without app-written endpoints.

Spec refs: BEH-EA-018, BEH-EA-154 · Effort: **M** · Depends on: RRM-005, RRM-003

**Needs decision:** yes — see *Decisions needed* above.

**Recommended status:** `ready-for-human`

### Workstream `authz-docs-truthfulness`

#### DTWS-002 — 20 of 21 package READMEs claim 'no line of source in this package has shipped yet' while shipping real source

`high` · `docs` · `roles` · [.issues/high/DTWS-002-documentation-technical-writing-specialist.md](../../.issues/high/DTWS-002-documentation-technical-writing-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) — canonical for PERS-009

**Evidence at HEAD:**

- `packages/roles/README.md:3` — `grep -l 'no line of source in this package has shipped yet' packages/*/README.md | wc -l` → 20 (every package except next, migrate-auth0, migrate-better-auth).

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
```

- `packages/two-factor/src/index.ts:8` — `ls packages/{api-key,cli,magic-link,two-factor}/src` → index.ts only: these four are the only genuinely-planned packages; the other 16 bannered packages ship real source.

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**Fix plan:** Rewrite the 16 stale banners to shipped-vs-planned status (packages/next/README.md as template), keep the banner only on the 4 placeholder packages, and add a CI drift check.

Steps:
1. For admin, api, client, core, jwt, oauth, organization, passkey, password, ports, qadi, react, roles, server, sql, test: replace line 3 with a status line and a 'Shipped modules' list (file → BEH ids) plus 'Not yet' deviations; roles/qadi/organization content per RRM-009/OHS-010 (and PERS-009's qadi surface: AuthorizedSubject, SubjectExtractor, SubjectResolver slot, Resolvers, AttributeResolvers, SubjectApi).
2. Keep the banner on api-key, cli, magic-link, two-factor.
3. scripts/check-readme-status.mjs: fail if a README carries the planned banner while packages/<p>/src has any file other than a ≤10-line index.ts; add `pnpm readme:check` and include it in `pnpm check`.

Files: `packages/*/README.md`, `scripts/check-readme-status.mjs`, `package.json`

Tests (write first):
- Run the new script against the pre-fix tree (must fail listing 16 packages) and post-fix (must pass).

Acceptance:
- No shipped package's README claims it is unshipped; `pnpm check` enforces it.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### SAM-005 — No RLS-to-qadi translation guidance; the mapping mechanics survive only as inline comments

`medium` · `docs` · `organization` · [.issues/medium/SAM-005-supabase-auth-migration-specialist.md](../../.issues/medium/SAM-005-supabase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/OrganizationQadi.ts:11` — The mapping mechanics survive only here; `grep -rni 'row-level|RLS' spec` → 0 hits.

```
// **Correction to spec.md's own framing, found while reading the real
// `@qadi/core` API this ticket builds against**: `AttributeResolverShape.resolve`
// is `(subjectId, attribute) => Effect<unknown, AttributeResolveError>` —
// it carries no `resourceId` at all.
```

**Fix plan:** Write the RLS→qadi migration guide as a spec appendix.

Steps:
1. spec/appendices/04-rls-to-qadi-migration.md (+ index.yaml entry): policy-catalog-first method; mapping table (`auth.uid() = user_id` → EvaluateOptions.resource ownership check; org membership/role EXISTS → Organization relations member/role:<name>/<resource>:<action>; auth.jwt() claims → subject attributes (SAM-007/FAMS-004)); explicitly unsupported shapes (SECURITY DEFINER helpers, storage.objects prefixes) with workarounds; SQL pushdown via @qadi/predicate-sql for list queries (BEH-EA-166).
2. Worked example translating one real Supabase policy end to end.

Files: `spec/appendices/04-rls-to-qadi-migration.md`, `spec/appendices/index.yaml`

Tests (write first):
- `pnpm run spec:verify:strict` passes with the new appendix registered.

Acceptance:
- A Supabase migrator can translate a typical RLS policy without reading source comments.

Spec refs: BEH-EA-162, BEH-EA-166 · Effort: **M** · Depends on: RZS-006

**Recommended status:** `ready-for-agent`

#### SAM-007 — Token claims are write-only: auth.jwt()-based policies have no read path into qadi

`medium` · `architecture` · `qadi` · [.issues/medium/SAM-007-supabase-auth-migration-specialist.md](../../.issues/medium/SAM-007-supabase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/SubjectResolver.ts:52` — Bearer-token claims never reach AuthSubject; nothing in jwt/qadi docs says so.

```
 * BEH-EA-137: `id` only, no roles, no permissions — for every principal kind,
```

**Fix plan:** Document that JWT claims authenticate but do not authorize, and where claim-driven policy logic must be re-homed.

Steps:
1. packages/jwt/README.md + packages/qadi/README.md: 'definePayload claims are not projected into AuthSubject; re-home auth.jwt()-style facts into Roles (roles), Organization relations (membership), UserClaims (FAMS-004) or an app SubjectResolver override'.
2. Cross-link from SAM-005's RLS appendix.

Files: `packages/jwt/README.md`, `packages/qadi/README.md`

Tests (write first):
- Docs-only; `pnpm run spec:verify:strict` unaffected.

Acceptance:
- A Supabase migrator reading the jwt/qadi READMEs learns claims are not an authorization input.

Spec refs: BEH-EA-137 · Effort: **S** · Depends on: DTWS-002

**Recommended status:** `ready-for-agent`

#### JH-009 — No authoring guide or template plugin — conventions live in code comments and test fixtures

`low` · `docs` · `organization` · [.issues/low/JH-009-jared-hanson.md](../../.issues/low/JH-009-jared-hanson.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/OrganizationHooks.ts:5`

```
// `Organization` is the first real plugin consumer of the core
// `HookPoint` mechanism (`packages/core/src/HookPoint.ts`,
// `BEH-EA-089`–`096`); there is no prior plugin example to mirror.
```

- `packages/admin/src/Admin.ts:4` — Conventions still live in per-file header comments; `ls docs/` shows only agents/, domain.md, issue-tracker.md, triage-labels.md — no authoring guide or template plugin.

```
// `Auth.make([Admin])` composes: `dependsOn` is left unset on
// `AuthPlugin.layer` — `Sessions`/`Users`/`AuthEvents` are core domain
// services this plugin's own `make` Effect simply `yield*`s directly, the
// same established convention `@awthaq/passkey`'s own ticket 06
// corrected `Passkey.ts` to (see that file's own header comment).
```

**Fix plan:** Ship docs/plugin-authoring.md plus a minimal, test-exercised template plugin so conventions have one canonical, CI-checked home.

Steps:
1. examples/plugin-template/: a ~100-line AuthPlugin.Service with a config Context.Reference (+ `.config` sugar), one HttpApi group, one table + dialect-branched migration, one veto HookPoint + observe point, handlers, and a vitest suite run by `pnpm run test` (Migrations.run + AuthHttp round trip).
2. docs/plugin-authoring.md: walk through the template — dependsOn vs direct `yield*` (Admin.ts:4-8), ports-required rule (ADR-EA-010), hook tap-registry freeze (provide erasure/invalidation taps once, app-wide), migrations append-only, HookAborted veto contract (BEH-EA-090), no `as`, no return-type annotations.
3. Link from packages/core/README.md and AGENTS.md.

Files: `examples/plugin-template/`, `docs/plugin-authoring.md`, `packages/core/README.md`

Tests (write first):
- examples/plugin-template/test/Template.test.ts: builds via Auth.make, runs migrations, exercises the endpoint and a veto abort.

Acceptance:
- A new plugin author can copy one directory and one doc; the template's test keeps it from rotting.

Spec refs: BEH-EA-089, BEH-EA-090 · Effort: **L** · Depends on: —

**Recommended status:** `ready-for-agent`

#### OHS-010 — README and spec model still claim the package is unimplemented

`low` · `docs` · `organization` · [.issues/low/OHS-010-organization-hierarchy-specialist.md](../../.issues/low/OHS-010-organization-hierarchy-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/README.md:3`

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
```

- `spec/models/14-organization.md:24` — Model doc banner equally stale (beyond DTWS-002's README sweep).

```
"`Organization` (membership, invitations, relationship resolver)." Nothing
described here exists yet — awthaq is pre-implementation.
```

**Fix plan:** Rewrite the organization README (capability set, config flags, relation vocabulary, HTTP surface) and update the model doc's status paragraph.

Steps:
1. packages/organization/README.md: status 'shipped', capability list (orgs, memberships, invitations, teams, dynamic access control, hooks, erasure tap, qadi relationships/attributes), OrganizationConfig table with defaults, the qadi relation vocabulary (after RZS-001/RZS-005/RZS-006) and the 'resourceId is the org/team id unless depth ≥ 1' contract (OHS-009's ask), role tiers (OHS-005), and team scope (flat today / hierarchy per OHS-001).
2. spec/models/14-organization.md:24-25: replace 'Nothing described here exists yet' with implemented status + deviations.

Files: `packages/organization/README.md`, `spec/models/14-organization.md`

Tests (write first):
- DTWS-002's banner-check script covers the README; `pnpm run spec:verify:strict` stays green.

Acceptance:
- README describes what ships; no 'planned package' banner.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: DTWS-002

**Recommended status:** `ready-for-agent`

#### PERS-009 — qadi package README still claims nothing has shipped

`low` · `docs` · `qadi` · [.issues/low/PERS-009-policy-engine-rego-specialist.md](../../.issues/low/PERS-009-policy-engine-rego-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **DTWS-002**

**Evidence at HEAD:**

- `packages/qadi/README.md:3` — One of DTWS-002's 20 banners.

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
```

**Fix plan:** No separate fix — closed by DTWS-002's plan.

**Recommended status:** `resolved`

#### RRM-009 — Roles docs and metrics still claim the package is an empty placeholder

`low` · `docs` · `roles` · [.issues/low/RRM-009-rbac-role-modeling-specialist.md](../../.issues/low/RRM-009-rbac-role-modeling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `spec/behaviors/18-roles-subject-resolver.md:15` — Spec banner stale (beyond DTWS-002's README scope).

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

- `.quality-metrics/roles.json:43` — Metrics still describe the `export {}` placeholder (qadi.json:43 identical).

```
      "totalLoc": 9,
```

**Fix plan:** Refresh the roles/qadi spec banner and quality metrics (README handled by DTWS-002).

Steps:
1. spec/behaviors/18-roles-subject-resolver.md:15: implemented-status banner listing deviations (BEH-EA-138 enforcement point → RRM-012; BEH-EA-140/141 not implemented).
2. Regenerate or delete the stale `.quality-metrics/roles.json` and `.quality-metrics/qadi.json` (whatever produced them; `pnpm quality:dashboard` only renders).
3. Roles README content (via DTWS-002): layer vs layerSql, catalog config, SubjectResolver override, global-vs-org authority (MTI-007).

Files: `spec/behaviors/18-roles-subject-resolver.md`, `.quality-metrics/roles.json`, `.quality-metrics/qadi.json`

Tests (write first):
- `pnpm run spec:verify:strict` green.

Acceptance:
- No roles/qadi doc artefact claims the packages are empty.

Spec refs: BEH-EA-137, BEH-EA-138 · Effort: **S** · Depends on: DTWS-002

**Recommended status:** `ready-for-agent`

#### RRM-012 — Slot-conflict enforcement lands at layer build, not Auth.make as spec promises

`info` · `architecture` · `qadi` · [.issues/info/RRM-012-rbac-role-modeling-specialist.md](../../.issues/info/RRM-012-rbac-role-modeling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `spec/behaviors/18-roles-subject-resolver.md:44`

```
REQUIREMENT: At most one installed plugin MAY override the `SubjectResolver`
             slot; installing two plugins that both override it MUST fail at
             `Auth.make`, not at first request.
```

- `packages/qadi/src/SubjectResolver.ts:20` — Code enforces at Layer build (packages/core/test/Slots.test.ts covers SlotConflict generically).

```
// `MissingDep`) can ever observe a slot override. `@awthaq/roles`'s
// `Roles` claims this slot through `Slots.override`, which enforces the
// same conflict, at `Layer`-build time, through an explicit registry
// instead — see that call site, and `Slots.ts`'s own header comment, for
```

**Fix plan:** Align BEH-EA-138/REQ-EA-385-387 with the real enforcement point and pin it with a roles-specific test.

Steps:
1. spec/behaviors/18-roles-subject-resolver.md BEH-EA-138: REQUIREMENT → 'MUST fail during composition (Layer build, via Slots.SlotsRegistry), before any request is served'; replace the 'compile error at Auth.make' code comment; cite the structural reason.
2. features/features/06-roles-and-authorization-bridge/18-roles-subject-resolver.feature REQ-EA-386/387 wording to match; step definitions build with Slots.layer.
3. packages/roles/test/AuthComposition.test.ts: 'two SubjectResolver overrides with Slots.layer fail with SlotConflict at build'.

Files: `spec/behaviors/18-roles-subject-resolver.md`, `features/features/06-roles-and-authorization-bridge/18-roles-subject-resolver.feature`, `packages/roles/test/AuthComposition.test.ts`

Tests (write first):
- packages/roles/test/AuthComposition.test.ts (above); BDD REQ-EA-386/387.

Acceptance:
- Spec, feature text and code agree on where slot conflicts are caught.

Spec refs: BEH-EA-138 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `qadi-decision-cache-invalidation`

#### PCS-002 — No event-driven invalidation path exists: AuthEvents are published but nothing connects them to a cache flush

`high` · `architecture` · `organization` · [.issues/high/PCS-002-permission-caching-specialist.md](../../.issues/high/PCS-002-permission-caching-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1571` — Invalidation triggers exist…

```
          yield* events.publish({
            _tag: "auth.organization.memberRemoved",
            organizationId,
            userId: targetUserId,
          });
```

- `packages/core/src/AuthEvents.ts:391` — …and a subscription helper exists, but `grep -rn 'AuthEvents.on\|DecisionCache' packages/*/src examples` → 0 hits.

```
export const on = <Tag extends AuthEvent["_tag"]>(
```

- `packages/organization/src/Organization.ts:1640` — leave() runs no Before/AfterRemoveMember hook at all — a hook-tap bridge would miss it.

```
          yield* members
            .remove(callerId, organizationId)
```

**Note:** Related cross-slice: PCS-001, RZS-002 (ticket 12 part 1, appendix per-request scope).

**Fix plan:** Ship ticket 12's opt-in invalidation bridge (DecisionCacheInvalidationLive) for application-scoped DecisionCache deployments, and close the leave() hook gap it depends on.

Steps:
1. New packages/qadi/src/DecisionCacheInvalidation.ts exporting `DecisionCacheInvalidationLive` (Layer<never, never, DecisionCache>) that taps OrganizationHooks observe points — AfterAddMember, AfterRemoveMember, AfterUpdateMemberRole, AfterDeleteOrganization, AfterAddTeamMember, AfterRemoveTeamMember, AfterUpdateTeam, AfterDeleteTeam (ticket 12's list) plus AfterAcceptInvitation (adds a member) and AfterCreateRole/AfterUpdateRole/AfterDeleteRole (statement changes move RZS-006's permission relations) — each calling `DecisionCache.clear`.
2. @awthaq/qadi package.json gains `@awthaq/organization` (no cycle: organization depends on @qadi/core, never @awthaq/qadi). Re-export from packages/qadi/src/index.ts.
3. Organization.leave: run beforeRemove/afterRemove (same points as removeMember) so self-removal is observable to taps.
4. Doc comment on the export: coverage caveat (only awthaq-owned relationship state; app-owned resource attributes are the app's to clear) and the provide-once rule (HookPoint tap registries freeze after first run — same posture as Organization.beforeUserDeleteErasure).
5. Coordinate with PCS-001 / RZS-002 (other slice): spec/appendices/02-qadi-path-a-end-to-end.md moves decisionCacheLayer to per-request scope and documents this bridge as the mandatory pairing for app scope; optional ADR-EA recording the cache-scope policy.

Files: `packages/qadi/src/DecisionCacheInvalidation.ts`, `packages/qadi/src/index.ts`, `packages/qadi/package.json`, `packages/organization/src/Organization.ts`, `packages/qadi/test/DecisionCacheInvalidation.test.ts`

Tests (write first):
- packages/qadi/test/DecisionCacheInvalidation.test.ts: with an app-scoped decisionCacheLayer + Organization memory composition + OrganizationQadi.relationships: decide hasRelationship('member') → Allow; removeMember; decide again → Deny WITH the bridge; and a control case pinning the stale Allow WITHOUT it. Repeat for leave() and updateMemberRole.

Acceptance:
- With the bridge provided, no membership/role mutation leaves a cached Allow behind.

Spec refs: BEH-EA-162 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### PCS-004 — Decision cache has no TTL or staleness upper bound: FIFO capacity eviction only

`medium` · `security` · `qadi` · [.issues/medium/PCS-004-permission-caching-specialist.md](../../.issues/medium/PCS-004-permission-caching-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

**Evidence at HEAD:**

- `../qadi/packages/core/src/DecisionCache.ts:291` — True at ../qadi HEAD (0.8.0) too: no TTL.

```
 * **Unbounded by default** — `entries` is never evicted unless `capacity` is
 * given.
```

- `../qadi/spec/decisions/031-decision-cache.md:166` — Upstream ADR-QD-031 deliberately rejects a TTL.

```
**A TTL on entries.** Rejected: a time-bounded cache needs a clock, so it needs a
determinism story against
[INV-QD-008](../invariants.md#inv-qd-008-evaluation-is-reproducible-given-the-same-history),
and "stale for at most 5 seconds" is a claim about the caller's tolerance that Qadi
cannot make. A request-scoped cache needs no clock at all, which is why the scope is
the caller's rather than the duration.
```

**Note:** Real but deliberately rejected upstream (ADR-QD-031). Ticket 12's decision supplies the mitigation: per-request cache scope by default plus PCS-002's event/hook-driven clear for app scope. The 'document it' half lands with PCS-002/PCS-001.

**Fix plan:** No fix planned — see note.

**Recommended status:** `wontfix`

### Workstream `authz-model-boundaries`

#### MTI-007 — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models

`medium` · `architecture` · `roles` · [.issues/medium/MTI-007-multi-tenant-isolation-specialist.md](../../.issues/medium/MTI-007-multi-tenant-isolation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for RRM-006, YL-002

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:41` — Global, tenant-blind assignment.

```
  readonly assign: (userId: Users.UserId, roleName: string) => Effect.Effect<void>;
```

- `packages/roles/src/Roles.ts:191` — Subject roles/permissions come only from the global store.

```
      return Effect.gen(function* () {
        const userId = Users.UserId(principal.ref.id);
        const names = yield* roles.listRoleNames(userId);
```

- `packages/organization/src/Organization.ts:1335` — Organization authority is strictly per-org; nothing composes the two.

```
      const effectivePermissionsOf = (
        organizationId: string,
        membership: MembershipRecords.MembershipRecord,
      ) =>
```

**Fix plan:** Decide and codify the authority split between global Roles and per-organization roles (see Decisions); the recommended option is a documented, test-pinned contract plus naming guidance, not a third mechanism.

Steps:
1. (Recommended option A) Roles.ts header + packages/roles/README.md + packages/organization/README.md: 'Roles = platform-global authority (AuthSubject.roles/permissions, hasRole/hasPermission); tenant authority = Organization relations only (hasRelationship member/role:<name>/<resource>:<action>)'.
2. Add a worked example to spec/appendices/02-qadi-path-a-end-to-end.md combining hasPermission (global) with hasRelationship (org) correctly.
3. Naming guidance: prefix global role names (e.g. `platform:support`) and have Roles.config reject catalog names equal to organization built-ins (owner/admin/member) to avoid reader confusion.
4. Record the split as a short ADR-EA (spec/decisions/017-global-roles-vs-organization-roles.md).
5. If option B/C is chosen instead, see Decisions for the alternative plans.

Files: `packages/roles/src/Roles.ts`, `packages/roles/README.md`, `packages/organization/README.md`, `spec/appendices/02-qadi-path-a-end-to-end.md`, `spec/decisions/017-global-roles-vs-organization-roles.md`

Tests (write first):
- packages/roles/test/Roles.test.ts: 'Roles.config rejects a catalog role named owner/admin/member' (if naming guard adopted).

Acceptance:
- A reader can tell from the docs which mechanism answers 'is X an admin of org Y' vs 'is X a platform admin'.

Spec refs: BEH-EA-139, BEH-EA-162 · Effort: **S** · Depends on: RZS-006

**Needs decision:** yes — see *Decisions needed* above.

**Recommended status:** `ready-for-human`

#### RRM-006 — Three disjoint role/permission models with no bridge between them

`medium` · `architecture` · `roles` · [.issues/medium/RRM-006-rbac-role-modeling-specialist.md](../../.issues/medium/RRM-006-rbac-role-modeling-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MTI-007**

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:191` — The roles resolver reads only its own global store — the seam MTI-007's decision codifies.

```
      return Effect.gen(function* () {
        const userId = Users.UserId(principal.ref.id);
        const names = yield* roles.listRoleNames(userId);
```

**Fix plan:** No separate fix — closed by MTI-007's plan.

**Recommended status:** `resolved`

#### YL-002 — No domain/tenant dimension in RBAC; org-scoped power is a parallel relationship mechanism

`medium` · `architecture` · `organization` · [.issues/medium/YL-002-yang-luo.md](../../.issues/medium/YL-002-yang-luo.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MTI-007**

**Evidence at HEAD:**

- `packages/organization/src/OrganizationQadi.ts:14`

```
// it carries no `resourceId` at all. `spec.md`'s "resolves `orgRole`/
// `orgPermissions` from a subject's membership in whichever organization
// the check concerns" is not expressible through this shape: there is no
// parameter naming which organization is meant. Reading
```

- `packages/qadi/node_modules/@qadi/core/src/AttributeResolver.ts:52` — (subjectId, attribute) only — the engine-level half is option C of MTI-007's decision.

```
  readonly resolve: (
```

**Fix plan:** No separate fix — closed by MTI-007's plan.

**Recommended status:** `resolved`

### Workstream `org-config-and-tenancy`

#### AR-004 — Multi-tenancy is a plugin bolt-on, absent from the core identity model

`medium` · `architecture` · `organization` · [.issues/medium/AR-004-aeneas-rekkas.md](../../.issues/medium/AR-004-aeneas-rekkas.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **EP-001**

**Evidence at HEAD:**

- `.scratch/resolve-ready-for-human-findings/issues/18-multi-tenant-composition-oauth-connections.md:60` — The 'decide the tenancy line' ask is answered by ticket 18 (EP-001/DRS-001/CWM-001/EP-004): opaque tenant_id on core tables + TenantResolver port + per-org OAuth connections.

```
**1. Tenant = an `Organization` row.** No new "Tenant" concept, no new
```

- `packages/core/src/Users.ts:51` — Still no tenant dimension (`grep -rni tenant packages/core/src` → 0 hits): the gap is real but decided, not yet built — canonical EP-001.

```
export interface UserRecord {
  readonly id: UserId;
  /** BEH-EA-041: always the lower-cased form of whatever email was given. */
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
```

**Fix plan:** No separate fix — closed by EP-001's plan.

**Recommended status:** `resolved`

#### DRS-007 — Organization record has no region/homeRegion attribute — orgs cannot be pinned to a residency zone

`medium` · `compliance` · `organization` · [.issues/medium/DRS-007-data-residency-sharding-specialist.md](../../.issues/medium/DRS-007-data-residency-sharding-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/OrganizationRecords.ts:23` — No residency attribute.

```
export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly logo: Option.Option<string>;
  readonly metadata: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
}
```

**Fix plan:** Add a typed, config-validated homeRegion to organizations (pending decision) so the org→shard mapping is data-driven.

Steps:
1. OrganizationConfig: `regions: ReadonlyArray<string>` (default []) — the allowed residency vocabulary.
2. Append migration: `organization_org.homeRegion TEXT` (nullable); OrganizationRecord.homeRegion: Option<string>; create/update accept it and fail `OrganizationApi.UnknownRegion` (422) when not in config.regions; OrganizationDto exposes it.
3. Export a pure `homeRegionOf(record)` helper applications use for shard routing; membership-level region overrides stay out of scope.
4. Coordinate with DRS-001/ticket 18 (tenant_id on core tables).

Files: `packages/organization/src/OrganizationRecords.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/test/OrganizationRecords.test.ts`

Tests (write first):
- packages/organization/test/OrganizationRecords.test.ts (both layers): homeRegion round-trips; Organization.test.ts: unknown region rejected.

Acceptance:
- Every organization can carry a validated residency region.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **M** · Depends on: EP-001

**Needs decision:** yes — see *Decisions needed* above.

**Recommended status:** `ready-for-human`

#### EP-005 — No branding or custom-domain surface beyond org logo/metadata fields

`medium` · `api` · `organization` · [.issues/medium/EP-005-eugenio-pace.md](../../.issues/medium/EP-005-eugenio-pace.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:484` — Only branding-adjacent fields; nothing in the library consumes them.

```
    logo: Option.getOrNull(record.logo),
    metadata: Option.getOrNull(record.metadata),
```

- `packages/organization/src/Organization.ts:1784` — The one email the plugin sends carries no org name/logo.

```
              data: { token: record.id, organizationId, role: record.role },
```

**Fix plan:** Make the existing branding fields load-bearing where the plugin itself renders to tenants' users, and route custom-domain → tenant through ticket 18's TenantResolver.

Steps:
1. invite(): include `organizationName` and `organizationLogo` (from requireOrganization's record) in the organization-invite Mailer data.
2. Document logo/metadata as host-owned presentation data in the README and OrganizationRecord doc comment.
3. Custom domains: once EP-001's TenantResolver port lands, document the Host-header resolver recipe (no separate table until a real consumer exists).

Files: `packages/organization/src/Organization.ts`, `packages/organization/README.md`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'invitation email data includes organization name and logo' (capture Mailer).

Acceptance:
- Invitation emails can be branded per tenant without app code.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: EP-001

**Recommended status:** `ready-for-agent`

#### EP-006 — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded

`medium` · `security` · `organization` · [.issues/medium/EP-006-eugenio-pace.md](../../.issues/medium/EP-006-eugenio-pace.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:67`

```
const defaultOrganizationConfig: OrganizationConfigShape = {
  creatorRole: "owner",
  allowUserToCreateOrganization: () => Effect.succeed(true),
  organizationLimit: Number.POSITIVE_INFINITY,
  membershipLimit: 100,
```

- `packages/organization/src/Organization.ts:87` — One deployment-wide reference; no per-organization override.

```
export const OrganizationConfig: Context.Reference<OrganizationConfigShape> = Context.Reference(
  "awthaq/organization/Config",
  { defaultValue: () => defaultOrganizationConfig },
);
```

**Fix plan:** Add per-organization quota overrides and set a finite default organizationLimit (pending the default decision).

Steps:
1. OrganizationConfigShape: add `limitsFor?: (organizationId: string) => Effect.Effect<Partial<{ membershipLimit: number; invitationLimit: number; maximumTeams: number; maximumMembersPerTeam: number; maximumRolesPerOrganization: number }>>` — consulted at decision time and merged over the static values (the config is already read per decision).
2. Organization.ts: a single `limitsOf(organizationId)` helper used by addMember, acceptInvitation, invite, createTeam, addTeamMember, createRole.
3. Default change (decision): organizationLimit finite (recommended 10); allowUserToCreateOrganization stays permissive.
4. Update the OrganizationConfigShape doc comments and README config table.

Files: `packages/organization/src/Organization.ts`, `packages/organization/test/Organization.test.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'limitsFor overrides membershipLimit for one org only'; 'default organizationLimit stops the 11th owned org' (if adopted).

Acceptance:
- An operator can give one tenant a different quota without a redeploy of the plugin tuple (ADR-EA-005/006).

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **M** · Depends on: —

**Needs decision:** yes — see *Decisions needed* above.

**Recommended status:** `ready-for-human`

#### EP-010 — Invitations accepted from unverified emails by default

`low` · `security` · `organization` · [.issues/low/EP-010-eugenio-pace.md](../../.issues/low/EP-010-eugenio-pace.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:83`

```
  cancelPendingInvitationsOnReInvite: false,
  requireEmailVerificationOnInvitation: false,
```

- `packages/organization/src/Organization.ts:1858` — An unverified account holding the invited address is admitted by default.

```
          if (user.email !== record.email) {
            return yield* Effect.fail(new OrganizationApi.InvitationEmailMismatch());
          }
          if (orgConfig.requireEmailVerificationOnInvitation && !user.emailVerified) {
            return yield* Effect.fail(new OrganizationApi.EmailVerificationRequired());
          }
```

**Fix plan:** Flip requireEmailVerificationOnInvitation to true (pending decision) so membership is conferred only on a verified address.

Steps:
1. defaultOrganizationConfig.requireEmailVerificationOnInvitation: true; doc comment explains the opt-out.
2. Update fixtures that accept invitations with unverified users (Organization.test.ts, AuthHttp.test.ts, BDD worlds) to verify the email first or opt out explicitly.
3. README config table notes the secure default.

Files: `packages/organization/src/Organization.ts`, `packages/organization/test/Organization.test.ts`, `packages/organization/test/AuthHttp.test.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'by default an unverified user cannot accept (EmailVerificationRequired)'; 'config({ requireEmailVerificationOnInvitation: false }) restores the old behaviour'.

Acceptance:
- Default composition refuses invitation acceptance from unverified emails.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: —

**Needs decision:** yes — see *Decisions needed* above.

**Recommended status:** `ready-for-human`

### Workstream `org-team-hierarchy`

#### OHS-001 — Team model is flat: no parent pointers, closure structure, or hierarchy queries

`high` · `architecture` · `organization` · [.issues/high/OHS-001-organization-hierarchy-specialist.md](../../.issues/high/OHS-001-organization-hierarchy-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) — canonical for RZS-003

**Evidence at HEAD:**

- `packages/organization/src/TeamRecords.ts:26`

```
export interface TeamRecord {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly memberCount: number;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}
```

- `packages/organization/src/TeamRecords.ts:52`

```
  readonly createTeam: (input: {
    readonly organizationId: string;
    readonly name: string;
  }) => Effect.Effect<TeamRecord>;
```

- `.scratch/resolve-ready-for-human-findings/issues/34-team-hierarchy-model.md:1` — Decision: parentId adjacency + organization_team_closure, moveTeam/getAncestors/getDescendants/getSubtree, TeamHierarchyCycle; permission inheritance deferred to OHS-004. (Its 'no migrations' side note is now obsolete — 58ef46a shipped them.)

```
# Team hierarchy model (parent pointers / closure structure)
```

**Fix plan:** Implement ticket 34: parentId write model + closure-table read model, cycle guard, move/ancestor/descendant/subtree operations, exposed through Organization and its HTTP contract.

Steps:
1. Append migrations: `ALTER TABLE organization_team ADD COLUMN parentId TEXT REFERENCES organization_team(id)`; `CREATE TABLE organization_team_closure (ancestorId TEXT NOT NULL, descendantId TEXT NOT NULL, depth INTEGER NOT NULL, PRIMARY KEY (ancestorId, descendantId))` + index on descendantId; backfill `INSERT INTO organization_team_closure SELECT id, id, 0 FROM organization_team`. Add the table to Organization's `tables`.
2. TeamRecords (both layers): TeamRecord.parentId: Option<string>; createTeam input `parentId?`; new moveTeam/getAncestors/getDescendants/getSubtree and `TeamHierarchyCycle` error; closure maintenance on create/move/remove inside sql.withTransaction (OHS-002). removeTeam of a team with children fails new `TeamHasChildren` (explicit, safe default).
3. Organization service + OrganizationApi: createTeam payload `parentId`; `PATCH /organization/:organizationId/teams/:teamId/parent` (team:update, cycle → 409); `GET .../teams/:teamId/ancestors|descendants` (member-only). New hook points BeforeMoveTeam/AfterMoveTeam and event `auth.organization.teamMoved` (AuthEvents + AuditLog.actorOf).
4. spec/models/14-organization.md: document the hierarchy; permission inheritance stays with OHS-004.

Files: `packages/organization/src/TeamRecords.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `packages/organization/src/OrganizationHooks.ts`, `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `spec/models/14-organization.md`

Tests (write first):
- packages/organization/test/TeamRecords.test.ts (both layers): closure rows after nested creates; moveTeam re-parents a subtree; moving a team under its own descendant fails TeamHierarchyCycle; removeTeam with children fails TeamHasChildren.
- packages/organization/test/Organization.test.ts + AuthHttp.test.ts: the new endpoints and their gates.

Acceptance:
- getDescendants/getAncestors are single indexed closure queries; no cycle can be created.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **XL** · Depends on: OHS-002, OHS-003

**Recommended status:** `ready-for-agent`

#### OHS-004 — Team membership carries no role; no per-team permission override exists

`medium` · `architecture` · `organization` · [.issues/medium/OHS-004-organization-hierarchy-specialist.md](../../.issues/medium/OHS-004-organization-hierarchy-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/organization/src/TeamRecords.ts:35`

```
export interface TeamMembershipRecord {
  readonly id: string;
  readonly teamId: string;
  readonly userId: Users.UserId;
  readonly createdAt: DateTime.Utc;
}
```

- `packages/organization/src/Organization.ts:2254` — All team mutations gated by org-level statements only.

```
          yield* requirePermission(Users.UserId(caller.ref.id), organizationId, "team", "update");
```

**Fix plan:** Add team-scoped roles with explicit precedence (pending decision; ticket 34 deferred inheritance here).

Steps:
1. Append migration: `organization_team_membership.role TEXT NOT NULL DEFAULT '["member"]'` (JSON array like organization_membership.role).
2. OrganizationConfig.teamStatements: Record<string, Statements> for team roles (default: `lead` → team:[update], member:[create,delete] scoped to the team).
3. Organization: a `requireTeamPermission(caller, orgId, teamId, resource, action)` = org-level statements OR the caller's team role statements on this team (or an ancestor once OHS-001 lands).
4. OrganizationQadi: `team-role:<name>` relations on team ids; team-member unchanged.
5. addTeamMember/updateTeamMemberRole endpoints accept a role, guarded by canGrant against the caller's team+org statements.

Files: `packages/organization/src/TeamRecords.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationQadi.ts`, `packages/organization/src/OrganizationApi.ts`

Tests (write first):
- packages/organization/test/Organization.test.ts: 'a team lead can add members to their team but not to another team'; 'org admin retains authority over every team'.

Acceptance:
- A team lead's authority can be scoped to one team (and its subtree).

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **L** · Depends on: OHS-001

**Needs decision:** yes — see *Decisions needed* above.

**Recommended status:** `ready-for-human`

#### RZS-003 — Relationship graph is flat depth-0: no org hierarchy, no team nesting, no member-of-org-implies-team

`medium` · `architecture` · `organization` · [.issues/medium/RZS-003-rebac-zanzibar-specialist.md](../../.issues/medium/RZS-003-rebac-zanzibar-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **OHS-001**

**Evidence at HEAD:**

- `packages/organization/test/OrganizationQadi.test.ts:158` — Flat team model pinned; the team-nesting half is OHS-001 (ticket 34), org→team implication is OHS-004's decision. Organization-level nesting (org.parentId) is not requested anywhere else and is not planned.

```
      assert.strictEqual(adminIsTeamMember, "Unrelated");
```

**Fix plan:** No separate fix — closed by OHS-001's plan.

**Recommended status:** `resolved`

### Workstream `session-assurance-channel`

#### AAPS-006 — SessionViewExtension slot from ADR-EA-012 never declared; no channel for session trust attributes

`medium` · `architecture` · `qadi` · [.issues/medium/AAPS-006-abac-attribute-policy-specialist.md](../../.issues/medium/AAPS-006-abac-attribute-policy-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/SubjectResolver.ts:88` — Still the only Slots.define in the repo; SessionViewExtension (ADR-EA-012) is undeclared.

```
  Slots.define<SubjectResolverShape>()("SubjectResolver", {
```

- `packages/core/src/Sessions.ts:106` — FIXED part (3d16a96, AAPS-001): SessionView now carries a freshness fact; still no amr/MFA/trust channel into the subject.

```
  readonly authenticatedAt: DateTime.Utc;
```

**Note:** Coordinates with ticket 05's TwoFactor build (AOMS-003/THS-001, other slice), which becomes the first SessionViewExtension producer.

**Fix plan:** Declare the ADR-EA-012 SessionViewExtension slot and carry session-trust facts (authenticatedAt, amr, derived aal) onto the principal and into AuthSubject.attributes through one mapping point.

Steps:
1. core Sessions: add `authenticationMethods: ReadonlyArray<AuthenticationMethod>` (RFC 8176 amr literals: pwd, hwk, swk, user, otp, sms, fed, mfa) to Session row/SessionView/SessionListItem, set by `issue` input (Password → [pwd]; Passkey → [hwk|swk] + user when UV; OAuth → [fed]); `reauthenticate` appends; migration adds a JSON text column in packages/sql/src/CoreMigrations.ts.
2. core: declare `SessionViewExtension` via Slots.define (default passthrough) so exactly one plugin (TwoFactor, ticket 05) may enrich session trust facts, conflict-checked by SlotsRegistry.
3. @awthaq/api UserPrincipal: add optional `authenticatedAt`/`amr` fields populated by Authentication from the verified SessionView.
4. @awthaq/qadi resolveIdentityOnly and the Roles override: map them into AuthSubject.attributes (`authenticatedAt`, `amr`, `aal` from SOS-005's pure function) — the single computation point AAPS-006 asks for.

Files: `packages/core/src/Sessions.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/core/src/Slots.ts`, `packages/api/src/Api.ts`, `packages/server/src/Authentication.ts`, `packages/qadi/src/SubjectResolver.ts`, `packages/roles/src/Roles.ts`

Tests (write first):
- packages/core/test/Sessions.test.ts: 'issue stores amr; reauthenticate appends'.
- packages/qadi/test/SubjectResolver.test.ts: 'a user principal's amr/authenticatedAt appear on AuthSubject.attributes'; packages/roles/test/Roles.test.ts: 'the Roles override preserves them'.

Acceptance:
- A qadi policy can require hasAttribute('amr', contains('mfa')) without per-check re-derivation.

Spec refs: BEH-EA-137, BEH-EA-144 · Effort: **L** · Depends on: —

**Recommended status:** `ready-for-agent`

#### SOS-005 — qadi has no factor-strength/assurance vocabulary, so an SMS factor could not be policy-ranked below a passkey

`medium` · `security` · `qadi` · [.issues/medium/SOS-005-sms-otp-specialist.md](../../.issues/medium/SOS-005-sms-otp-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/index.ts:3` — `grep -rniE 'aal|amr|assurance|factorStrength|mfaVerified' packages/core/src packages/qadi/src packages/api/src` → 0 hits.

```
// AuthorizedSubject middleware (Path A), SubjectExtractor layer (Path B),
// the SubjectResolver slot, and resolvers/obligation handlers — the bridge
// to qadi, not an authorizer of its own (ADR-EA-009).
```

**Fix plan:** Add the assurance vocabulary on top of AAPS-006's amr channel so SMS can be policy-ranked below TOTP/passkey before any SMS plugin ships.

Steps:
1. core: `assuranceLevel(amr): "aal1" | "aal2" | "aal3"` pure function (NIST SP 800-63B-4 mapping; sms/restricted never raises above aal1 on its own) + `isRestrictedFactor`.
2. Expose `aal` as an AuthSubject attribute via AAPS-006's mapping point; document policy recipes (`hasAttribute("aal", oneOf("aal2","aal3"))`).
3. When ticket 05's SMS plugin lands it must emit `sms` in amr (never `otp`).

Files: `packages/core/src/Sessions.ts`, `packages/qadi/src/SubjectResolver.ts`, `spec/behaviors/07-sessions.md`

Tests (write first):
- packages/core/test/Sessions.test.ts: property table for assuranceLevel (pwd→aal1, pwd+otp→aal2, hwk+user→aal2/aal3 per mapping, pwd+sms→aal2-restricted flag).

Acceptance:
- A policy can distinguish a passkey session from a password+SMS session.

Spec refs: BEH-EA-137 · Effort: **M** · Depends on: AAPS-006

**Recommended status:** `ready-for-agent`

#### AAPS-009 — ApiKey/Service principals carry no attribute payload; attribute policies deny them by construction

`info` · `architecture` · `qadi` · [.issues/info/AAPS-009-abac-attribute-policy-specialist.md](../../.issues/info/AAPS-009-abac-attribute-policy-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/SubjectResolver.ts:74`

```
    case "ApiKey":
      return makeSubject({ id: `apikey:${principal.ref.id}` });
    case "Service":
      return makeSubject({ id: `service:${principal.ref.id}` });
```

- `packages/qadi/src/SubjectResolver.ts:26` — Deliberate, documented deferral; api-key is an empty placeholder.

```
// **BEH-EA-140/141 (ApiKey/Service principal scopes → permissions) are also
// not implemented, for a different reason**: `@awthaq/api`'s
// `ApiKeyPrincipal`/`ServicePrincipal` (`Api.ts`) carry only a `ref`, no
// `scopes` field — there is no `@awthaq/api-key` plugin yet (M7,
```

**Note:** Fail-closed today and not actionable until the api-key plugin exists (ticket 10, other slice). Carry the finding's constraint into that design: add scopes to ApiKeyPrincipal and map them into AuthSubject.permissions in the same change.

**Fix plan:** No fix planned — see note.

**Recommended status:** `wontfix`

### Workstream `qadi-upstream`

#### PERS-002 — External-engine seam (HasCustom/CustomPredicate) receives no action and no request context

`medium` · `architecture` · `qadi` · [.issues/medium/PERS-002-policy-engine-rego-specialist.md](../../.issues/medium/PERS-002-policy-engine-rego-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `../qadi/packages/core/src/Evaluate.ts:801` — Verified at ../qadi HEAD (0.8.0); identical in the installed 0.7.0.

```
  const allowed = yield* CustomPredicate.evaluate(policy.name, subject, resource, policy.params).pipe(
```

- `../qadi/packages/core/src/CustomPredicate.ts:46` — No action, no request context; EvaluateOptions has `action` but no `context` field.

```
  readonly evaluate: (
    name: string,
    subject: AuthSubject,
    resource: Resource | undefined,
    params: unknown,
  ) => Effect.Effect<boolean, CustomPredicateError>;
```

**Note:** Target repo: ../qadi (not this repo).

**Fix plan:** In ../qadi: pass the evaluation's action and an opaque caller context to custom predicates.

Steps:
1. ../qadi packages/core/src/Evaluate.ts: add `EvaluateOptions.context?: unknown`; thread `{ action, context }` into evaluateHasCustom.
2. ../qadi packages/core/src/CustomPredicate.ts: `evaluate(name, subject, resource, params, input: { readonly action: string | undefined; readonly context: unknown })`; update customPredicateFromRecord/Retrying/Bounded wrappers.
3. Amend ADR-QD-055 and add a changeset; release; then bump @qadi/* in awthaq (currently ^0.7.0) and let Path A/B pass request context (ip, userAgent) through.

Files: `../qadi/packages/core/src/Evaluate.ts`, `../qadi/packages/core/src/CustomPredicate.ts`, `../qadi/spec/decisions/055-a-named-registered-custom-predicate.md`

Tests (write first):
- ../qadi packages/core/test: 'a HasCustom predicate receives the evaluation action and context'.

Acceptance:
- An OPA-style sidecar predicate receives {subject, action, resource, context}.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### PERS-006 — Retrying wrapper re-executes custom predicates with no idempotency contract

`low` · `correctness` · `qadi` · [.issues/low/PERS-006-policy-engine-rego-specialist.md](../../.issues/low/PERS-006-policy-engine-rego-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `../qadi/packages/core/src/CustomPredicate.ts:117` — No idempotency/read-only requirement stated on the shape or the wrapper (../qadi HEAD).

```
 * Wraps a registry layer so every `evaluate` call retries on
 * `CustomPredicateError` under the given schedule before surfacing it.
```

**Note:** Target repo: ../qadi.

**Fix plan:** In ../qadi: state the read-only/idempotent contract and give predicates a replay signal.

Steps:
1. CustomPredicateShape.evaluate doc: predicates MUST be read-only and idempotent; side effects belong in obligations.
2. customPredicateRetrying doc: repeats the contract; pass `attempt` (0-based) through the PERS-002 input object so a predicate can detect a replay.

Files: `../qadi/packages/core/src/CustomPredicate.ts`

Tests (write first):
- ../qadi packages/core/test: 'customPredicateRetrying passes an increasing attempt number'.

Acceptance:
- The retry wrapper's contract is explicit in both doc comments.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: PERS-002

**Recommended status:** `ready-for-agent`

#### PERS-007 — HasCustom name typos fail at enforcement time; no registry-policy cross-check exists

`low` · `dx` · `qadi` · [.issues/low/PERS-007-policy-engine-rego-specialist.md](../../.issues/low/PERS-007-policy-engine-rego-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `../qadi/packages/core/src/CustomPredicate.ts:105` — Dangling names are only discovered at evaluation time (../qadi HEAD).

```
      return registered === undefined
        ? Effect.fail(
            new CustomPredicateError({
              name,
              reason: "no predicate is registered under this name",
            }),
          )
        : registered(subject, resource, params);
```

**Note:** Target repo: ../qadi.

**Fix plan:** In ../qadi: a composition-time validator for HasCustom names against the registry.

Steps:
1. ../qadi packages/core/src/CustomPredicate.ts: `danglingCustomPredicates(policies, table): ReadonlyArray<string>` (walk the Policy ADT for HasCustom nodes) and `customPredicateFromRecordChecked(table, policies)` whose Layer build fails with a typed error listing dangling names.
2. Document in ADR-QD-055; awthaq's QadiLive examples use the checked variant after the bump.

Files: `../qadi/packages/core/src/CustomPredicate.ts`

Tests (write first):
- ../qadi packages/core/test: 'a policy referencing an unregistered predicate fails layer build naming it'.

Acceptance:
- A typo'd HasCustom name fails at startup, not on the hot path.

Spec refs: — (no BEH-EA ids cover the organization plugin; update spec/models/14-organization.md where behaviour changes) · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `user-claims-store`

#### FAMS-004 — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent

`medium` · `architecture` · `qadi` · [.issues/medium/FAMS-004-firebase-auth-migration-specialist.md](../../.issues/medium/FAMS-004-firebase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

**Evidence at HEAD:**

- `packages/qadi/src/Resolvers.ts:60` — Still only the three UserRecord fields; `grep -rni customClaims` → 0 hits.

```
export const UserAttributeNames = ["email", "emailVerified", "name"] as const;
```

- `packages/roles/src/Roles.ts:138` — FIXED part (1331cd5, BAM-006): per-user role claims (Firebase `role: admin`) now have a durable home via Roles.layerSql.

```
const rolesMigrations: Migrations.Migrations = [
  {
    name: "create_role_assignments",
```

**Fix plan:** Add an opt-in per-user claims store exposed to qadi as a namespaced attribute (pending decision), and document the Firebase import mapping.

Steps:
1. New module packages/qadi/src/UserClaims.ts: `UserClaims` service (get/set/merge/delete per user; layerMemory/layerSql over `user_claims(userId PRIMARY KEY, claims TEXT JSON, updatedAt)` with migrations) — or host it in @awthaq/core if JWT definePayload should read it too.
2. `UserClaimsAttributes` AttributeResolver answering the single attribute name `claims` (a record; policies read nested fields via qadi field paths), registered through attributeResolverRegistry so it cannot shadow UserAttributes.
3. Publish `auth.user.claimsUpdated` (AuthEvents → AuditLog).
4. Docs: Firebase `setCustomUserClaims` → role claims to Roles.assign, everything else to UserClaims; JWT definePayload may copy from UserClaims.

Files: `packages/qadi/src/UserClaims.ts`, `packages/qadi/src/index.ts`, `packages/core/src/AuthEvents.ts`

Tests (write first):
- packages/qadi/test/UserClaims.test.ts (both layers): set/merge round-trip; a policy on claims.plan allows/denies accordingly.

Acceptance:
- A migrated custom claim is readable by a qadi policy without redeploying config.

Spec refs: BEH-EA-161 · Effort: **M** · Depends on: —

**Needs decision:** yes — see *Decisions needed* above.

**Recommended status:** `ready-for-human`

### (no workstream — already fixed)

#### YL-001 — Role assignments are memory-only, breaking the repo's own storage-adapter convention

`high` · `architecture` · `roles` · [.issues/high/YL-001-yang-luo.md](../../.issues/high/YL-001-yang-luo.md) · current status `ready-for-agent`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `1331cd5`

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:249`

```
  /** BAM-006: the same composition as `layer`, over `rolesMakeSql` instead of the in-memory `rolesMake`. */
  static readonly layerSql = Slots.override(
    Roles,
    QadiSubjectResolver.SubjectResolver,
    subjectResolverMake,
  ).pipe(Layer.provideMerge(AuthPlugin.layer(Roles, { make: rolesMakeSql })));
```

- `packages/roles/src/Roles.ts:145` — Durable table with the uniqueness the finding asked for; packages/roles/test/RolesSql.test.ts passes (ran at HEAD).

```
          CREATE TABLE role_assignments (
            userId TEXT NOT NULL,
            role TEXT NOT NULL,
            createdAt TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (userId, role)
          )`,
```

**Fix plan:** No fix — already fixed at HEAD (see evidence).

**Recommended status:** `resolved`

#### BE-008 — Hook veto aborts are converted to defects, crashing the request instead of denying it

`medium` · `dx` · `organization` · [.issues/medium/BE-008-bereket-engida.md](../../.issues/medium/BE-008-bereket-engida.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `c648000`

**Evidence at HEAD:**

- `packages/organization/src/Organization.ts:1312` — Veto aborts are a typed HookAborted (403) naming point/code — not a defect.

```
        effect.pipe(
          Effect.catchTag(
            "HookAbort",
            (abort) =>
              new HookPoint.HookAborted({ point, code: abort.code, message: abort.message }),
          ),
        );
```

- `packages/organization/src/OrganizationHooks.ts:14`

```
// PERS-001: ticket 19's original design decision (converting that to a
// defect via `Effect.orDie` right where each veto runs) directly
// contradicted BEH-EA-090's own MUST that an abort "surface to the caller
// as a typed error naming the abort's code" — reversed.
```

**Fix plan:** No fix — already fixed at HEAD (see evidence).

**Recommended status:** `resolved`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| MTI-004 | high | ALREADY-FIXED | Fixed by `58ef46a`; Residual UNIQUE-constraint gap is owned by MTI-003 (membership) and OHS-003 (team membership); core tenant columns by DRS-001/EP-001 (ticket 18). | `packages/organization/src/Organization.ts:1236` |
| YL-001 | high | ALREADY-FIXED | Fixed by `1331cd5` | `packages/roles/src/Roles.ts:249` |
| BE-008 | medium | ALREADY-FIXED | Fixed by `c648000` | `packages/organization/src/Organization.ts:1312` |
| PPS-005 | medium | ALREADY-FIXED | Fixed by `58ef46a`; Composite (email, organizationId, status) not added; the email index is a selective leading key. Count materialization is MTI-005. | `packages/organization/src/Organization.ts:1077` |
| AR-004 | medium | DUPLICATE | Duplicate of EP-001 | `.scratch/resolve-ready-for-human-findings/issues/18-multi-tenant-composition-oauth-connections.md:60` |
| PCS-003 | medium | DUPLICATE | Duplicate of RRM-005 | `packages/roles/src/Roles.ts:77` |
| RRM-006 | medium | DUPLICATE | Duplicate of MTI-007 | `packages/roles/src/Roles.ts:191` |
| RZS-003 | medium | DUPLICATE | Duplicate of OHS-001 | `packages/organization/test/OrganizationQadi.test.ts:158` |
| YL-002 | medium | DUPLICATE | Duplicate of MTI-007 | `packages/organization/src/OrganizationQadi.ts:14` |
| OHS-007 | low | DUPLICATE | Duplicate of CWM-003 | `packages/organization/src/Organization.ts:1507` |
| OHS-008 | low | DUPLICATE | Duplicate of MTI-005 | `packages/organization/src/TeamRecords.ts:476` |
| PERS-009 | low | DUPLICATE | Duplicate of DTWS-002 | `packages/qadi/README.md:3` |
| RRM-007 | low | DUPLICATE | Duplicate of OHS-005 | `packages/organization/src/PermissionEngine.ts:32` |
| TS-008 | low | DUPLICATE | Duplicate of RRM-003 | `packages/roles/src/Roles.ts:41` |
| YL-005 | low | DUPLICATE | Duplicate of RRM-003 | `packages/roles/src/Roles.ts:194` |
| OHS-009 | info | DUPLICATE | Duplicate of RZS-001 | `packages/organization/src/OrganizationQadi.ts:107` |
| PCS-004 | medium | WONTFIX-CANDIDATE | Real but deliberately rejected upstream (ADR-QD-031). Ticket 12's decision supplies the mitigation: per-request cache scope by default plus PCS-002's event/hook-driven clear for app scope. The 'document it' half lands with PCS-002/PCS-001. | `../qadi/packages/core/src/DecisionCache.ts:291` |
| AAPS-009 | info | WONTFIX-CANDIDATE | Fail-closed today and not actionable until the api-key plugin exists (ticket 10, other slice). Carry the finding's constraint into that design: add scopes to ApiKeyPrincipal and map them into AuthSubject.permissions in the same change. | `packages/qadi/src/SubjectResolver.ts:74` |

## Cross-slice references

- **AR-004 → EP-001** (ticket 18: tenant = organization row; opaque tenant_id on core tables). EP-005 and DRS-007 also depend on EP-001's TenantResolver/tenant key.
- **PCS-002** implements part 2 of ticket 12, whose part 1 (appendix per-request cache scope) is **PCS-001 / RZS-002** — coordinate.
- **RRC-003** depends on **RRC-001** (ticket 28 ReadRouting) before it can be implemented.
- **DRS-008** extends the erasure sweep started by **CSG-001 / DRS-002** (`ec065a7`), which explicitly scoped out organization_active_context, team memberships and invitations.
- **MTI-004 / PPS-005** were fixed by BAM-002's `58ef46a`; **DRS-003** (other slice, "zero production migrations for plugin tables") is very likely ALREADY-FIXED by the same commit.
- **AAPS-006 / SOS-005** must land before ticket 05's TwoFactor/SMS work (**AOMS-003, THS-001, SOS-001**); **AAPS-009** belongs with ticket 10 (api-key).
- **DTWS-002** owns the README banner sweep for all 20 packages, including packages owned by other slices.
