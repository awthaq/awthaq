---
plan: 31-admin-tier-gate
ticket: 09
title: "Admin's gate sits on the core gate"
type: execute
wave: 1
depends_on: [06]
files_modified:
  - packages/admin/src/internal/AdminGate.ts
  - packages/admin/test/AdminGate.test.ts
  - packages/admin/test/AdminGate.boundary.test.ts
  - .changeset/admin-on-admin-tier-gate.md
autonomous: true
requirements: [REQ-EA-1522, REQ-EA-1523]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Admin's 16 gated actions, impersonation, forceStop, list and the superadmin scope behave exactly as before (the plan-13 matrix stays green)"
    - "canAdministerTenants receives tenantId"
    - "No file in packages/admin/src publishes auth.admin.actionDenied or calls configInForce"
    - "AdminConfig's key string stays only in internal/AdminGate.ts"
  artifacts:
    - path: "packages/admin/src/internal/AdminGate.ts"
      provides: "admin's declaration over AdminTierGate; unchanged interface to Admin/AdminAccounts/AdminTenants"
  key_links:
    - from: "packages/admin/src/internal/AdminGate.ts"
      to: "packages/core/src/AdminTierGate.ts"
      via: "AdminTierGate.make({ config: AdminConfig, built: yield* AdminConfig, prefix: \"\", … })"
      pattern: "AdminTierGate\\.make\\("
---
Status: ready-for-agent
Blocked by: 06

<objective>
Keep admin's gate interface (plan 13) and its private configuration; replace its generic half with the core gate.

Purpose: admin stops owning the configuration read, the denial event and the ordering; it keeps what is admin's: the action table, the predicate pairing, the admin clearances with their deferred target lookup, and the impersonation denial.
Output: `internal/AdminGate.ts` without `inForce`, `refuse` and `decide`; the boundary test rewritten; the moved test deleted; a changeset.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§3.4 Admin)
@packages/core/src/AdminTierGate.ts (from ticket 06)
@packages/admin/src/internal/AdminGate.ts (whole file)
@packages/admin/src/Admin.ts (gate call sites :722-989; forceStop :951-960 discards the episode clearance)
@packages/admin/test/AdminGate.test.ts, AdminGate.boundary.test.ts, AdminGate.types.test.ts
@.planning/13-admin-gate/PLAN.md (§3.2-§3.5; Decisions taken: TS2883 alias)
</context>

<tasks>
<task type="auto">
  <name>Task 1: Admin's declaration</name>
  <files>packages/admin/src/internal/AdminGate.ts</files>
  <read_first>packages/admin/src/internal/AdminGate.ts, packages/core/src/AdminTierGate.ts</read_first>
  <action>Keep sections 1–3 (configuration, action table, clearance types) and the exported interface of `make` (`collection`, `user`, `organization`, `impersonation`, `episode`, `visibleEpisodes`, `crossTenantScope`) with the same signatures, except that `episode` now succeeds with `void` (its only caller, `Admin.ts:959`, discards the value). Add `readonly tenantId: Option.Option<string>` to `TenantAdminGateInput`. Add `impersonate: { gate: "canImpersonate", on: "user" }` to the action table and widen its `satisfies` with a `GateOf<ImpersonationGateInput>` member; keep `UserGate`/`TenantGate`/`UserAction`/`OrganizationAction`/`CollectionAction` exactly as `AdminGate.types.test.ts` pins them (impersonate must not join `UserAction`; give it its own `on` value such as "impersonation" if needed). In `make`: replace `inForce` (:247), `refuse` (:258-270) and `decide` (:272-301) by one `AdminTierGate.make` declaration: `config: AdminConfig`, `built: yield* AdminConfig`, `prefix: ""`, target type `string`, `predicate` dispatching on `actions[asked.action].gate` (canAdministerTenants gets `{ admin, organizationId: asked.target, tenantId }`; canImpersonate gets `{ admin, target, tenantId }` where a missing target answers `Effect.succeed(false)` via `Option.match`; the user predicates get `{ admin, target: Option.map(asked.target, subject), tenantId }`), `names` reading `actions[action].on` (organization → `{ organizationId }`, otherwise `{ targetUserId: Users.UserId(id) }`), `denied: () => new AdminApi.AdminActionDenied()`, and `throttle: () => Effect.void` with the comment `// shortcut: admin declares no rate rule yet; plan 31 ticket 11 (Q2) adds it`. `collection`/`user`/`organization` call `core.named` and build admin's branded clearances from `cleared.config` and `cleared.adminUserId`. `impersonation` calls `core.named(caller, "impersonate", Option.some(targetUserId), refuse)` where `refuse` is the existing `impersonationDenied` with operation "impersonate". `episode`, `visibleEpisodes` and `crossTenantScope` call `core.ask` with a question over the configuration (episode: on `false` it runs `impersonationDenied` with operation "forceStop" as today). Replace every `caller.ref.id` in the file with the clearance's or `asked`'s `adminUserId`; the `subject` helper takes a string. Update the header comment: the generic half is core's `AdminTierGate` (ADR-EA-050); this file is admin's declaration. If TS2883 appears in `Admin.ts`/`AdminAccounts.ts`/`AdminTenants.ts` declaration emit, export a type alias from this file as plan 13 did; never annotate.</action>
  <verify><automated>npx vitest run packages/admin</automated></verify>
  <acceptance_criteria>
    - `grep -c '_tag: "auth.admin.actionDenied"' packages/admin/src/internal/AdminGate.ts` → 0 (baseline 1).
    - `grep -rn 'configInForce' packages/admin/src | grep -v '^\S*:\s*//' | grep -v '://' | wc -l` → 0 (baseline 1 code site).
    - `grep -c 'caller\.ref\.id' packages/admin/src/internal/AdminGate.ts` → 0 (baseline 13).
    - `grep -c 'AdminTierGate.make(' packages/admin/src/internal/AdminGate.ts` → 1 (baseline 0).
    - `npx vitest run packages/admin/test/AdminGate.types.test.ts` passes unchanged.
  </acceptance_criteria>
  <done>Admin's interface is unchanged; its implementation sits on the core gate.</done>
</task>

<task type="auto">
  <name>Task 2: Tests: replace, don't layer</name>
  <files>packages/admin/test/AdminGate.test.ts, packages/admin/test/AdminGate.boundary.test.ts</files>
  <read_first>packages/admin/test/AdminGate.test.ts, packages/admin/test/AdminGate.boundary.test.ts</read_first>
  <action>In `AdminGate.test.ts`, delete "BEH-EA-236: with no tenant configuration the build-time value applies exactly as before" (`:502-511`), now core case 5. In the case "BEH-EA-221, IDS-001/002: each predicate sees the identity-only admin, the target and the ambient tenant" (`:574`), add the assertion that `canAdministerTenants` sees `tenantId`. Leave every other case unchanged; they pin admin's declaration (pairing, opens/tightens per predicate, impersonation, episodes, non-gate configuration). In `AdminGate.boundary.test.ts` (`:31-41`), assert `filesMatching(/\bconfigInForce\b/)` is `[]`, `filesMatching(/"auth\.admin\.actionDenied"/)` is `[]`, the `"awthaq/admin/Config"` key and `"auth.admin.impersonationDenied"` are only in `internal/AdminGate.ts`, and that `internal/AdminGate.ts` imports `AdminTierGate`; update the test titles accordingly.</action>
  <verify><automated>npx vitest run packages/admin/test/AdminGate.test.ts packages/admin/test/AdminGate.boundary.test.ts packages/admin/test/AdminGate.types.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "with no tenant configuration the build-time value applies exactly as before" packages/admin/test/AdminGate.test.ts` → 0 (baseline 1).
    - The boundary test contains `AdminTierGate` (baseline 0).
  </acceptance_criteria>
  <done>Admin's tests pin admin's declaration only.</done>
</task>

<task type="auto">
  <name>Task 3: Changeset and gate</name>
  <files>.changeset/admin-on-admin-tier-gate.md</files>
  <read_first>.changeset/admin-denied-target.md</read_first>
  <action>Create `.changeset/admin-on-admin-tier-gate.md`: `"@awthaq/admin": minor`; "Admin's gate runs on `@awthaq/core`'s `AdminTierGate`; `canAdministerTenants` also receives `tenantId`. Responses, events and configuration are unchanged." `Migration: none.` Run the ticket gate.</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/admin && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - All commands exit 0.
  </acceptance_criteria>
  <done>Green; changeset present.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| administrator → admin groups | user erasure, credential changes, bans, impersonation, tenant suspension |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-31-14 | Elevation of privilege | predicate dispatch in the declaration | high | mitigate | The plan-13 matrix ("each operation opens on its own predicate and on no other") stays green unchanged |
| T-31-15 | Elevation of privilege | impersonation with a missing target | medium | mitigate | `canImpersonate` adapter answers `false` when the target is `None` (fail-closed) |
| T-31-09 | Elevation of privilege | configuration read | high | mitigate | Boundary test: no `configInForce` in admin; core reads per call |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- Admin's suite green with one test deleted and the boundary test rewritten; 0 `caller.ref.id` in `AdminGate.ts`.
</success_criteria>

## Comments
