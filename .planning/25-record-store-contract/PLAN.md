# Plan 25: Plugin record stores get atomic primitives and a data-driven contract

| | |
|---|---|
| Source | Architecture review of 2026-11-08 (`/improve-codebase-architecture`), candidate "plugin record stores get the ADR-EA-041 treatment" |
| Strength | **Strong** |
| Dependency category | **local-substitutable** (memory and SQL adapters of one record-store interface) **plus ports & adapters** (the store interface is the seam; a host may bring its own adapter through `@awthaq/organization/records`) |
| Relation to plan 24 | **Plan 25 subsumes plan 24's Track B.** That means its canonical drift fixes (Phase 1), its per-package adoption (Phase 3), its ten Postgres atomicity fixes C1–C10 (Phase 4) and its docs/template phase (Phase 5). The differential parity harness is replaced by this plan's stated contract. Plan 24 shrinks to its Track A spike (Phase 0, S1–S5, gates G1–G5) and keeps ADR-EA-046 for that decision only. Why: §8 |
| Wave / position | **Ticket 03 is a Wave-0 hotfix and ships alone, now**, on whatever branch is current. The rest is batch 2's Wave C ("persistence"): **after plan 22** (which moves each table's DDL into the same records modules, phases 2–9 not yet run) and in place of plan 24's Track B (`22 ──► 25`, with 24's Track A spike free to run in parallel or after). It runs alongside plan 28 (sql-store-adapters) and goes before plan 29's edits to the organization system modules (§8) |
| Fixes live bugs | **Last owner** (BEH-EA-285): two owners removing or demoting each other leave zero owners, on memory, SQLite and Postgres (reproduced; on Postgres it happens with no hook involved). **Last team**: two concurrent removals leave zero teams (reproduced). **Membership quota** (BEH-EA-287): two concurrent adds at `limit - 1` give `limit + 1` members (reproduced). **Team forest**: on Postgres, `moveTeam` A-under-B racing B-under-A makes a 2-cycle in 13 of 16 rounds with no hook involved (reproduced; memory and SQLite are atomic). Also: same-shape quota races (6 more limits), unconditional invitation transitions, an API-key rotate that can bring a just-revoked key back as a successor, the impersonation memory ledger split (3 primitives), and passkey counter check-then-write (§2.6) |
| Touches | `@awthaq/organization`, `@awthaq/admin`, `@awthaq/webhooks`, `@awthaq/api-key`, `@awthaq/passkey`, `@awthaq/device-authorization`, `@awthaq/jwt`, `@awthaq/two-factor`, `@awthaq/saml`, `@awthaq/scim`, `@awthaq/roles`, `@awthaq/qadi` (record stores and their tests), `@awthaq/sql` (`SqlStore.atomically`), `@awthaq/test` (`RecordsContract`, `runPluginContractTests`), `examples/plugin-template`, `docs/plugin-authoring.md`, `scripts/`, spec |
| Wire change | No new endpoint, field or error tag, and **no schema change**. Under concurrency the losing request now gets the error the sequential path already returns: `409 OwnerInvariantViolation`, the `*LimitReached` tags, `LastTeamCannotBeRemoved`, `InvitationNotPending`, `ApiKeyNotFound`, `PasskeyCounterAnomaly` (under `counterAnomalyPolicy: "reject"`). A concurrent double removal of one member is `404 MembershipNotFound` instead of a `500` defect |
| Verified at | **2026-11-08, in two trees** (see "Read this first"). (1) `ede063d8` + working tree on `chore/effect-4.1-peer-deps`, where the probes of §2.5 ran. The brief said HEAD `6c5377f8`, but HEAD was already `ede063d8`. (2) Partway through, the checkout moved to **`architecture/deepening-plans-2` @ `5a0e8df4`**, with a merge of `main` (`935d15ee`) staged and not committed (`git status`: "All conflicts fixed but you are still merging"). Every anchor below is given for tree (2). `git diff ede063d8 -- <the nine record and system modules this plan fixes>` is empty, so the probe results hold there unchanged. `effect` is `^4.1.2` in the catalog and **4.1.2** is installed (`node_modules/.pnpm/effect@4.1.2`; SQL is `effect/sql/*`); every Effect API named below was checked there |

### Read this first: where this plan sits on `architecture/deepening-plans-2`

The brief was written for a tree whose `.planning/` held plans 01–10 and whose ADRs ended at 041. The working copy now
holds **batch 2 (plans 11–24, review of 2026-10-17)**: plans 11–14, 16–19 and 23 are executed (`git log`), plan 22 has
run phases 0–1 of 9, and plans 15, 20, 21 and 24 have not started. ADR-EA-042 and 043 exist, and 044–046 are reserved. So this plan is **plan 25**. The other
plans of this batch are 26 (request-context), 27 (password-credential), 28 (sql-store-adapters), 29 (plugin-owned
events) and 30 (speculative follow-ups). It **claims no new ADR number** and amends ADR-EA-041 instead (§6).

**Plan 24 overlaps, and plan 25 subsumes its Track B.** Plan 24 ("Plugin record stores: one behaviour for memory and
SQL", Speculative) has two tracks. Its default, Track B, does four things:

- fixes memory/SQL drifts R1–R6 (member and team ordering, `emailDomains` order, a duplicate JWT `kid`), SQLite's primary-key
  `ConstraintError` that `orConflict` misses, and six wrong `StoreUnavailable.operation` labels;
- adds a *differential* harness, `TestAuth.runRecordsParity`, that runs random operation sequences on both adapters in
  lockstep;
- fixes **ten SQL adapters that are not atomic on Postgres** (C1–C10, "confirmed by reading, not run");
- keeps the 19 bespoke `suite(name, layer)` files.

It does not cover the domain-level check-then-write this plan found: the last owner (P0), the last team, the seven
quotas, invitation transitions, API-key rotation and the passkey counter. It also gives no store a stated contract.
Plan 25 takes over Track B:

- R1–R6, the `orConflict` gap and the labels become cases in each store's suite and are fixed in that store's ticket.
- C1–C10 become `atomic` verdicts with `race` cases and are fixed the same way.
- Plan 24's Q2, Q3, Q4 and Q8 defaults are adopted (§10).
- The differential harness is **not** built (§8 says why). It stays a possible follow-up if drift reappears once the
  contract is in place.

Plan 24 keeps only its Track A spike (SQL over SQLite `:memory:` as the memory adapter, gates G1–G5) and ADR-EA-046 for
that decision. This plan's §2.5 probe **ran** plan 24's C1 (the team-move cycle) on Postgres and reproduced it.

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality**. Domain terms come from
`spec/glossary.md`. Everything in [`.planning/README.md` § Shared conventions](../README.md#shared-conventions-apply-to-every-plan)
applies: no `as` (and no `as const` in new or rewritten code), no return type annotations on new Effect/Layer consts,
type-system first, replace-don't-layer tests, spec + traceability + BDD updates, a changeset with a `Migration:` note for
every package-visible change, the per-phase gate `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`,
`pnpm check` per plan, and **`pnpm test:pg` in every phase gate**, because every phase changes a SQL adapter or the way it
is tested. Track execution as `.scratch/25-record-store-contract/issues/NN-*.md` (see `docs/agents/issue-tracker.md`).

**Running Postgres on this machine.** `scripts/test-pg.sh` starts its container with `docker`, and the docker socket
refuses this user ("permission denied ... /var/run/docker.sock"). `podman` works:
`podman run -d --rm --name awthaq-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=awthaq -p 55432:5432 docker.io/library/postgres:16-alpine`,
then `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55432/awthaq pnpm test:pg`. The script skips its own container
when the variable is set. Plans 02 and 08 could not run `test:pg` ("Docker unavailable"). This plan can, and its gates
require it.

---

## 1. Summary, goals, non-goals

### Summary

Twelve plugin packages own **25 record stores in 24 modules (12,319 lines)**. Each store ships two adapters, `layerMemory`
over a `Ref` and `layerSql` over the ambient `SqlClient`. Plan 08 bundled them as `Plugin.records = { memory, sql }`, and the
compiler checks that the pair is complete, matched, and records-only (BEH-EA-334). Plugins are not where core was before
plan 02: their domain rules are already written once, in the plugin's system modules (`OrganizationMembers`,
`OrganizationTeams`, `Webhooks`, `ApiKey`, ...; ADR-EA-040). The records modules *are* the adapters.

What plugins lack is the other half of ADR-EA-041:

1. **No stated atomicity per primitive.** Nothing says which record method is a read-modify-write that the domain relies on.
   So the domain does check-then-write across two calls (`countOwners`, then `remove`), and three invariants break under
   concurrency on every backend. A SQL primitive wrapped in a transaction is not atomic on Postgres READ COMMITTED either:
   `TeamRecords.moveTeam` checks the closure and then writes it in one transaction, and two crossing moves still make a cycle.
2. **No contract every adapter must meet.** `runPluginContractTests`' records check (`recordsParityProblems`,
   `packages/test/src/TestAuth.ts:973`) builds both bundles and compares their keys. Nothing more. Behaviour is tested by 19
   hand-rolled `const suite = (name, layer)` files that each build their own SQLite or Postgres database
   (`TestSql.layer` + `Migrations.run`). Five stores have no adapter-level suite on SQL at all. Plan 08 meant to add a
   per-plugin `describe.each(recordModes)` and did not (its record, `.planning/08-test-composition/PLAN.md:1193`).

This plan gives plugin record stores what ADR-EA-041 gave core stores, adapted to the fact that the domain is already single:

1. **Phase 0 hotfix.** Membership writes enforce the owner invariant themselves, atomically on every adapter. It is a
   failing test plus a fix in one small PR, independent of everything else here.
2. **Audit.** Every record method (about 200) is classified `read`, `write`, `atomic` or `exempt`. Every domain
   check-then-write is listed.
3. **Atomic primitives.** An invariant over several rows moves into the write that could break it: one `Ref.modify` in
   memory, and one transaction holding a keyed lock in SQL (`SqlStore.atomically(sql, key)`; `pg_advisory_xact_lock` on
   Postgres). The system module keeps its early check, but only for error precedence. The primitive is the authority.
4. **`RecordsContract`** (`@awthaq/test`). Cases are data. Each store has one suite, keyed by its `/records/` key, and the
   suite's `methods` map is keyed by the store's operations, so an unclassified method does not compile. The cases reuse
   `StoreContract`'s `Case`, `race` and `run`. `runPluginContractTests` gains a `records` option. It is required by the
   compiler for every plugin whose bundle provides a store, it reads the adapters from `Plugin.records`, and it runs every
   case on memory and on SQL (SQLite in `pnpm test`, Postgres in `pnpm test:pg`), with a fresh adapter per case.
5. **Migrate store by store, then delete the bespoke suites.** `examples/plugin-template` and `docs/plugin-authoring.md`
   teach the result. ADR-EA-041 gains decision 9 (§6).

### Goals

- G1. **No invariant over several rows is check-then-write.** Each one (owners, last team, the forest, the seven quotas,
  invitation transitions, API-key rotation, the passkey counter, the impersonation ledger) is enforced by the primitive
  that writes. A race case on memory, SQLite and Postgres proves it (§3.4).
- G2. **The last-owner race is fixed in a standalone patch** (tickets 02–03), with a deterministic failing test first and a
  natural-race case that is meaningful on Postgres.
- G3. **Every record method has a stated verdict** (`read` / `write` / `atomic` / `exempt` with reason), written next to its
  cases. A method added to an interface without one does not compile.
- G4. **One contract module, cases as data, adapters from `Plugin.records`.** No plugin test builds `TestSql.layer` or runs
  `Migrations.run` just to test a record store. Every store's cases run on memory, SQLite and Postgres.
- G5. **Coverage is compiler-enforced.** `runPluginContractTests` does not compile for a plugin whose bundle provides a store
  without a suite. `pnpm check` fails when a `Contract.test.ts` with `records` is missing from `scripts/test-pg.sh`.
- G6. **Replace, don't layer.** The 19 bespoke suites are deleted as their store migrates. The five stores without an
  adapter-level SQL suite get one. Measured targets are in §5.4.
- G7. **The authoring story teaches it.** The template's record store has a classified suite, including one `atomic` method
  with a `race` case. The docs' record-store section and checklist describe the rule and the runner.

### Non-goals

- **No collapse of the twins.** Core's twins each restated the domain, and plan 02 collapsed them. A plugin's twins are its
  adapters, and the domain sits once above them. The adapters stay, and the contract is what keeps them honest.
- **No schema change.** Every fix is a query, a lock or a code change, so rollback is `git revert` alone (§7).
- **No transactional memory** (`TxRef`). ADR-EA-041 rejected it for core, and atomicity stays per primitive here too.
- **No publication of the cases** for third-party adapters (a `./contract` sub-path). See Q1. The cases live in each plugin's
  `test/contract/`.
- **No change to core stores** or to `StoreContract`'s core cases. Plan 16 (executed) shaped `packages/sql`'s core
  adapters, and plan 28 owns what is left there. `SessionStoreSql`'s two inline advisory locks (`:417`, `:588`) are left
  for plan 28 to move onto `SqlStore.atomically`.
- **No differential parity harness** (plan 24's `runRecordsParity`) and **no Track A** (memory adapter over SQLite).
  §8 and Q0 explain why.
- **No change to what `runTenantIsolationTests` and `runSealedColumnTests` check.** The contract only provides their
  adapters (tenancy is folded into a suite; sealed calls reuse the base builder).
- **No BDD scenario for a race.** BDD steps are sequential HTTP. Concurrency is proven at the store (contract) and the system
  module (domain regression tests). BDD gains only the tooling scenarios of §6.3.
- **Erasure of a sole owner** leaves an ownerless organization by design today. That is not a race, so it is Q3, not a fix.

---

## 2. Verified current state

### 2.1 Re-measurement commands

```bash
# twin modules (export both adapters) and their size
grep -rlE "export const layerMemory" packages/*/src | xargs grep -lE "export const layerSql" | wc -l          # 22
grep -rlE "export const layerMemory" packages/*/src | xargs grep -lE "export const layerSql" | xargs cat | wc -l   # 11442
wc -l packages/two-factor/src/TwoFactorStore.ts packages/roles/src/RoleAssignments.ts                           # 686 + 191
# record stores (keys with a /records/ segment), template excluded
grep -rhoE '"[a-z@/.-]+/records/[A-Za-z]+"' packages/*/src | sort -u | wc -l                                     # 25
# hand-rolled per-store suites
grep -lE "^const (suite|contract) = \(" packages/{admin,jwt,organization,passkey,qadi,saml,scim,two-factor,webhooks}/test/*.test.ts | wc -l   # 19
# hand-built databases in tests
grep -rlF "TestSql.layer(" packages/*/test examples/*/test | wc -l                                              # 41 (28 outside packages/{core,sql,test})
grep -rlE "Migrations\.run\(" packages/*/test examples/*/test | wc -l                                           # 30 (34 with features/)
# the domain check-then-write sites of §2.6
grep -n "countOwners\|wouldViolateOwnerInvariant" packages/organization/src/OrganizationMembers.ts
grep -rnE "count[A-Za-z]*\(|memberCount >=|\.length >= settings\.max" packages/{organization,webhooks}/src/{Organization,Webhooks}*.ts
grep -rn "vanished between\|\"RowVanished\"" packages/*/src --include=*.ts | grep -v ports/src/Defects.ts | wc -l   # 15 (14 in plugins)
# store-level concurrency cases today
grep -lE 'concurrency: "unbounded"' packages/{admin,api-key,device-authorization,jwt,organization,passkey,qadi,roles,saml,scim,two-factor,webhooks}/test/*.ts
# Postgres coverage today (every plugin's Contract.test.ts is already listed; OrganizationMembers.test.ts is not)
grep -c "packages/\|examples/" scripts/test-pg.sh                                                               # 65 suites
grep -n "OrganizationMembers" scripts/test-pg.sh                                                                # (nothing)
```

### 2.2 Counts (2026-11-08)

| Measure | Value | Note |
|---|---:|---|
| Record stores in shipped packages | **25** | 24 modules; `TwoFactorStore.ts` holds two |
| Modules exporting both `layerMemory` and `layerSql` | 22 (11,442 lines) | plus `TwoFactorStore.ts` (`layerSecrets*`, `layerRecoveryCodes*`, 686) and `RoleAssignments.ts` (twins not exported, only `records`, 191) = **12,319 lines** |
| Hand-rolled `suite(name, layer)` record-store test files | **19** (7,639 lines, ~212 case definitions) | each runs its cases twice (memory, SQL) |
| Test files building `TestSql.layer(` | 41 | 28 outside `packages/{core,sql,test}` |
| Test files running `Migrations.run(` | 30 | 34 counting `features/` |
| `scripts/test-pg.sh` suites | 65 | all 13 plugin `Contract.test.ts` files (12 packages + template) are already listed, so G5's script rule starts green |
| Stores with no adapter-level suite on SQL | **5** | `ApiKeyRecords` and `DeviceGrantRecords` are used only to arrange rows in domain suites (device CAS cases run on `layerMemory` only, `device-authorization/test/Plugin.test.ts:220-304`). `ApiKeyClientRecords`, `DeviceClientRecords` and `RoleAssignments` are never driven directly |
| Record-store test files with a store-level concurrency case | 4 | `ChallengeStore`, `PasskeyUserHandle`, `KeyRing`, `TwoFactorStore`. The organization stores have none |
| Domain-level SQL test of BEH-EA-285 (owner invariant) | **0** | `OrganizationMembers.test.ts` runs memory only and is not in `scripts/test-pg.sh`. BDD REQ-EA-724..727 are sequential |
| `as const` in the record modules | ~130 | allowed by lint (`.oxlintrc.json`: "`as const` stays allowed"), but not by this repo's plan convention. Rewritten methods drop it (Q9) |

### 2.3 Per-store inventory

"Mem"/"SQL" are the line where each adapter starts. "Suite today" is the adapter-level test, its case count, and whether
it runs under `test:pg`. "Findings" refer to §2.6.

| Package | Store (key `awthaq/<pkg>/records/…`) | Module, lines | Mem / SQL | Ops | Suite today | Findings |
|---|---|---|---|---:|---|---|
| admin | `ImpersonationRecords` | `ImpersonationRecords.ts` 790 | 325 / 534 | 6 | `ImpersonationRecords.test.ts` 21 (pg) | F7 |
| api-key | `ApiKeyRecords` | `ApiKeyRecords.ts` 241 | 83 / 140 | 7 | none (domain suites `ApiKey.test.ts`, pg) | F6, F10, F11 |
| api-key | `ApiKeyClientRecords` | `ApiKeyClientRecords.ts` 232 | 77 / 131 | 6 | none (`ServiceToken.test.ts` arranges) | F11 |
| device-authorization | `DeviceGrantRecords` | `DeviceGrantRecords.ts` 423 | 125 / 242 | 12 | CAS on memory only (`Plugin.test.ts:220`) | F11 (model CAS, untested on SQL) |
| device-authorization | `DeviceClientRecords` | `DeviceClientRecords.ts` 171 | 61 / 99 | 4 | none | F11 |
| jwt | `SigningKeyRecords` | `SigningKeyRecords.ts` 493 | 177 / 312 | 5 | via `KeyRing.test.ts` 24 (pg) | model (at most one current key; `markRotated` CAS) |
| jwt | `RevocationStore` | `RevocationStore.ts` 156 | 64 / 102 | 3 | `RevocationStore.test.ts` 7 (pg) | none |
| organization | `OrganizationRecords` | 471 | 124 / 286 | 8 | 10 (pg) | F9 (Directory sites) |
| organization | `MembershipRecords` | 499 | 147 / 299 | 10 | 9 (pg) | **F1**, F4 |
| organization | `ActiveContextRecords` | 419 | 123 / 244 | 9 | 9 (pg) | none (stale pointer re-validated on read, BEH-EA-289) |
| organization | `InvitationRecords` | 584 | 141 / 341 | 13 | 9 (pg) | F4 (`invitationLimit`), F5 |
| organization | `OrgRoleRecords` | 359 | 90 / 214 | 7 | 6 (pg) | F4 (`maximumRolesPerOrganization`), F9 |
| organization | `TeamRecords` | 1227 | 247 / 703 | 20 | 19 (pg) | **F2, F3**, F4 (`maximumTeams`, `maximumMembersPerTeam`) |
| organization | `ConnectionRecords` | 700 | 205 / 443 | 7 | 5 (pg) | none known |
| organization | `DomainClaims` | 239 | 92 / 141 | 3 | 6 (pg) | none known |
| passkey | `PasskeyCredentials` | 505 | 132 / 318 | 8 | 9 (pg) | F8 |
| passkey | `PasskeyUserHandles` | 137 | 53 / 81 | 2 | 11 (pg) | none (has a race case) |
| passkey | `ChallengeStore` (+ `layerCookie`) | 354 | 124 / 181 | 3 | 23 (pg; three adapters) | none (guarantees declared, WPS-009) |
| qadi | `UserClaims` | 343 | 157 / 215 | 6 | `UserClaims.test.ts` 12 (pg) | none known |
| roles | `RoleAssignments` | 191 | 53 / 112 | 5 | none (domain `RolesSql.test.ts`, pg) | F11 |
| saml | `SamlRecords` | 936 | 317 / 595 | 13 | 7 (pg) | none known |
| scim | `ScimRecords` | 805 | 186 / 492 | 14 | 6 (pg) | none known |
| two-factor | `TwoFactorSecrets`, `TwoFactorRecoveryCodes` | `TwoFactorStore.ts` 686 | 152, 269 / 359, 481 | 5 + 5 | 10 (pg) | model (`upsertPending`, `confirm`, `advanceLastUsedStep`, `markUsed` are CAS) |
| webhooks | `WebhookRecords` | 1358 | 336 / 861 | 24 | 9 (pg) | F4 (`maxEndpoints`), F9 |
| template | `NoteRecords` (`example/notes/records/…`) | `Template.ts` 367 | 101 / 155 | 2 | via `runTenantIsolationTests` only | teaching target (§3.8) |

"Ops" is approximate (functions plus `Effect`-valued members). Ticket 05 re-counts them exactly as it classifies them.

### 2.4 How `StoreContract` is built (the shape this plan reuses)

`packages/test/src/StoreContract.ts` (2,053 lines; plan 02, ADR-EA-041 decision 6; plans 16/17/23 added cases):

- `Case<R> = { name; run: Effect<void, unknown, R> }` (`:42-45`). Cases are values and need no test runner (`node:assert/strict`).
- `CONCURRENCY = 8` and `race(effect)` run 8 copies under `Effect.all(..., { concurrency: "unbounded" })` (`:48-55`). Race
  cases assert exact counts.
- `run(framework, { adapter, layer, cases })` (`:57-74`) registers each case under `describe("StoreContract: <adapter>")`
  and gives every case a **fresh** layer (`Effect.provide(config.layer)`): a new `Ref`, a new `:memory:` database, or a reset
  Postgres schema.
- Cases never read the ambient clock for expiry. A primitive takes the instant it judges at.
- The runners live in `packages/test/test/support/storeContract.ts`: `runOnMemory()` (`:112`), and
  `runOnSql(label, client)` (`:146`) over `TestSql.layer("store_contract")` (Postgres under `test:pg`), a WAL file
  (`:87`) and a libSQL file (`:101`). Four tiny test files call them, and `StoreContract.sql.test.ts` is in
  `scripts/test-pg.sh`.
- Core cases are one exported list per port (`auditLog`, `verification`, `accounts`, `users`, `sessions`, `relayCursor`).

Two plan-05 siblings sit beside it and are framework-injected the same way. `runTenantIsolationTests`
(`TenantConformance.ts`) classifies every method with `methods: { readonly [K in keyof Shape]: MethodClass }`, so an
unclassified method does not compile. That is the trick §3.5 reuses for atomicity. `runSealedColumnTests` is the other.
Both take hand-built `adapters` today.

### 2.5 The last-owner race, reproduced (and three more)

`OrganizationMembers.remove` (`packages/organization/src/OrganizationMembers.ts:301-355`):
`requireTarget` (`:305`) → `wouldViolateOwnerInvariant` (`:306-310`, which calls `members.countOwners`, `:170-177`) →
`BeforeRemoveMember` veto (`:313-315`) → `sqlTransaction.withTransaction` (`:319-336`) → `members.remove`. The count and the
delete are separate calls with a hook between them.

- **`setRoles`** (demote) has the same shape: check at `:264-272`, veto at `:273-275`, `members.updateRole` at `:279-288`.
- **`leave`** is `remove` with the user as actor (`Organization.ts:359-365`).
- SCIM and the SAML role mapping reach the same two methods (`Scim.ts:621`, `Saml.ts:1085`), so every path is affected.
- **Moving the check inside the transaction would not fix Postgres.** Under READ COMMITTED, two transactions each count 2
  owners and each delete a different row. Only a lock taken before the count, or SERIALIZABLE, prevents that. The repo
  already uses keyed advisory locks for exactly this (`SessionStoreSql.ts:417`
  `pg_advisory_xact_lock(hashtext('session-cap:' || userId))`, `:588`, `ImpersonationRecords.ts:593`).
- `MembershipRecords.remove`/`updateRole` answer `MembershipRecordNotFound` when the row is gone. `OrganizationMembers` turns
  that into a `RowVanished` **defect** (`:282-287`, `:325-331`), so two concurrent removals of one member give one `500`.

**Probes run for this plan** (throwaway test files copied into `packages/organization/test/`, run, then deleted; the
tree is unchanged). They ran at `ede063d8`, and the modules they exercise are byte-identical in the current tree.
Postgres ran in a podman `postgres:16-alpine` container. "Barrier" means a veto tap that holds each
caller until both have arrived, so both checks run before either write. That interleaving is deterministic, not a timing
race.

| Probe | memory | SQLite `:memory:` | Postgres |
|---|---|---|---|
| Two owners remove each other, barrier on `BeforeRemoveMember` | 0 owners left | 0 owners left | 0 owners left |
| Same, **no barrier** (natural concurrency) | 1 left (no interleave) | 1 left | **0 owners left, 3 of 3 runs** |
| Remove the last two teams, barrier on `BeforeDeleteTeam` (`allowRemovingAllTeams: false`) | 0 teams | 0 teams | 0 teams |
| Two adds with `membershipLimit: 2` and 1 member, barrier on `BeforeAddMember` | 3 members | 3 members | 3 members |
| `TeamRecords.moveTeam` A→B racing B→A, 8 rounds, **no hook** | 0 cycles | 0 cycles | **7 and 6 cycles** (two runs) |

The ticket 02 test is the first probe, turned into a permanent regression test.

### 2.6 Preliminary audit: check-then-write and atomicity drift

Severity: **P0** an invariant the product promises breaks and needs data surgery to repair; **P1** a structural invariant
or a security-adjacent decision is undone; **P2** a quota or lifecycle rule is exceeded or skipped; **P3** the wrong status
or a duplicate event. "Confirmed" means a probe in §2.5 reproduced it. Everything else comes from reading the code, and
ticket 05 confirms or refutes it.

| # | Where | Shape | Backends | Sev | Status | Fix (§3.4) |
|---|---|---|---|---|---|---|
| F1 | `OrganizationMembers.remove` `:301-355`, `setRoles` `:236-298` | `countOwners` → veto → write | all | **P0** | confirmed | tickets 02–03, then 10 |
| F2 | `OrganizationTeams.remove` `:519-560` | `countTeamsByOrganization <= 1` (`:524-527`) → veto → `removeTeam` | all | P1 | confirmed | 11 |
| F3 | `TeamRecords` SQL `moveTeam` `:956-1009`, `removeTeam` children check `:1071-1087`, `createTeam` under a parent `:916-955` | read closure/children, then write, in one transaction with no lock | **Postgres only** | P1 | `moveTeam` confirmed; the other two are the same cause | 11 |
| F4 | quotas: `membershipLimit` (`OrganizationMembers.add :203-206`, `OrganizationInvitations.accept :489-492`), `organizationLimit` (`OrganizationDirectory.create :226-229`), `invitationLimit` (`OrganizationInvitations.invite :306-312`), `maximumTeams` (`OrganizationTeams.create :369-372`), `maximumMembersPerTeam` (`:570`, `:678`, `OrganizationInvitations.accept :494-511`), `maximumRolesPerOrganization` (`OrganizationRoles.create :155-157`), webhooks `maxEndpoints` (`Webhooks.createEndpoint :602-610`) | count → (veto / DNS check) → insert | all | P2 | `membershipLimit` confirmed; the rest share the shape | 10–13, 16 |
| F5 | `InvitationRecords.updateStatus` (`UPDATE ... SET status WHERE id AND org`, no `status = 'pending'` guard; memory sets unconditionally) used by accept, reject, cancel and expire | read "pending" → write status | all | P2 | code | 12 |
| F6 | `ApiKey.rotate` `:921-946` | `ownedKey` + `isLive` → `mint` successor → `limitExpiry` (`:938`); a `revoke` in between leaves a live successor of a revoked key | all | P1 | code | 17 |
| F7 | `ImpersonationRecords.layerMemory` `create :348-369` (`Ref.update` `:366`, then `append` `:367`), `endEpisode :384-418`, `closeExpired :420-430` | the row and its ledger link in two steps (SQL does both in one transaction with an advisory lock, `:589-597`, `:702-724`) | memory | P2 | code | 15 |
| F8 | `PasskeyCeremony.counterVerdict` `:389-408` (plan 12 moved it out of `Passkey.ts`), then `recordUsage` `:468` | compare with a counter read earlier in the ceremony, then `max()` | all | P2 | code | 18 |
| F9 | 14 `RowVanished` defects in plugins (organization 13, webhooks 1) | "row vanished between check and write" can be reached by plain concurrency | all | P3 | code | in each module's ticket |
| F10 | `ApiKeyRecords.revoke` answers `void`, so `ApiKey.revoke :914-919` publishes `auth.apiKey.revoked` on a no-op. `layerMemory.insert` overwrites a duplicate id where SQL fails | drift | all / memory | P3 | code | 17 |
| C2–C10 | plan 24 §2.4 (verified there at `fc990c88`): team create-under vs remove orphan (C2, = F3); `memberCount` double decrement / negative (C3); `OrganizationRecords.update` lost update (C4); `ActiveContextRecords` first write PK race and `getOrThrow` defect (C5); `ConnectionRecords.update` resurrects a removed connection (C6); `UserClaims.modify` lost key (C7); `WebhookRecords.setDisabled`/`updateEndpoint` vs `bumpDead` (C8); `deleteEndpoint` two DELETEs, no transaction (C9); `SamlRecords.saveSession` DELETE+INSERT (C10) | SQL read-modify-write without lock or single statement | Postgres | P1–P3 | plan 24: by reading. Ticket 05 re-confirms each at the current tree | the store's ticket (§4) |
| R1–R6 + labels | plan 24 §2.3/§2.5: `listByOrganization` ignores `sortDirection` over SQL (R1, reproduced there), `(createdAt, id)` tie-break (R2, R3), `emailDomains` order (R4, R5), duplicate JWT `kid` (R6), SQLite PK `ConstraintError` missed by `orConflict`, six wrong `StoreUnavailable.operation` labels | memory/SQL drift | mixed | P2–P3 | plan 24 | the store's ticket; `orConflict` in ticket 06 |
| F11 | 5 stores lack an adapter-level SQL suite (§2.2) | coverage | – | – | measured | 17, 19, 24 |
| F12 | erasure (`OrganizationPersonalData` `deleteAllByUser`) of a sole owner | not a race; the org becomes ownerless by design | all | – | code | Q3 |

**Verified not to be bugs:** `ActiveContextRecords.setOrganization` racing a removal can leave a stale pointer, but it is
re-validated on read and is never an authority (BEH-EA-289). `DeviceGrantRecords.claim/decide/consume` are documented CAS
on both adapters (`:296-342`). `SigningKeyRecords` has at most one current key, and `markRotated` is a CAS (`KeyRing.ts:159-191`
handles the loser). `TwoFactor*` primitives are CAS (THS-005, BCR-002). `WebhookRecords.claimDue` leases with a guarded
`UPDATE` (`:1076-1084`). `PasskeyCredentials.recordUsage` is monotonic on both adapters (`:175-185`, `:375-378`).
`RoleAssignments.add/remove` are idempotent (`ON CONFLICT DO NOTHING` / `RETURNING`). `OrganizationTeams.remove`'s
`TeamHasChildren` is pre-checked and then re-checked in the records layer: atomically in memory, but not on Postgres (F3).
That pre-check plus re-check is the pattern §3.2 makes general.

### 2.7 Evidence corrections (review numbers checked)

- **Twins:** 22 modules export both `layerMemory` and `layerSql`, with **11,442** lines (the review said ~11,466, close). The
  twin set is **24 modules / 25 stores / 12,319 lines** once `TwoFactorStore.ts` (two stores, `layerSecrets*` and
  `layerRecoveryCodes*` names) and `RoleAssignments.ts` (twins kept private, exported only as `records`) are counted.
- **Anchors:** `TeamRecords` memory starts at **:247** and SQL at **:703** (the review said ~:251/~:707).
  `ImpersonationRecords` memory `create` writes at **:366-367** (the review said :369-370), and SQL `create` is **:702-724**
  (the review said :711-726). The drift covers **three** primitives (`create`, `endEpisode`, `closeExpired`), not one.
- `recordsParityProblems` was at `TestAuth.ts:973` at `ede063d8` (as the review said). It is at **`:1066`** in the current
  tree, with its base at `:1073-1074` and `runPluginContractTests` at `:1133`. Plan 08's "per-plugin
  `describe.each(recordModes)` ... was not written" is at `08-test-composition/PLAN.md:1193`, exact.
- **Hand-rolled suites:** **19** files, not "at least 10". The examples hold: `ImpersonationRecords.test.ts:65` (definition),
  `:330-331` (calls), `TeamRecords.test.ts:45`, `ScimRecords.test.ts:37`.
- `TestSql.layer`: **36** files at `ede063d8` (the review said ~35) and **41** in the current tree. `Migrations.run`:
  29 at `ede063d8` and **30** now in `packages/*/test` + `examples/*/test`, 34 with `features/` (the review said 28).
- **No adapter-level test:** `ApiKeyClientRecords` and `DeviceClientRecords`, as stated, **plus** `RoleAssignments`.
  `ApiKeyRecords` is only arranged inside domain suites, and `DeviceGrantRecords`' CAS cases run on memory only.
- **The race:** confirmed (§2.5), with three corrections. `setRoles`' demotion and `leave` are affected too. A concurrent
  double removal of one member is a `500` (F9). And putting the count inside the existing transaction is **not** enough on
  Postgres (READ COMMITTED write skew).
- **New: the same shape elsewhere.** The last-team rule, `membershipLimit` and the Postgres team forest are reproduced, and
  six more quotas share the code shape (F2–F4).
- **New: there is no SQL test of BEH-EA-285 at all** (`OrganizationMembers.test.ts` is memory-only and not in `test:pg`).
- **New: `test:pg` can run here** through podman, though not through docker (header).

---

## 3. Target design

### 3.1 The seam, and what sits behind it

```
  system modules (written once, ADR-EA-040)          OrganizationMembers · OrganizationTeams · Webhooks · ApiKey · Passkey …
        │  early check (error precedence only) ─┐
        ▼                                        │  the primitive is the authority: it refuses atomically
  ┌──────────────── record-store interface (the seam) ───────────────┐
  │  every operation classified: read · write · atomic · exempt      │  ← RecordsContract suite, keyed by "/records/" key
  └───────┬───────────────────────────┬──────────────────────────────┘
          ▼                           ▼                              ▼
   layerMemory (Ref)            layerSql (SqlClient)          a host's adapter (@awthaq/organization/records)
   atomic = one Ref.modify      atomic = SqlStore.atomically(sql, key)(…) = one transaction + keyed lock on Postgres
          └──────── Plugin.records = { memory, sql }  (BEH-EA-334; read by the runner, never hand-wired in tests) ┘
```

Leverage: one rule ("an invariant lives in the write") plus one runner, and every adapter, current or future, is held to
it. Locality: a store's verdicts, cases and tenancy cases sit in one file (`test/contract/<Store>.ts`). The interface gets
**deeper**: callers stop composing `count` with `write` and get one operation that answers "done, or refused, and why".

### 3.2 The atomic-primitive rule and `SqlStore.atomically`

**Rule (ADR-EA-041 decision 9, §6).** A record method whose result the domain relies on to keep an invariant over more than
one row, or over a row read earlier, is `atomic`. That covers a count bound, a "keep at least one", an acyclicity, a status
transition, a "still live" condition, and a row together with its ledger link. The method takes everything it needs to
decide (the limit, the expected state) and answers the refusal as a typed error. Two techniques are allowed:

- **Single-row condition:** one conditional statement (`UPDATE ... WHERE <condition> RETURNING`), for example the team
  `memberCount` increment or an invitation transition. Postgres row locks make it race-free under READ COMMITTED.
- **Multi-row invariant:** one transaction that first takes a lock keyed by the invariant's scope, then reads, decides and
  writes. Memory uses one `Ref.modify`.

The system module may keep its earlier check (that is what puts `OwnerInvariantViolation` before the veto, BEH-EA-288 D4),
but the primitive's answer decides.

```ts
// packages/sql/src/SqlStore.ts (addition). The only way to take the lock is inside the transaction it guards.
/**
 * Plan 25 (ADR-EA-041 decision 9): `effect` runs in one transaction (a savepoint inside a caller's,
 * ADR-EA-037) that first takes an exclusive lock named `key`, held until the outermost transaction ends.
 * Every writer that names the same key is serialised, so an invariant over several rows (an organization's
 * owners, a quota, the team forest) is read and written as one step. Postgres needs this because READ
 * COMMITTED lets two transactions each see the other's rows unchanged:
 * `pg_advisory_xact_lock(hashtextextended(key, 0))`. SQLite takes no lock: a client runs one transaction at a
 * time (its transaction acquirer holds a one-permit semaphore), and a second writer process gets SQLITE_BUSY,
 * never a skewed read.
 */
export const atomically =
  (sql: SqlClient.SqlClient, key: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    SqlTransaction.transactional(sql)(
      Effect.andThen(
        sql.onDialectOrElse({
          pg: () => Effect.asVoid(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`),
          orElse: () => Effect.void,
        }),
        effect,
      ),
    );
```

Keys are `<table>:<scope>:<id>`, for example `organization_membership:org:<orgId>` or
`organization_team:org:<orgId>`. A shared key serialises all writers of that scope. A hash collision only adds
serialisation, never unsafety. `hashtextextended` (64-bit, Postgres ≥ 11) replaces `hashtext` for new code.

**Why not `FOR UPDATE` on existing rows** (plan 02's `AccountsRepository.lockByUser`)? It has a zero-row hole: a quota on an
empty set, or two inserts into a scope with no rows, lock nothing. Inserts are never blocked. **Why not SERIALIZABLE?**
The `SqlTransaction` port has no isolation option, a serialization failure would surface as `StoreUnavailable` (the
transient retry runs only at the top level, never inside a caller's transaction, ADR-EA-028), and every caller would need
a retry loop. Both are listed as rejected alternatives in the ADR revision.

### 3.3 The hotfix (tickets 02–03): membership writes keep an owner

`MembershipRecords.remove` and `updateRole` refuse to take `owner` from the last owner, atomically. This guards the
existing primitives instead of adding new ones, so no unguarded path is left. `removeAllForOrganization` (organization
deletion) and `deleteAllByUser` (erasure, Q3) stay unguarded by design, and their doc comments say so.

```ts
// packages/organization/src/MembershipRecords.ts
/** BEH-EA-285: the write would leave the organization with no member holding `owner`. */
export class MembershipRecordLastOwner extends Data.TaggedError("MembershipRecords/LastOwner")<{
  readonly organizationId: string;
}> {}

export interface MembershipRecordsShape {
  // ...
  /**
   * Atomic (BEH-EA-285): refuses with `MembershipRecordLastOwner` when `role` drops `owner` from the
   * organization's only owner. The owner count and the write are one step on every adapter.
   */
  readonly updateRole: (
    userId: Users.UserId,
    organizationId: string,
    role: ReadonlyArray<string>,
  ) => Effect.Effect<
    MembershipRecord,
    MembershipRecordNotFound | MembershipRecordLastOwner | StoreFailure.StoreUnavailable
  >;
  /** Atomic (BEH-EA-285): refuses with `MembershipRecordLastOwner` to remove the organization's only owner. */
  readonly remove: (
    userId: Users.UserId,
    organizationId: string,
  ) => Effect.Effect<void, MembershipRecordNotFound | MembershipRecordLastOwner | StoreFailure.StoreUnavailable>;
}

// layerMemory: the decision is inside the one Ref.modify
const holdsOwner = (row: MembershipRecord) => row.role.includes("owner");
const ownersIn = (s: State, organizationId: string) =>
  Array.from(HashMap.values(s)).filter((row) => row.organizationId === organizationId && holdsOwner(row)).length;

const remove: MembershipRecordsShape["remove"] = (userId, organizationId) =>
  Ref.modify(
    state,
    (s): readonly [Result.Result<void, MembershipRecordNotFound | MembershipRecordLastOwner>, State] => {
      const key = keyOf(userId, organizationId);
      const target = HashMap.get(s, key);
      if (Option.isNone(target)) return [Result.fail(notFound(userId, organizationId)), s];
      if (holdsOwner(target.value) && ownersIn(s, organizationId) <= 1) {
        return [Result.fail(new MembershipRecordLastOwner({ organizationId })), s];
      }
      return [Result.succeed(undefined), HashMap.remove(s, key)];
    },
  ).pipe(Effect.flatMap(Effect.fromResult));

// layerSql: one transaction, the organization's membership lock first, then read, count and write
const atomicallyFor = (organizationId: string) =>
  // ticket 03 inlines the lock (no @awthaq/sql change, so the hotfix ships alone); ticket 06 swaps in SqlStore.atomically
  SqlStore.atomically(sql, `organization_membership:org:${organizationId}`);

const remove: MembershipRecordsShape["remove"] = (userId, organizationId) =>
  atomicallyFor(organizationId)(
    Effect.gen(function* () {
      const target = yield* findByUserAndOrgQuery({ userId, organizationId });
      if (Option.isNone(target)) return yield* Effect.fail(notFound(userId, organizationId));
      if (holdsOwner(toRecord(target.value)) && (yield* countOwnersQuery(organizationId)).count <= 1) {
        return yield* Effect.fail(new MembershipRecordLastOwner({ organizationId }));
      }
      yield* removeQuery({ userId, organizationId });
    }),
  ).pipe(unavailable("remove"));
// updateRole: the same shape. It refuses when the target holds owner, `role` does not, and the count is <= 1.
```

`OrganizationMembers` keeps `wouldViolateOwnerInvariant` before the veto (error precedence) and maps the primitive's
answers:

```ts
// remove, inside the existing transaction (OrganizationMembers.ts:322-331), and the same in setRoles (:279-288)
yield* members.remove(userId, organizationId).pipe(
  Effect.catchTags({
    // A concurrent removal of the same member won: the sequential answer, not a defect (F9).
    MembershipRecordNotFound: () => Effect.fail(new OrganizationErrors.MembershipNotFound()),
    // A concurrent removal or demotion of the other owner won (BEH-EA-285).
    "MembershipRecords/LastOwner": () => Effect.fail(new OrganizationErrors.OwnerInvariantViolation()),
  }),
);
```

Both errors are already in `remove`'s and `setRoles`' error channels and on the wire (409 / 404), so there is no API change.
The veto already ran, but no event or observer fires, because those run after the transaction. The accept compensation
(`OrganizationInvitations.ts:549-552`, inside `Effect.ignore`) is unaffected.

### 3.4 Primitive catalogue (Phase 3)

Each row is one interface change, one technique per adapter, one system-module change, and one race case in the store's
suite plus one domain regression test (barrier or natural race).

| # | Store primitive (new or changed) | Memory | SQL | System module change | Refusal mapped to |
|---|---|---|---|---|---|
| F1 | `MembershipRecords.remove`, `.updateRole` guard owners | in `Ref.modify` | `atomically(organization_membership:org:<id>)` | §3.3 | `OwnerInvariantViolation`, `MembershipNotFound` |
| F4 | `MembershipRecords.create(input, { within?: number })` → `MembershipRecords/LimitReached` | count in `Ref.modify` | same lock, `COUNT(*)`, insert | `OrganizationMembers.add`, `OrganizationInvitations.accept` keep the pre-check | `MembershipLimitReached` |
| F4 | `MembershipRecords.create(input, { ownedWithin?: { role; limit; grant } })` (the creator's membership in `OrganizationDirectory.create`'s transaction) | count the user's `role` memberships in `Ref.modify` | `atomically(organization_membership:owner:<userId>)`, cross-tenant count (witness), insert | `OrganizationDirectory.create`; a refusal rolls the organization row back (memory: the existing `orgs.delete` compensation, `:257`) | `OrganizationLimitReached` |
| F2 | `TeamRecords.removeTeam(org, id, { keepOne: boolean })` → `TeamRecords/LastTeam` | in the existing `Ref.modify` (`:429-450`) | `atomically(organization_team:org:<id>)`, count, children, delete | `OrganizationTeams.remove` passes `keepOne: !allowRemovingAllTeams` | `LastTeamCannotBeRemoved` |
| F3 | `TeamRecords.moveTeam`, `removeTeam`, `createTeam` (with a parent) take the forest lock | unchanged (already one `Ref.modify`) | `atomically(organization_team:org:<id>)` before the closure read | none | `TeamHierarchyCycle`, `TeamHasChildren` (existing) |
| F4 | `TeamRecords.createTeam(input, { within?: number })` → `TeamRecords/LimitReached` | count in `Ref.modify` | same forest lock, count, insert | `OrganizationTeams.create` (`:369`) | `TeamLimitReached` (existing tag) |
| F4 | `TeamRecords.addTeamMember(input, { within?: number })` → `TeamRecords/MemberLimitReached` | in `Ref.modify` | `UPDATE organization_team SET "memberCount" = "memberCount" + 1 WHERE id = $1 AND "memberCount" < $2 RETURNING` (the single-row technique) | `OrganizationTeams.addMember` `:570`, `setMembers` `:678` (final count under the team's lock), `OrganizationInvitations.accept` `:494-511` | `TeamMemberLimitReached` |
| F4 | `InvitationRecords.create(input, { pendingWithin?: { inviterId; limit; grant } })` | count in `Ref.modify` | `atomically(organization_invitation:inviter:<id>)` | `OrganizationInvitations.invite` `:306` | `InvitationLimitReached` |
| F5 | `InvitationRecords.transition(org, id, { from: "pending"; to })` → `boolean`; `updateStatus` is deleted | compare in `Ref.modify` | `UPDATE ... SET status = $to WHERE id AND org AND status = 'pending' RETURNING` | accept (inside its transaction: a lost transition fails the unit, so the membership rolls back on SQL and is compensated in memory), reject, cancel, expire | `InvitationNotPending` |
| F4 | `OrgRoleRecords.create(input, { within?: number })` | count in `Ref.modify` | `atomically(organization_role:org:<id>)` | `OrganizationRoles.create` `:155` | `RoleLimitReached` (existing tag) |
| F4 | `WebhookRecords.createEndpoint(input, { within?: number })` | count in `Ref.modify` | `atomically(webhooks_endpoint:tenant:<tenant or "-">)` | `Webhooks.createEndpoint` `:606` (the pre-check stays before the DNS validation) | `WebhookEndpointLimitReached` |
| F6 | `ApiKeyRecords.rotate({ predecessorId, successor, graceUntil, now })` → `"rotated" \| "notLive"` | one `Ref.modify` (check live, set expiry, insert) | one transaction: `UPDATE apikey_key SET "expiresAt" = <min> WHERE id = $1 AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > $now) RETURNING id`, then insert | `ApiKey.rotate` (`mint` builds the record, the primitive stores it) | `ApiKeyNotFound` |
| F10 | `ApiKeyRecords.revoke` → `boolean`; memory `insert` refuses a duplicate id (a defect, like SQL's unique violation) | `Ref.modify` | `RETURNING id` | `ApiKey.revoke` publishes only on `true` | – |
| F7 | `ImpersonationRecords` memory: the row write and its ledger link in **one** critical section (`appendLock.withPermit` around both, uninterruptible); `verifyChain` reads rows and ledger under the same permit | as stated | unchanged (already one transaction with the chain lock) | none | – |
| F8 | `PasskeyCredentials.recordUsage(id, counter, backedUp)` → `"advanced" \| "regressed"`, decided at the write | compare and set in `Ref.modify` | `UPDATE ... SET counter = $n, ... WHERE id = $id AND (counter < $n OR ($n = 0 AND counter = 0)) RETURNING id`; no row → `regressed` (or `NotFound` on a re-read) | `Passkey.applyCounterPolicy` decides from the answer (flag, then reject under `"reject"`) | `PasskeyCounterAnomaly` |
| F9 | every "vanished between check and write" in a plugin system module | – | – | map the primitive's not-found to the module's typed not-found | existing `*NotFound` |

Error tags of new internal errors follow `check:error-tags` (`<Store>/<Reason>`). Existing wire tags are reused unchanged.

### 3.5 `RecordsContract` (`packages/test/src/RecordsContract.ts`)

```ts
// @awthaq/test — RecordsContract
//
// Plan 25 (ADR-EA-041 decision 9): the bar every adapter of a plugin's record store must clear,
// the plugin-side twin of StoreContract. One suite per store; every operation of the store's
// interface carries a verdict and the cases that prove it; the runner reads the adapters from
// `Plugin.records` and runs every case on each, a fresh adapter per case.
import type { Auth, AuthPlugin } from "@awthaq/core";
import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import * as StoreContract from "./StoreContract.ts";
import type { TestFramework } from "./TestFramework.ts";
import type * as TenantConformance from "./TenantConformance.ts";

export type Case<R> = StoreContract.Case<R>;
export const race = StoreContract.race;
export const CONCURRENCY = StoreContract.CONCURRENCY;

/** What a case may read besides its store: what every adapter is built over (crypto, AuthEvents, hook points, AuditChain, the test Encryption). */
export type Base = Layer.Success<typeof recordsFoundation>;

type NonEmpty<A> = readonly [A, ...Array<A>];

/** The audit's verdict on one operation, written where its cases are (ADR-EA-041 decision 9). */
export type Verdict<R> =
  /** Reads; no write. */
  | { readonly read: NonEmpty<Case<R>> }
  /** One row, one statement / one `Ref.update`, no condition anyone relies on (last writer wins). */
  | { readonly write: NonEmpty<Case<R>> }
  /** A read-modify-write the domain relies on: atomic by contract, and at least one `race` case proves it. */
  | { readonly atomic: NonEmpty<Case<R>>; readonly race: NonEmpty<Case<R>> }
  /** Not driven here, and why (a test seam, a method only a cascade calls and another suite covers). */
  | { readonly exempt: string };

/** The operations of a store interface: its functions and its `Effect`-valued members (`listEndpoints`), not data (`ChallengeStore.guarantees`). */
export type Operations<Shape> = {
  readonly [K in keyof Shape as Shape[K] extends
    | ((...args: never) => unknown)
    | Effect.Effect<unknown, unknown, unknown>
    ? K
    : never]: Shape[K];
};

/** A store's suite; `Id` (the store's identifier type) ties it to its key in `Suites`. */
export interface Suite<in out Id> {
  readonly store: Context.Key<Id, unknown>;
  readonly entries: ReadonlyArray<{
    readonly operation: string;
    readonly verdict: "read" | "write" | "atomic" | "race";
    readonly case: Case<Id | Base>;
  }>;
  readonly exempt: ReadonlyArray<{ readonly operation: string; readonly reason: string }>;
  readonly sql: ReadonlyArray<Case<Id | Base | SqlClient.SqlClient>>;
  readonly tenancy: ReadonlyArray<TenantConformance.TableCase<unknown, unknown, Id | Base>>;
}

export const suite = <Id, Shape, RowId = never>(
  store: Context.Key<Id, Shape>,
  definition: {
    /** Every operation, with its verdict. A new operation without one does not compile. */
    readonly operations: { readonly [K in keyof Operations<Shape>]: Verdict<Id | Base> };
    /** Adapter-level cases that read rows directly (atomicity under `TestSql.injectFailure`, a dialect codec). SQL modes only. */
    readonly sql?: ReadonlyArray<Case<Id | Base | SqlClient.SqlClient>>;
    /** Plan 05's tenant-isolation cases for this store's tables, run over the same adapters (`runTenantIsolationTests`, with `rls`). */
    readonly tenancy?: ReadonlyArray<TenantConformance.TableCase<Shape, RowId, Id | Base>>;
  },
): Suite<Id> => {
  /* flatten `operations` into entries (each case named "<operation> [<verdict>]: <case name>") and exemptions */
};

/** One suite per store the plugin's bundle provides, keyed by its "/records/" key. A missing or surplus key does not compile. */
export type Suites<P extends { readonly records: AuthPlugin.AnyRecords }> = {
  readonly [S in Layer.Success<P["records"]["memory"]> as AuthPlugin.RecordKeysOf<S>]: Suite<S>;
};

export interface RunConfig<P extends { readonly records: AuthPlugin.AnyRecords }> {
  readonly suites: Suites<P>;
  /** Names the Postgres schema (`TestSql.layer`); one per test file. */
  readonly suite: string;
  /** Another adapter of some of the stores (passkey's `ChallengeStore.layerCookie`). Run on the suites of the keys it provides. */
  readonly adapters?: ReadonlyArray<{ readonly name: string; readonly layer: Layer.Layer<never, unknown, Base> }>;
}

/**
 * The base every adapter of a mode is built over, shared with the parity check: the foundation plus the
 * test Encryption, and in SQL mode a client migrated with core's migrations and then the composition's
 * (SQLite `:memory:`, or this suite's Postgres schema under `AWTHAQ_POSTGRES_URL`).
 */
export const recordsBase = (
  mode: "memory" | "sql",
  migrations: Auth.Built<ReadonlyArray<AuthPlugin.Any>>["migrations"],
  suite: string,
) => /* memory: recordsFoundation; sql: recordsFoundation + migratedClient(migrations, suite) (SqlClient in the output) */;

/** Registers every case of every suite, on memory and on SQL, plus the coverage and tenancy checks. */
export const run = <P extends AuthPlugin.Any & { readonly records: AuthPlugin.AnyRecords }>(
  framework: TestFramework,
  plugin: P,
  host: ReadonlyArray<AuthPlugin.Any>,
  config: RunConfig<P>,
): void => {
  /*
   * describe(`RecordsContract: ${plugin.id}`)
   *   it("every store the bundle provides has a suite, and every suite names a store it provides")  // runtime half, for AuthPlugin.Any
   *   for (key, suite) of suites, for mode of ["memory", "sql", ...extra adapters]:
   *     StoreContract.run(framework, { adapter: `${key} (${mode})`, layer: bundle(mode), cases: suite.entries.map(e => e.case) })
   *     sql mode also runs suite.sql
   *   for each exemption: framework.it(`${key}.${operation} is exempt: ${reason}`, () => {})
   *   suite.tenancy → runTenantIsolationTests(framework, { plugin, adapters: [memory, sql], cases, covers: tables of the key,
   *                                                        rls: { layer: bundle("sql") } })
   * bundle(mode) = Layer.mergeAll(...[...host, plugin].map(p => p.records?.[mode] ?? Layer.empty))
   *                  .pipe(Layer.provideMerge(recordsBase(mode, Auth.make([...host, plugin]).migrations, `${config.suite}_${key}`)))
   */
};
```

Notes for the executor:

- **Fresh per case.** `StoreContract.run` already provides a fresh layer per case. Each SQL build resets the schema and runs
  the migrations, which is what the 19 bespoke suites already do per case, so this is not a regression. If Postgres time
  grows past the budget, see R2.
- **Host bundles** are provided too, so a `SamlRecords` case can arrange an organization row. A `dependsOn` store keeps its
  own suite in its own plugin.
- **Capabilities.** A store that declares what it guarantees (`ChallengeStore.guarantees`, WPS-009) lets its cases branch on
  the store's own value, as the current suite does (`ChallengeStore.test.ts:167,181,200`). The runner needs no feature for
  it.
- **Sealed columns** (`runSealedColumnTests`) stay separate calls, because they need each adapter's `raw`/`plant` seam
  (`MemoryEnvelopes` is projected out of the bundle, BEH-EA-334). They build over `RecordsContract.recordsBase(mode, ...)`
  instead of a hand-built `TestSql.layer` + `Migrations.run`.
- **Types are a spike (ticket 04):** `Operations<Shape>` key filtering; `Suites<P>` key remapping over the bundle's
  identifier union (`[S in Union as RecordKeysOf<S>]`); `Suite<Id>`'s invariance so a suite built for one store cannot sit
  under another's key; and `Context.Key<Id, Shape>` inference from a `Context.Service` class. `recordsFoundation` is
  `TestAuth.memoryFoundation` merged with `TestEncryption.layer`, the same base `recordsParityProblems` builds today
  (`TestAuth.ts:1073-1074`).

### 3.6 `runPluginContractTests` requires the suites

```ts
// packages/test/src/TestAuth.ts
/** Plan 25: the record-store contract, required exactly when the plugin's bundle provides a store. */
type RecordsOption<P> = [AuthPlugin.RecordKeysOf<AuthPlugin.RecordsOut<P>>] extends [never]
  ? { readonly records?: never }
  : P extends { readonly records: AuthPlugin.AnyRecords }
    ? { readonly records: RecordsContract.RunConfig<P> }
    : never;

export const runPluginContractTests = <O, P extends AuthPlugin.Any, R = never>(
  framework: TestFramework,
  makePlugin: (options: O) => P,
  config: ContractTestOptions<O, R> & RecordsOption<P>,
): void => {
  /* ...existing checks; the parity check reuses RecordsContract.recordsBase; then, once (not per option value):
     if (config.records !== undefined) RecordsContract.run(framework, makePlugin(config.options[0]), host, config.records) */
};
```

- A hand-built `AuthPlugin.Any` (the third-party shape, and `runPluginContractTests.test.ts`' fixtures) gets `records`
  optional with untyped suites. The runtime coverage check is its half (the spike decides the exact branch).
- **Fallback if the spike fails** (inference breaks existing calls, or `typecheck` time on `packages/organization` grows
  more than 15 %): a separate `TestAuth.runRecordsContract(framework, Plugin, config)`, plus `check-contract-tests.mjs`
  rule 3, "a class whose `AuthPlugin.Service` options carry `records:` has a `runRecordsContract` call". Record which path
  was taken in the Decisions section.
- `scripts/check-contract-tests.mjs` gains rule 4: every `Contract.test.ts` that passes `records:` is listed in
  `scripts/test-pg.sh`'s `suites`. This keeps G4's "and on Postgres" true.

### 3.7 A worked suite (ticket 10's shape)

```ts
// packages/organization/test/contract/MembershipRecords.ts
import { Users } from "@awthaq/core";
import { RecordsContract } from "@awthaq/test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MembershipRecords } from "../../src/records.ts";

const org = "org-1";
const owner = (n: number) => Users.UserId(`owner-${n}`);

export const membershipRecords = RecordsContract.suite(MembershipRecords.MembershipRecords, {
  operations: {
    create: {
      atomic: [ /* round-trip; MembershipRecordAlreadyExists on a second (userId, org); `within` refuses at the limit */ ],
      race: [
        {
          name: "8 creates racing at limit - 1 store exactly one",
          run: Effect.gen(function* () { /* RecordsContract.race(...) and assert the count is the limit */ }),
        },
      ],
    },
    remove: {
      atomic: [
        {
          name: "the only owner is refused (MembershipRecords/LastOwner) and stays",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            yield* records.create({ userId: owner(1), organizationId: org, role: ["owner"] });
            const refused = yield* Effect.flip(records.remove(owner(1), org));
            assert.equal(refused._tag, "MembershipRecords/LastOwner");
            assert.ok(Option.isSome(yield* records.findByUserAndOrg(owner(1), org)));
          }),
        },
      ],
      race: [
        {
          name: "8 owners removing one another concurrently leave exactly one",
          run: Effect.gen(function* () {
            const records = yield* MembershipRecords.MembershipRecords;
            for (let n = 0; n < RecordsContract.CONCURRENCY; n++) {
              yield* records.create({ userId: owner(n), organizationId: org, role: ["owner"] });
            }
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) => Effect.exit(records.remove(owner(n), org))),
              { concurrency: "unbounded" },
            );
            assert.equal(outcomes.filter((exit) => exit._tag === "Success").length, RecordsContract.CONCURRENCY - 1);
            assert.equal(yield* records.countOwners(org), 1);
          }),
        },
      ],
    },
    updateRole: { atomic: [/* ... */], race: [/* demote vs remove: one owner remains */] },
    findByUserAndOrg: { read: [/* ... */] },
    listByOrganization: { read: [/* createdAt order, offset/limit */] },
    listByUser: { read: [/* across organizations with the witness */] },
    countByOrganization: { read: [/* ... */] },
    countOwners: { read: [/* json role containment on both dialects */] },
    removeAllForOrganization: { write: [/* unguarded by design: an organization deletion */] },
    deleteAllByUser: { write: [/* unguarded by design: erasure (Q3) */] },
  },
  tenancy: [/* moved verbatim from MembershipRecords.test.ts' runTenantIsolationTests call */],
});

// packages/organization/test/Contract.test.ts
TestAuth.runPluginContractTests(framework, () => Organization.Organization, {
  options: [{}],
  build: { services: Layer.empty },
  records: {
    suite: "organization_contract",
    suites: {
      "awthaq/organization/records/MembershipRecords": membershipRecords,
      "awthaq/organization/records/TeamRecords": teamRecords,
      // ... the eight keys; leaving one out does not compile
    },
  },
});
```

### 3.8 The template teaches it

`examples/plugin-template` gains a per-owner note quota (`NotesConfig.maxNotesPerOwner`, default 100). It is the smallest
real invariant there is: `NoteRecords.create(input, { within })` is `atomic`, and the SQL adapter uses
`SqlStore.atomically(sql, "notes_note:owner:<owner>")`. The domain keeps a pre-check, and the typed refusal reuses the
template's existing "domain refusal is a typed error" path. Its suite (`test/contract/NoteRecords.ts`) has one `atomic` +
`race` entry, one `read` entry, and the tenancy cases moved from `Template.test.ts:158-213`. `Template.test.ts` drops its
hand-built `MemoryRecords`/`RecordsLive` (`:158-170`). The alternative, a quota-free template, would teach the
classification without ever showing `atomic`/`race` (Q5).

### 3.9 Rejected alternatives

- **Collapse each plugin store's twins into one implementation over a narrower port** (the literal ADR-EA-041 shape). The
  domain is already single (ADR-EA-040). The twins are thin adapters, and the drift is in atomicity, which the primitives
  plus contract fix at a fraction of the churn.
- **Cases in each plugin's `src/` (or on `Plugin.records`)** so a host's adapter could run them. That ships test code in
  runtime packages, and no host is known to bring its own plugin record adapter (Q1).
- **A separate `runRecordsContract` call enforced only by a script.** Weaker than a compile error. It is kept as the
  fallback (§3.6).
- **Row `FOR UPDATE` or SERIALIZABLE** instead of keyed advisory locks (§3.2).

---

## 4. Phased migration

Order: Phase 0 → 1 → 2 → 3 (stores with invariant findings, highest severity first) → 4 (the rest, any order) → 5.
Tickets 02–03 can ship from any branch, before everything else. Phase 3 and 4 tickets touch the same records modules as
plan 22's phases 2–9 (DDL moves into each records module). Run them **after plan 22 has finished with that package**. A
store ticket that has to go first rebases plan 22, not the other way round.

**Gates.** Per phase: `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, plus
`AWTHAQ_POSTGRES_URL=... pnpm test:pg` (podman, header). Per ticket: the single-file runs named in the ticket, e.g.
`pnpm exec vitest run --project organization packages/organization/test/OrganizationMembers.test.ts`, once without and
once with `AWTHAQ_POSTGRES_URL`. Per plan: `pnpm check`. Treat `pnpm knip` as passing when every reported file is under
`.reports/` (`IMPLEMENTING.md`). Commits follow `IMPLEMENTING.md`: one per green ticket, subject `<type>(<scope>): <summary>
(plan 25 ticket NN)`, with boxed diagrams.

### Phase 0: baseline, the owner hotfix, the type spike (tickets 01–04)

**01 — Baseline and a Postgres runner.**
- Files: `.scratch/25-record-store-contract/baseline.md` (not committed).
- Change: record every count of §2.1/§2.2 at the starting commit. Record wall time of `pnpm test`,
  `pnpm test:pg` (podman Postgres) and each of the 13 `Contract.test.ts` files plus the 19 bespoke suites, run alone
  with and without `AWTHAQ_POSTGRES_URL`. Record `pnpm typecheck` time on `packages/organization` (the spike's budget
  base).
- Done when: the file holds every number §5.4 compares against.
- Gate: none (measurement only).

**02 — Failing tests: the last-owner race.**
- Files: `packages/organization/test/OrganizationMembers.test.ts`,
  `packages/organization/test/MembershipRecords.test.ts`, `scripts/test-pg.sh` (add `OrganizationMembers.test.ts`).
- Change: add a module-level barrier helper. It returns a veto handler that holds every caller until N have arrived
  (`Ref.makeUnsafe(0)`, `Latch.makeUnsafe(false)`, `Ref.updateAndGet`, `latch.open`, `latch.await`; effect 4.1.2
  `Latch.ts:164`, `Ref.ts:146`, `:1243`). Then add `describe("OrganizationMembers owner invariant under concurrency (<mode>
  records)")` over `TestAuth.recordModes` (`records: "sql", suite: "organization_members_race"` for SQL) with:
  1. "two owners removing each other leave exactly one owner; the loser is OwnerInvariantViolation" (barrier on
     `BeforeRemoveMember`, the §2.5 probe);
  2. "an owner demoting the other while being removed leaves one owner" (one barrier shared by `BeforeUpdateMemberRole`
     and `BeforeRemoveMember`);
  3. "two removals of the same member: one succeeds, the other is MembershipNotFound, never a defect" (F9);
  4. "natural race, 8 rounds, no hook: every round leaves an owner". It is meaningful on Postgres, where it fails today
     3/3, and it passes trivially on memory and SQLite.

  In `MembershipRecords.test.ts`'s existing suite (both layers) add the store-level case "8 owners removing one another
  concurrently leave exactly one", which goes red after ticket 03 changes the interface.
- Done when: cases 1–3 fail on memory and SQLite, and 1–4 fail under `test:pg`. They are recorded in the ticket as red.
  The branch is never merged red: 02 and 03 land together as one PR, test commit first.
- Gate: the four cases red, everything else green.

**03 — Hotfix: membership writes keep an owner (standalone patch).**
- Files: `packages/organization/src/MembershipRecords.ts`, `packages/organization/src/OrganizationMembers.ts`,
  `spec/behaviors/35-organization.md` (BEH-EA-285 implementation note, Document Control 1.7 → 1.8),
  `spec/traceability.md` (the BEH-EA-285 test row names `OrganizationMembers.test.ts` and its `test:pg` run),
  `.changeset/organization-owner-invariant-atomic.md`.
- Change: as §3.3. Add `MembershipRecordLastOwner` (`"MembershipRecords/LastOwner"`). `remove` and `updateRole` decide
  inside one `Ref.modify` (memory). In SQL they decide inside one `SqlTransaction.transactional(sql)` that first runs
  `sql.onDialectOrElse({ pg: () => sql\`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))\`, orElse: () =>
  Effect.void })`, inline, with `key = "organization_membership:org:<organizationId>"`. `OrganizationMembers.remove`/`setRoles`
  keep the pre-check and map `MembershipRecordNotFound` → `MembershipNotFound` and `LastOwner` →
  `OwnerInvariantViolation` (removing the two `RowVanished` defects at `:282-287` and `:325-331`). Doc comments on
  `removeAllForOrganization` and `deleteAllByUser` say "unguarded by design (organization deletion; erasure, see
  BEH-EA-285)". The rewritten memory methods drop `as const`.
- Changeset: `"@awthaq/organization": patch`. Text: "Removing, demoting or leaving can no longer leave an organization
  without an owner when two such requests race; a concurrent second removal of one member answers 404, not 500."
  `Migration:` "A custom `MembershipRecords` adapter (through `@awthaq/organization/records`) must refuse
  `MembershipRecordLastOwner` atomically in `remove` and `updateRole`. On Postgres, take a lock per organization before
  counting owners; a transaction alone is not enough under READ COMMITTED. BEH-EA-285, ADR-EA-041."
- Done when: ticket 02's cases are green on memory, SQLite and Postgres. The four BDD scenarios REQ-EA-724..727 still pass.
  `grep -n "RowVanished" packages/organization/src/OrganizationMembers.ts` shows only the `add` path, if any.
- Gate: per-phase gate + `pnpm test:pg` + `pnpm test:bdd` + `pnpm spec:verify:strict` + `pnpm check:error-tags`.

**04 — Spike: `RecordsContract` types.**
- Files: `packages/test/test/RecordsContract.types.test.ts` (it becomes the permanent type test in ticket 07).
- Change: prove with `// @ts-expect-error` lines and `Includes<…>` constants (the `*.types.test.ts` convention of
  `packages/test/test/TestAuthRecords.types.test.ts`):
  1. `Operations<Shape>` keeps functions and `Effect`-valued members and drops data. Check it on `ChallengeStoreShape`
     (drops `guarantees`), `WebhookRecordsShape` (keeps `listEndpoints`) and `DeviceClientRecordsShape` (keeps `list`).
  2. `suite(Store, { operations })` infers `Id`/`Shape` from a `Context.Service` class, and omitting an operation is an
     error naming it.
  3. `Suites<typeof Organization.Organization>` has exactly the eight `/records/` keys. A missing key and a suite built
     for another store under a key are both errors (needs `Suite<in out Id>`).
  4. `runPluginContractTests` with `P` inferred from `() => Organization.Organization` requires `records`.
     `() => Password.Password` (no stores) forbids it. A hand-built `AuthPlugin.Any` makes it optional.
  5. `typecheck` time on `packages/organization` stays within +15 % of ticket 01's number.
- Done when: all five hold, or the spike records which fail. If 3–5 fail, ticket 08 takes the §3.6 fallback (a separate
  `runRecordsContract` call plus a script rule), and the Decisions section says so.
- Gate: `pnpm typecheck`.

### Phase 1: audit (ticket 05)

**05 — Audit every record store.**
- Files: `.scratch/25-record-store-contract/audit.md` (not committed; its verdict table is transcribed into each store's
  suite in Phases 3–4).
- Change: for each of the 25 stores, and for each operation (`Operations<Shape>`), record:
  1. the verdict (`read` / `write` / `atomic` / `exempt` + reason);
  2. how memory does it (one `Ref.modify`? several `Ref` calls?);
  3. how SQL does it (one statement? a transaction? a lock or a single conditional statement where the invariant spans a
     read?);
  4. every system-module caller that reads, then writes, through two calls. Use this recipe:
     `grep -n "yield\* <records>\.\(count\|find\|list\)" <module>`, then check whether a write follows before the
     function returns.

  Confirm or refute F2–F10 and plan 24's C2–C10 and R1–R6 at the current tree, each with a scratch probe (the §2.5
  method) or a line-cited reading. A newly found P0/P1 opens its own ticket before Phase 2. Re-count "Ops" in §2.3.
- Done when: every operation of every store has a verdict, and every finding has a severity, a status and an owning
  ticket.
- Gate: none (analysis). The orchestrator reviews the table before Phase 3 starts.

### Phase 2: substrate, contract module, runner, template (tickets 06–09)

**06 — `SqlStore.atomically`, and `orConflict` on SQLite.**
- Files: `packages/sql/src/SqlStore.ts`, `packages/sql/src/StoreFailure.ts`, `packages/sql/test/SqlStore.test.ts`
  (new or extended), `packages/sql/test/StoreFailure.test.ts`, `packages/organization/src/MembershipRecords.ts` (the
  hotfix's inline lock moves onto the helper), `.changeset/sql-store-atomically.md` (`@awthaq/sql: patch`, additive; no
  `Migration:` needed).
- Change: `atomically(sql, key)` as in §3.2, exported, and the bare lock not exported. `StoreFailure`'s unique-violation
  test also recognises SQLite's primary-key `ConstraintError` (plan 24 Phase 1 item 5).
- Done when: on Postgres, two fibers in `atomically(sql, "k")` that each read, sleep 50 ms and write never interleave
  (assert the order of a shared log); with distinct keys they do. On SQLite, both orders are serialised by the client.
  An `orConflict` over SQLite maps a PK clash like Postgres does.
- Gate: `pnpm exec vitest run --project sql packages/sql/test/SqlStore.test.ts packages/sql/test/StoreFailure.test.ts`
  with and without Postgres.

**07 — `RecordsContract` in `@awthaq/test`.**
- Files: `packages/test/src/RecordsContract.ts` (new), `packages/test/src/index.ts` (export
  `* as RecordsContract`), `packages/test/src/TestAuth.ts` (the parity check builds over `RecordsContract.recordsBase`),
  `packages/test/test/RecordsContract.test.ts` (new), `RecordsContract.types.test.ts` (from 04),
  `packages/test/README.md`, `.changeset/test-records-contract.md` (`@awthaq/test: minor`).
- Change: §3.5. Its self-test uses a fixture plugin with one store `Counter` (`increment(max)` atomic, `get` read) and
  three bundles:
  1. a correct pair, which passes in both modes;
  2. a memory adapter that reads and then writes in two `Ref` calls with a `yieldNow` between, whose `race` case must
     fail naming store, mode, operation and verdict;
  3. a bundle that provides a store the suites do not name, whose coverage check fails naming the key.

  Exemptions show up as passing tests named `"<key>.<operation> is exempt: <reason>"`. A `tenancy` entry runs
  `runTenantIsolationTests` over the derived adapters. Run it through the recording `TestFramework` that
  `runPluginContractTests.test.ts` uses.
- Done when: the three fixtures behave as stated, and `RecordsContract.test.ts` is in `scripts/test-pg.sh`.
- Gate: per-phase gate + `pnpm test:pg`.

**08 — `runPluginContractTests` requires the suites.**
- Files: `packages/test/src/TestAuth.ts`, `packages/test/test/runPluginContractTests.test.ts`,
  `scripts/check-contract-tests.mjs`, `features/features/08-tooling/25-testing-harness.feature` and its step definitions,
  `.changeset/test-records-contract.md` (same changeset).
- Change: §3.6 (or the fallback recorded by 04). The 13 existing `Contract.test.ts` calls compile only once they pass
  `records`. To keep main green, this ticket passes **`records: { suite, suites: RecordsContract.pending(plugin) }`**
  for each of them: a temporary, explicitly named value whose type satisfies `Suites<P>` and which registers one passing
  test per store, `"<key>: contract pending (plan 25 ticket NN)"`. Each Phase 3/4 ticket replaces its plugin's
  `pending` with real suites. Ticket 25 deletes `pending` and fails `pnpm check` if any use remains. The script gains
  rule 4: a `Contract.test.ts` passing `records` must be listed in `scripts/test-pg.sh`. BDD gains REQ ids for that rule
  (allocate with `features/scripts/allocate-req-ea.py`).
- `Migration:` (in the `@awthaq/test` changeset): "`runPluginContractTests` requires `records: { suite, suites }` for a
  plugin whose `records` bundle provides a store; write one `RecordsContract.suite` per store (see
  docs/plugin-authoring.md)."
- Done when: removing one key from organization's `suites` fails `pnpm typecheck`, naming the key. Deleting a
  `Contract.test.ts` line from `test-pg.sh` fails `pnpm check:contract-tests`.
- Gate: per-phase gate + `pnpm test:bdd`.

**09 — The plugin template teaches it.**
- Files: `examples/plugin-template/src/Template.ts`, `src/TemplateApi.ts` (if the refusal needs a tag),
  `test/contract/NoteRecords.ts` (new), `test/Contract.test.ts`, `test/Template.test.ts`, `examples/plugin-template/README.md`
  (if present).
- Change: §3.8. Add `maxNotesPerOwner`, `NoteRecords.create(input, { within })` atomic (memory `Ref.modify`, SQL
  `SqlStore.atomically`), a domain pre-check, the suite, and `Contract.test.ts` passing `records`. Delete
  `Template.test.ts`' hand-built record layers and its `runTenantIsolationTests` call, since both move into the suite.
- Done when: the template's `race` case "8 creates at max − 1 store exactly one" passes on memory, SQLite and Postgres,
  and fails when the memory adapter is changed to `Ref.get` + `Ref.update`. That second run is part of the ticket's
  evidence and is not committed.
- Gate: per-phase gate + `pnpm test:pg`.

### Phase 3: stores with invariant findings (tickets 10–18)

Every ticket in Phases 3–4 has the same frame, plus its specific items:

1. Write the store's suite in `packages/<pkg>/test/contract/<Store>.ts`, with verdicts from ticket 05. Move every case of
   the bespoke suite that asserts a behaviour into it (renamed `<operation> [<verdict>]: …`), plus its
   `runTenantIsolationTests` cases into `tenancy`. Move the bespoke file's SQL-only atomicity cases
   (`TestSql.injectFailure`) into `sql`.
2. Write the new `race` cases **red first**, together with the domain regression test for each invariant, on memory,
   SQLite and Postgres.
3. Change the primitives (§3.4) and their system-module callers. Delete the `RowVanished` sites the ticket owns. Drop
   `as const` in rewritten methods.
4. Swap the plugin's `RecordsContract.pending` for the suite in `Contract.test.ts`.
5. **Delete the bespoke suite** (`suite(...)` function and its two calls, its `TestSql.layer`/`Migrations.run` wiring).
   If cases remain that are not about the store (domain cases), keep that file and rebuild them over
   `RecordsContract.recordsBase`. Remove the deleted file from `scripts/test-pg.sh`.
6. Update spec (BEH note + Document Control), traceability rows and a changeset with `Migration:` for every interface
   change visible through a `records` sub-path or a `Shape` export.

Gate for every ticket: the package's tests with and without `AWTHAQ_POSTGRES_URL`, `pnpm typecheck`, `pnpm lint`,
`pnpm check:error-tags`. Per phase: the phase gate + `pnpm test:pg` + `pnpm test:bdd`.

**10 — organization `MembershipRecords`.** Primitives F1 (from 03), F4 `create(input, { within })` and
`create(input, { ownedWithin })`. Callers `OrganizationMembers.add` (`:203-206`), `OrganizationInvitations.accept`
(`:489-492`), `OrganizationDirectory.create` (`:226-229`, refusal rolls back or is compensated at `:257`). Plan 24's R1/R2
(`listByOrganization` honours `sortDirection`, `(createdAt, id)` tie-break; SQL orders and pages in SQL). Domain
regression tests: `membershipLimit` (barrier on `BeforeAddMember`, the §2.5 probe) and `organizationLimit` (barrier on
`BeforeCreateOrganization`). Delete `MembershipRecords.test.ts`'s bespoke suite. Done when the §3.7 suite is green on all
three backends and `grep -c "countOwners\|countByOrganization" packages/organization/src/Organization{Members,Invitations}.ts`
counts only pre-checks, each with a comment naming the authoritative primitive.

**11 — organization `TeamRecords`.** F2 `removeTeam(org, id, { keepOne })`. F3/C1/C2: forest lock
`atomically(organization_team:org:<id>)` in SQL `createTeam` (with parent), `moveTeam`, `removeTeam` (`:916`, `:956`,
`:1071`). C3: `DELETE … RETURNING "teamId"` and floored decrements in `removeUserFromOrganizationTeams`/`removeUserFromAllTeams`
and `adjustMemberCount` (`:911`). F4 `createTeam(input, { within })` and the conditional `memberCount` increment for
`addTeamMember(input, { within })`. Callers `OrganizationTeams.create` (`:369`), `remove` (`:519-560`), `addMember`
(`:570`), `setMembers` (`:678`), `OrganizationInvitations.accept` (`:508`). R3 (team listing `(createdAt, id)`). Race cases:
"crossing moves never make a cycle" (8 rounds, natural; red on Postgres today, 13/16 in §2.5), "the last two teams removed
concurrently leave one", "8 adds at `maximumMembersPerTeam − 1` store one", "a member removed twice concurrently decrements
once". Delete `TeamRecords.test.ts`' bespoke suite. Its five SQL-only atomicity cases move to `sql`.

**12 — organization `InvitationRecords`.** F5: `transition(org, id, { from: "pending", to })`. Delete `updateStatus`.
Callers: accept (inside its transaction, `:516`), reject (`:611-`), cancel (`cancelAndAnnounce` `:242-243`), expire. F4
`create(input, { pendingWithin })` for `invite` (`:306`). Race cases: "accept racing cancel: exactly one wins, the other
is `InvitationNotPending`, and no membership survives a lost accept", "8 invites at `invitationLimit − 1` store one".
Delete the bespoke suite.

**13 — organization `OrgRoleRecords`.** F4 `create(input, { within })`; caller `OrganizationRoles.create` (`:155-157`). F9:
the four `RowVanished` sites in `OrganizationRoles.ts` become `RoleNotFound`. Delete the bespoke suite.

**14 — organization: `OrganizationRecords`, `ActiveContextRecords`, `ConnectionRecords`, `DomainClaims`.** C4
(`OrganizationRecords.update` is one `UPDATE … SET col = COALESCE(…)` per patched column, `RETURNING *`). C5
(`ActiveContextRecords` writes are `INSERT … ON CONFLICT ("sessionId") DO UPDATE`, with no `getOrThrow`). C6
(`ConnectionRecords.update` is `UPDATE … WHERE id RETURNING *`, `None` is not-found, and domains are replaced in the same
transaction). R4 (`emailDomains` sorted, plan 24 Q2 default). F9: the four `RowVanished` sites in
`OrganizationDirectory.ts`. Delete four bespoke suites. `OrganizationSql.test.ts` keeps its cascade-atomicity cases (they
test `Organization.delete`, a system-module transaction) over `RecordsContract.recordsBase`.

**15 — admin `ImpersonationRecords`.** F7: memory `create` (`:348-369`), `endEpisode` (`:384-418`) and `closeExpired`
(`:420-430`) write the row and its ledger link in one `appendLock.withPermit` section, uninterruptible, and `verifyChain`
(`:469`) reads both under the permit. Race case: "8 creates racing `verifyChain` never report a break" (red on memory
today), plus "an interrupted create leaves neither row nor link". The SQL-only tamper cases (plan 24 counted 8) move to
`sql`. Delete the bespoke suite (`ImpersonationRecords.test.ts:65`, `:330-331`).

**16 — webhooks `WebhookRecords`.** F4 `createEndpoint(input, { within })`; caller `Webhooks.createEndpoint` (`:606`; the
pre-check stays before the DNS validation). C8: `setDisabled`/`updateEndpoint`/`bumpDead` are single-statement `UPDATE`s
of their own fields. C9: `deleteEndpoint`'s two DELETEs run in one `SqlTransaction.transactional`. F9: the one
`RowVanished` in `Webhooks.ts`. Plan 24's label fix and memory `claimDue` returning leased rows (W-1). Race cases:
"8 creates at `maxEndpoints − 1` store one", "admin PATCH racing `bumpDead` keeps both". Sealed calls stay
(`runSealedColumnTests` over `recordsBase`). Delete the bespoke suite.

**17 — api-key `ApiKeyRecords` and `ApiKeyClientRecords`.** F6 `rotate(...)` → `"rotated" | "notLive"`; caller
`ApiKey.rotate` (`:921-946`), where a lost rotation is `ApiKeyNotFound`. F10: `revoke` → `boolean`, `ApiKey.revoke`
(`:914-919`) publishes once, and memory `insert` refuses a duplicate id. F11: these are the **first adapter-level suites**
for both stores. Plan 24's labels for api-key outages. Race cases: "rotate racing revoke never leaves a live successor of
a revoked key", "8 concurrent revokes publish one `auth.apiKey.revoked`" (domain).

**18 — passkey `PasskeyCredentials`, `PasskeyUserHandles`, `ChallengeStore`.** F8: `recordUsage` → `"advanced" |
"regressed"`; caller `PasskeyCeremony.counterVerdict` (`:389-408`, `:468`) decides from the answer. Under
`counterAnomalyPolicy: "reject"` a regressed answer fails the ceremony with the counter not advanced. Race case: "two
assertions with the same counter: exactly one advances, the other is regressed". `ChallengeStore`'s suite runs on
`layerCookie` too, through `adapters`, with cases branching on `store.guarantees` as today. Delete three bespoke suites.
Coordinate with plan 22's D2 (the counter column becomes `BIGINT`): the conditional `UPDATE` is column-type agnostic.

### Phase 4: the remaining stores (tickets 19–24)

These are mostly migration. Ticket 05's verdicts and plan 24's items set the fixes. Each ticket follows the frame above.

**19 — device-authorization `DeviceGrantRecords`, `DeviceClientRecords`.** The CAS primitives (`claim`, `decide`,
`consume`) get `atomic`+`race` cases that run **on SQL and Postgres for the first time** (they are memory-only at
`device-authorization/test/Plugin.test.ts:220-304`, which moves into the suite). `DeviceClientRecords` gets its first suite
(F11). Labels per plan 24.

**20 — jwt `SigningKeyRecords`, `RevocationStore`.** R6: `create` with an existing `kid` is `KidTaken`, and an identical
re-registration is idempotent (plan 24 Q3 default). `KeyRing.ts`'s `Effect.die` becomes the typed error. Race case: "8
creates of a current key leave one current". `KeyRing.test.ts` keeps its domain cases over `recordsBase`, and its
store-level cases move into the suite. Delete `RevocationStore.test.ts`' bespoke suite.

**21 — two-factor `TwoFactorSecrets`, `TwoFactorRecoveryCodes`.** These are already atomic by contract. Verdicts and race
cases for `upsertPending`, `confirm`, `advanceLastUsedStep` and `markUsed` (the existing concurrency cases move). Delete
`TwoFactorStore.test.ts`' bespoke suite. Sealed calls stay.

**22 — saml `SamlRecords`.** C10 (`saveSession` is `INSERT … ON CONFLICT ("sessionId") DO UPDATE`; `update`/`remove` in
one transaction). R5 (`emailDomains` sorted). Delete the bespoke suite. Sealed calls stay.

**23 — scim `ScimRecords`.** Plan 24's link-conflict item (memory checks the full key), labels. Delete the bespoke suite.

**24 — roles `RoleAssignments` and qadi `UserClaims`.** `RoleAssignments` gets its **first suite** (F11). The
`Roles.test.ts`/`RolesSql.test.ts` store-level copies move into it, and their domain cases stay. C7: `UserClaims.modify`
takes `SqlStore.atomically(sql, "qadi_claims:user:<id>")`, so concurrent merges keep both keys and publish two correct
`claimsUpdated` events. Delete `UserClaims.test.ts`' bespoke `contract(...)`.

### Phase 5: close-out (tickets 25–27)

**25 — Sweep and shrinkage.**
- Delete `RecordsContract.pending`. `pnpm check:contract-tests` fails on any remaining use.
- Re-run §2.1 and record the §5.4 numbers in `.scratch/25-record-store-contract/result.md` beside the baseline.
- Remove every bespoke file from `scripts/test-pg.sh`, and confirm the 13 `Contract.test.ts` files and
  `OrganizationMembers.test.ts` are listed.
- `grep -rn "as const" ` over the rewritten methods: none in a rewritten method.
- Done when every §5.4 target is met or re-baselined with a reason (plan 08's "follow-up" discipline).

**26 — Docs teach the contract.**
- `docs/plugin-authoring.md`:
  - "Record stores and bundles": the verdicts, the atomic-primitive rule, `SqlStore.atomically`, pre-check versus
    authority.
  - "Testing a plugin": `RecordsContract.suite`, `test/contract/`, `records` in `runPluginContractTests`, Postgres via
    `test-pg.sh`.
  - "Multi-statement writes": "a transaction is not enough for an invariant over several rows on Postgres; take the scope's
    lock".
  - Checklist items 4, 6 and 10.
- `packages/test/README.md` (the kit list gains `RecordsContract`).
- `packages/organization/README.md`: the records sub-path note says a host adapter must pass the suites, and where they
  live (Q1).
- `pnpm check:readmes`.

**27 — Spec, ADR, traceability, BDD, changeset roll-up.** §6 in full. Done when `pnpm spec:verify:strict` and
`pnpm test:bdd` pass.

### Ticket table (maps 1:1 onto `.scratch/25-record-store-contract/issues/NN-*.md`)

| # | Title | Phase | Depends on |
|---|---|---|---|
| 01 | Baseline and a Postgres runner | 0 | – |
| 02 | Failing tests: the last-owner race | 0 | – |
| 03 | Hotfix: membership writes keep an owner | 0 | 02 |
| 04 | Spike: `RecordsContract` types | 0 | 01 |
| 05 | Audit every record store | 1 | 03 |
| 06 | `SqlStore.atomically`, and `orConflict` on SQLite | 2 | 03 |
| 07 | `RecordsContract` in `@awthaq/test` | 2 | 04, 06 |
| 08 | `runPluginContractTests` requires the suites | 2 | 07 |
| 09 | The plugin template teaches it | 2 | 08 |
| 10 | organization `MembershipRecords` | 3 | 05, 08, plan 22 (organization) |
| 11 | organization `TeamRecords` | 3 | 05, 08, plan 22 (organization) |
| 12 | organization `InvitationRecords` | 3 | 10 |
| 13 | organization `OrgRoleRecords` | 3 | 08 |
| 14 | organization: Organization/ActiveContext/Connection records, DomainClaims | 3 | 08 |
| 15 | admin `ImpersonationRecords` | 3 | 05, 08, plan 22 (admin) |
| 16 | webhooks `WebhookRecords` | 3 | 05, 08, plan 22 (webhooks) |
| 17 | api-key stores | 3 | 05, 08 |
| 18 | passkey stores | 3 | 05, 08, plan 22 (passkey D2) |
| 19 | device-authorization stores | 4 | 08 |
| 20 | jwt stores | 4 | 08 |
| 21 | two-factor stores | 4 | 08 |
| 22 | saml `SamlRecords` | 4 | 08, 14 |
| 23 | scim `ScimRecords` | 4 | 08 |
| 24 | roles `RoleAssignments`, qadi `UserClaims` | 4 | 08 |
| 25 | Sweep and shrinkage | 5 | 09–24 |
| 26 | Docs teach the contract | 5 | 09 |
| 27 | Spec, ADR, traceability, BDD, changesets | 5 | 25 |

---

## 5. Test plan

### 5.1 At the new interface

- **`RecordsContract.test.ts`** (ticket 07) proves the runner. It runs every case on every mode with a fresh adapter,
  catches a non-atomic memory adapter through a `race` case, catches a bundle/suite key mismatch at runtime, shows
  exemptions, and runs tenancy over derived adapters. **`RecordsContract.types.test.ts`** proves the compile-time half
  (ticket 04's five properties).
- **One suite per store, 25 suites** (plus the template), run from 13 `Contract.test.ts` files. Each runs on memory and
  SQL (SQLite in `pnpm test`, Postgres in `pnpm test:pg`). `ChallengeStore` also runs on `layerCookie`. Every `atomic`
  verdict has at least one `race` case (8-way, exact counts, `RecordsContract.race`). Ticket 05 fixes the expected count
  of atomic operations. The §3.4 catalogue alone gives at least 20.
- **Domain regression tests at the system modules** (the barrier technique, each on all three backends). There is one
  per invariant: owners (remove/remove, demote/remove, double remove), last team, `membershipLimit`,
  `organizationLimit`, `invitationLimit`, `maximumTeams`, `maximumMembersPerTeam`, `maximumRolesPerOrganization`,
  `maxEndpoints`, accept racing cancel, rotate racing revoke, the passkey equal-counter pair. They prove the module uses
  the primitive, while the store's suite proves the primitive. Neither re-tests the other's subject.
- **`SqlStore.test.ts`** proves the lock (serialised on one key, parallel across keys, a savepoint inside a caller's
  transaction keeps it until the outer end).

### 5.2 Replaced, not layered

- Deleted: the `suite`/`contract` functions and their calls in the 19 files of §2.2, with their `TestSql.layer` and
  `Migrations.run` wiring. Files left with no domain cases are deleted (expected: `RevocationStore.test.ts`, the eight
  organization `*Records.test.ts`, `PasskeyUserHandle.test.ts`, `PasskeyCredentials.test.ts`, `ChallengeStore.test.ts`,
  `ScimRecords.test.ts`, `SamlRecords.test.ts`, `WebhookRecords.test.ts`, `TwoFactorStore.test.ts`,
  `ImpersonationRecords.test.ts`, `UserClaims.test.ts`; ticket 05 confirms each).
- Moved, not copied: device-authorization `Plugin.test.ts:220-304` (CAS cases) into the device suite, `KeyRing.test.ts`'
  store-level cases into the signing-key suite, and `Roles.test.ts`/`RolesSql.test.ts` store-level cases into the roles
  suite.
- `runTenantIsolationTests` calls with hand-built `adapters` become `tenancy` entries. `runSealedColumnTests` calls stay
  but build over `RecordsContract.recordsBase`.
- `recordsParityProblems` keeps its job (the bundle pair builds and is matched), now over the shared base. The
  key-coverage check (every store has a suite) is new, not a copy.

### 5.3 Concurrency and real Postgres

`scripts/test-pg.sh` already lists the 13 `Contract.test.ts` files. It gains `OrganizationMembers.test.ts` (02),
`RecordsContract.test.ts` (07), `packages/sql/test/SqlStore.test.ts` (06), and the domain regression files of Phase 3,
and loses every deleted bespoke file. On Postgres, the race cases are the point. On memory they pin the reference
semantics. On SQLite they are smoke tests, because SQLite serialises transactions, but **not** a domain's two separate
calls: §2.5 shows SQLite fails the barrier tests too.

### 5.4 Measured targets (acceptance; numbers re-taken in ticket 25)

| Measure (§2.1 command) | Today | Target |
|---|---:|---:|
| Hand-rolled record-store `suite`/`contract` files | 19 | **0** |
| Test files building `TestSql.layer(` | 41 | **≤ 22** (41 − 19 bespoke − template, +1 slack) |
| Test files running `Migrations.run(` (packages + examples) | 30 | **≤ 11** |
| Stores without an adapter-level suite on SQL | 5 | **0** |
| Stores whose suite runs on Postgres | 20 of 25 | **25 of 25** |
| Record-store test files with a store-level race case | 4 | every store with an `atomic` verdict |
| SQL tests of BEH-EA-285 under `test:pg` | 0 | ≥ 4 (ticket 02) |
| Domain check-then-write sites without an authoritative primitive (§2.6 F1–F8) | 14+ | **0** |
| `RowVanished` defects in plugin system modules | 14 | **0** |
| Lines of record-store test code (19 files today, 20 stores) | 7,639 | recorded, not gated. Budget ≤ 8,500 for 25 stores plus the new race cases; wiring alone drops by ~800 |
| `pnpm test` / `pnpm test:pg` wall time | ticket 01 | ≤ baseline + 15 % (R2) |

---

## 6. Spec, ADR, traceability, BDD, docs, changesets

### 6.1 ADR-EA-041 amendment (no new ADR number)

`spec/decisions/041-domain-store-ports.md` is at revision **1.3**. Plan 25 takes the next revision in landing order
(1.4 if nothing else lands first; plan 24's Track A would also amend it, per the README's ADR table). Add:

> **9. Plugin record stores follow decisions 2 and 6.** A plugin's domain is already written once in its system modules
> (ADR-EA-040), so its record store keeps its two adapters, bundled as `records` (BEH-EA-334). Every operation of a
> record store carries a verdict (`read`, `write`, `atomic`, `exempt` with a reason) in a `RecordsContract` suite
> (`@awthaq/test`), one suite per store keyed by its `/records/` key. `runPluginContractTests` requires the suites for
> every store a plugin's bundle provides and runs every case on memory, SQLite and Postgres, a fresh adapter per case. An
> invariant a system module relies on across rows or across a read (the last owner, the last team, a quota, the team
> forest, a status transition, a "still live" condition, a row and its ledger link) is enforced by the primitive that
> writes: one `Ref.modify`, or one conditional statement, or one transaction holding `SqlStore.atomically(sql, key)` on
> Postgres. A transaction alone is not atomicity under READ COMMITTED. The module's earlier check only orders errors.

Consequences: the cost is one advisory lock per guarded write and serialisation per scope (an organization's membership,
its team forest, an inviter's invitations, a tenant's endpoints). The gain is that every adapter, including a host's own
through `@awthaq/organization/records`, has one written bar. Alternatives considered: collapse each plugin's twins into
one implementation (rejected: the domain is already single); a differential memory/SQL parity harness as the bar (plan
24 Track B; rejected as the bar, because it states no semantics and sees no races, but it remains a possible addition);
SERIALIZABLE isolation (no isolation option on the `SqlTransaction` port, and every caller would need a retry loop); row
`FOR UPDATE` (a zero-row hole); cases in the plugin's `src` (ships test code; Q1). Change-history line: "1.x
(2026-11-…): decision 9, plugin record stores: verdicts, atomic primitives, `RecordsContract` (architecture plan 25)."
Update `spec/decisions/index.yaml` only if it carries the revision.

ADR-EA-040 needs no revision; add one sentence to its Consequences: "A system module's invariant over several rows is
enforced by a record-store primitive (ADR-EA-041 decision 9)." ADR-EA-046 stays plan 24's, for Track A only.

### 6.2 Behaviours (each with a Document Control revision and a change-history line)

| File (revision today) | Change |
|---|---|
| `35-organization.md` (1.7) | BEH-EA-285: the invariant is enforced by the membership write, atomically on every adapter, and a race leaves exactly one owner (ticket 03, → 1.8). Erasure is exempt (Q3). BEH-EA-287: "checked against the stored count at the moment of the write" is now true under concurrency (tickets 10–13). BEH-EA-286: transitions are compare-and-set from `pending` (ticket 12) |
| `25-testing-harness.md` (1.4) | BEH-EA-336 revised: the contract suite runs each store's `RecordsContract` suite. New **BEH-EA-R1** "Every plugin record store passes its contract suite on memory, SQLite and Postgres" |
| `01-plugin-contract.md` (1.3) | BEH-EA-334 note: a plugin declaring `records` must give `runPluginContractTests` one suite per store (compile-time) |
| `05-persistence-stratum.md` (1.7) | BEH-EA-035's OHS-002 paragraph: a multi-statement records operation that guards an invariant takes the scope's lock (`SqlStore.atomically`). New **BEH-EA-R2** "A record store's read-modify-write is one atomic primitive, and its verdict is stated" |
| `27-admin-impersonation.md` (1.6) | the ledger paragraph (`:181`): a row and its link are written as one step on every adapter |
| `34-webhooks.md` (1.6) | BEH-EA-281/309: `maxEndpoints` holds under concurrency |
| `17-passkey.md` (1.5) | BEH-EA-131: the counter verdict is decided at the write |

`R1`/`R2` take the next free BEH ids at landing (the highest today is **BEH-EA-339**; plans 26–30 may allocate first).

### 6.3 Traceability and BDD

- `spec/traceability.md` (1.44): §1 rows for BEH-R1/R2 → `packages/test/src/RecordsContract.ts`, `packages/sql/src/SqlStore.ts`.
  §4 ADR-EA-041 row gains "decision 9". §5 test-file rows: add `RecordsContract.test.ts`, `RecordsContract.types.test.ts`,
  each plugin's `test/contract/*.ts`, `SqlStore.test.ts`, `OrganizationMembers.test.ts` (BEH-EA-285 on Postgres). Remove
  the rows of deleted bespoke files.
- BDD `features/features/08-tooling/25-testing-harness.feature` under BEH-EA-336 (or R1). There are two scenarios. "A
  Contract.test.ts that passes records but is missing from scripts/test-pg.sh fails pnpm check" names the file. "The same
  package passes once it is listed". Both are driven by `AWTHAQ_CONTRACT_TESTS_ROOT` like REQ-EA-1299/1300; allocate REQ
  ids with `features/scripts/allocate-req-ea.py`. Organization scenarios REQ-EA-724..727 are unchanged (sequential). No
  race scenarios (non-goal).

### 6.4 Changesets (all packages are in the fixed group)

| Ticket | Changeset | Level | `Migration:` |
|---|---|---|---|
| 03 | `organization-owner-invariant-atomic.md` | patch | custom `MembershipRecords` adapters (§4, ticket 03) |
| 06 | `sql-store-atomically.md` | patch | none (additive); the `orConflict` SQLite mapping is noted |
| 07–08 | `test-records-contract.md` | minor | `runPluginContractTests` requires `records` for plugins with stores |
| 10–14 | `organization-atomic-records.md` (one per ticket, or one cumulative) | minor | new `within`/`ownedWithin`/`pendingWithin`/`keepOne` options, `transition` replaces `updateStatus`, new internal error tags, sorted `emailDomains`, `sortDirection` honoured over SQL |
| 15 | `admin-impersonation-memory-ledger.md` | patch | none |
| 16 | `webhooks-endpoint-limit-atomic.md` | patch | custom `WebhookRecords`: `createEndpoint` takes `within` |
| 17 | `api-key-rotate-atomic.md` | minor | `ApiKeyRecords.rotate`, `revoke` answers `boolean` |
| 18 | `passkey-counter-at-write.md` | minor | `recordUsage` answers `"advanced" \| "regressed"` |
| 19–24 | one per package where an interface or behaviour changed | patch/minor | per ticket |

---

## 7. Risks, mitigations, rollback

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Lock contention.** An advisory lock per organization serialises its membership writes, and one per forest its team edits. | These are human-rate admin operations. The lock scope is one organization, never global. Measure p99 of `OrganizationMembers.remove` under 8-way load on Postgres in ticket 10 and record it. |
| R2 | **Postgres time per case.** A fresh schema plus migrations for every case. | The bespoke suites already do this per case, so it is no regression. If `test:pg` grows past +15 %, switch the SQL mode's reset from `DROP SCHEMA` to `TRUNCATE` of `plugin.tables` between cases on one migrated schema per file (a `RecordsContract` option, measured first). |
| R3 | **Type-level suites are slow or opaque.** | Ticket 04 measures, and §3.6 has a fallback. Messages use the existing `~records` property pattern. |
| R4 | **Behaviour change for a losing concurrent request** (409/403/404 where it used to "succeed"). | It is the sequential answer, already declared on every endpoint. SCIM and SAML paths already handle `OwnerInvariantViolation` and `MembershipLimitReached` in their error channels. Every case is named in a changeset. |
| R5 | **SQLite across processes** (a WAL file shared by two processes). | No lock is taken, and SQLite's single writer makes a stale read fail with `SQLITE_BUSY` → `StoreUnavailable` (the transient retry at the top level), never skew. Document it in the `atomically` doc comment. |
| R6 | **Host adapters** through `@awthaq/organization/records` break on interface changes. | `Migration:` lines per ticket. Q1 decides whether they get the suites. |
| R7 | **Advisory-lock key collisions** (`hashtextextended`, 64-bit). | A collision only serialises two unrelated scopes. Keys are prefixed by table and scope. |
| R8 | **Plan 22 edits the same modules** (DDL moves, the passkey counter type). | Phase 3/4 tickets depend on plan 22 having finished that package (ticket table). The hotfix (03) touches only two methods' bodies and two catch blocks, so it rebases trivially either way. |
| R9 | **`RecordsContract.pending` lingers.** | It is named, typed and counted. Ticket 25 makes any remaining use a `pnpm check` failure. |
| R10 | **Pre-check and primitive disagree** (a refactor drops the primitive and keeps the pre-check). | The domain regression tests use the barrier, so the pre-check alone cannot pass them. |

**Rollback.** **No schema change in any ticket**: every fix is a statement, a lock or code. So every ticket reverts with
`git revert` alone.
- 02–03 revert together (test and fix).
- 06 reverts only after the tickets that use `atomically` (or after inlining the lock again, as in 03).
- 07–08 revert only with every Phase 3/4 suite (they import `RecordsContract`). Reverting a single store ticket puts
  that plugin back on `pending` and restores its bespoke file from history.
- Docs/spec tickets revert alone.

---

## 8. Interactions with other plans

**Plan 24 (batch 2): plan 25 subsumes its Track B.** Why:

1. **One bar, not two.** Every drift plan 24 fixes (R1–R6, the `orConflict` gap, the labels) and every atomicity bug it
   lists (C1–C10) is a *stated* behaviour. A contract case pins it on every adapter, Postgres included. A differential
   harness proves only that two adapters agree, and its own §3.3 says it "cannot see races", so plan 24 already needed
   hand-written race cases next to it. Running both per store would be layering (the shared convention).
2. **The worst bugs are not adapter drift.** The P0 owner race, the last team, the quotas, the invitation transitions,
   API-key rotation and the passkey counter are system-module check-then-write. They fail identically on both adapters,
   so a parity harness passes them. They need the atomic-primitive rule, which plan 24 does not state.
3. **Cost.** The harness needs a seeded `Crypto`, lockstep `TestClock`s, `Arbitrary` sequence generation and shrinking.
   The contract reuses `StoreContract`'s `Case`/`race`/`run` and `TenantConformance`'s coverage-map technique, and it
   deletes the 19 bespoke suites, where plan 24 keeps them.
4. **What stays plan 24's:** the Track A spike (S1–S5, G1–G5). It asks a different question (should the memory adapter
   *be* SQLite?), and ADR-EA-046 stays reserved for that answer. If Track A goes, this plan's suites still apply: a
   single-adapter bundle simply runs the suites once per SQL backend. The orchestrator should mark plan 24 Phases 1–5
   "superseded by plan 25" in the README.

| Plan | Shared seam | Order and contract |
|---|---|---|
| **22** (table DDL locality, phases 0–1 done) | the same 24 records modules; the passkey counter column (D2); `Migrations.ledger` | **22 before 25's Phase 3/4, per package.** The runner migrates through whatever 22 leaves (`Auth.make(...).migrations`, the ledger). 22's schema/tenancy pinning complements the suites. Ticket 18 coordinates with D2. |
| **23** (relay cursor, done) | `StoreContract` (it added `relayCursor`), `TestAuth`'s base | None: plan 25 reuses `StoreContract`'s exports unchanged and leaves core cases alone. |
| **16** (sql-store-adapters, done) and **28** (this batch's sql-store-adapters) | `packages/sql` (`SqlStore.ts`, `StoreFailure.ts`) | 25 adds `SqlStore.atomically` and the SQLite PK mapping. 28 may move `SessionStoreSql`'s inline locks (`:417`, `:588`) onto `atomically`. Whichever lands second rebases `SqlStore.ts`; ADR-EA-041 revisions go in landing order. |
| **15** (host composition, not started) | `records` bundles | No change. Plan 25 keeps the bundle shape. |
| **12** (passkey ceremony, done) | `PasskeyCeremony.ts` | Ticket 18 edits `counterVerdict` (`:389-408`) and the `recordUsage` call (`:468`). |
| **13** (admin gate, done) · **04/05/08** (done) | admin, organization, `TestAuth` | Line shifts only. 08's `recordsParityProblems` is reused. 05's conformance suites are invoked by the runner. |
| **26** request-context | plugin interfaces dropping `ip`/`userAgent` | No record store carries `ip`/`userAgent` (`grep` over `*Records.ts`/`*Store.ts`: none), so there is no conflict. |
| **27** password-credential | core `Accounts` | None. |
| **29** plugin-owned events | publish sites in `OrganizationMembers`, `OrganizationTeams`, `OrganizationInvitations`, `Webhooks`, `ApiKey`, `PasskeyCeremony` | **25's Phase 3 before 29** in those files when possible. Otherwise rebase the error mapping, which is a few lines per site. 25's ticket 17 changes when `auth.apiKey.revoked` is published (once), so 29 must keep that condition. |
| **30** speculative follow-ups (organization authorize primitive) | `OrganizationAuthority`/`Organization.ts` | Disjoint from the membership write path. If 30's primitive lands, the owner pre-check may move into it, and the store primitive stays the authority. |

---

## 9. Acceptance checklist

- [ ] `OrganizationMembers.test.ts` has the four ticket-02 cases, and they are green on memory, SQLite and Postgres
      (`AWTHAQ_POSTGRES_URL=… pnpm exec vitest run --project organization packages/organization/test/OrganizationMembers.test.ts`).
      The file is in `scripts/test-pg.sh`.
- [ ] `MembershipRecords.remove`/`updateRole` fail with `MembershipRecords/LastOwner` atomically. `grep -n "RowVanished" packages/organization/src/OrganizationMembers.ts` shows no hit in `remove`/`setRoles`.
- [ ] `SqlStore.atomically` exists, the bare lock is not exported, and `SqlStore.test.ts` passes on Postgres.
- [ ] `RecordsContract` is exported from `@awthaq/test`. `RecordsContract.test.ts` and `.types.test.ts` pass, and the type
      test includes "a missing store key does not compile" and "an unclassified operation does not compile".
- [ ] All 13 `Contract.test.ts` files pass real suites (`grep -rn "RecordsContract.pending" packages examples` → nothing),
      and `pnpm check:contract-tests` enforces the `test-pg.sh` listing.
- [ ] Every §2.6 finding F1–F10 and plan 24 C2–C10/R1–R6 is fixed, with a red-first test named in its ticket, or refuted
      in ticket 05's audit with evidence.
- [ ] §5.4 targets met (`.scratch/25-record-store-contract/result.md`):
      `grep -lE "^const (suite|contract) = \(" packages/{admin,jwt,organization,passkey,qadi,saml,scim,two-factor,webhooks}/test/*.test.ts | wc -l` → 0.
- [ ] The template has a suite with an `atomic` + `race` entry, and `docs/plugin-authoring.md` describes verdicts,
      `SqlStore.atomically`, `RecordsContract` and the checklist items. `pnpm check:readmes` passes.
- [ ] ADR-EA-041 carries decision 9 at its next revision. BEH-EA-285/286/287/334/336/035 and the files of §6.2 carry Document Control
      revisions. BEH-R1/R2 have real ids. `spec/traceability.md` is updated. `pnpm spec:verify:strict` passes.
- [ ] The changesets of §6.4 exist with `Migration:` lines where required.
- [ ] `pnpm check`, `pnpm test:pg` and `pnpm test:bdd` are green. Wall time is within §5.4's budget.
- [ ] No `as`, no `as const` in new or rewritten code, and no return type annotation on a new Effect/Layer const.

---

## 10. Open questions only the user can answer

- **Q0: Plan 24.** Accept that plan 25 supersedes plan 24's Track B (Phases 1–5), so plan 24 keeps only its Track A spike
  and ADR-EA-046? *Recommended: yes* (§8). The alternative keeps plan 24's differential harness as well. That means two
  test mechanisms per store, and the harness still cannot see the races.
- **Q1: Publish the cases for host adapters?** `@awthaq/organization/records` invites a host to bring its own record
  layers, but the suites live in each package's `test/contract/`, which is not published. Publish them as a `./contract`
  sub-path (they would need `node:assert` or an Effect-based assertion helper in runtime packages)? *Recommended: not now.*
  Revisit when a host actually ships an adapter; the move is mechanical, because cases depend only on the store's types
  and `RecordsContract`.
- **Q2: Quotas strict under concurrency?** BEH-EA-287 already says limits are checked "at the moment of the write", so
  this plan makes them strict, at the cost of one lock per scope. *Recommended: yes, strict.* The alternative is to
  amend BEH-EA-287 to "best effort under concurrency" and drop the quota primitives (tickets 10–13, 16 shrink).
- **Q3: Erasure of a sole owner.** Erasure deletes every membership of the user, so a sole owner's organization becomes
  ownerless. Is that accepted (status quo, documented as an exemption in BEH-EA-285)? Or should erasure promote the
  longest-standing admin, or refuse until ownership is transferred (which conflicts with ADR-EA-031's "erasure
  completes")? *Recommended: status quo, documented.*
- **Q4: Ship the hotfix before the merge settles?** Ticket 03 is self-contained. *Recommended: yes,* as its own PR on
  whichever branch is current, then forward-merged.
- **Q5: The template gains a note quota** to teach `atomic`/`race`. *Recommended: yes.* Without one, the template never
  shows an atomic primitive.
- **Q6: Postgres in local gates.** `scripts/test-pg.sh` hard-codes `docker`, and on this machine only `podman` works.
  Teach the script to fall back to `podman` when `docker` fails? *Recommended: yes,* a two-line change in ticket 01. It
  touches a shared script, so it is your call.
- **Q7: Passkey equal counters under `"flag"`.** With the counter decided at the write, the second of two concurrent
  assertions with the same counter is flagged (an anomaly event), which it is not today. *Recommended: yes* (CB-004's
  intent: a clone replaying a value keeps tripping).
- **Q8: Plan 24's open questions this plan inherits.** Q2 (`emailDomains` sorted ascending), Q3 (`registerRemoteKey`
  idempotent for an identical key, `KidTaken` otherwise), Q4 (fix C1–C10 here: yes, by construction), Q8 (offset
  pagination stays; amend BEH-EA-036 for membership and SCIM listing). *Recommended: plan 24's recommended defaults, as
  written there.*
- **Q9: `as const` in record modules.** Lint allows it, and there are ~130 today. Remove it only in methods a ticket
  rewrites, or sweep every record module in ticket 25? *Recommended: only rewritten methods* (no churn without a reason).

---

## Decisions taken (implementation record)

### Wave 0: tickets 02–03, PR #49 (merged 2026-11-08)

- Shipped: failing tests first (two owners removing each other, demote vs remove, double remove, 8 rounds of natural race, 8 concurrent removals at the store), then `MembershipRecords.remove`/`updateRole` refuse `MembershipRecordLastOwner` (`"MembershipRecords/LastOwner"`): memory in one `Ref.modify`, SQL in one transaction that first takes `pg_advisory_xact_lock(hashtextextended('organization_membership:org:<id>',0))` on Postgres. `OrganizationMembers` maps a lost race to 409/404; both `RowVanished` defects are gone.
- Q3 (recommended): erasing a sole owner stays exempt, documented.
- Q4 (recommended): ships alone, the lock inlined (no shared primitive yet).
- Q9 (recommended): only the rewritten methods drop `as const`.
- Ticket 01 (and the Q6 podman fallback) skipped: 02 does not depend on it.
- Stale: BEH-EA-035 was at 1.8 (shipped 1.9); `35-organization.md` landed at rev 1.10 because PR #51 took 1.9; traceability had no BEH-EA-285 row (added). Four fixtures that removed a sole owner through the store now use a member or add a co-owner.
- Q0 (recommended, accepted by the user 2026-11-08): plan 25 supersedes plan 24's Track B (Phases 1–5); plan 24 carries a superseded banner and keeps its Track A spike and ADR-EA-046.

### Wave E: Phase 2 and the organization package (tickets 04, 06–14), branch `feat/record-store-contract`

Shipped, one commit per green phase or package:

- **06** `SqlStore.atomically(sql, key)` (`packages/sql`), the bare lock unexported; `MembershipRecords`' inlined Wave 0 lock now goes through it (same key). Tests: same key serialised, 8 writers lose no update, distinct keys parallel on Postgres, held to the outer transaction's end, released on failure.
- **04 + 07 + 08** `RecordsContract` (`@awthaq/test`): `suite`, `Verdict`, `Operations`, `Suites<P>`, `run`, `recordsBase`, `recordsFoundation`, `pending`; `runPluginContractTests` gains `records` (`RecordsOption<P>`: required when the bundle provides a store, forbidden when none, optional for a hand-built `AuthPlugin.Any`); `check-contract-tests.mjs` rule 3 (a records-passing `Contract.test.ts` must be in `test-pg.sh`), REQ-EA-1500/1501.
- **09** the template's `maxNotesPerOwner` (default 100), `NoteRecords.create(input, { within })`, `test/contract/NoteRecords.ts`, a barrier domain race; the non-atomic probe (`Ref.get` + `Ref.update`) failed both race cases and was reverted.
- **10–14** organization: `MembershipRecords.create({ within, ownedWithin })`, `TeamRecords` (`createTeam({ within })`, `removeTeam({ keepOne })`, `addTeamMember({ within })` as a conditional `UPDATE`, every forest write under `organization_team:org:<id>`, C3 `DELETE … RETURNING` + floored decrements, R3), `InvitationRecords.transition` (CAS, replaces `updateStatus`) and `create({ pendingWithin })`, `OrgRoleRecords.create({ within })`, C4 (`OrganizationRecords.update` one `UPDATE` of the patched columns via `sql.update`), C5 (`ActiveContextRecords` upserts), C6 (`ConnectionRecords.update` is `UPDATE … RETURNING`), R1/R2 (member listing ordered and paged in SQL), R4 (sorted `emailDomains`). Eight suites in `packages/organization/test/contract/`; the organization `Contract.test.ts` passes them and runs `ConnectionRecords` on libSQL as an extra adapter. Domain race tests (barrier `Rendezvous.held`) for every organization quota, the last team and accept-vs-cancel.
- Spec: ADR-EA-041 rev 1.5 (decision 9; decision 5 rewritten = plan 28 ticket 03), ADR-EA-040 Consequences sentence, BEH-EA-336 (25-testing-harness 1.7), BEH-EA-334 (01-plugin-contract 1.5), BEH-EA-035 (05-persistence-stratum 1.12), BEH-EA-286/287 (35-organization 1.11), traceability 1.55; `docs/plugin-authoring.md`; organization and test READMEs; changesets `sql-store-atomically`, `test-records-contract`, `organization-atomic-records`.

Decisions (recommended defaults unless noted):

- Q1 not now (cases stay in each package's `test/contract/`); Q2 strict quotas; Q5 the template gains a quota; Q8 plan 24's defaults (R4 sorted ascending); Q9 only rewritten methods drop `as const` (new code has none). Q6 (podman fallback in `test-pg.sh`) not taken: the brief forbids touching containers and supplies a running server instead.
- Ticket 04's spike passed all type properties (1–4), so the compile-time path was taken, not the §3.6 fallback. Property 5 (typecheck time) was not formally measured; `tsc -p tsconfig.test.json` stays ~4 s incremental. The error message for an unclassified operation is long (the whole `operations` object type), but names the missing key (R3).
- **Deviation: no new BEH ids.** The verifier requires contiguous BEH ids and BEH-EA-345 is reserved for plan 27 (not landed), so BEH-R1 is folded into BEH-EA-336 and BEH-R2 into BEH-EA-035 instead of 346/347.
- **Deviation:** `InvitationRecords.transition` answers `boolean` (as planned) plus `InvitationRecordNotFound`; callers map `false` to `InvitationNotPending` (accept, reject, cancel) or treat it as already settled (expire publishes only when it moved; a re-invite's cancellation of a stale pending one ignores it).
- **Deviation:** `RunConfig.adapters` entries name the `stores` they provide (the plan inferred it); used for libSQL on `ConnectionRecords`.
- **Deviation:** cases run under a `TestClock` (part of `recordsFoundation`), so moved cases that call `TestClock.adjust` keep working; a domain race uses `Rendezvous.held(n)` (new in `@awthaq/test`).
- **Deviation:** `TenantConformance` gained `runTenantIsolationWith` (runners instead of layers) so the contract runs tenancy over `Plugin.records` without a type assertion; the memory foundation moved to `internal/foundation.ts` (shared by `TestAuth` and `RecordsContract` without an import cycle).
- `organizationLimit` is `ownedWithin: { role: creatorRole, limit, grant }` keyed `organization_membership:owner:<userId>`; with both bounds the owner lock is taken before the organization lock.
- F9: the `RowVanished` sites on a concurrent removal of a team, role or organization now answer the typed not-found. Kept as defects (not reachable by a plain concurrent request, or the caller's error channel has no fitting tag): accept's "invitation's team vanished", and the roster sites of `OrganizationTeams` (`vanished("team roster")`, `"team membership"`, `"a fresh team's roster"`).
- Residual organization test files keep only what is not about a store: `ConnectionRecords.test.ts` (the sealed-column seam, still over hand-built layers rather than `recordsBase`), `DomainClaims.test.ts` (`withClaim`), `TeamRecords.test.ts` (the hierarchy backfill migration), `ActiveContextRecords.test.ts` (a type-level witness check).
- Stale in the plan: the SQLite primary-key `orConflict` gap (ticket 06, plan 24 §2.5) was already closed by plan 16's `isUniqueViolation`; the new real-driver case passed first time. BEH-EA ids now end at 344 (plan says 339). ADR-EA-041 was at 1.4 (plan 15), so this is 1.5. `traceability.md` was at 1.54.
- Postgres was **not reachable** on this machine during this run (`127.0.0.1:55499` refused), so every race case ran on memory and SQLite only; the Postgres-specific ones (crossing `moveTeam`, create-under-removed-parent, the `SqlStore.atomically` parallel/held cases, C4–C6, every quota race on SQL) are proven only once CI runs `pnpm test:pg`.
- **CI fix (PR #55, Postgres):** `ConnectionRecords.remove` and `removeAllForOrganization` now delete the connection row before its domains, the order `update` locks them in; the old domains-first order deadlocked C6's update-vs-removal race on Postgres and the removal came back as `StoreUnavailable`. Observable results are unchanged.

Not done at the end of Wave E (left on `RecordsContract.pending`, with their bespoke suites still running): tickets 15–25 and ticket 01's baseline. Wave F below closes 15–25.

- **CI fixes (PR #55, Postgres), besides the `ConnectionRecords` order above:** every SQL build of a `RecordsContract` suite gets its own Postgres schema (`<suite>_<store>_<n>`; the runner's builds raced on one schema's DROP/CREATE), and a suite's `tenancy` may say `withoutRls: <reason>` for tables the RLS probe cannot seed (`OrganizationRecords`, keyed by its own id; `ActiveContextRecords`, derived from core's sessions), shown as a passing test.

### Wave F: tickets 15–25, branches `feat/record-store-contract-2` (PR #57) and `feat/record-store-contract-3`

One commit per ticket; every store's suite lives in `packages/<pkg>/test/contract/` and replaces `RecordsContract.pending` in that package's `Contract.test.ts`. Postgres was down on this machine for the whole wave (`127.0.0.1:55499` refused), so every case ran on memory and SQLite; the cases marked PG-only are proven only by CI's `pnpm test:pg`.

- **15 admin `ImpersonationRecords`:** F7, memory `create`/`endEpisode`/`closeExpired` write the row and its ledger link in one uninterruptible `appendLock` section, `verifyChain` reads under the permit. Beyond the plan: the SQL `verifyChain` reads both tables in one transaction under the chain lock (a read-side race). No domain race (no system module calls `verifyChain`). Stale: "red on memory today" shows only with `Scheduler.MaxOpsBeforeYield` = 4 (Effect 4.1.2 stalls below 4; every suite since uses that budget for its races); "SQL unchanged" was false. Spec: `invariants.md` 1.8, model 15 1.2. PG-only: 3 SQL race cases, the RLS `verifyChain` case, the pg trigger tamper cases.
- **16 webhooks `WebhookRecords`:** F4 `createEndpoint(input, { within })` (`WebhookRecords/LimitReached` → `WebhookEndpointLimitReached`), C8 single-column `UPDATE`s (`setDisabled` no longer writes `consecutiveDead`), C9 `deleteEndpoint` in one transaction, F9 `testEndpoint`'s `RowVanished` → `WebhookEndpointNotFound`, W-1 memory `claimDue` answers leased rows. Domain barrier test on memory (8 held at the DNS lookup). Stale: plan 24's label fix was already correct. **Deviation:** the sealed-column suite does not build over `recordsBase` (type and `Encryption` shadowing); `WebhookRecords.test.ts` keeps it and the declaration test. No records sub-path, so the changeset's `Migration:` names `WebhookRecordsShape`. Not closed: an `enqueue` racing a delete can orphan a delivery (no FK); the lifted `claimDue` versus the delivery `DELETE` lock order is pre-existing. PG-only: create races, C8 races, delete without deadlock, RLS tenancy.
- **17 api-key:** F6 `rotate` answers `"rotated" | "notLive"` (`limitExpiry` deleted); F10 `revoke` answers `boolean`, published once; a duplicate id is a defect on both stores; the client insert outage label is `ApiKeyClientRecords.insert`. `StoreOutage.test.ts` moved into the suites' `sql` and left `test-pg.sh`. Decision: the store-level rotate-vs-revoke race is unobservable in the final state, so it is a deterministic interleaving plus 8 zero-grace rotations racing a revoke; the domain barrier test is the proof. Spec BEH-EA-140, MOD-EA-007. Not done: `revokeClient` publishes on a no-op; client secret rotation versus client revoke. PG-only: row-lock serialisation of rotate versus revoke/rotate, 8 revokes.
- **18 passkey:** F8 `recordUsage` answers `"advanced" | "regressed"`, decided by the SQL `UPDATE` (`counter = 0 AND counter = $n` for the zero case: pg's int4 typing of a bare `$n`); the ceremony writes first, then decides (`counterVerdict` deleted); a credential deleted mid-ceremony is `unknownCredential`, not a defect. Q7 yes. A regressed answer writes only the flag (no `lastUsedAt`/`backedUp` stamp). `ChallengeStore` also runs on `layerCookie` (extra adapter). Deleted `ChallengeStore.test.ts`, `PasskeyCredentials.test.ts`; `PasskeyUserHandle.test.ts` keeps BPAS-003/006. Stale: the call site was `:466-468`; `17-passkey.md` was at 1.6; passkey tables are global (no tenancy). PG-only: every 8-way SQL race, the domain equal-counter race on SQL.
- **19 device-authorization:** the CAS cases of `Plugin.test.ts` (`:222-306`) moved into the suites and run on SQL for the first time; `StoreOutage.test.ts` deleted (outage cases in `sql`, left `test-pg.sh`); the insert label was `.amr` → `.insert`; memory `insert` refused nothing on a reused grant id where SQL did, now it refuses. `raiseInterval` and client `revoke` are atomic too (the plan named three). Stale: file headers cited BEH-EA-312/313 (webhooks ids), corrected to 299–304, 306. No BEH change. PG-only: all seven race cases.
- **20 jwt:** R6, `create` with a stored `kid` never overwrites: an identical public-only key answers the stored record, anything else is `SigningKeyRecords/KidTaken` (`ON CONFLICT DO NOTHING RETURNING` then a read back). `KeyRing.registerRemoteKey`/`importKey` are typed `KidTaken` (plus `CurrentKeyConflict` in `registerRemoteKey`), which rotates only for a new `kid` (re-registration no longer rotates the key it just registered); `mint` maps `KidTaken` to a defect. New `findByKid` read. Minor bump. Q3 default; private material is never "the same key". **Deviation:** `KeyRing.test.ts` keeps hand-built layers (its union type lacks `SqlClient`); it is the one file §2.1's suite grep still counts. Stale: "8 creates leave one current" was already true. `RevocationStore.test.ts` deleted. BEH-EA-296. PG-only: create/markRotated/retire/purgeExpired races, 8 same-`kid` creates, concurrent `registerRemoteKey`.
- **21 two-factor:** SQL `TwoFactorRecoveryCodes.replaceAll` (and `deleteAllByUser`) under `SqlStore.atomically(two_factor_recovery_code:user:<id>)`: two regenerations racing on Postgres could leave both sets valid. Atomic + race for `upsertPending`, `confirm`, `advanceLastUsedStep`, `replaceAll`, `markUsed` (a get-then-set probe on memory made six race cases red). `TwoFactorStore.test.ts` keeps erasure/export and the sealed-column suite over hand-built layers. BEH-EA-264/265. PG-only: the regeneration race and the other five.
- **22 saml `SamlRecords`:** C10 `saveSession` is one `INSERT … ON CONFLICT ("sessionId") DO UPDATE` (8 saves of one id gave a primary-key failure even on SQLite). Beyond C10's "update/remove in one transaction": `create` too (the compensating DELETEs are gone); `update` is `UPDATE … WHERE id AND organization RETURNING *` first, then the domain set, the order `remove` deletes in (no update-vs-remove deadlock), and domains are inserted sorted, so two claims cannot cross. R5: both adapters answer `emailDomains` ascending (memory kept insertion order). Race cases: create and update claiming one domain, updates racing a removal, 8 removals, 8 session saves; the constraint case and two rollback cases in `sql`; tenancy with RLS. `SamlRecords.test.ts` keeps the sealed-column suite (still in `test-pg.sh`). BEH-EA-315/318 (29-saml-sp 1.12). PG-only: every race, the RLS probe.
- **23 scim `ScimRecords`:** plan 24's link item: memory `link` checks the full key, so a resource linked twice is `ScimLinkConflict` (`field: "name"`, the field Postgres reports for the primary key; decision: no new `field` value, no caller distinguishes it). Label `ScimRecords.row` → `.revokeConnection`; `removeAllForOrganization` in one transaction. Race cases: 8 links under one `userName`, one resource linked 8 times (red on memory before), 8 links taking one `externalId`, 8 revocations. `ScimRecords.test.ts` deleted, left `test-pg.sh`. BEH-EA-247 note (30-scim 1.6). PG-only: the four races, RLS.
- **24 roles and qadi:** `RoleAssignments`' first suite (F11; `add`/`remove` atomic and idempotent, race-proven); `RolesSql.test.ts` loses its five store cases and the outage case (now `sql` in the suite) and keeps the domain; `Roles.test.ts` is all domain (its `holders` case tests `Roles.holders`), unchanged. Labels stay `Roles.assign`/`Roles.revoke`/… (plan 24 did not list them). C7: SQL `UserClaimsRecords.modify` under `SqlStore.atomically(sql, "qadi_claims:user:<id>")`, so `@awthaq/qadi` now depends on `@awthaq/sql`. `UserClaims.test.ts`' `contract(...)` is gone: its plugin cases run once on memory, plus a domain race (8 merges keep every key, 8 events of one key each) on memory and SQL. No roles BEH change; qadi BEH-EA-161 note (21-qadi 1.5), since claims have no BEH of their own. PG-only: the C7 store race and the domain race (memory and SQLite serialise anyway, so neither could be shown red here).
- **25 sweep:** `RecordsContract.pending` deleted (`RunConfig.suites` is `Suites<P>`); `check-contract-tests.mjs` rule 4 reports a test naming it (probed). `test-pg.sh` lists the 13 records-passing `Contract.test.ts` files and `OrganizationMembers.test.ts`, no deleted file; its header now describes the three kinds of suite. **Deviation:** the residual files that keep sealed-column, migration or domain-over-SQL cases (`ConnectionRecords`, `TeamRecords`, `SamlRecords`, `TwoFactorStore`, `WebhookRecords`, `UserClaims`, `RolesSql`, `KeyRing`) stay listed: they are no longer bespoke store suites, and their SQL cases still belong on Postgres. The only `as const` left in a rewritten method (`TeamRecords.removeTeam`, ticket 11) is gone; none was added by the plan. BEH-EA-336 (25-testing-harness 1.8), traceability 1.66, changeset `test-records-contract-pending-removed` (minor, `Migration:` for third-party plugins).
- **Ticket 01 skipped:** its starting commit has moved on, and CI's Postgres runs (`pnpm test:pg` on every PR) are the baseline for wall time and race coverage.

§5.4, re-taken at ticket 25 (also in `.scratch/25-record-store-contract/result.md`):

| Measure | Baseline | Target | Now |
|---|---:|---:|---|
| Hand-rolled record-store `suite`/`contract` files | 19 | 0 | 1, re-baselined: `KeyRing.test.ts` runs KeyRing (a system module) over both stores |
| Test files building `TestSql.layer(` | 41 | ≤ 22 | **31** (13 outside core/sql/test): not met, see below |
| Test files running `Migrations.run(` | 30 | ≤ 11 | **15** (19 with `features/`): not met, see below |
| Stores without an adapter-level suite on SQL | 5 | 0 | 0 |
| Stores whose suite runs on Postgres | 20 of 25 | 25 of 25 | 25 of 25, plus the template |
| Store suites with a race case | 4 | every `atomic` verdict | 24 of 25 suites; every `atomic` verdict has one (the type requires it); `ApiKeyClientRecords` has no `atomic` verdict |
| SQL tests of BEH-EA-285 under `test:pg` | 0 | ≥ 4 | ≥ 4 |
| F1–F8 sites without an authoritative primitive | 14+ | 0 | 0 (the pre-checks stay, each naming its primitive) |
| `RowVanished` defects in plugin system modules | 14 | 0 | 3 grep sites, re-baselined in Wave E (not reachable by a plain concurrent request, or no fitting typed tag) |
| Lines of record-store test code | 7,639 (20 stores) | recorded, ≤ 8,500 | 10,749 in 26 suite files (25 stores + template): over the budget, because tenancy, SQL atomicity and ~60 race cases moved in |
| `pnpm test` / `pnpm test:pg` wall time | ticket 01 | ≤ + 15 % | not measured (ticket 01 skipped) |

The two unmet file counts are the residual files above: sealed-column suites still build over hand-built layers instead of `RecordsContract.recordsBase` (§5.2's intent; a follow-up), plus migration backfill tests and domain-over-SQL race tests that a store suite cannot hold.

Remaining: ticket 26 (docs teach the contract: `docs/plugin-authoring.md` sections and checklist items 4/6/10, `packages/test/README.md`, the organization README's records note, `pnpm check:readmes`) and ticket 27's roll-up (§6 in full: the `05-persistence-stratum`/`27-admin`/`34-webhooks`/`17-passkey` notes that earlier tickets did not already land, `pnpm test:bdd`); the sealed-column suites over `recordsBase`; a first `pnpm test:pg` run on CI for everything marked PG-only above.

### Wave G: tickets 26–27, branch `docs/record-store-contract-close`

Plan 25 is done. Most of §6 and ticket 26 had already landed with the tickets that made each change (Wave E and F records above), so this wave checked each item and added only what was missing.

- **26 docs:** already there from Wave E: "Record stores and bundles" (verdicts, the atomic-primitive rule, `SqlStore.atomically`, pre-check versus authority), "Multi-statement writes", checklist items 4/6/10, the organization README's records note (a host adapter must pass the suites, in this package's `test/contract/`, not published: Q1), the test README's `RecordsContract` entry. Added: "Testing a plugin" now covers a suite's `sql` cases, `adapters` (extra adapters such as `layerCookie`, libSQL), `tenancy.withoutRls`, the removal of `RecordsContract.pending` (refused by `check:contract-tests`) and why a records-passing `Contract.test.ts` goes in `scripts/test-pg.sh`; the test README names `test/contract/<Store>.ts`, the template's worked suite and `Rendezvous.held`. The template needed no change. `pnpm check:readmes` passes. No changeset: `@awthaq/test` is private and the rest is `docs/`.
- **27 roll-up:** already there: §6.1 (ADR-EA-041 1.5 decision 9, ADR-EA-040 Consequences sentence; `index.yaml` carries no revision), every §6.2 note (35-organization 1.10/1.11, 25-testing-harness 1.8, 01-plugin-contract 1.5, 05-persistence-stratum 1.12, 27-admin-impersonation 1.8, 34-webhooks 1.7, 17-passkey 1.7), the §6.3 BDD scenarios (REQ-EA-1500/1501 under BEH-EA-336) and every §6.4 changeset (plus one per package for 19–24). Added: `traceability.md` 1.71: §1 rows 05 and 25 name `SqlStore.ts` and `RecordsContract.ts`; the §4 ADR-EA-041 row's decision 9 list names every plugin's `test/contract/*.ts`; §5 rows for `RecordsContract.test.ts`/`.types.test.ts`, `SqlStore.test.ts`, the seven other organization suites, `WebhookRecords`, the two api-key suites and the template's `NoteRecords`. No row named a deleted bespoke file.
- **Ids:** none new. R1/R2 stay folded into BEH-EA-336/035 (Wave E's deviation; BEH-EA-345 and ADR-EA-048 belong to plan 27), no new REQ-EA ids.
- **Stale, not fixed here:** `traceability.md` §6's row for `08-tooling/25-testing-harness.feature` lists REQ-EA ids and node counts from before plans 25 and others (it omits 1295–1300 and 1500–1501); correcting it needs the node and pruned counts re-taken for the whole table, which another plan's roll-up is better placed to do.

