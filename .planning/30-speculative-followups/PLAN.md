# Plan 30: Speculative follow-ups: (A) organization authorization as one primitive, (B) core sealed columns under `SealedColumn` (superseded)

| Property | Value |
|---|---|
| Source | The architecture review of 2026-11-08 (`/improve-codebase-architecture`): its two speculative candidates. This is batch 3 of `.planning/` (plans 25–30). Drafted as "plan 16"; the orchestrator renumbered it 30 |
| Strength | **Speculative.** Two independent parts, each behind its own go/no-go gate (§1.A.1, §1.B.1). **Part B is superseded on the current base:** batch-2 plan 17 (`.planning/17-core-sealed-columns/PLAN.md`) implemented it. What remains is one verification ticket and one conditional residue |
| Dependency category | Part A: **in-process**. It touches only `@awthaq/organization` and moves no I/O seam. Part B residue: **local-substitutable** (the SQL adapters, SQLite and Postgres) |
| Wave / position | **A**: independent. The A0 hotfixes (tickets 02–04) can land at once, and A1–A3 can follow at any time. A depends on no other plan. **B**: ticket 21 runs right after the merge of `main` into `architecture/deepening-plans-2` is committed. It verifies that batch-2 plan 17 survived the merge. Tickets 22–23 run only if residue R1's gate opens |
| Touched packages | A: `@awthaq/organization` (src, tests) and `features/` (BDD). B: none for ticket 21; `@awthaq/sql` and its docs if R1 opens |
| Wire change | **A: yes, three answers change** (§3.A.8). An outsider's role request while dynamic access control is off goes from `403` to `404`. Acting on an invitation of a suspended organization goes from `2xx` to `404`. A suspended organization's active pointer reads as none. **B: none** |
| ADRs | A amends [ADR-EA-040](../../spec/decisions/040-plugin-exposes-domain-services.md): a new decision 6, revision 1.1. For B, [ADR-EA-019](../../spec/decisions/019-encryption-key-rotation.md) is already at revision 1.3 (batch-2 plan 17); it gets a revision 1.4 only if R1 opens. No new ADR numbers (ADR-EA-042 to 046 are taken) |
| Tickets | `.scratch/30-speculative-followups/issues/NN-*.md`: Part A is 01–12, Part B is 21–23 |
| Verified at | **2026-11-08, twice.** First pass: `chore/effect-4.1-peer-deps` at `ede063d8`, the brief's base (HEAD was one commit past the brief's `6c5377f8`). While this plan was being written, the checkout changed to `architecture/deepening-plans-2` at `5a0e8df4`, with a merge of `origin/main` (`935d15ee`) staged and conflict-free (`git diff --name-only --diff-filter=U` prints nothing). **Every `file:line` below is re-verified against that current tree.** Part A's files are identical on both trees, with two exceptions. `Organization.ts` has 3 more lines (batch-2 plan 17's `sealedColumns` declaration), so every `Organization.ts` line cited here is 3 higher than on `ede063d8`. `OrganizationHandlers.ts` now reads its caller through batch-2 plan 11's `CurrentUser`. Effect `^4.1.2` (catalog), `4.1.2` installed; TypeScript `7.0.2` |

Every count and `file:line` below was re-measured against the working tree. §2.1 gives the commands so an executor can re-run them. Where the review's numbers were wrong, the "Evidence corrections" subsections (§2.A.6, §2.B.4) say so.

Conventions: everything in [`.planning/README.md` § Shared conventions](../README.md#shared-conventions-apply-to-every-plan) applies:

- No `as` (no `as const`, no `as unknown as`) in library source, and no return-type annotations on new Effect or Layer consts.
- Type-system first.
- Replace, don't layer, when moving tests.
- Spec, traceability and BDD updates, and a changeset with a `Migration:` note for every package-visible change.
- The per-phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Run `pnpm check` per part.
- Part B's residue runs `pnpm test:pg` (ticket 21, and 22–23 if built). Part A changes no SQL. It needs `pnpm test:pg` only if ticket 03 touches a records statement, and it does not plan to.

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality**. "Authorized interface" and "system interface" carry plan 04's meaning: the first is what a signed-in member reaches over HTTP, the second is what trusted code calls with an explicit `Actor`.

---

## 0. How to read this plan

The two parts share a plan only because both are speculative follow-ups of the same review. They share no file, no ticket and no gate:

| | Part A | Part B |
|---|---|---|
| Problem | The MTI-009 ordering is a security invariant, and each of 29 authorized methods writes it by hand | On `main`, six core sealed columns sat outside `SealedColumn`. **On the current base, batch-2 plan 17 has already moved them** |
| Deepened module | `OrganizationAccess` (package-private), plus a branded access proof. `OrganizationAuthority` mints every ceiling | Nothing new. `CoreSealedColumns`, `SealedColumn.Deployed` and `auth.sealedColumns` already exist |
| Gate default | **GO** (live bugs found, §2.A.4) | **Superseded.** Ticket 21 (verify): GO. R1 (re-key rows sealed before revision 1.3): NO-GO unless an environment is named |
| Lands even if NO-GO | Tickets 02–04 (spec violations) | Ticket 21 |

Sections 1–10 have an **A** and a **B** subsection wherever the parts differ. The ticket table (§4.C) and the acceptance checklist (§9) keep them separate.

---

## 1. Summary, goals, non-goals

### 1.A Part A: organization authorization as one primitive

#### 1.A.1 Go/no-go gate

**Evidence that justifies building the primitive.** Any one item is enough. All three hold on code reading today. Ticket 01 turns them into red tests before anything is built:

1. **A live bug caused by a per-method ordering choice.** A-F1: the five role endpoints run the dynamic-access-control gate *before* the membership check. With the feature off (the default, `OrganizationConfig.ts:100`), an outsider gets `403 DynamicAccessControlDisabled` for an existing organization and `404 OrganizationNotFound` for an unknown one. That is the organization-existence oracle BEH-EA-284 forbids, and it was fixed for teams (PV-300, `AuthHttp.test.ts:220`) but not for roles.
2. **A live bug caused by a missing step.** A-F2 to A-F5: four operations act on a suspended organization, which BEH-EA-237 forbids "for members and outsiders alike". `cancelInvitation` and `getInvitation` skip `requireOrganization`. The invitee's `accept`, `reject` and `getInvitationByToken` have no suspension check in the system module. The active context reports and accepts a suspended organization's pointers.
3. **More than two hand-written variants of one check.** There are five variants of "is the caller a member" (§2.A.3), three patterns for the permission-denial audit, and two recomputations of a ceiling the check had just computed.

**Evidence against.** If ticket 01's red tests show that none of A-F1 to A-F5 reproduces (the reading was wrong), the primitive is a refactor without a bug. Then the gate is NO-GO and only the regression tests are kept. The hotfix tickets 02–04 are **not gated**: they fix spec violations and land either way. The gate decides phases A1–A3 (tickets 05–12).

**Recommended default: GO** (§10 Q1).

#### 1.A.2 Summary

Plan 04 split `@awthaq/organization` into an authorized interface (`Organization`, 41 methods) over eight system modules. It decided that the authorized interface contains only authorization (BEH-EA-330). It also planned to put that authorization behind one internal helper module (`internal/authorize.ts`, plan 04 §3.6). That helper was never built. Plan 04's implementation record (§11, "What was done differently", Phase 1) says the helpers stayed in `Organization.ts` "because they need the closure's services". So `Organization.ts` (861 lines) still writes the ordering by hand in every method:

```
requireOrganization (EP-003)  →  requireMembership (MTI-009)  →  [feature gate, PV-300]  →  requirePermission (PermissionEngine + PERS-005)  →  effectivePermissionsOf (the ceiling)
```

It does so with 27, 8, 19 and 6 call sites, plus a fifth helper, `requireTeamsFor`, with 12, plus two inline re-implementations. The ordering is a security invariant, and each method has to get it right on its own. Five do not (§2.A.4).

This part replaces the hand-written ordering with one package-private primitive, `OrganizationAccess`:

- It has **six entry points** (`member`, `teamMember`, `require`, `requireRole`, `requireOnTeam`, `invitation`) and two continuations (`alsoOnTeam`, `upgrade`). Each one fixes the order internally, so a method chooses *what* it needs and never *how* to check it.
- Each entry point returns a **branded proof**: `MemberAccess` (visibility) or `StatementAccess<R, A>` (a statement held in scope). Only `OrganizationAccess` can mint one.
- A proof carries the organization id it was checked against, the `User` actor, and, for a statement, the **ceiling** the caller may confer (`Bound.Ceiling` over the same statements the check read). The authorized implementation takes all three from the proof.
- **A `Bound.Ceiling` can be minted only by `OrganizationAuthority`.** It mints the proof's ceiling and, through `ceilingOf`, an identity provider's. So no code path can make a role-conferring system call on behalf of a member without the statement check that produced its ceiling. The compiler enforces this, not a comment.
- A 41-entry **policy table** (`internal/policy.ts`) is checked for completeness against `keyof OrganizationShape`. The authorization-matrix test is derived from it, so a new endpoint without a policy entry does not compile, and its probes are generated.

Fixing the live bugs is not the main payoff. That would take three small patches, which are tickets 02–04. The payoff is that the next endpoint cannot reintroduce them.

#### 1.A.3 Goals

- **GA1.** Every organization-scoped authorized method obtains its access through exactly one `OrganizationAccess` entry point. `Organization.ts` contains no `requireOrganization`, `requireMembership`, `requirePermission`, `effectivePermissionsOf`, `requireTeamsFor`, `teamCeiling`, `ceilingOfMember` or `mayReadInvitation`, and a static guard test enforces this.
- **GA2.** The order is written once per entry point: active organization (EP-003), then membership (MTI-009), then the feature gate (PV-300), then the statement (PermissionEngine), then the proof. A non-member's answer never depends on an optional feature (BEH-EA-284), for roles as well as teams.
- **GA3.** BEH-EA-237 holds on every path that names an organization, a team or an invitation of one: authorized methods, the invitee's acts, and the active context.
- **GA4.** PERS-005 is uniform. Every statement-gated method publishes `auth.organization.permissionDenied` for a non-member (`notMember`) and for a member without the statement (`missingStatement`) (§10 Q2).
- **GA5.** The ceiling of a role-conferring call made for a member is the one minted with its access proof. `Bound.Ceiling` is not constructible outside `OrganizationAuthority` (type test).
- **GA6.** One authorization-matrix suite, derived from the policy table, replaces the hand-listed non-member probes (replace, don't layer). `Organization.ts` shrinks to ≤ 700 lines.

#### 1.A.4 Non-goals

- **No change to the system interfaces' contract.** They keep taking an `Actor` and never authorize (plan 04 §3.2, ADR-EA-040 decision 5). Requiring a proof there is open question Q5, recommended **no**. SCIM, SAML and AdminTenants have no principal to prove anything with.
- **No qadi round trip for the organization's own endpoints.** `PermissionEngine` stays the evaluator ([ADR-EA-025](../../spec/decisions/025-global-roles-vs-organization-roles.md); plan 04 Q9, decided "no"). `OrganizationAccess` adds no permission model, policy language or authorizer of its own, so [ADR-EA-009](../../spec/decisions/009-authorization-delegated-to-qadi.md) is untouched. It consolidates the one gate the plugin already owns. Publishing the policy table to qadi's permission registry (Path B, BEH-EA-158) is Q7, recommended **no**.
- **No change to `OrganizationShape`.** All 41 signatures and error unions stay, so `OrganizationHandlers.ts` does not change.
- **No change to `PermissionEngine` semantics, statements or role tiers.**
- **Not `SamlAdmin` or `AdminTenants`.** Their gates are platform-tier (`canManageSaml`, `canAdministerTenants`), a different authority.
- **Not who may list invitations.** Any member can list an organization's invitations, but reading one invitation needs `invitation:create`. A-F9 records this as an inconsistency, Q6 asks, and this part keeps today's behaviour.

### 1.B Part B: core sealed columns under `SealedColumn` (superseded)

#### 1.B.1 Go/no-go gate

**Status: superseded on the current base.** The candidate is word for word the candidate of batch-2 plan 17, "Core sealed columns onto `SealedColumn`", from the review of 2026-10-17. That plan's "Decisions taken (implementation, 2026-10-18)" record says it was implemented, with every gate run, `pnpm test:pg` on Docker Postgres included. These commits on `architecture/deepening-plans-2` carry it:

- `89d12ef8`: phase 0, the bugs pinned as expected failures.
- `1a206af6`: phase 1, `Sealed` in ports, `Deployed`/`sweepDeployed`, a savepoint re-seal.
- `b97c8c20` and `9416e17a`: phases 2–3, PII and provider tokens on `SealedColumn`, crossing the ports sealed.
- `7f3f6bf6` and `5cbf528b`: phase 4, `Persistence.sql` provides `Deployed`; ADR-EA-019 revision 1.3, BEH-EA-339, the runbook.
- `9e6302fe`: phase 5, plugins declare `sealedColumns`.

Batch-2 plan 16 ("Fold `Repositories` into the SQL store adapters") then deleted `Repositories.ts` (`bb72df50` … `6b68edcc`). The review's evidence (`packages/sql/src/Repositories.ts:74-128, 794-934`) describes `main` before batch 2. I measured it there (`ede063d8`) before the checkout changed (§2.B.2), and on the current tree none of it exists (§2.B.1).

**Genuinely open residue**, each with its own gate:

- **R1: rows sealed under the core spellings used before revision 1.3** (`user:<id>:metadata`, `session:<id>:<field>`, `<providerId>:<userId>:<field>`). Plan 17's Q1 took "no environment holds such rows: a clean break". The re-key it designed (§3.8 "design B": `SealedColumn.rekey` plus `CoreSealedColumns.previousAad`, phase 2b) was **not built** (`grep -rn "rekey\|previousAad" packages/*/src` finds nothing). This is the brief's "key-rotation migration path for existing rows".
  - *Evidence that justifies building it:* the maintainer names an environment that ran a build from before batch 2 with core rows sealed. It matters most for `users.metadata` with `encryptPii` on, which is real data loss without a re-key. Tokens heal through re-consent, and session IP/UA is display only.
  - *Evidence against:* no such environment exists. Plan 17's record says so, and `git tag` is still empty.
  - **Recommended default: NO-GO** (§10 Q8).
- **R2: does batch 2's guarantee survive the merge of `main`?** The staged merge rewrites `packages/ports/src/Encryption.ts` (163 changed lines, the effect 4.1 upgrade) under every sealed column. Ticket 21 re-runs batch 2's own proof on the merged tree: the core wiring suite, the mechanism suite and `pnpm test:pg`. **Recommended default: GO** (cheap, and it lands either way).
- **R3: the `adoptPlaintext` sunset.** ADR-EA-019 revision 1.2 names a sunset ticket (`.scratch/plugin-table-substrate/issues/16-adopt-plaintext-sunset.md`). That file does not exist in this checkout, and plan 17's record says it "was not ticked". **Out of scope here.** It is a separate decision with its own gate (a `plaintext: 0` census), recorded so it is not lost.

The brief's coordination question ("land after or inside plan 14") is **answered by history.** Batch 2 ran core sealed columns (its plan 17) *before* the repository fold (its plan 16, plan 17's Q8: "17 first"), and both are done. This round's plan 28 (sql-store-adapters, drafted as "14") overlaps batch-2 plan 16. That is for the orchestrator to reconcile (§8), and it is not a ticket here.

#### 1.B.2 Goals (residue only)

- **GB1 (R2).** On the merged base, every Part B claim of §2.B.1 holds. These pass on SQLite and Postgres: `packages/test/test/CoreSealedColumns.test.ts`, `packages/sql/test/SealedColumn.test.ts` and BDD REQ-EA-1320.
- **GB2 (R1, only if GO).** Rows sealed under a spelling from before revision 1.3 move to the canonical AAD through one offline, idempotent, reversible operator effect. Nothing is deleted. The effect is removed before the first tag.

#### 1.B.3 Non-goals

- Re-planning anything batch-2 plans 16 and 17 delivered: declarations, adapters, `Sealed` in ports, `Deployed`, plugin `sealedColumns`, the runbook and ADR-EA-019 revision 1.3.
- A per-column AAD override, which plan 17 §3.8 "design A" rejected. A CLI (plan 17 Q5). Sealing in the `Ref` adapters (plan 17 Q6).
- R3, the `adoptPlaintext` sunset.

---

## 2. Verified current state

### 2.1 Re-measurement commands

```bash
# ---- Part A ----
# Call sites of each authorization helper in the authorized interface (definitions excluded)
for h in requireOrganization requireMembership requirePermission effectivePermissionsOf requireTeamsFor teamCeiling ceilingOfMember; do
  printf '%-24s %s\n' "$h" "$(grep -n "\b$h(" packages/organization/src/Organization.ts | grep -v "const $h" | wc -l)"; done
# expected today: 27 8 19 6 12 2 2

# The same names anywhere else in the package (expect Organization.ts, plus OrganizationQadi.ts in a doc comment only)
grep -rln "\brequireOrganization\b\|\brequireMembership\b\|\brequirePermission\b\|\beffectivePermissionsOf\b" packages/organization/src

# Sibling modules: suspension checks and caller authorization (expect: requireActive / findActive guards only)
grep -n "requireActive\|findActive\|isSuspended\|hasPermission" packages/organization/src/Organization{Members,Teams,Invitations,Connections,ActiveContext,Roles}.ts

# The system invitation acts and the active context: where is the suspension step? (expect 1 line: create, :304)
grep -n "requireActive" packages/organization/src/OrganizationInvitations.ts

# Who constructs a ceiling or a User actor
grep -rn "Bound\.Ceiling\|OrganizationActor\.user\b" packages features --include=*.ts | grep -v "/lib/"

# HTTP probes that pin MTI-009 today (roles are absent from the teams-disabled probe)
grep -n "PV-300\|/roles" packages/organization/test/AuthHttp.test.ts

# ---- Part B (current base: batch-2 plans 16 and 17 are executed) ----
# The repository layer is gone (batch-2 plan 16 phase 6, 11416585)
ls packages/sql/src/Repositories.ts 2>&1                                       # expect: No such file
# No hand-written core codec, AAD helper or core re-seal knob remains
grep -rnE "PiiCodec|sealedPii|userMetadataAad|sessionAad|tokenAad|AccountsRepositoryConfig|reencryptOnRead" packages/*/src --include=*.ts | grep -v "/lib/"
#   expect 2 lines: SessionStoreSql.ts:115 and :120, `PiiCodecs`, a local name for a pair of SealedColumn codecs
# The six declarations and who builds codecs over them
grep -c "SealedColumn.column(" packages/sql/src/CoreSealedColumns.ts            # expect 6
grep -rn "CoreSealedColumns\.\w*" packages/sql/src packages/core/src --include=*.ts | grep -v "/lib/" | awk -F: '{print $1}' | sort | uniq -c
#   expect AccountStoreSql 5, SessionStoreSql 4, UserStoreSql 3, CoreStoresSql 2, index 2
# Core columns under the wiring suite, on Postgres too
grep -c "runSealedColumnTests" packages/test/test/CoreSealedColumns.test.ts    # expect 3
grep -n "CoreSealedColumns" scripts/test-pg.sh                                 # expect :29
# The deployment-wide sweep and the plugin declarations
grep -n "export class Deployed\|export const sweepDeployed" packages/sql/src/SealedColumn.ts   # expect :350, :370
grep -rln "sealedColumns:" packages/*/src --include=*.ts | grep -v "/lib/"     # expect jwt, organization, saml, two-factor, webhooks (+ core's Auth/AuthPlugin)
# ADR and behaviour
grep -n "^> | Revision" spec/decisions/019-encryption-key-rotation.md            # expect 1.3
grep -n "^## BEH-EA-339" spec/behaviors/05-persistence-stratum.md               # expect :217
# R1: is a re-key path present? (expect nothing: plan 17 Q1 chose a clean break)
grep -rn "rekey\|previousAad" packages/*/src --include=*.ts | grep -v "/lib/"
# R2: what the merge of main changes under the sealed columns
git diff HEAD --stat -- packages/ports/src/Encryption.ts packages/sql/src/SealedColumn.ts packages/sql/src/CoreSealedColumns.ts
# Release state (R1's window)
git tag | wc -l; grep '"version"' packages/core/package.json packages/sql/package.json
```

### 2.A Part A: the authorized interface today

#### 2.A.1 Where the code is

| File | Lines | Role |
|---|---|---|
| `packages/organization/src/Organization.ts` | 864 | Plugin class and `make`, which **is** the authorized implementation. Helpers: `effectivePermissionsOf` `:163` (an alias of `authority.effectivePermissions`), `requirePermission` `:170-206`, `requireMembership` `:209-217`, `requireOrganization` `:225` (an alias of `directory.requireActive`), `mayReadInvitation` `:468-485`, `ceilingOfMember` `:530-537`, `requireTeamsFor` `:618-619`, `teamCeiling` `:625-636` |
| `packages/organization/src/OrganizationShape.ts` | 515 | The 41-method authorized interface (unchanged by this plan) |
| `packages/organization/src/OrganizationHandlers.ts` | 570 | Decoding, DTO mapping, one call into the shape. **No authorization** (`grep -n "Permission\|requireActive" OrganizationHandlers.ts` matches only record imports) |
| `packages/organization/src/OrganizationAuthority.ts` | 209 | Read-only module: `statementsByRole`, `effectivePermissions` `:121-127`, `teamAuthority` `:135-149`, `attributesFor`, `checkRoleCeiling` `:168-187` (checks `requireActive` itself), `ceilingOf` `:189-198` (the only `Bound.Ceiling` outside `Organization.ts`) |
| `packages/organization/src/OrganizationActor.ts` | 55 | `ActorSchema`, `user(principal)` `:32-33`, `Bound` `:50-54` (`Data.taggedEnum`, public constructors) |
| `packages/organization/src/OrganizationInvitations.ts` | 665 | System invitations. `create` checks `directory.requireActive` (`:304`). `accept` `:448-609`, `reject` `:611-632` and `cancel` `:634-648` do not |
| `packages/organization/src/OrganizationActiveContext.ts` | 163 | `isSuspended` `:75-80`. `get` `:82-117` has no suspension check. `setOrganization` `:119-131` and `activeMembership` `:145-158` check it. `setTeam` `:133-143` does not |
| `packages/organization/src/OrganizationTeams.ts`, `OrganizationRoles.ts` | 761, 236 | Each has a `requireEnabled` feature gate (`Teams :283`, `Roles :114`) and a `gate = requireActive → requireEnabled` (`Teams :295-296`, `Roles :123-124`) for its own system operations |

#### 2.A.2 The ordering, method by method

Legend: **V** = `requireOrganization` (active, EP-003). **M** = `requireMembership` (MTI-009). **G** = feature gate. **S** = `requirePermission` (which also reads the membership and publishes `notMember`/`missingStatement`). **C** = ceiling recomputed with `effectivePermissionsOf`.

| Pattern | Methods (`Organization.ts` lines) | Count | Verdict |
|---|---|---|---|
| V → M | `get` 257, `getFull` 263, `listMembers` 311, `leave` 359, `listInvitationsForOrganization` 513 | 5 | correct |
| V → S | `update` 276, `delete` 292 | 2 | correct; a non-member is audited `notMember` |
| V → S → C | `invite` 399 | 1 | correct; C re-reads what S computed (A-F8) |
| V → M → S | `removeMember` 319 | 1 | correct; membership read twice; a non-member is **not** audited (A-F6) |
| V → M → S → C | `updateMemberRole` 335 | 1 | as above, plus A-F8 |
| V → **G** → S (→ C) | `createRole` 539, `listRoles` 558, `getRole` 567, `updateRole` 576, `deleteRole` 595 | 5 | **live bug A-F1**: the gate runs before membership |
| V → M → G | `listTeamAncestors` 684, `listTeamDescendants` 692, `listTeams` 700, `listUserTeams` 710, `listTeamMembers` 742 | 5 | correct (PV-300) |
| V → M → G → S(team) (→ C) | `createTeam` 638 (parent scope), `updateTeam` 718, `removeTeam` 732, `addTeamMember` 751, `updateTeamMemberRole` 777, `removeTeamMember` 799; `moveTeam` 659 (S twice) | 7 | correct order; a non-member is not audited (A-F6); team scope not checked against the organization (A-F7, latent) |
| find → inline M → status → S | `cancelInvitation` 435 | 1 | **live bug A-F2**: no V |
| find → inline M + `hasPermission` or invitee | `getInvitation` 487 (via `mayReadInvitation` 468) | 1 | **live bug A-F3**: no V; and a second, unaudited permission evaluator |
| (system module) | `acceptInvitation` 423, `rejectInvitation` 429, `getInvitationByToken` 498 | 3 | **live bug A-F4**: no suspension check anywhere on the path |
| (system module, session) | `getActive` 389, `setActiveTeam` 813 | 2 | **live bug A-F5**: suspension not checked |
| none needed | `create` 229 (config policy), `checkSlug` 252, `list` 254, `listInvitationsForUser` 522, `getActiveMember` 377, `getActiveMemberRole` 380, `setActive` 383 (module checks) | 7 | correct |

Sum: 5+2+1+1+1+5+5+7 = **27** methods take V, which matches the 27 `requireOrganization` calls. Of the 41 methods, 29 name an organization, a team or an invitation of one, and 12 do not.

#### 2.A.3 Five variants of "is the caller a member"

1. `requireMembership` (`:209-217`): `memberSystem.find` → `OrganizationNotFound`, no audit.
2. Inside `requirePermission` (`:188-192`): `memberSystem.find` → audit `notMember` → `OrganizationNotFound`.
3. `requireTeamsFor` (`:618-619`): variant 1 followed by `teamSystem.requireEnabled`.
4. Inline in `cancelInvitation` (`:449-452`): `memberSystem.find` → `InvitationNotFound`, no audit.
5. Inline in `mayReadInvitation` (`:473-480`): `memberSystem.find` → `effectivePermissionsOf` → `hasPermission("invitation","create")`. This is a second statement evaluator, with no denial audit.

#### 2.A.4 Findings

| # | Kind | Finding and evidence | Spec |
|---|---|---|---|
| **A-F1** | **live bug** (information disclosure) | **Role endpoints are an organization-existence oracle.** `createRole`, `listRoles`, `getRole`, `updateRole` and `deleteRole` run `roleSystem.requireEnabled` (`Organization.ts:542, 561, 570, 579, 598`) before `requirePermission`, the first membership read. With `dynamicAccessControl.enabled: false` (the default, `OrganizationConfig.ts:100`), an outsider gets `403 DynamicAccessControlDisabled` (`OrganizationErrors.ts:129-133`) for an existing active organization, and `404 OrganizationNotFound` (from `requireOrganization`) for an unknown or suspended one. Tests miss it: the HTTP probe at `AuthHttp.test.ts:166-219` lists no role path, the teams-disabled probe (`:220-250`) covers only teams, and BDD REQ-EA-715 (`35-organization.feature:84-111`) runs its role rows with "dynamic access control is enabled" | BEH-EA-284: "The answer to a non-member MUST NOT depend on which optional features are enabled" |
| **A-F2** | **live bug** | **`cancelInvitation` acts on a suspended organization.** It finds the invitation, checks membership inline, checks status, then `requirePermission` (`:435-464`). There is no `requireOrganization`, and the system `cancel` (`OrganizationInvitations.ts:634-648`) has no `requireActive`. A member holding `invitation:cancel` cancels a pending invitation of a suspended organization: it writes, runs veto and observe points, and publishes `invitationCanceled`. The EP-003 test (`Organization.test.ts:1380-1411`) probes only `get`, `update` and `invite` | BEH-EA-237: "MUST refuse every organization-scoped operation … members and outsiders alike" |
| **A-F3** | **live bug** | **`getInvitation` reads a suspended organization's invitation** for a member holding `invitation:create` (`:468-496`), because `mayReadInvitation` has no active check | BEH-EA-237 |
| **A-F4** | **live bug** (system module) | **The invitee's acts ignore suspension.** `accept` (`OrganizationInvitations.ts:448-609`) runs the veto, the token, expiry, address, verification and limits, then **creates a membership** in a suspended organization. `reject` (`:611-632`) and `getInvitationByToken` (`Organization.ts:498-511` → `invitationSystem.findByToken`) have no check either | BEH-EA-237 |
| **A-F5** | **live bug** (system module, low severity) | **The active context reports and accepts a suspended organization's pointers.** `get` (`OrganizationActiveContext.ts:82-117`) returns `activeOrganizationId` of a suspended organization (only `activeMembership` filters it, `:150-152`). `setTeam` (`:133-143`) accepts a team of a suspended organization. BDD REQ-EA-855 checks `activeMembership` and `setOrganization` only | BEH-EA-237: "MUST not become or remain a member's active organization" |
| A-F6 | audit gap (PERS-005) | **Whether an outsider's attempt is audited depends on the endpoint.** `requirePermission` publishes `notMember` (`:188-191`), but only methods that call it *first* reach that branch: `update`, `delete`, `invite`, and roles when the feature is on. `removeMember`, `updateMemberRole`, `cancelInvitation` and all seven team writes check membership first through variants 1, 3 and 4, which publish nothing. The test "a non-member's denied delete is recorded with reason notMember" (`Organization.test.ts:1258-1272`) pins the audited path only | PERS-005 (`spec/models/14-organization.md:137`) |
| A-F7 | latent | **Team scope is not checked against the organization.** `teamAuthority(userId, organizationId, teamId)` (`OrganizationAuthority.ts:135-149`) scopes the ancestors (`getAncestors(organizationId, teamId)` returns `[]` for a foreign team, `TeamRecords.ts:315-323`) but reads `findTeamMembership(teamId, userId)` for the named team itself, unscoped. A member of A who leads team T of B passes `requirePermission(caller, A, "team", "update", T)`. The system module then refuses (`OrganizationTeams` `requireTeam` is scoped), so the answer is `404` and nothing changes. The decision itself was wrong | BEH-EA-284 (cross-organization ids) |
| A-F8 | redundancy | The membership is read twice in `removeMember`, `updateMemberRole` and the seven team writes. The ceiling is recomputed after `requirePermission` already computed it (`:347, :417, :535, :632`), at 1–3 extra store reads per write | — |
| A-F9 | inconsistency (not a spec violation) | Any member can list an organization's invitations, including the invitee addresses (`listInvitationsForOrganization` `:513-520`, V → M). Reading one invitation by id needs `invitation:create` or being the invitee (`:468-485`). The spec is silent | Q6 |

**Live bugs confirmed: 5 (A-F1 to A-F5), by code reading.** None was executed, because the brief forbids test edits. Ticket 01 reproduces each as a red test before any fix. A-F1 and A-F2 are the security-relevant ones. A-F1 lets any signed-in user enumerate organization ids under the default configuration. A-F2 lets a suspended tenant's administrators keep acting.

#### 2.A.5 What plan 04's record says about this code

- Phase 1: "the authorized layer keeps `requirePermission` and `requireMembership` in `Organization.ts` (the plan's `internal/authorize.ts` extraction was not made …)". This part makes that extraction, as a module with a proof rather than a bag of helpers.
- D4 (permission before the owner invariant) and D6 (a cancellation's veto runs after authorization) stay. The proof is obtained before the system call, exactly as today.
- Q7: `Actor` lives in `@awthaq/organization`. Q9: no qadi gating. Both stand.
- Phase 0's circularity lesson (`pnpm circular` counts type-only cycles) applies: `internal/access.ts` imports system modules and `OrganizationAuthority`, and nothing imports `Organization.ts`.

#### 2.A.6 Evidence corrections (Part A)

- **The counts are exact; the location is not.** The review's figures of 27, 8, 19 and 6 call sites match `requireOrganization`, `requireMembership`, `requirePermission` and `effectivePermissionsOf` exactly (§2.1 command). All of them are in `Organization.ts`. The sibling modules have **zero**: `OrganizationMembers`, `OrganizationTeams`, `OrganizationInvitations`, `OrganizationConnections` and `OrganizationHandlers` contain none of these helpers. The system modules take an `Actor` and do not authorize (plan 04 G3, BEH-EA-330). Their only related lines are suspension guards on their own writes (`Members :157-158`, `Teams :292-296`, `Invitations :304`, `Connections :445-455`, `Roles :123-124`). The four `requireOrganization*` hits in `OrganizationTeams.ts` are `requireOrganizationMember` (`:330`, called at `:374, :569, :675`), a check that a roster *target* is a member, not caller authorization.
- `requireOrganization` is not a helper of its own. It is `directory.requireActive` under another name (`Organization.ts:225`).
- The review missed a fifth helper, `requireTeamsFor` (12 calls), and two inline re-implementations (§2.A.3, variants 4 and 5).
- The ordering differs in **three** places that matter (roles, invitation-id paths, the audit), and steps are missing in **two system modules** the review did not name (`OrganizationInvitations`, `OrganizationActiveContext`).

### 2.B Part B: core sealed columns on the current base

#### 2.B.1 The brief's claims, checked against the current tree

| The brief / review (measured on `main`) | Current base (`architecture/deepening-plans-2` + staged merge) | Evidence |
|---|---|---|
| `users.metadata`, session IP/UA and account tokens use a separate `PiiCodec` and token path (`Repositories.ts:74-128, 794-934`) | **Gone.** `Repositories.ts` is deleted, and each adapter builds a codec over a declaration: `AccountStoreSql.ts:99-101` (`SealedColumn.sqlCodec(CoreSealedColumns.accounts*)`), plus `UserStoreSql.ts` and `SessionStoreSql.ts` | §2.1 Part B commands; commits `0a449314`, `79909faf`, `11416585`, `b97c8c20`, `9416e17a` |
| Null-and-warn behaviour and their own AAD formats | **Canonical AAD** `<table>:<rowKey>:<column>` (`CoreSealedColumns.ts:8-9`). The core ports carry `Sealed` values (`packages/ports/src/Sealed.ts:32`, `plain` at `:37`), so the domain chooses the treatment: PII degrades, and tokens fail typed (`ProviderTokensUnreadable`, plan 17 Q2/Q3) | ADR-EA-019 rev 1.3, "The unreadable decision moves to the domain" |
| `SealedColumn.sweepAll` cannot rotate them | **It can.** `CoreSealedColumns.deployed(options)` (`:72-76`), `SealedColumn.Deployed` (`SealedColumn.ts:350`) and `sweepDeployed` (`:370`). `Persistence.sql` provides `Deployed`. Plugins declare `sealedColumns` (5 plugins), and `auth.sealedColumns` is the sweep's `also` (`packages/core/src/Auth.ts:581`) | BEH-EA-339 (`05-persistence-stratum.md:217`), REQ-EA-1320 |
| `runSealedColumnTests` does not cover them | **It does.** `packages/test/test/CoreSealedColumns.test.ts` (in `scripts/test-pg.sh:29`), including "a token moved to another account of the same user and provider does not open" (`:157`) | plan 17 record: "The core columns test lives in `packages/test/test/`" |
| ADR-EA-019 decision 6 keeps core's formats deliberately; draft the amendment | **Amended.** Revision 1.3 (2026-10-18), "Revision 1.3: core columns" (`019-encryption-key-rotation.md:55-61`) | the file |
| A key-rotation migration path for existing rows | **Not built, deliberately.** Revision 1.3: "an internal environment with sealed core rows either accepts re-consent … and the loss of sealed `users.metadata`/session PII, or runs a one-off re-key it writes for itself. A shipped `SealedColumn.rekey` was considered and not built: no named environment needs it." | `:58`; residue **R1** |
| Coordinate with plan 14 (fold repositories) | **Done, in the other order.** Batch-2 plan 17 (Q8 "17 first") then batch-2 plan 16 | §1.B.1 |

#### 2.B.2 Findings measured on `main` (`ede063d8`) before the checkout changed, and their status

I re-measured the review's candidate on the brief's base before the switch. Each finding matches one of batch-2 plan 17's, and each is closed on the current base:

| # | Finding on `main` | Status on the current base |
|---|---|---|
| B-F1 | A key retirement cannot finish for core rows: no sweep exists, and `aadOf` cannot express `user:`/`session:` or the token spelling | Closed: `sweepDeployed` over `Deployed` (BEH-EA-339) |
| B-F2 | Opting into `encryptPii` never finishes for dormant rows (adoption happens on read only) | Closed: `Deployed` lists the adopting columns when `encryptPii` is on (plan 17 record) |
| B-F3 | The token AAD `<providerId>:<userId>:<field>` does not bind the row: two accounts of one user under one provider share it | Closed: `accounts:<id>:<field>`, with test `CoreSealedColumns.test.ts:157` |
| B-F4 | Two re-seal knobs (`AccountsRepositoryConfig.reencryptOnRead`, `SealedColumnConfig.resealOnRead`) | Closed: one knob (ADR rev 1.3) |
| B-F5 | Core's unreadable warnings carry no ids | Superseded: the domain chooses the treatment over a `Sealed` value |
| B-F6 | Six hand-written compare-and-swap statements | Closed: `sqlSwap`, now in a savepoint (rev 1.3) |
| B-F7 | The mechanism is tested twice (core's bespoke suites) | Closed: core runs the shared wiring suite |
| B-F8 | Dead degraded token read path | Closed: deleted (plan 17 record: `findById`, `listByUser`, `findTokensById`, `AccountTokenUndecryptable`) |

#### 2.B.3 Release state (R1's window)

`git tag | wc -l` prints `0`, and `packages/core` and `packages/sql` are both at `0.1.0`. No outside operator can hold core rows under a spelling from before revision 1.3. Only an internal environment that ran a build from before batch 2 can.

#### 2.B.4 Evidence corrections (Part B)

- **The review's line ranges describe `main` before batch 2.** On the current base, `Repositories.ts` does not exist and every range is void. On `main` they were close: `PiiCodec` is `:74-122` and the token path `:787-964`.
- **The candidate is not new.** The review of 2026-10-17 found it, with three live bugs: the documented runbook corrupted `users.metadata`, the token AAD did not bind the row, and key retirement could not finish (plan 17 header). The 2026-11-08 review re-found it on a branch without batch 2.
- **There are six columns, not five.** `accounts.idToken` is sealed too, on both trees.

---

## 3. Target design

### 3.A Part A: `OrganizationAccess` and the access proof

#### 3.A.1 Module map

```
 OrganizationHandlers ──► Organization (authorized interface, OrganizationShape: 41 methods, signatures unchanged)
                               │   each organization-scoped method:  access = yield* access.<entry>(…)  then  system.<op>(access.actor, { organizationId: access.organizationId, …, bound: access.bound })
                               ▼
                 ┌───────────────────────────────────────────────────────────────┐
                 │ OrganizationAccess (src/internal/access.ts, package-private)  │   small interface: 6 entry points + 2 continuations
                 │  order, written once per entry point:                          │   behind it: EP-003, MTI-009, PV-300, PermissionEngine,
                 │  active → member (audit notMember) → gate → statement           │   PERS-005 audit, team scoping, ceiling derivation,
                 │  (audit missingStatement) → mint proof                          │   invitation → organization resolution and error remapping
                 └───────┬───────────────┬──────────────────┬────────────────────┘
                         │ reads         │ gates            │ mints ceiling via
                         ▼               ▼                  ▼
          OrganizationDirectory   Teams/Roles.requireEnabled   OrganizationAuthority (read-only; sole minter of Bound.Ceiling:
          OrganizationMembers                                    scopedStatements, ceilingFor, ceilingOf)
          OrganizationInvitations                                     ▲
                                                                       └── OrganizationQadi (unchanged; same statements)
```

**Depth:** six small entry points stand in front of the whole ordering protocol, the audit, the team scoping and the ceiling. **Leverage:** 29 methods, plus every future endpoint. **Locality:** an MTI-009 change, such as a new gate, touches one file.

#### 3.A.2 Statements and proofs (`src/internal/access.ts`)

```ts
// @awthaq/organization — internal/access (package-private: never re-exported by index.ts)
import type { Api } from "@awthaq/api";
import { AuthEvents, Users } from "@awthaq/core";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as MembershipRecords from "../MembershipRecords.ts";
import * as OrganizationActor from "../OrganizationActor.ts";
import * as OrganizationAuthority from "../OrganizationAuthority.ts";
import * as OrganizationDirectory from "../OrganizationDirectory.ts";
import * as OrganizationErrors from "../OrganizationErrors.ts";
import * as OrganizationInvitations from "../OrganizationInvitations.ts";
import * as OrganizationMembers from "../OrganizationMembers.ts";
import * as OrganizationRoles from "../OrganizationRoles.ts";
import * as OrganizationTeams from "../OrganizationTeams.ts";
import type * as PermissionEngine from "../PermissionEngine.ts";

/** The five built-in statement resources the authorized interface gates (PermissionEngine.defaultStatements). */
export type Resource = "organization" | "member" | "invitation" | "team" | "role";

/** One statement an endpoint needs. `const` type parameters keep the literals (no `as const`). */
export interface Statement<R extends Resource = Resource, A extends string = string> {
  readonly resource: R;
  readonly action: A;
}
export const statement = <const R extends Resource, const A extends string>(resource: R, action: A) => ({
  resource,
  action,
});

// Batch-2 plan 13's clearance idiom (`packages/admin/src/internal/AdminGate.ts:235-260`, after core's SignIn
// `Clearance`): exported `Brand.Brand` types, module-local `Brand.nominal` constructors, minted only here.

/** MTI-009 passed: the organization is active and the caller is a member. Only this module mints one. */
export type MemberAccess = {
  readonly organizationId: string;
  /** Always the `User` case, built from the principal here and nowhere else (`OrganizationActor.user` is removed, §3.A.4). */
  readonly actor: OrganizationActor.Actor;
  readonly membership: MembershipRecords.MembershipRecord;
} & Brand.Brand<"awthaq/organization/MemberAccess">;

/** `MemberAccess` plus a statement held in scope, and the ceiling of what this caller may confer. */
export type StatementAccess<R extends Resource, A extends string> = {
  readonly statement: Statement<R, A>;
  readonly organizationId: string;
  readonly actor: OrganizationActor.Actor;
  readonly membership: MembershipRecords.MembershipRecord;
  /** The statements the decision read: org-level, or org merged with the team subtree's (OHS-004). */
  readonly statements: PermissionEngine.Statements;
  /** RRM-001 / OHS-004: `Ceiling(statements)`, minted by `OrganizationAuthority` from the same read. */
  readonly bound: OrganizationActor.Bound;
} & Brand.Brand<"awthaq/organization/StatementAccess">;

// Module-local: never exported (ticket 11's guard also forbids `Brand.nominal<…Access>` in any other file).
const memberAccessOf = Brand.nominal<MemberAccess>();
const statementAccessOf = <R extends Resource, A extends string>() => Brand.nominal<StatementAccess<R, A>>();
```

There is no generic "policy dispatcher". A function that switched on a policy union and returned a type computed from it would need a conditional return type, and TypeScript cannot check that without `as`. Each entry point is its own function instead, and its error union is **inferred** from the steps it composes. So `member`'s union cannot contain `OrganizationPermissionDenied`, and `get`'s signature (`OrganizationNotFound | StoreUnavailable`) keeps compiling.

#### 3.A.3 The entry points

```ts
export const make = Effect.gen(function* () {
  const directory = yield* OrganizationDirectory.OrganizationDirectory;
  const members = yield* OrganizationMembers.OrganizationMembers;
  const invitations = yield* OrganizationInvitations.OrganizationInvitations;
  const teams = yield* OrganizationTeams.OrganizationTeams;
  const roles = yield* OrganizationRoles.OrganizationRoles;
  const authority = yield* OrganizationAuthority.OrganizationAuthority;
  const events = yield* AuthEvents.AuthEvents;

  const callerId = (caller: Api.UserPrincipal) => Users.UserId(caller.ref.id);
  const actorOf = (caller: Api.UserPrincipal) =>
    OrganizationActor.ActorSchema.cases.User.make({ userId: caller.ref.id, sessionId: caller.sessionId });

  /** PERS-005: a denied statement-gated operation leaves a durable who/what/why (attempt lane, ADR-EA-037). */
  const denied = (caller: Api.UserPrincipal, organizationId: string, wanted: Statement, reason: "notMember" | "missingStatement") =>
    events.publish({
      _tag: "auth.organization.permissionDenied",
      organizationId, userId: callerId(caller), resource: wanted.resource, action: wanted.action, reason,
    });

  // ---- steps (private). They are never called in another order: only the entry points below compose them.
  /** EP-003 then MTI-009: a suspended, unknown or not-a-member organization is one answer. */
  const visibleMembership = Effect.fnUntraced(function* (caller: Api.UserPrincipal, organizationId: string, audited: Statement | undefined) {
    yield* directory.requireActive(organizationId);
    const found = yield* members.find(organizationId, callerId(caller));
    if (Option.isNone(found)) {
      if (audited !== undefined) yield* denied(caller, organizationId, audited, "notMember");
      return yield* new OrganizationErrors.OrganizationNotFound();
    }
    return found.value;
  });
  const memberAccess = (caller: Api.UserPrincipal, organizationId: string, membership: MembershipRecords.MembershipRecord) =>
    memberAccessOf({ organizationId, actor: actorOf(caller), membership });
  /** The statement on the statements in scope; `teamId` widens with team authority scoped to this organization (A-F7). */
  const granted = Effect.fnUntraced(function* <R extends Resource, A extends string>(
    caller: Api.UserPrincipal, base: MemberAccess, wanted: Statement<R, A>, teamId: string | undefined,
  ) {
    const { statements, bound } = yield* authority.scopedCeiling(base.organizationId, base.membership, teamId);
    if (!authority.holds(statements, wanted)) {
      yield* denied(caller, base.organizationId, wanted, "missingStatement");
      return yield* new OrganizationErrors.OrganizationPermissionDenied();
    }
    return statementAccessOf<R, A>()({
      organizationId: base.organizationId, actor: base.actor, membership: base.membership, statement: wanted, statements, bound,
    });
  });

  // ---- entry points: the ONLY places the order is written ----
  /** Read endpoints any member may use (get, getFull, listMembers, leave, listInvitationsForOrganization). */
  const member = Effect.fnUntraced(function* (caller: Api.UserPrincipal, organizationId: string) {
    return memberAccess(caller, organizationId, yield* visibleMembership(caller, organizationId, undefined));
  });
  /** Team reads: membership BEFORE the gate (PV-300), so a non-member never sees TeamsDisabled. */
  const teamMember = Effect.fnUntraced(function* (caller: Api.UserPrincipal, organizationId: string) {
    const membership = yield* visibleMembership(caller, organizationId, undefined);
    yield* teams.requireEnabled;
    return memberAccess(caller, organizationId, membership);
  });
  /** Org-scoped statement (update, delete, removeMember, updateMemberRole, invite). */
  const require = Effect.fnUntraced(function* <R extends Resource, A extends string>(caller: Api.UserPrincipal, organizationId: string, wanted: Statement<R, A>) {
    const membership = yield* visibleMembership(caller, organizationId, wanted);
    return yield* granted(caller, memberAccess(caller, organizationId, membership), wanted, undefined);
  });
  /** Dynamic roles: membership BEFORE the gate (fixes A-F1), then the statement. */
  const requireRole = Effect.fnUntraced(function* <A extends string>(caller: Api.UserPrincipal, organizationId: string, wanted: Statement<"role", A>) {
    const membership = yield* visibleMembership(caller, organizationId, wanted);
    yield* roles.requireEnabled;
    return yield* granted(caller, memberAccess(caller, organizationId, membership), wanted, undefined);
  });
  /** Team writes: membership, the teams gate, then the statement on `teamId` (undefined = org-level, a root). */
  const requireOnTeam = Effect.fnUntraced(function* <A extends string>(caller: Api.UserPrincipal, organizationId: string, wanted: Statement<"team", A>, teamId: string | undefined) {
    const membership = yield* visibleMembership(caller, organizationId, wanted);
    yield* teams.requireEnabled;
    return yield* granted(caller, memberAccess(caller, organizationId, membership), wanted, teamId);
  });
  /** A second statement on the same visible membership (moveTeam's destination). No new membership read. */
  const alsoOnTeam = <A extends string>(caller: Api.UserPrincipal, proof: StatementAccess<"team", string>, wanted: Statement<"team", A>, teamId: string | undefined) =>
    granted(caller, memberAccess(caller, proof.organizationId, proof.membership), wanted, teamId);
  /**
   * An invitation id names its organization: resolve it, then EP-003 + MTI-009 on that organization, every
   * miss answered `InvitationNotFound` (MTI-009 on an id path; fixes A-F2/A-F3's missing step).
   */
  const invitation = Effect.fnUntraced(function* (caller: Api.UserPrincipal, invitationId: string, audited: Statement<"invitation", string> | undefined) {
    const found = yield* invitations.find(invitationId);
    if (Option.isNone(found)) return yield* new OrganizationErrors.InvitationNotFound();
    const membership = yield* visibleMembership(caller, found.value.organizationId, audited).pipe(
      Effect.catchTag("OrganizationNotFound", () => Effect.fail(new OrganizationErrors.InvitationNotFound())),
    );
    return { access: memberAccess(caller, found.value.organizationId, membership), invitation: found.value };
  });
  /** A statement on an access already proven (cancelInvitation's `invitation:cancel` after its status check, D6). */
  const upgrade = <R extends Resource, A extends string>(caller: Api.UserPrincipal, base: MemberAccess, wanted: Statement<R, A>) =>
    granted(caller, base, wanted, undefined);

  return { member, teamMember, require, requireRole, requireOnTeam, alsoOnTeam, invitation, upgrade };
});
```

Notes for the executor:

- `granted` is generic, and `Effect.fnUntraced` with a generic generator is used elsewhere in the repo. If inference widens `R` or `A`, write `granted` as a plain generic arrow returning `Effect.gen(…)` (the same thing). Do not annotate the return type.
- `getInvitation` needs "member holding `invitation:create`, **or** the invitee". It composes `invitation(caller, id, undefined)` with `upgrade(…, statement("invitation","create"))`, catching `OrganizationPermissionDenied` and `InvitationNotFound` into an invitee check. The invitee check runs `directory.requireActive` on the invitation's organization first (A-F3), because an invitee is not a member and does not pass through `invitation`. **No denial is audited** on this read path: it is a read, and the invitee fallback is not a denial. The current behaviour is that `mayReadInvitation` publishes nothing, and that is kept (Q2 scope).
- `permissionDenied` keeps its payload. If plan 29 moves organization event definitions into the plugin, `denied` publishes the plugin-owned definition. The call site is this one function.

#### 3.A.4 `OrganizationAuthority` gains the ceiling, `OrganizationActor` loses two constructors

```ts
// OrganizationAuthority.ts — added to the read-only interface
/** Org effective statements merged with team authority on `teamId` — `{}` from a team outside `organizationId` (A-F7). */
readonly scopedStatements: (organizationId: string, membership: MembershipRecord, teamId: string | undefined) =>
  Effect.Effect<PermissionEngine.Statements, Errors.StoreUnavailable>;
/** `scopedStatements` plus the `Bound.Ceiling` over exactly those statements: the only way to mint a member's ceiling. */
readonly scopedCeiling: (organizationId: string, membership: MembershipRecord, teamId: string | undefined) =>
  Effect.Effect<{ readonly statements: PermissionEngine.Statements; readonly bound: OrganizationActor.Bound }, Errors.StoreUnavailable>;
/** Pure: `PermissionEngine.hasPermission(statements, s.resource, s.action)`. */
readonly holds: (statements: PermissionEngine.Statements, s: { readonly resource: string; readonly action: string }) => boolean;
// `teamAuthority` changes: it reads `teams.findTeamById(organizationId, teamId)` first and answers `{}` for `None`.
// `ceilingOf` (SAML) is unchanged in signature and now mints through the same private `mintCeiling`.
```

```ts
// OrganizationActor.ts — `Bound` keeps `Data.taggedEnum`, `Unbounded()` and `$match`; a Ceiling's statements are branded
export type CeilingStatements = PermissionEngine.Statements & Brand.Brand<"awthaq/organization/CeilingStatements">;
export type Bound = Data.TaggedEnum<{
  Unbounded: {};
  Ceiling: { readonly statements: CeilingStatements };
}>;
// OrganizationAuthority.ts holds the only constructor, module-local:
//   const ceilingStatements = Brand.nominal<OrganizationActor.CeilingStatements>();   // used by ceilingOf and scopedCeiling only
export const Bound = Data.taggedEnum<Bound>();
// `user(principal)` is deleted: the authorized layer gets its actor from a proof (§3.A.3 `actorOf`).
```

`OrganizationActor.Bound.Ceiling({ statements })` with plain `Statements` stops compiling everywhere, because the field now wants `CeilingStatements`. A `CeilingStatements` is assignable to `Statements`, so `internal/bound.ts` (`requireWithin`, `PermissionEngine.canGrant`) does not change. The only constructor is the module-local `Brand.nominal` in `OrganizationAuthority.ts`, so outside the package a Ceiling is reachable only through `OrganizationAuthority` (`ceilingOf`, or a proof's `bound`). Inside the package, ticket 11's guard forbids `Brand.nominal<…CeilingStatements>` and `Brand.nominal<…Access>` outside their owning files. This is the limit of the idiom: `Brand.nominal` is a public function, so the brand stops accidents, not someone determined to forge one. The admin and SignIn clearances accept the same limit. Ticket 05 checks what is left: `Data.taggedEnum` over a branded field, inference of the generic entry points, and a hook tap amending the input (the ceiling is a value, so it survives).

#### 3.A.5 The authorized implementation afterwards (examples)

```ts
// Organization.ts make — the system modules it delegates to, plus the access module
const access = yield* OrganizationAccess.make;

const get: OrganizationShape["get"] = Effect.fnUntraced(function* (caller, organizationId) {
  yield* access.member(caller, organizationId);
  return yield* directory.requireActive(organizationId);   // the record; `member` proved it active a moment ago
});

const removeMember: OrganizationShape["removeMember"] = Effect.fnUntraced(function* (caller, organizationId, targetUserId) {
  const proof = yield* access.require(caller, organizationId, statement("member", "delete"));   // D4: before the owner invariant
  yield* memberSystem.remove(proof.actor, { organizationId: proof.organizationId, userId: targetUserId });
});

const updateMemberRole: OrganizationShape["updateMemberRole"] = Effect.fnUntraced(function* (caller, organizationId, targetUserId, role) {
  const proof = yield* access.require(caller, organizationId, statement("member", "update"));
  const { membership } = yield* memberSystem
    .setRoles(proof.actor, { organizationId: proof.organizationId, userId: targetUserId, roles: role, bound: proof.bound, ifAbsent: "fail" })
    .pipe(Effect.catchTags({ AlreadyMember: Effect.die, MembershipLimitReached: Effect.die }));
  return membership;
});

const createRole: OrganizationShape["createRole"] = Effect.fnUntraced(function* (caller, organizationId, input) {
  const proof = yield* access.requireRole(caller, organizationId, statement("role", "create"));   // A-F1 fixed by construction
  return yield* roleSystem.create(proof.actor, { organizationId: proof.organizationId, role: input.role, permission: input.permission, bound: proof.bound });
});

const moveTeam: OrganizationShape["moveTeam"] = Effect.fnUntraced(function* (caller, organizationId, teamId, parentId) {
  const proof = yield* access.requireOnTeam(caller, organizationId, statement("team", "update"), teamId);
  yield* access.alsoOnTeam(caller, proof, statement("team", "update"), Option.getOrUndefined(parentId));   // OHS-004: the destination too
  return yield* teamSystem.move(proof.actor, { organizationId: proof.organizationId, teamId, parentId });
});

const cancelInvitation: OrganizationShape["cancelInvitation"] = Effect.fnUntraced(function* (caller, invitationId) {
  const { access: seen, invitation } = yield* access.invitation(caller, invitationId, statement("invitation", "cancel"));
  if (invitation.status !== "pending") return yield* new OrganizationApi.InvitationNotPending();
  const proof = yield* access.upgrade(caller, seen, statement("invitation", "cancel"));
  yield* invitationSystem.cancel(proof.actor, { invitationId });   // D6: the veto after authorization
});
```

For `get`, the record is read a second time. Alternatively, `member` returns the `OrganizationRecord` it obtained from `requireActive` (as `record`), and `get`/`getFull` use it. Prefer that: it removes A-F8's last double read. It is a `MemberAccess.organization` field.

#### 3.A.6 The policy table (`src/internal/policy.ts`)

```ts
export type Policy =
  | { readonly _tag: "Open" }                         // checkSlug
  | { readonly _tag: "Own" }                          // list, listInvitationsForUser
  | { readonly _tag: "Creator" }                      // create (allowUserToCreateOrganization)
  | { readonly _tag: "Session" }                      // getActiveMember(Role), setActive, getActive, setActiveTeam
  | { readonly _tag: "Invitee" }                      // acceptInvitation, rejectInvitation, getInvitationByToken
  | { readonly _tag: "Member"; readonly feature: "teams" | undefined }
  | { readonly _tag: "Statement"; readonly statement: Statement; readonly feature: "teams" | "roles" | undefined;
      readonly scope: "organization" | "team" | "parent" | "teamAndParent"; readonly confers: boolean }
  | { readonly _tag: "InvitationStatement"; readonly statement: Statement }
  | { readonly _tag: "InvitationReader" };

export const policy = {
  create: { _tag: "Creator" },
  checkSlug: { _tag: "Open" },
  list: { _tag: "Own" },
  get: { _tag: "Member", feature: undefined },
  update: { _tag: "Statement", statement: statement("organization", "update"), feature: undefined, scope: "organization", confers: false },
  removeMember: { _tag: "Statement", statement: statement("member", "delete"), feature: undefined, scope: "organization", confers: false },
  updateMemberRole: { _tag: "Statement", statement: statement("member", "update"), feature: undefined, scope: "organization", confers: true },
  createRole: { _tag: "Statement", statement: statement("role", "create"), feature: "roles", scope: "organization", confers: true },
  listTeams: { _tag: "Member", feature: "teams" },
  moveTeam: { _tag: "Statement", statement: statement("team", "update"), feature: "teams", scope: "teamAndParent", confers: false },
  addTeamMember: { _tag: "Statement", statement: statement("team", "update"), feature: "teams", scope: "team", confers: true },
  cancelInvitation: { _tag: "InvitationStatement", statement: statement("invitation", "cancel") },
  getInvitation: { _tag: "InvitationReader" },
  // … all 41 (the full list is §2.A.2's table, one row per method)
} satisfies Record<keyof OrganizationShape, Policy>;
```

`satisfies Record<keyof OrganizationShape, Policy>` refuses both a missing key and an extra key. The table is **the matrix test's oracle, not a dispatcher** (§3.A.2 explains why). The matrix suite (§5.A) walks it and, per entry, generates the probes its `_tag`, `feature` and `scope` imply. So the implementation and the table cannot drift without a red test, and a new endpoint cannot ship without an entry.

#### 3.A.7 What the compiler enforces, and what it does not

| Invariant | Enforced by |
|---|---|
| A member-conferred role is bounded by the conferrer's statements in scope (BEH-EA-288) | **Compiler plus guard.** `Bound.Ceiling` needs `CeilingStatements`. Only `OrganizationAuthority` constructs them, and the authorized layer's only source of a Ceiling is `proof.bound` |
| The order (active → member → gate → statement) | **Locality plus tests.** Written once per entry point. The matrix suite proves every entry point and every method |
| Every endpoint has a policy | **Compiler.** `satisfies Record<keyof OrganizationShape, Policy>` |
| An authorized method acts on the organization it authorized, with the actor it authorized | **Convention plus a static guard.** `proof.organizationId` and `proof.actor` are the only sources, and `OrganizationActor.user` no longer exists. Ticket 11's guard forbids `ActorSchema.cases.User.make` in `Organization.ts`, and any `requireActive`, `members.find` or `effectivePermissions` there |
| A proof cannot be forged in library source | **Compiler plus lint plus guard.** The brand (§3.A.2), the repo's no-`as` rule, and ticket 11's guard on `Brand.nominal` |
| System interfaces never authorize | **Unchanged** (plan 04). Q5 asks whether to move this to the compiler too |

#### 3.A.8 Behaviour changes (each named in the changeset)

| # | Change | Why |
|---|---|---|
| DA1 | A non-member calling a role endpoint gets `404 OrganizationNotFound`, byte-identical to an unknown id, whether dynamic access control is on or off. Today it is `403` when off | A-F1, BEH-EA-284 |
| DA2 | `cancelInvitation`, `getInvitation`, `acceptInvitation`, `rejectInvitation` and `getInvitationByToken` answer `404 InvitationNotFound` when the invitation's organization is suspended. Today they are `204` or `200`, or create a membership | A-F2–A-F4, BEH-EA-237, Q3 |
| DA3 | `GET /organization/active` reads `activeOrganizationId: null`, `activeTeamId: null` while the organization is suspended. The row is **not** cleared, so reinstatement restores it (REQ-EA-856). `POST /organization/active-team` for a team of a suspended organization answers `404 TeamMembershipNotFound` | A-F5, Q4 |
| DA4 | Every statement-gated method publishes `permissionDenied` `notMember` for a non-member. That adds `removeMember`, `updateMemberRole`, `cancelInvitation` and the seven team writes | A-F6, Q2 |
| DA5 | A team role held in another organization no longer counts toward a statement checked under this organization's path. The answer for that corner case moves from `404 TeamNotFound` (system module) to `403 OrganizationPermissionDenied`, which BEH-EA-284 permits for a member lacking the statement | A-F7 |
| DA6 | `OrganizationActor.user` is removed. `OrganizationActor.Bound.Ceiling(…)` is no longer constructible outside the package, so callers use `OrganizationAuthority.ceilingOf` | GA5, Q9 |

#### 3.A.9 Alternatives considered

- **(a) Three hotfixes and stop.** This fixes A-F1 to A-F5. The next endpoint repeats the hazard, and five membership variants stay. It is kept as the NO-GO branch (tickets 02–04 land either way).
- **(b) A combinator `guarded(policy, delegate)` that builds each method from its table entry.** Custom flows (`cancelInvitation`'s status between membership and statement, `moveTeam`'s two scopes, `getInvitation`'s invitee fallback) need escape hatches, and typing the combinator over the policy union needs conditional return types. Rejected.
- **(c) System interfaces require the proof.** SCIM, SAML, AdminTenants and the application have no principal. They would need a "trusted" proof anyone can mint, which proves nothing. It would also reverse ADR-EA-040 decision 5 and plan 04 §3.2. Rejected here, and kept open as Q5.
- **(d) Gate through qadi (Path A or B).** Plan 04 Q9 decided "no". The policy table *could* later feed Path B's registry (Q7).
- **(e) Chosen:** one package-private module with typed entry points, a branded proof, a compiler-owned ceiling and a table-driven matrix.

### 3.B Part B residue: re-keying rows sealed before revision 1.3 (only if R1 opens)

Nothing is designed for R2 (ticket 21 runs existing proofs) or R3 (out of scope). R1's design is **batch-2 plan 17's §3.8 "design B"**, which was designed, recommended "by default ship neither", and not built. This plan adopts it unchanged in shape and pins four properties plan 17 left open:

```ts
// packages/sql/src/SealedColumn.ts — the one-shot operator effect (plan 17 §3.8 design B)
export const rekey = <F extends Schema.Struct.Fields>(
  declared: Sweepable,
  previous: {
    /** The extra columns the old AAD was built from (e.g. `providerId`, `userId`); decoded, never `as`. */
    readonly fields: F;
    readonly aad: (row: Schema.Struct<F>["Type"], rowKey: string) => string;
  },
  options?: { readonly batch?: number; readonly direction?: "toCanonical" | "toPrevious" },
) => /* Effect<RekeyReport, SqlError, SqlClient | Encryption> */;

export interface RekeyReport {
  readonly scanned: number; readonly rekeyed: number; readonly current: number;
  readonly plaintextSealed: number; readonly unreadable: number;
}

// packages/sql/src/CoreSealedColumns.ts — the mapping, with its own deletion ticket (23)
export const previousAad = [
  { column: usersMetadata, fields: {}, aad: (_row, id) => `user:${id}:metadata` },
  { column: sessionsIpAddress, fields: {}, aad: (_row, id) => `session:${id}:ipAddress` },
  { column: sessionsUserAgent, fields: {}, aad: (_row, id) => `session:${id}:userAgent` },
  { column: accountsAccessToken, fields: { providerId: Schema.String, userId: Schema.String }, aad: (row, _id) => `${row.providerId}:${row.userId}:accessToken` },
  // … refreshToken, idToken
];
```

The four properties pinned:

1. **Idempotent.** A value that opens under the target AAD counts as `current`. If it is stale it is re-sealed to the current kid (the `sweep` rule). A second run reports `rekeyed: 0`.
2. **Reversible.** `direction: "toPrevious"` re-seals canonical values under the old spelling, so rolling back to a build from before batch 2 is a re-run, not a restore. A rollback otherwise needs a backup.
3. **Conservative.** A non-envelope value on an adopting column (`adoptPlaintext`) is sealed and counted `plaintextSealed`, but only when the caller passes the `Deployed` list (so never over a plaintext deployment, the same rule as `sweepDeployed`). A value that opens under neither spelling is counted `unreadable` and left byte-identical (ADR-EA-019 revision 1.2: the library deletes nothing).
4. **Offline.** The runbook is: stop the application, run `rekey` per `previousAad` entry with the new build's code, check every report, start. No request path reads two spellings, and the substrate gains no fallback, consistent with revision 1.2.

The CAS reuses `sqlSwap`, which already runs in a savepoint. It sits in `SealedColumn` beside `sweep` because it pages and swaps exactly like `sweep`. The core spellings live only in `CoreSealedColumns.previousAad`, so deleting that constant (ticket 23) leaves a generic, unused-by-core `rekey`. Ticket 23 also deletes `rekey` unless a plugin has adopted it by then.

**ADR-EA-019 revision 1.4 (draft, only if built).** Append to "Revision 1.3: core columns":

> **Revision 1.4: a shipped re-key.** An environment named by the maintainer holds core rows sealed under the spellings used before revision 1.3. `SealedColumn.rekey` (offline, idempotent, reversible, deletes nothing) and `CoreSealedColumns.previousAad` move them to the canonical AAD. The mapping is removed before the first tagged release (revision 1.5 records it). No request path reads a previous spelling.

---

## 4. Phased migration

Each ticket below is one `.scratch/30-speculative-followups/issues/NN-<slug>.md` file. The ticket tracker is local markdown (`docs/agents/issue-tracker.md`), and each file starts with label `ready-for-agent` (or `needs-info` where §10 must answer first). "Gate" is the command that must be green before the ticket closes. `PG` is shorthand for `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`.

### 4.A Part A

Order: A0 (01–05) → A1 (06–09) → A2 (10–11) → A3 (12). Tickets 02–04 are independent of each other and of the gate. Tickets 06 onward wait for the gate decision recorded in 01.

#### Phase A0: gate evidence, hotfixes, spike (tickets 01–05)

**01 — Gate A evidence: reproduce A-F1 to A-F6 as red tests.**
- Files: a throwaway branch only. Record results in `.scratch/30-speculative-followups/baseline-A.md`.
- Change: re-run the §2.1 Part A commands and record the counts. Write one failing test per finding:
  - A-F1: an HTTP probe with DAC disabled, outsider on `GET /organization/:id/roles` and `POST …/roles`, existing versus unknown id, expecting the same `404` body.
  - A-F2: `cancelInvitation` by an owner after `directory.suspend`.
  - A-F3: `getInvitation` by an owner after suspension.
  - A-F4: `acceptInvitation` by the invitee after suspension.
  - A-F5: `getActive` after suspension, and `setActiveTeam` after suspension.
  - A-F6: an outsider's `removeMember` audits nothing.
  
  Record red/green per test and the wall time of `pnpm vitest run packages/organization` as the baseline. Do not commit red tests to the main line: each fix ticket carries its own test.
- Done when: `baseline-A.md` lists the counts (expect 27/8/19/6/12) and a red/green verdict per finding, and states the gate decision (GO if A-F1..A-F5 has at least one red; see §1.A.1) and the §10 Q2–Q6 answers.
- Gate: none (no commit).

**02 — Role endpoints check membership before the dynamic-access-control gate (A-F1, DA1).** *Not gated.*
- Files: `packages/organization/src/Organization.ts` (`createRole` 539, `listRoles` 558, `getRole` 567, `updateRole` 576, `deleteRole` 595); `packages/organization/test/AuthHttp.test.ts`; `features/features/10-organization/35-organization.feature` and its steps if a "dynamic access control is disabled" step is missing; `spec/behaviors/35-organization.md` (BEH-EA-284 implementation note, revision 1.8).
- Change: in each of the five methods, insert `requireMembership(callerId, organizationId)` between `requireOrganization` and `roleSystem.requireEnabled`. This is the PV-300 order teams already use (`requireTeamsFor`). Tickets 06–08 then rewrite these methods onto `access.requireRole`. Add an HTTP test, "a non-member gets the same 404 from role endpoints whether or not dynamic access control is enabled" (role paths, DAC off, byte-identical bodies). Add a BDD scenario beside REQ-EA-720 with the next free REQ id (1321+ today).
- Done when: the new test and scenario pass, and `grep -n "roleSystem.requireEnabled" packages/organization/src/Organization.ts` shows each call preceded by a membership check.
- Gate: PG, plus `pnpm test:bdd`.

**03 — Invitation paths refuse a suspended organization (A-F2, A-F3, A-F4, DA2).** *Not gated.*
- Files: `Organization.ts` (`cancelInvitation` 435, `mayReadInvitation` 468 / `getInvitation` 487, `getInvitationByToken` 498); `packages/organization/src/OrganizationInvitations.ts` (`accept` 448, `reject` 611); `packages/organization/test/OrganizationInvitations.test.ts`, `Organization.test.ts`; `features/features/12-multi-tenancy/28-tenancy.feature` (one scenario under "A suspended organization refuses organization-scoped access"); `spec/behaviors/28-tenancy.md` (BEH-EA-237 text names invitations and the invitee's acts, revision 1.10).
- Change:
  - In `accept` and `reject`, after `requirePendingInvitation` and before any further check, add `directory.findActive(record.organizationId)`. A `None` fails `InvitationNotFound`. Keep the veto first (plan 04: "`accept`/`reject` keep veto-first").
  - In `cancelInvitation`, after the membership check, add `requireOrganization(found.organizationId)` mapped to `InvitationNotFound`.
  - In `mayReadInvitation` and `getInvitationByToken`, check `directory.findActive` on the invitation's organization first, and answer `InvitationNotFound` on `None`.
  - No error union changes: `InvitationNotFound` is in every one of these unions (`OrganizationApi.ts:503-558`).
- Done when: five new cases pass (cancel, get, get-by-token, accept and reject, all after `directory.suspend`, each `InvitationNotFound` with nothing written). `accept` leaves no membership. The EP-003 test (`Organization.test.ts:1380`) gains `cancelInvitation` and `getInvitation` lines.
- Gate: PG, plus `pnpm test:bdd`.

**04 — The active context never reports or accepts a suspended organization's pointers (A-F5, DA3).** *Not gated.*
- Files: `packages/organization/src/OrganizationActiveContext.ts` (`get` 82, `setTeam` 133); `packages/organization/test/OrganizationActiveContext.test.ts`; `features/features/12-multi-tenancy/28-tenancy.feature` (extend REQ-EA-855 with "and her active context reads no organization").
- Change:
  - `get`: when `activeOrganizationId` names a suspended organization (`isSuspended`), return the row with both pointers `None`, **without** writing (Q4 default), so REQ-EA-856's reinstatement restores it.
  - `setTeam`: after the team-membership witness is found, resolve the team's organization with `teams.findTeamByIdAnyOrg(grant, teamId)` (`TeamRecords.ts:114-118`). The witness is minted beside the call with its reason ("a session's own team pointer names its organization through the team"), the same pattern as OrganizationQadi's `teamExistenceGrant` (`OrganizationQadi.ts:208`). If that organization is suspended (`isSuspended`), fail `TeamMembershipNotFound`.
- Done when: the new cases pass. Reinstating restores `get`'s pointers (extend the REQ-EA-856 step or add a unit case).
- Gate: PG, plus `pnpm test:bdd`.

**05 — Spike: the brands and their declaration emit.** *Gated (GO).*
- Files: `packages/organization/test/Access.types.test.ts` (new, following `packages/two-factor/test/TwoFactor.types.test.ts`); a scratch `src/internal/access.ts` stub.
- Change: prove under `tsc -b` (which emits `lib/**/*.d.ts`) and `tsc -p tsconfig.test.json`:
  1. The `Brand.Brand` proof types emit declarations (`tsc -b`), as `AdminGate`'s clearances already do.
  2. An object literal without the brand is not assignable to `MemberAccess` (`// @ts-expect-error`).
  3. `Data.taggedEnum` over `statements: CeilingStatements` makes `Bound.Ceiling({ statements: {} })` fail to compile (`// @ts-expect-error`) and `Bound.Unbounded()` and `Bound.$match` still work.
  4. A generic `Effect.fnUntraced(function* <R, A>(…))` infers `StatementAccess<"role","create">` at a call site.
- Done when: the four properties hold, or the ticket records the fallback chosen for each.
- Gate: `pnpm typecheck`.

#### Phase A1: the primitive (tickets 06–09)

**06 — `OrganizationAuthority.scopedStatements`, `scopedCeiling`, `holds`, and team scope fixed (A-F7, DA5).**
- Files: `packages/organization/src/OrganizationAuthority.ts`; `packages/organization/test/OrganizationAuthority.test.ts`.
- Change:
  - Add the three members (§3.A.4).
  - `teamAuthority` first resolves `teams.findTeamById(organizationId, teamId)`, and a `None` contributes `{}`.
  - `ceilingOf` and `scopedCeiling` mint through one private `mintCeiling(statements)`, which builds `Bound.Ceiling({ statements: ceilingStatements(statements) })`. Until ticket 10 narrows the field to `CeilingStatements`, the branded value is simply a `Statements`, so this ticket compiles on its own.
- Done when:
  - New cases pass: "a team role held in another organization confers nothing under this organization's id"; "scopedStatements merges team authority down the subtree only" (moved from the OHS-004 cases at `Organization.test.ts:754`); "scopedCeiling's bound is Ceiling(statements)".
  - `OrganizationQadi.test.ts` "relations agree with requirePermission for every membership" still passes.
- Gate: PG.

**07 — `src/internal/access.ts`: six entry points, two continuations, proofs, uniform PERS-005 (DA4).**
- Files: `packages/organization/src/internal/access.ts` (new, §3.A.2–3.A.3); `src/internal/policy.ts` (new, §3.A.6, all 41 entries).
- Change: as designed. `make` yields the seven services once at the top (ticket 19's rule from plan 04: a service captured inside a handler closure leaks into `HttpApiBuilder`'s requirements). Not exported from `index.ts`. `pnpm knip` must not flag it: it is used by `Organization.ts` in ticket 08, so land 07 and 08 in one PR, or add a temporary knip ignore that ticket 08 removes.
- Done when: `pnpm circular` is clean (access imports system modules and Authority, and nothing imports `Organization.ts`), and the type tests from ticket 05 run against the real module.
- Gate: PG.

**08 — `Organization.ts` onto `OrganizationAccess`: delete the hand-written helpers.**
- Files: `packages/organization/src/Organization.ts`.
- Change:
  - Every organization-scoped method takes its proof from one entry point: `member` ×5, `teamMember` ×5, `require` ×5, `requireRole` ×5, `requireOnTeam` ×7 (`moveTeam` adds `alsoOnTeam`), `invitation` + `upgrade` for `cancelInvitation`, and `invitation` + `upgrade` + the invitee fallback for `getInvitation`.
  - Delete `effectivePermissionsOf`, `requirePermission`, `requireMembership`, `requireOrganization`, `mayReadInvitation`, `ceilingOfMember`, `requireTeamsFor` and `teamCeiling`.
  - Pass `proof.actor`, `proof.organizationId` and `proof.bound` to the system calls.
  - The `getInvitationByToken`, `accept` and `reject` paths keep calling the system module, which ticket 03 already made suspension-aware.
  - Keep each method's error remapping (`catchTags` that die on impossible tags). Keep D4 and D6.
- Done when:
  - `grep -cE "\b(requireOrganization|requireMembership|requirePermission|effectivePermissionsOf|requireTeamsFor|teamCeiling|ceilingOfMember|mayReadInvitation)\b" packages/organization/src/Organization.ts` = `0`.
  - `wc -l packages/organization/src/Organization.ts` ≤ 700.
  - Every pre-existing test in `packages/organization/test` passes unchanged, except the DA4/DA5 cases this ticket updates (an outsider's `removeMember` now audits `notMember`).
- Gate: PG, plus `pnpm test:bdd`.

**09 — The authorization matrix, derived from the policy table; delete what it subsumes.**
- Files: `packages/organization/test/AuthorizationMatrix.test.ts` (new); `packages/organization/test/AuthHttp.test.ts`; `packages/organization/test/Organization.test.ts`.
- Change: see §5.A.1 for the suite. Delete the tests it subsumes (§5.A.3).
- Done when:
  - The matrix runs once per method per applicable probe (≥ 150 generated cases), and deleting any `policy` entry fails to compile.
  - Swapping two lines in any entry point (gate before membership, say) turns at least one generated case red. Prove it once by mutation and record it in the ticket.
  - The deleted tests are listed in the ticket.
- Gate: PG.

#### Phase A2: compiler-owned ceiling and a static guard (tickets 10–11)

**10 — `Bound.Ceiling` is minted only by `OrganizationAuthority`; `OrganizationActor.user` is removed (DA6).**
- Files: `packages/organization/src/OrganizationActor.ts`; `packages/organization/src/OrganizationAuthority.ts`; `packages/organization/test/OrganizationTeams.test.ts:544` (the one test `Bound.Ceiling`, which becomes `authority.ceilingOf(org, ["admin"])` or a `scopedCeiling` call); `packages/organization/test/support.ts` if it builds a User actor; `Access.types.test.ts`.
- Change:
  - `Bound`'s `Ceiling.statements` becomes `CeilingStatements`.
  - `user` is deleted from `OrganizationActor.ts`, and the authorized layer's actors come from proofs. Tests that need a User actor build it with `ActorSchema.cases.User.make` (a test is allowed to).
  - `scim` (`Scim.ts:686, :1122`), `features/step-definitions/TenancySteps.ts:305` and the qadi test keep `Bound.Unbounded()` unchanged.
- Done when:
  - `grep -rn "Bound\.Ceiling(" packages/*/src --include=*.ts | grep -v "/lib/"` lists only `OrganizationAuthority.ts`'s `mintCeiling`.
  - `grep -rn "OrganizationActor\.user\b" packages features --include=*.ts | grep -v "/lib/"` = nothing.
  - `Access.types.test.ts` has a passing `// @ts-expect-error` on `OrganizationActor.Bound.Ceiling({ statements: {} })`.
- Gate: PG, plus `pnpm test:bdd`.

**11 — Static guard: authorization lives in one file.**
- Files: `packages/organization/test/AuthorizationBoundary.test.ts` (new, the `RecordsBoundary.test.ts` pattern).
- Change: scan `packages/organization/src`:
  - (a) `Organization.ts` contains no `requireActive(`, `findActive(`, `.find(` on a members or invitations module (`memberSystem.find`, `members.find`), `effectivePermissions`, `hasPermission`, `ActorSchema.cases.User.make`, or `Bound.`.
  - (b) `Brand.nominal<` naming `CeilingStatements` appears only in `OrganizationAuthority.ts`.
  - (c) `Brand.nominal<` naming `MemberAccess` or `StatementAccess` appears only in `internal/access.ts`.
  - (d) No file outside `internal/access.ts` publishes `auth.organization.permissionDenied`.
- Done when: the guard passes, and it fails when any forbidden token is planted (prove once, record it in the ticket).
- Gate: PG.

#### Phase A3: spec, ADR, docs, changesets (ticket 12)

**12 — ADR-EA-040 revision 1.1, BEH revisions, model, traceability, BDD, changesets.**
- Files: per §6.A.
- Done when: `pnpm spec:verify:strict` passes, and both changesets exist with `Migration:` notes.
- Gate: `pnpm check`, plus `pnpm test:bdd`.

### 4.B Part B

Order: 21 → (only if R1's gate opens) 22 → 23.

**21 — Verify batch-2 plan 17 on the merged base (R2).** *Not gated: lands either way.*
- Precondition: the merge of `origin/main` into `architecture/deepening-plans-2` is committed. This plan does not touch git.
- Files: `.scratch/30-speculative-followups/baseline-B.md` only.
- Change: re-run every §2.1 Part B command and record its output against the expectations. Then run batch 2's proof on the merged tree:
  - `pnpm vitest run packages/test/test/CoreSealedColumns.test.ts packages/sql/test/SealedColumn.test.ts`;
  - `pnpm test:pg` (its list includes both, `scripts/test-pg.sh:25, :29`);
  - `pnpm test:bdd` (REQ-EA-1320).
  
  Also put R1's question to the maintainer (§10 Q8) and record the answer.
- Done when: every expectation in §2.1 Part B holds, the three runs are green, and `baseline-B.md` holds the outputs and the R1 answer. If any expectation fails, the ticket names the regression and the file the merge changed (`git diff HEAD -- packages/ports/src/Encryption.ts` first), and becomes a bug ticket.
- Gate: PG, `pnpm test:pg`, `pnpm test:bdd`.

**22 — `SealedColumn.rekey` and `CoreSealedColumns.previousAad` (R1).** *Gated: only if ticket 21 records a named environment.*
- Files: `packages/sql/src/SealedColumn.ts`; `packages/sql/src/CoreSealedColumns.ts`; `packages/sql/test/SealedColumn.test.ts` (generic cases); `packages/test/test/CoreSealedColumns.rekey.test.ts` (new; it needs `Persistence.sql`, so it lives in `packages/test`, plan 17's precedent; add it to `scripts/test-pg.sh`); `spec/decisions/019-encryption-key-rotation.md` (revision 1.4, §3.B draft); `packages/sql/README.md` ("Moving rows sealed before revision 1.3"); a changeset.
- Change: §3.B.
- Done when, for planted rows on all six columns (an old spelling under the current kid, an old spelling under a retired kid, canonical, plaintext on an adopting column, an envelope that opens under neither, and null):
  - one run per column reports the expected counts;
  - a second run reports `rekeyed: 0, plaintextSealed: 0`;
  - `direction: "toPrevious"` restores every old spelling (assert with `SealedColumn.reveal` under the old AAD);
  - the plaintext deployment (`Deployed` without PII) leaves PII rows byte-identical;
  - every `unreadable` value is byte-identical;
  - after `toCanonical`, the store ports open every row.
- Gate: PG, `pnpm test:pg`, `pnpm spec:verify:strict`.

**23 — Remove `CoreSealedColumns.previousAad` (and `rekey`, if no other caller) before the first tag.** *Gated: only after 22, with maintainer sign-off that the named environment ran it.*
- Files: as in 22, plus ADR-EA-019 revision 1.5 (the removal, mirroring revision 1.2's bullets) and a changeset.
- Done when: `grep -rn "previousAad\|rekey" packages/*/src --include=*.ts | grep -v "/lib/"` = nothing (or only `rekey`, if adopted elsewhere).
- Gate: `pnpm check`, `pnpm test:pg`.

### 4.C Ticket table

Maps 1:1 onto `.scratch/30-speculative-followups/issues/NN-*.md`.

| # | Title | Phase | Depends on |
|---|---|---|---|
| 01 | Gate A evidence: reproduce A-F1..A-F6 as red tests | A0 | — |
| 02 | Role endpoints check membership before the DAC gate (A-F1) | A0 | — |
| 03 | Invitation paths refuse a suspended organization (A-F2..A-F4) | A0 | — |
| 04 | Active context never reports or accepts a suspended organization's pointers (A-F5) | A0 | — |
| 05 | Spike: brands and declaration emit | A0 | 01 (GO) |
| 06 | `OrganizationAuthority.scopedStatements`/`scopedCeiling`/`holds`, team scope fixed (A-F7) | A1 | 05 |
| 07 | `internal/access.ts` and `internal/policy.ts` | A1 | 06 |
| 08 | `Organization.ts` onto `OrganizationAccess`; helpers deleted | A1 | 02, 03, 04, 07 |
| 09 | Authorization matrix from the policy table; subsumed tests deleted | A1 | 08 |
| 10 | `Bound.Ceiling` minted only by Authority; `OrganizationActor.user` removed | A2 | 08 |
| 11 | Static guard: authorization in one file | A2 | 10 |
| 12 | ADR-EA-040 rev 1.1, BEH, model, traceability, BDD, changesets | A3 | 09, 11 |
| 21 | Verify batch-2 plan 17 on the merged base (R2) | B | merge of `main` committed |
| 22 | `SealedColumn.rekey` and `CoreSealedColumns.previousAad` (R1) | B | 21 (R1 GO) |
| 23 | Remove `previousAad` (and `rekey`) before the first tag | B | 22, maintainer sign-off |

---

## 5. Test plan

### 5.A Part A

#### 5.A.1 New: `packages/organization/test/AuthorizationMatrix.test.ts`

The suite walks `policy` (`internal/policy.ts`, imported by relative path, since it is package-private) and an `invoke` record typed `{ [K in OrganizationScoped]: (o: OrganizationShape, caller, ids) => Effect<unknown, { _tag: string }> }`. `OrganizationScoped` is the keys whose policy `_tag` is `Member`, `Statement`, `InvitationStatement` or `InvitationReader`, computed with a key-remapping mapped type, so a missing `invoke` entry is a compile error too. Fixtures: an owner, a plain member, an outsider, an organization with a team, a dynamic role and a pending invitation, a second organization with its own team, and a suspended copy. Generated probes per entry:

| Probe | Applies to | Expected |
|---|---|---|
| outsider vs unknown id vs suspended id | every organization-scoped entry | the same `_tag` (`OrganizationNotFound`, or `InvitationNotFound` on invitation entries), and **nothing written** (record counts unchanged) |
| the same, with `feature` off | entries with `feature` | still the not-found tag, never `TeamsDisabled`/`DynamicAccessControlDisabled` (A-F1 for every role entry) |
| member without the statement | `Statement`, `InvitationStatement` | `OrganizationPermissionDenied`, and one `permissionDenied` `missingStatement` audit row naming the resource and action |
| outsider on a statement entry | `Statement`, `InvitationStatement` | one `permissionDenied` `notMember` audit row (DA4) |
| member with `feature` off | entries with `feature` | `TeamsDisabled` / `DynamicAccessControlDisabled` |
| member of A naming a team or role of B | `scope: "team"`/`"parent"`/`"teamAndParent"`, and role-id entries | `403` for a member lacking the statement, `404` for one holding it; never a write (DA5, BEH-EA-284) |
| owner on a suspended organization | every organization-scoped entry | the not-found tag (A-F2, A-F3) |
| owner, happy path | every organization-scoped entry | success; for `confers: true`, the system call received `Bound.Ceiling` equal to the owner's statements (spy through a veto tap that records `input.bound`, where a hook input carries it; otherwise assert the RRM-001 outcome) |

Expect ≥ 150 generated cases (29 entries × 4–8 probes), on the memory composition the existing `Organization.test.ts` `buildLayer()` builds. One HTTP pass reruns the not-found probes over `AuthHttp`'s real handler and asserts byte-identical bodies, which replaces the two hand-listed probe tests.

#### 5.A.2 New or extended unit cases

- `OrganizationAuthority.test.ts`: the three ticket 06 cases.
- `OrganizationInvitations.test.ts`: accept and reject after suspension (ticket 03).
- `OrganizationActiveContext.test.ts`: `get` after suspension reads no pointers, reinstatement restores them, and `setTeam` refuses a suspended organization's team (ticket 04).
- `Access.types.test.ts`: the brand, Ceiling and inference properties (tickets 05, 10).
- `AuthorizationBoundary.test.ts`: the static guard (ticket 11).

#### 5.A.3 Deleted (replace, don't layer)

Their cases are generated by the matrix.

| File | Test | Replaced by |
|---|---|---|
| `Organization.test.ts:126` | "getFull/listMembers/listInvitationsForOrganization are denied to a non-member" | outsider probe |
| `Organization.test.ts:872` | "listTeams/listTeamMembers are denied to a non-member" | outsider probe |
| `Organization.test.ts:1258` | "a non-member's denied delete is recorded with reason notMember" | `notMember` audit probe (now for every statement entry) |
| `Organization.test.ts:1380` (half) | the `get`/`update`/`invite` lines of "EP-003: a suspended organization is refused everywhere" | suspended probe. The `list` and reinstatement half stays |
| `AuthHttp.test.ts:141` | "update answers 404 for a non-member" | HTTP not-found pass |
| `AuthHttp.test.ts:166` | "a non-member gets the same 404 for an existing organization as for a random id" | HTTP not-found pass (roles included) |
| `AuthHttp.test.ts:220` | "a non-member gets the same 404 from team endpoints whether or not teams are enabled" | `feature`-off probe over HTTP |
| ticket 02's interim role probe | (added in 02) | `feature`-off probe |

These stay: the RRM-001/OHS-005/OHS-004 role-conferring suites (they test `canGrant` outcomes, not ordering), "a member without the statement still gets 403, not 404" (`AuthHttp.test.ts:252`, the HTTP status mapping), the invitation-capability suite (MTI-010) and every system-module suite.

#### 5.A.4 Measurable targets

- `Organization.ts` goes from 864 lines to **≤ 700**, and authorization-helper occurrences in it go from 82 to **0** (`grep -cE` in ticket 08).
- Membership-check variants go from 5 to **1** (`visibleMembership`).
- Hand-listed non-member probes go from 3 HTTP tests and 3 unit tests to **0**, replaced by one generated suite.
- `pnpm vitest run packages/organization` wall time is within **+15 %** of ticket 01's baseline.

### 5.B Part B

- **Ticket 21** adds no test. It runs batch 2's suites on the merged tree: `packages/test/test/CoreSealedColumns.test.ts` (the six core columns through `runSealedColumnTests`, the three pinned bugs, deployment sweep, plaintext adoption), `packages/sql/test/SealedColumn.test.ts` (the mechanism, including the savepoint re-seal) and BDD REQ-EA-1320, on SQLite and on Postgres.
- **Ticket 22** (only if R1 opens) adds the generic `rekey` cases to `SealedColumn.test.ts` (idempotence, both directions, unreadable untouched, plaintext only with an adopting declaration). It also adds the core matrix in `packages/test/test/CoreSealedColumns.rekey.test.ts` (six columns × six row kinds × two directions). Both run under `pnpm test:pg`.
- **Ticket 23** deletes the core matrix with the mapping. If `rekey` goes too, its generic cases go with it.
- Nothing is deleted from batch 2's suites. Measurable target: none beyond green runs. Part B adds no permanent code unless R1 opens, and after ticket 23 it adds none at all.

---

## 6. Spec, ADR, traceability, BDD, docs, changesets

### 6.A Part A

**ADR-EA-040 revision 1.1.** Bump the Document Control: revision, effective date, and a change history row "1.1 (date): decision 6, the authorized interface authorizes through one primitive; ceilings are minted only by `OrganizationAuthority` (plan 30 Part A)". Then append:

> **6. The authorized interface authorizes through one primitive (revision 1.1).** Every organization-scoped method of `Organization` obtains an access proof from the package-private `OrganizationAccess` before it calls a system interface. A proof is minted in one fixed order, written once per entry point:
>
> 1. the organization is active (EP-003);
> 2. the caller is a member (MTI-009; a statement-gated entry publishes `auth.organization.permissionDenied` `notMember`);
> 3. the feature gate (PV-300: after membership, so a non-member's answer never depends on a feature);
> 4. the statement, held in the caller's statements in scope (`OrganizationAuthority.scopedStatements`; `missingStatement` on a miss).
>
> The proof carries the organization id, the `User` actor and, for a statement, the ceiling the caller may confer. A `Bound.Ceiling` is minted only by `OrganizationAuthority`: a proof's ceiling, or `ceilingOf` for an identity provider. So a role-conferring call on behalf of a member cannot be made without the statement check that produced its ceiling. System interfaces still take an `Actor` and never authorize (decision 5 unchanged), because trusted callers have no principal to prove. The organization's own endpoints are still gated by its `PermissionEngine` (ADR-EA-025), not by qadi.

Add "Consequences: one more package-private module; `OrganizationActor.user` removed; `Bound.Ceiling` not constructible outside the package". Add "Alternatives: §3.A.9 (a)–(d)".

**Behaviors** (`spec/behaviors/`, each file gets a Document Control bump and a change-history row):

- `35-organization.md` → 1.8:
  - BEH-EA-284 gains "with dynamic access control disabled, a role endpoint still answers `404`" and an implementation note naming `OrganizationAccess`.
  - BEH-EA-288 gains "a member's ceiling is minted with its access proof".
  - BEH-EA-330's last sentence becomes "The authorized interface MUST be only `OrganizationAccess` proofs (visibility, the feature gates, `PermissionEngine` statements with the denial audit event) and the delegation they authorize".
  - A PERS-005 sentence, "every statement-gated operation records a non-member's and a statement-less member's denial", goes into BEH-EA-284 or a new paragraph under BEH-EA-330, the author's choice. No new BEH id is required.
- `28-tenancy.md` → 1.10 (1.9 today, after batch 2): BEH-EA-237 names the invitation paths, the invitee's acts and the active team pointer (DA2, DA3).

**Model:** `spec/models/14-organization.md:137` describes the authorized interface. Add "through `OrganizationAccess` (one primitive, branded proofs)".

**Traceability** (`spec/traceability.md`, revision +1):

- §1: BEH-EA-284/237/288/330 → `internal/access.ts`, `internal/policy.ts`, `OrganizationAuthority.ts`.
- §3: an invariant row "a non-member's answer does not depend on a feature" → `access.ts` entry points → `AuthorizationMatrix.test.ts`.
- §4: ADR-EA-040 → BEH-EA-330, 288.
- §5: the new test files, and the removal of the deleted cases.
- §6: the new REQ ids.

**BDD:**

- `features/features/10-organization/35-organization.feature`: a new scenario beside REQ-EA-720, "With dynamic access control disabled a non-member still gets the same 404 for a role endpoint" (next free REQ id, 1321+ today).
- `features/features/12-multi-tenancy/28-tenancy.feature`: new scenarios "A suspended organization's invitations can be neither cancelled nor accepted" and an extension of REQ-EA-855 ("her active context reads no organization"). Keep the `features/traceability.md` rows in step.

**Docs:** `packages/organization/README.md`: check with `grep -n "requirePermission\|OrganizationActor.user\|Bound.Ceiling" packages/organization/README.md docs/*.md`, and update any hit.

**Changesets** (all packages are in the fixed group; ADR-EA-034):

- `organization-authorization-hotfixes.md` (tickets 02–04, patch):
  > Role endpoints answer a non-member `404` whether or not dynamic access control is enabled. Invitations of a suspended organization can no longer be cancelled, read, accepted or rejected (`404 InvitationNotFound`). A suspended organization's active pointers read as none.
  >
  > **Migration:** a client that relied on `403 DynamicAccessControlDisabled` to learn that the feature is off must ask as a member. Nothing else changes.
- `organization-access-primitive.md` (tickets 08–10, minor):
  > The authorized interface authorizes through one primitive. Every statement-gated endpoint audits a non-member's attempt.
  >
  > **Migration:** `OrganizationActor.user` is removed (build `ActorSchema.cases.User.make` if you need a user actor for a system call). `OrganizationActor.Bound.Ceiling(…)` is no longer constructible; use `OrganizationAuthority.ceilingOf(organizationId, roles)`. Expect additional `auth.organization.permissionDenied` audit rows with reason `notMember`.

### 6.B Part B

- **Ticket 21:** no spec change. If it finds a regression, the fix ticket carries its own spec update.
- **Ticket 22 (if built):**
  - ADR-EA-019 revision 1.4 (the §3.B draft): Document Control revision, date, and a change-history row "1.4 (date): decision 6, a shipped one-off re-key for core rows sealed before revision 1.3 (plan 30 Part B)".
  - `spec/behaviors/05-persistence-stratum.md` (revision +1): BEH-EA-339 gains one sentence, "rows sealed under a previous core spelling move with `SealedColumn.rekey` over `CoreSealedColumns.previousAad`, an offline operator effect that deletes nothing".
  - `spec/traceability.md`: §4 ADR-EA-019 row and §5 the new test file.
  - `packages/sql/README.md`: the runbook subsection.
  - Changeset `core-sealed-columns-rekey.md` (`@awthaq/sql`, minor, additive). **Migration:** an environment that ran a build from before batch 2 with sealed core rows stops the application and runs `SealedColumn.rekey` for each `CoreSealedColumns.previousAad` entry before starting this build. It reverses with `direction: "toPrevious"`.
- **Ticket 23:** ADR-EA-019 revision 1.5, the README subsection removed, and a changeset whose **Migration:** line reads "run the re-key on the previous build first".

---

## 7. Risks, mitigations, rollback

| # | Risk | Likelihood / impact | Mitigation | Rollback |
|---|---|---|---|---|
| RA1 | DA1–DA4 change answers a client relied on (a `403` that leaked existence; cancelling a suspended organization's invitations) | low / low | Every change is a spec conformance fix and is named in the changeset | Revert the single ticket. 02–04 are independent commits |
| RA2 | `Brand.nominal` is a public function, so a determined author can forge a proof or a ceiling | low / medium | The repo-wide idiom (admin and SignIn clearances) accepts this. Ticket 11's guard confines both constructors to their owning files | n/a |
| RA3 | `Data.taggedEnum` loses the brand on `Ceiling.statements` (ticket 05) | low / medium | Fallback: a hand-written `Bound` union with `Unbounded()` and `$match` re-implemented, same API | n/a (decided in the spike) |
| RA4 | Extra `permissionDenied` rows (DA4) flood the audit log under scanning | low / low | Attempt-lane events are already rate-limited per caller by the server's budget (plan 06). The volume is bounded by requests | Q2 = "keep the old asymmetry": `visibleMembership` skips the audit for the entries that skipped it before |
| RA5 | The matrix suite is slow (≥ 150 cases) | medium / low | Memory composition, one layer per `describe`, shared fixtures. Target +15 % (§5.A.4) | Trim probes per entry |
| RA6 | Merge conflicts with plan 25 (record-store contract: organization membership primitives) or plan 29 (plugin-owned events) | medium / low | §8 ordering. `access.ts` is new, and the overlaps are `Organization.ts` and the `permissionDenied` publish call | Rebase |
| RB1 | The merge of `main` (effect 4.1, 163 changed lines in `packages/ports/src/Encryption.ts`) regresses batch 2's sealed columns | low / high | Ticket 21 re-runs batch 2's proofs on SQLite and Postgres before anything else builds on the merge | Fix forward in a bug ticket; the merge itself is the user's |
| RB2 | (only if R1 opens) The named environment starts the new build before the re-key: its PII reads absent and its tokens fail typed | medium / high for that environment | Runbook order (stop → re-key → start) is first in the changeset's `Migration:`. The re-key is idempotent, so running it late recovers every value the new build has not overwritten | `direction: "toPrevious"` and the old build |
| RB3 | This round's plan 28 (sql-store-adapters) re-plans batch-2 plan 16 and touches the adapters ticket 22 would edit | high / low | §8: the orchestrator reconciles 28 with batch-2 16 before either runs | n/a |

Rollback granularity:

- **A**: every ticket is its own commit. 08 + 09 revert together, and 10 + 11 together.
- **B**: ticket 21 changes nothing. Ticket 22 is additive and reverts as one commit. Ticket 23 reverts as one commit.

---

## 8. Interactions with other plans

Numbering, per the orchestrator: batch 1 is 01–10 (review of 2026-10-13, implemented). Batch 2 is 11–24 (review of 2026-10-17, implemented on `architecture/deepening-plans-2`). Batch 3 is 25–30 (review of 2026-11-08): 25 record-store-contract, 26 request-context, 27 password-credential, 28 sql-store-adapters, 29 plugin-owned-events, and 30 this plan.

| Plan | Shared seam | Rule |
|---|---|---|
| **04** organization system modules (batch 1) | A: the authorized/system split and its decisions record | Part A is plan 04's unbuilt `internal/authorize.ts` (§11, "What was done differently", Phase 1), done as a module with a proof. Q7 (`Actor` lives in organization) and Q9 (no qadi gating) stand. D4 and D6 are kept |
| **05** plugin table substrate (batch 1) | B: `SealedColumn`, ADR-EA-019 decision 6 | Batch-2 plan 17 extended 05 to core. R1's `rekey` adds no read-path fallback, consistent with revision 1.2 |
| **09** event definitions, **10** item 5 after-commit events (batch 1) | A: `auth.organization.permissionDenied` is an attempt event (ADR-EA-037) | Released either way, so DA4's audit rows survive the rollback of the denied unit. Published from one place (`access.ts`) |
| 01–03, 06–08 (batch 1) | — | none. Part A's matrix uses the organization suite's `buildLayer()`, or `TestAuth.layer` (08) if that suite has moved |
| **11** credential resolution (batch 2) | A: `OrganizationHandlers` reads its caller through `CurrentUser.current` | No conflict. `OrganizationAccess` receives the `Api.UserPrincipal` the handlers already pass to the shape |
| **13** admin gate (batch 2) | A: the **precedent** | `packages/admin/src/internal/AdminGate.ts` is the same deepening for admin: one internal gate, clearances "minted only here" as `Brand.Brand` types with module-local `Brand.nominal` constructors (`:235-260`), and existence after the gate. Part A copies its brand idiom (§3.A.2). No file overlap: AdminTenants' `canAdministerTenants` is platform-tier and stays out of scope (§1.A.4) |
| **14** federated identity (batch 2) | A: SAML role mapping mints its bound with `OrganizationAuthority.ceilingOf` (`Saml.ts:1083-1085`) | `ceilingOf` keeps its signature (§3.A.4), so SAML does not change. No other overlap |
| **16** sql-store-adapters, **17** core sealed columns (batch 2) | **B** | 17 delivered Part B; 16 deleted `Repositories.ts`. Part B is reduced to the residue (§1.B.1) |
| **22** table DDL locality, **24** memory records over SQLite (batch 2) | A: the organization records' DDL and memory adapters | Neither touches `Organization.ts`, `internal/*`, `OrganizationAuthority`, `OrganizationInvitations` or `OrganizationActiveContext`. Rebase only |
| 12, 15, 18–21, 23 (batch 2) | — | none |
| **25** record-store contract (batch 3) | A: organization record primitives (the last-owner race lives in `OrganizationMembers`/`MembershipRecords`) | No file overlap with A (A0 touches `OrganizationInvitations` and `OrganizationActiveContext`; A1 touches `Organization.ts`, `OrganizationAuthority.ts`, `OrganizationActor.ts`, `internal/*`). Either order; rebase |
| **26** request context, **27** password credential (batch 3) | — | none for A. None for B's residue (ticket 22 touches `SealedColumn.ts` and `CoreSealedColumns.ts` only) |
| **28** sql-store-adapters (batch 3) | B | **Overlaps batch-2 plan 16, which is already executed.** For the orchestrator: reconcile 28 against the current base before it runs. If 28 still runs, ticket 22 (if built) lands after it |
| **29** plugin-owned events (batch 3) | A: the `permissionDenied` definition | If 29 moves organization events into the plugin, `access.ts`'s `denied` publishes the plugin-owned definition. Either order |

**One-line ordering:** A0's hotfixes (02–04) now; A1–A3 anytime after (independent; rebase around plans 25 and 29). B's ticket 21 right after the merge of `main` is committed; tickets 22–23 only if the maintainer names an environment with rows sealed before revision 1.3.

---

## 9. Acceptance checklist

### 9.A Part A

- [ ] `baseline-A.md` records the §2.1 counts (27/8/19/6/12/2/2), a red/green verdict for each of A-F1..A-F6, and the gate decision.
- [ ] Hotfixes (02–04): a non-member gets byte-identical `404` bodies from `GET`/`POST /organization/:id/roles` for an existing and an unknown id with dynamic access control off (new test in `AuthHttp.test.ts`, new BDD scenario, REQ id ≥ 1321).
- [ ] After `directory.suspend`, `cancelInvitation`, `getInvitation`, `getInvitationByToken`, `acceptInvitation` and `rejectInvitation` each answer `InvitationNotFound` and write nothing. `acceptInvitation` leaves no membership (five named cases in `OrganizationInvitations.test.ts`/`Organization.test.ts`).
- [ ] After suspension, `getActive` reads both pointers as `null` and `setActiveTeam` answers `TeamMembershipNotFound`. After reinstatement, `getActive` reads the pointers again (`OrganizationActiveContext.test.ts`).
- [ ] `grep -cE "\b(requireOrganization|requireMembership|requirePermission|effectivePermissionsOf|requireTeamsFor|teamCeiling|ceilingOfMember|mayReadInvitation)\b" packages/organization/src/Organization.ts` prints `0`.
- [ ] `wc -l packages/organization/src/Organization.ts` ≤ 700.
- [ ] `packages/organization/src/internal/access.ts` and `internal/policy.ts` exist and are not exported from `packages/organization/src/index.ts` (`grep -n "internal/" packages/organization/src/index.ts` prints nothing).
- [ ] `policy` uses `satisfies Record<keyof OrganizationShape, Policy>`. Deleting an entry fails `pnpm typecheck` (shown once in ticket 09).
- [ ] `pnpm vitest run packages/organization/test/AuthorizationMatrix.test.ts` runs ≥ 150 generated cases, green. A recorded mutation (gate before membership in one entry point) turned at least one red.
- [ ] `OrganizationAuthority.test.ts` "a team role held in another organization confers nothing under this organization's id" passes.
- [ ] `grep -rn "Bound\.Ceiling(" packages/*/src --include=*.ts | grep -v "/lib/"` matches only inside `OrganizationAuthority.ts`, and `Access.types.test.ts` has a passing `// @ts-expect-error` on `OrganizationActor.Bound.Ceiling({ statements: {} })`.
- [ ] `grep -rn "OrganizationActor\.user\b" packages features --include=*.ts | grep -v "/lib/"` prints nothing.
- [ ] `pnpm vitest run packages/organization/test/AuthorizationBoundary.test.ts` passes, and was shown to fail on a planted token.
- [ ] The tests in §5.A.3 are deleted. `grep -n "are denied to a non-member\|whether or not teams are enabled\|update answers 404 for a non-member" packages/organization/test/*.ts` prints nothing.
- [ ] ADR-EA-040 is at revision 1.1 with decision 6. `35-organization.md` is at 1.8 and `28-tenancy.md` at 1.10 (it is at 1.9 today, after batch 2). Traceability is updated, and `pnpm spec:verify:strict` passes.
- [ ] Changesets `organization-authorization-hotfixes.md` and `organization-access-primitive.md` exist, each with a `Migration:` section.
- [ ] `pnpm check` and `pnpm test:bdd` are green. `pnpm vitest run packages/organization` wall time is within +15 % of ticket 01's baseline.

### 9.B Part B

- [ ] `baseline-B.md` records every §2.1 Part B command's output, and each matches its stated expectation.
- [ ] `pnpm vitest run packages/test/test/CoreSealedColumns.test.ts packages/sql/test/SealedColumn.test.ts` is green on the merged base. `pnpm test:pg` is green (Docker Postgres). `pnpm test:bdd` is green (REQ-EA-1320).
- [ ] The maintainer's answer to §10 Q8 is recorded. If it is "yes, environment X": tickets 22–23 are done and their checks pass (§4.B). If it is "no": tickets 22–23 are closed `wontfix` with that answer cited.

---

## 10. Open questions only the user can answer

Gate questions come first. Each has a recommended default.

1. **Q1 — Gate A: build the primitive (phases A1–A3)?** The hotfixes (02–04) land either way. **Recommended: GO.** Five live spec violations come from per-method ordering or a missing step (§2.A.4), and there are five variants of one membership check. Batch-2 plan 13's `AdminGate` shows the same deepening paying off in admin.
2. **Q2 — Uniform PERS-005 (DA4).** Should every statement-gated method audit a non-member's attempt (`notMember`)? That adds `removeMember`, `updateMemberRole`, `cancelInvitation` and the seven team writes. Or should today's asymmetry stay? **Recommended: uniform.** An audit trail whose completeness depends on the endpoint is not one.
3. **Q3 — The invitee's acts on a suspended organization (DA2).** Answer `404 InvitationNotFound`, the same as an unknown invitation and in every error union already? Or add a new `OrganizationSuspended`-style error? **Recommended: `InvitationNotFound`.** BEH-EA-237 says "the same answer an unknown id gets".
4. **Q4 — A suspended organization's active pointers (DA3).** Read as none without clearing the row, so reinstatement restores them (REQ-EA-856)? Or clear them? **Recommended: read as none, keep the row.**
5. **Q5 — Should the system interfaces require the proof for `User` actors** (alternative (c) in §3.A.9)? **Recommended: no.** Trusted callers have no principal, so they would need a proof anyone can mint. It also reverses ADR-EA-040 decision 5.
6. **Q6 — Who may list an organization's invitations (A-F9)?** Today any member can, but reading one needs `invitation:create` or being the invitee. **Recommended: keep the behaviour in this plan,** and record the answer as a BEH-EA-286 clarification. If you want `invitation:create` for listing, it is a one-line policy change once the table exists (`member` → `Statement`).
7. **Q7 — Publish the policy table to qadi's permission registry** (Path B, `GET /__permissions`, BEH-EA-158)? **Recommended: no.** Plan 04's Q9 stands: the organization's own endpoints are not qadi-gated.
8. **Q8 — Gate B / R1: does any environment you care about hold core rows sealed before revision 1.3** (`user:<id>:metadata`, `session:<id>:<field>`, `<providerId>:<userId>:<field>`)? It matters most for `users.metadata` with `encryptPii` on. **Recommended default: no.** That is plan 17's recorded answer, and tickets 22–23 stay unbuilt. If yes, build them (§3.B) and remove the mapping before the first tag.
9. **Q9 — Remove `OrganizationActor.user` and make `Bound.Ceiling` package-internal (DA6, breaking)?** **Recommended: yes.** Pre-release, and the only outside users of a Ceiling go through `OrganizationAuthority.ceilingOf`, which stays.
10. **Q10 — For the orchestrator, not the user: batch numbering.** This round's plans 25–30 were written against `main`, while the current base carries batch 2. Plan 28 (sql-store-adapters) appears to duplicate executed batch-2 plan 16, as Part B duplicated batch-2 plan 17. **Recommended:** reconcile 28 against `.planning/16-sql-store-adapters/PLAN.md` before it runs.

---

## Decisions taken (implementation record)

### Wave 0: tickets 01–04, PR #51 (merged 2026-11-08)

- Ticket 01: the six new tests were red before the fixes; the red results are in each commit body (no `baseline-A.md`, no red commit).
- Ticket 02: role endpoints check membership before the dynamic-access-control gate (BEH-EA-284, REQ-EA-1335). Membership goes through a new `requireMembershipFor`, which keeps the `notMember` audit the plan's unaudited `requireMembership` would have dropped with dynamic access control on.
- Ticket 03: cancel, read (by id or token), accept and reject of a suspended organization's invitation answer `InvitationNotFound` and write nothing (BEH-EA-237, REQ-EA-1336). Accept/reject check the organization between the token and the pending check, so suspension does not reveal whether the invitation is pending.
- Ticket 04: `get` reads a suspended organization's active pointers as none without clearing them (also a team pointer whose team's organization is suspended); `setTeam` refuses its teams (REQ-EA-855/856 extended).
- Q3 (recommended): `InvitationNotFound`, no new error. Q4 (recommended): read as none, keep the row.
- Not done: A-F6, the system `cancel` guard.
- Stale: line numbers; `35-organization.md` was already at 1.8 (this PR took 1.9); `28-tenancy.md` took 1.10 and 1.11.

### Part B: ticket 21 (2026-11-08)

- Ticket 21 ran on `main` @ `85cf71da`. Every §2.1 Part B expectation holds, and the sealed-column suites are green on SQLite locally and on Postgres in CI. `pnpm test:bdd` is green; locally only known load flakes failed, and they pass when run alone. No regression from the merge. The record is `.scratch/30-speculative-followups/baseline-B.md`.
- Q8 (R1), answered by the maintainer: no environment holds rows sealed before ADR-EA-019 rev 1.3. Recommended **NO-GO** stands: tickets 22–23 are not built.
- Stale: BEH-EA-339's heading is at `05-persistence-stratum.md:248`, not `:217`, because plan 15 added behaviours above it. The local `awthaq-pg` container was down, so the Postgres proof is CI's run `42444884626`, which runs all of `pnpm check` with `AWTHAQ_POSTGRES_URL` set.

