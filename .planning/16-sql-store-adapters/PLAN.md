# Plan 16: Each core SQL store adapter owns its statements; `Repositories` stops being a module

| Property | Value |
|---|---|
| Strength | Strong (batch index). It reopens ADR-EA-041 decision 3 ("SQL adapters … over the existing repositories") |
| Dependency category | ports & adapters: the seam is the store port (`@awthaq/ports`); this plan deletes a second, hypothetical seam beneath it (seven repository `Context.Service`s, each with exactly one adapter caller) |
| Wave / order | After **plan 23** (relay-cursor-store), which removes the one importer of `Repositories` outside `@awthaq/sql` besides `Persistence.ts`. Before **plan 17** (core-sealed-columns), which then edits one sealing module and three adapters instead of `Repositories.ts` (§8) |
| Fixes live bugs | None at runtime (the adapters behave correctly). It removes: 8 repository methods and one token-read path no production code reaches, with the tests that cover only them; a BDD scenario (REQ-EA-821) and a BEH-EA-231 clause that only a dead method satisfies; dead layer wiring in 9 test compositions; a stale BEH-EA-035 requirement; and an unverified claim that the store primitives pass on libSQL. Housekeeping: the stray `packages/sql/src/Repositories.ts-E` and the stale `packages/sql/README.md` |
| Execution tickets | `.scratch/sql-store-adapters/issues/NN-*.md`, one per phase (`docs/agents/issue-tracker.md`) |

Every file:line below was checked against the tree at `fc990c88` (2026-10-17). Plan 23 lands first and deletes `Repositories.ts:2490-2552` (the relay cursor) and edits `Persistence.ts`; re-locate code by symbol before editing.

---

## 1. Summary, goals, non-goals

### Summary

Plan 02 (ADR-EA-041) gave each core service one implementation over a store port, with a `Ref` adapter in `@awthaq/ports` and a SQL adapter in `@awthaq/sql`. To keep that plan's scope bounded, the SQL adapters were written "over the existing repositories" (ADR-EA-041 decision 3). The result is two layers where one would do:

- `packages/sql/src/Repositories.ts` (2,552 lines) defines seven repository services. Each has exactly one production caller, its store adapter (`AuditLogStoreSql`, `VerificationStoreSql`, `AccountStoreSql`, `UserStoreSql`, `SessionStoreSql`: 1,051 lines together), and the seventh (`RelayCursorRepository`) is consumed by `core/src/EventRelay.ts:91` (plan 23 removes it).
- The adapters are mostly translation: `null` ↔ `Option`, `NoSuchElementError` → `None`, the repository row shape to the port record (`AuditLogStoreSql.ts:26-121`, `AccountStoreSql.ts:32-170`, `UserStoreSql.ts:35-71`).
- What makes a primitive correct is split across both files. A session insert's advisory lock (`SessionStoreSql.ts:93-99`), its tombstone (`Repositories.ts:1733-1753`), its row construction from `repo.models` (`SessionStoreSql.ts:115-138`) and its eviction query (`Repositories.ts:1701-1716`) are in four places in two modules. `AccountStoreSql.deleteUnlessLast` holds the transaction while the dialect-specific `FOR UPDATE` lives in the repository (`Repositories.ts:1249-1255`). `AuditLogStoreSql` opens `rewriteReferencing`'s transaction, while the ADR-EA-037 savepoint around `append` lives in the repository (`Repositories.ts:2443-2450`).
- The tenant-stamp rule is applied in three spellings: `Tenant.stamp` (5 sites), a raw `TenantContext` read (4 sites, one of which hand-rolls "explicit over ambient"), and `Tenant.resolve` in the `Ref` adapters.
- Behaviour is tested twice: repository cases in `packages/sql/test/contract.ts` (1,179 lines, 28 cases on 4 dialect suites) and port cases in `@awthaq/test`'s `StoreContract` (1,901 lines). Most repository cases now re-test what a contract case already proves.
- Plugin record adapters already have the one-layer shape: `SqlSchema` statements inside the records layer, no repository (`examples/plugin-template/src/Template.ts:160-190`). Core has a second shape for the same pattern.

This plan deepens each SQL store adapter. An adapter's interface is its port. Its implementation owns the statements (the `SqlSchema` queries and `SqlModel.makeRepository` CRUD, moved verbatim), the sealing hook, the tenant stamp (`Tenant.resolve`, once per insert), the dialect branches, the read routing and the failure classification (`SqlStore.make`). `@awthaq/sql` exports one bundle, `CoreStoresSql.layer({ encryptPii? })`, which `Persistence.sql()` re-exports. `Repositories` is deleted. The repository contract cases move into `StoreContract` (or are deleted where a contract case already covers them), dialect-specific cases move beside the adapter they test, and `StoreContract` gains the libSQL runner the repository contract had.

### Goals

1. **One module per SQL store.** Each `*StoreSql.ts` holds every statement, lock, savepoint and dialect branch its primitives need. No adapter reaches into another module's `models` (`SessionStoreSql.ts:115`, `UserStoreSql.ts:89` today).
2. **`Repositories` is gone.** `packages/sql/src/Repositories.ts` is deleted and `index.ts:26` no longer exports it; `grep -rn "Repositories" packages/*/src` finds only comments that are rewritten.
3. **One tenant rule spelling.** Every SQL insert primitive stamps through `Tenant.resolve(explicit)`, as the `Ref` adapters do.
4. **One contract.** `packages/sql/test/contract.ts` is deleted; `StoreContract` runs on `Ref`, SQLite `:memory:`, SQLite WAL, **libSQL** and Postgres. What only SQL can show (ciphertext at rest, query plans, timestamps on disk, spans, retries, two-connection locking) is tested once, beside its adapter.
5. **One bundle.** `CoreStoresSql.layer(options)` in `@awthaq/sql`; `Persistence.sql` is that function. Test and feature compositions use it and stop wiring repositories.
6. **Sealing moves as-is.** The `PiiCodec`, the account-token codec, their AADs, failure policies and the `reencryptOnRead` knob are unchanged; they move into one internal module so plan 17 can replace them in one place.
7. **Housekeeping.** Delete `packages/sql/src/Repositories.ts-E`; correct `packages/sql/README.md` and every other doc that tells a reader to wire repositories.

### Non-goals

- No schema change and no new migration. Every phase reverts with `git revert`.
- No change to any port (`@awthaq/ports`), any primitive's behaviour, any operation label, or any span name.
- No change to sealing semantics: AAD spelling, the null-and-warn policy of the PII columns, the strict token read, lazy re-encryption. That is plan 17.
- `CoreMigrations.ts` stays where it is (plan 22 owns DDL locality, for plugin tables).
- `Models.ts` stays public: plugins and record stores use its brands, `dialectFields` and `resolveDialect`.
- No app-level tenant filtering of reads (plan 02 Q4 stands).

---

## 2. Verified current state

### 2.1 `Repositories.ts`, section by section, and who calls each method

| Section (`Repositories.ts`) | Service | Methods called by the adapter | Methods with no production caller |
|---|---|---|---|
| `:1-124` | shared: `Cursor`, `Page`, `traced` (`:69-72`), `PiiCodec` + `sealedPii` (`:84-124`) | all | |
| `:126-665` Users | `UsersRepository` (`:243`); `UsersRepositoryLive` (`:646`), `UsersRepositoryEncryptedLive` (`:656`) | `models`, `insertIfAbsent`, `findByEmail`, `findByPhone`, `findById`, `updateProfile`, `casIdentity`, `setStatus`, `deleteReturning`, `listPage`, `readFields`, `writeFieldsReturning` (`UserStoreSql.ts:87-224`) | `insert` (`:352`), `delete` (`:633`) |
| `:667-1279` Accounts | `AccountsRepository` (`:816`); `AccountsRepositoryConfig` (`:807-814`, used by Users and Sessions too); `AccountTokenUndecryptable` (`:794`); `AccountsRepositoryLive` (`:837`) | `insertIdentityIfAbsent`, `findIdentityById`, `findIdentityByKey`, `listIdentitiesByUser`, `findPasswordHash`, `findTokensById`, `writePasswordHash`, `writeTokens`, `lockByUser`, `delete`, `deleteAllByUser` (`AccountStoreSql.ts:97-192`) | `insert` (`:966`), `findById` (`:991`), `listByUser` (`:1271`), and with them the whole degraded token read (`readColumnDegraded` `:901-917`, `decryptRow` `:963`): plan 02 made identity reads token-free (A-4), so nothing reaches it |
| `:1281-1867` Sessions | `SessionsRepository` (`:1425`); `MAX_PAGE_SIZE` (`:1438`); `SessionsRepositoryLive` (`:1847`), `SessionsRepositoryEncryptedLive` (`:1858`) | every method (`SessionStoreSql.ts:88-314`) | none |
| `:1869-2115` Verification | `VerificationRepository` (`:1950`); `VerificationRepositoryLive` (`:1955`) | `findByIdentifier`, `upsertLive`, `tryConsume`, `recordFailedAttempt`, `deleteAllByUser`, `deleteExpiredBefore` (`VerificationStoreSql.ts:57-128`) | `insert` (`:2104`), `findById`, `delete` (`:2105-2106`) |
| `:2117-2216` Reservations | `VerificationReservationsRepository` (`:2146`) | `claim`, `deleteExpiredBefore` | none |
| `:2218-2488` AuditLog | `AuditLogRepository` (`:2311`); `AuditLogRepositoryLive` (`:2316`) | every method (`AuditLogStoreSql.ts:44-121`) | none |
| `:2490-2552` RelayCursor | `RelayCursorRepository` | `core/src/EventRelay.ts:91` | removed by plan 23 |

The 8 dead methods are covered only by tests (`contract.ts`, `AccountsTokenReadPath.test.ts`, `PiiEncryption.test.ts`, the BDD worlds in §2.5).

### 2.2 Every importer of `Repositories` in library source

`grep -rn "Repositories" packages/*/src`:

| File:line | Why | After this plan |
|---|---|---|
| `core/src/EventRelay.ts:45`, `:91` | `RelayCursorRepository` | gone with plan 23 |
| `core/src/Persistence.ts:30`, `:80-88` | the six repository layers under the five adapters | `Persistence.sql = CoreStoresSql.layer` |
| `sql/src/{AuditLog,Verification,Account,User,Session}StoreSql.ts` (`:23`, `:27`, `:25-29`, `:28`, `:36`) | each adapter's repository; `SessionStoreSql` also `MAX_PAGE_SIZE` and `Cursor` | statements move in |
| `sql/src/index.ts:7-9` (header), `:26` (export) | public export | export removed; header rewritten |
| `sql/src/CoreMigrations.ts:237`, `:246` | **comments only** ("a real filter key (`Repositories.ts`'s …)") | name the adapter |
| `sql/src/ReadRouting.ts:5` | **comment only** ("Repositories run over one ambient `SqlClient`") | "Store adapters …" |
| `sql/src/Models.ts:228`, `:463`, `:591` | **comments only** | name the adapters |
| `passkey/src/PasskeyCredentials.ts:7` | **comment only** (`Models.ts`/`Repositories.ts` as a style reference) | name `Models.ts` and the adapters |

### 2.3 The split that makes a primitive hard to read

| Concern | Adapter side | Repository side |
|---|---|---|
| Session insert under a cap | Postgres advisory lock `SessionStoreSql.ts:93-99`; builds the row from `repo.models.Session.insert.makeEffect` `:115-138`; eviction loop `:142-151` | tombstone `Repositories.ts:1733-1753`; `insert` with `Tenant.stamp` and PII sealing `:1511-1523`; `listLiveIds` `:1701-1716`; generic `delete` `:1832` |
| Step-up (`reauthenticate`) | advisory lock `SessionStoreSql.ts:261-264`; CAS loop `:267-307` | the two `UPDATE` forms `Repositories.ts:1777-1826` |
| Last-account unlink | transaction `AccountStoreSql.ts:171-189` | `lockByUser`'s Postgres `FOR UPDATE` `Repositories.ts:1249-1255` |
| Audit append | none | ADR-EA-037 savepoint `inSavepoint` `Repositories.ts:2443-2450` |
| Audit erasure rewrite | transaction `AuditLogStoreSql.ts:89-109` | `FOR UPDATE` dialect branch `Repositories.ts:2397-2400` |
| User insert | builds the row from `repo.models.User.insert.makeEffect` `UserStoreSql.ts:89-103` | `insertIfAbsent` + `Tenant.stamp` + metadata sealing `Repositories.ts:402-420` |
| Identity CAS | savepoint `UserStoreSql.ts:156-183` | the dialect's null-safe equality `Repositories.ts:559-566` |

### 2.4 Tenant stamping today (BEH-EA-231)

| Site | Spelling | Reached in production? |
|---|---|---|
| `Repositories.ts:355` (`Users.insert`) | `Tenant.stamp(input)` | no (dead method) |
| `:412` (`Users.insertIfAbsent`) | `Tenant.stamp(input)` | yes |
| `:986` (`Accounts.insert`) | `Tenant.stamp(input)` | no (dead) |
| `:1128` (`Accounts.insertIdentityIfAbsent`) | `Effect.map(Tenant.TenantContext, Option.getOrNull)` | yes |
| `:1514` (`Sessions.insert`) | `Tenant.stamp(input)` | yes |
| `:2022` (`Verification.upsertLive`) | raw `TenantContext` | yes |
| `:2104` (`Verification.insert`) | `Tenant.stamp(input)` | no (dead) |
| `:2185` (`Reservations.claim`) | raw `TenantContext` | yes |
| `:2453` (`AuditLog.insertIfAbsent`) | raw `TenantContext`, then `input.tenantId ?? ambient` (hand-rolled explicit-over-ambient) | yes |

The `:2453` form is equivalent to `Tenant.resolve`, since `AuditLogStoreSql.ts:53` passes `Option.getOrNull(row.tenantId)`. There is no runtime bug, only three spellings of one rule.

**Spec drift found.** BEH-EA-231 (`spec/behaviors/28-tenancy.md:34-41`) requires that an insert into `users`, `accounts`, `sessions`, `verification_tokens` and `verification_reservations` "store the input's explicit value when non-null". No port carries an explicit tenant for those tables (`UserStore.NewUser` omits `tenantId`, `ports/src/UserStore.ts:53`; `SessionStore.NewSession` has none, `SessionStore.ts:70-83`; `VerificationStore.NewToken` omits it, `VerificationStore.ts:51`; the account and reservation primitives take none). Only `AuditLogStore.append` does. The BDD scenario that proves the clause, REQ-EA-821 ("An explicit tenant on the input wins over the ambient one", `features/features/12-multi-tenancy/28-tenancy.feature:90-93`), calls the dead `UsersRepository.insert` (`features/step-definitions/TenancySteps.ts:508-520`). Deleting the dead method forces the clause to be narrowed to the audit log (§6.1, §10 Q4).

### 2.5 Composition leaking into tests

Most of these are **dead wiring**: a repository layer `Layer.provide`d to a service that `Persistence.sql()` (`SqlStores`) already satisfied. `Persistence.sql()` uses `Layer.provide` for its repositories, so the service's remaining requirement is `SqlClient | Encryption | …`; the extra `Layer.provide(Repositories.XLive)` satisfies nothing and is a no-op that still type-checks (codemod residue from plan 02 phase 7). They will not compile once `Repositories` is gone, so they must be deleted, but deleting them changes no behaviour.

| Site | Wiring | Dead or real |
|---|---|---|
| `packages/core/test/AccountErasure.test.ts:126-139` | `AccountsRepositoryLive`, `Verification` + `VerificationReservations` repositories | dead |
| `packages/core/test/Verification.test.ts:920-923`, `:987-990` | `VerificationRepositoryLive`, `VerificationReservationsRepositoryLive` | dead |
| `packages/core/test/Retention.test.ts:52-61` | the two verification repositories | dead |
| `packages/core/test/SignUpSql.test.ts:69-71` | `AccountsRepositoryLive` | dead |
| `packages/core/test/UserImport.test.ts:40-45` | `UsersRepositoryLive`, `AccountsRepositoryLive` | dead |
| `packages/core/test/UserFields.test.ts:196-198` | `UsersRepositoryLive` | dead |
| `packages/core/test/LegacySessionBridge.test.ts:93-96` | `SessionsRepositoryLive` | dead |
| `packages/cli/test/support/SqlApp.ts:55-87` | `UsersRepositoryLive`, `AccountsRepositoryLive`, `AuditLogRepositoryLive` (+ its own `EncryptionLive` `:39-52` that only they need) | dead |
| `features/step-definitions/CliWorld.ts:160`, `:170` | `AccountsRepositoryLive`, `AuditLogRepositoryLive` | dead |
| `features/step-definitions/TenancyWorld.ts:117-128` | `UsersRepositoryLive` exposed (used by `TenancySteps.ts:514`), plus dead account/verification repositories | real (the user one) + dead |
| `packages/core/test/EventRelay.test.ts:65-66` | `RelayCursorRepositoryLive` | real; plan 23 |
| `packages/test/test/ReadRouting.test.ts:49-261` | `SessionsRepository`/`AuditLogRepository` as the subject under test | real |
| `packages/test/test/support/storeContract.ts:85-102` | builds the five adapters over six repositories by hand (a second copy of `Persistence.sql()`) | real; becomes `CoreStoresSql.layer()` |
| `features/step-definitions/PersistenceStratumWorld.ts:51-61`, `PersistenceStratumSteps.ts:164-375`, `PersistenceMigrationSteps.ts:73`, `:175`, `PersistenceTypeGates.ts:3-15`, `TenancySteps.ts:514`, `VerificationSteps.ts:886-901` | repositories as BDD subjects (BEH-EA-033..036, BEH-EA-231, BEH-EA-063 outage) | real; retargeted at the ports (§4 Phase 7) |

### 2.6 Tests, twice

| File | Lines | Subject | Disposition (§5) |
|---|---|---|---|
| `packages/sql/test/contract.ts` | 1,179 | 28 repository cases, run by `Repositories.test.ts:28` (SQLite `:memory:`), `.file.test.ts:37` (WAL), `.libsql.test.ts:24-28` (libSQL `file:`), `.postgres.test.ts:52` (Postgres) | deleted case by case (table in §5.3) |
| `packages/test/src/StoreContract.ts` | 1,901 | port cases, run on `Ref`, SQLite/Postgres (`StoreContract.sql.test.ts`), WAL (`StoreContract.file.test.ts`); **not libSQL** | gains the moved cases and a libSQL runner |
| `packages/sql/test/Repositories.test.ts` | 418 | contract runner + 8 SQLite specifics (EOTS-008 spans ×2, PPS-007, SEA-005 ×2, PPS-002, PPS-003, …) | specifics move beside their adapter or to `CoreStoresSql.test.ts` |
| `packages/sql/test/Repositories.file.test.ts` | 129 | contract runner + WAL mode + two connections racing `touch` / `claim` | `SqliteWal.test.ts` over two adapter builds |
| `packages/sql/test/Repositories.libsql.test.ts` | 28 | contract runner only | replaced by `StoreContract.libsql.test.ts` |
| `packages/sql/test/Repositories.postgres.test.ts` | 333 | contract runner + 9 Postgres cases | quoted-column and round-trip cases deleted (the contract on Postgres runs every primitive); the LSN and `regclass` cases move |
| `packages/sql/test/AccountsTokenReadPath.test.ts` | 279 | SMS-002/KRS-002 over `AccountsRepository` | live cases move onto `AccountStore` in `AccountStoreSql.test.ts`; dead ones deleted |
| `packages/sql/test/PiiEncryption.test.ts` | 240 | CSG-006 over the plain/encrypted repository pairs | rewritten over `UserStoreSql`/`SessionStoreSql` `layer` vs `layerSealedPii` |
| `packages/sql/test/{AuditLog,Verification,Account,User,Session}StoreSql.test.ts` | 119-273 | adapter failure mapping and retries through repository doubles (e.g. `SessionStoreSql.test.ts:57-68`, `:194-212`) | the doubles become `FaultySql` (§3.6) |
| `packages/sql/test/TenantScope.postgres.test.ts` | 373 | core RLS over `repositoriesLayer` (`:35`, `:87-88`) | over `CoreStoresSql.layer()` |

### 2.7 Read replicas (ADR-EA-024)

`ReadRouting.makeRouter` (`sql/src/ReadRouting.ts:196-226`) is called by the sessions repository (`Repositories.ts:1537`) and the audit repository (`:2346`) at layer construction; it reads `ReplicaSqlClient` and `ReplicationPosition` once. Only `Sessions.listByUser` (`:1538-1601`) and `AuditLog.list`/`page` (`:2347-2388`, `:2461-2471`) route. Causal tokens are captured by `SqlStore.make(sql)`'s `{ capture: true }` (`SqlStore.ts:57-76`) on the session adapter's writes (`SessionStoreSql.ts:164`, `:216`, `:221`, `:227`). The move keeps all of it: the adapter calls `makeRouter` where the repository did, in the same layer build, so a `ReadRouting.replica(...)` provided above the bundle still reaches it. `packages/test/test/ReadRouting.test.ts` is rewritten over `SessionStore.listLive` and `AuditLogStore.select`/`pageAfter`; `LaggingReplica.ts:44` ("put it below the repositories") becomes "below the store adapters".

### 2.8 Housekeeping found

- `packages/sql/src/Repositories.ts-E`: untracked (`git status` `??`), 2,556 lines, Oct 14 14:34. It is a BSD `sed -i -E` backup of `Repositories.ts` from before plan 02's follow-up dropped the `AccountUpdate`/`SessionUpdate`/`UserUpdate`/`VerificationTokenUpdate` imports (`diff` shows exactly those four lines). Nothing reads it (not a `.ts` file to `tsc`, oxlint or knip). Delete it.
- `packages/sql/README.md`: `:9-25` tells users to wire six repositories by hand (ADR-EA-041 replaced that with `Persistence.sql()`); `:11` says "23 forward-only migrations" (there are 29, `CoreMigrations.ts:640`); `:35` credits libSQL with "the shared contract cases" (`Repositories.libsql.test.ts`); `:81`, `:104`, `:161`, `:228` name repository test files and repository methods; `:194` omits `idToken` from the encrypted columns (it is sealed, BAM-008) and says an undecryptable token "degrades to `null` on identity reads" (identity reads no longer read tokens); `:203-209` opts into PII encryption by swapping repository layers; `:211-223` (read replicas) names repository methods and says "a service … wraps the write in `ReadRouting.captureToken`" (the session adapter does).
- `packages/sql/package.json:5`: "Models, repositories, migration records, memory twins" (no memory twins since plan 02).
- `packages/sql/src/index.ts:3-10`: "consumed by @awthaq/core's `layerSql` services".
- `spec/overview.md:48`: Persistence row "Models, repositories, migration records, memory twins."
- `README.md:348`: "Every `layerMemory` in this repository (`Users`, `Accounts`, `Sessions`, `Verification`, `AuditLog`, …)": those five no longer have one (plan 02); `:283`: "`packages/sql`'s domain layers" and `Repositories.postgres.test.ts`.
- `spec/appendices/04-sqlite-embedded-deployment.md:15`: "awthaq's `layerSql` compositions".
- `spec/behaviors/05-persistence-stratum.md:67-87` (BEH-EA-035) requires that a repository "MUST NOT call `SqlClient.withTransaction` itself" and allows one exception for plugin records (OHS-002). Since plan 02 the core store adapters open units in `deleteUnlessLast`, `flagReuse`, `insert`, `reauthenticate`, `casIdentity`, `rewriteReferencing` and `transaction` (ADR-EA-041 decision 2). Plan 02 §6 asked for the OHS-002 exception to be extended; the BEH text was never changed. This plan rewrites it (§6.1).

### 2.9 Claims in the candidate description that were wrong or imprecise

- "~1,117 lines" of adapters: 1,051 (`wc -l`).
- "Atomicity split: … reaches into `repo.models.Session.insert` (:115)": correct, and `UserStoreSql.ts:89` does the same with `repo.models.User`.
- "CoreMigrations, ReadRouting, Models import it": they do not import it; they mention it in comments (§2.2).
- "`passkey/PasskeyCredentials.ts` (comment only?)": confirmed comment only.
- "Core tests … wire repository layers piecemeal": they do, but the wiring is dead (§2.5) except `EventRelay.test.ts` (plan 23), `ReadRouting.test.ts` and the store-contract support.
- "the audit insert hand-rolls explicit over ambient (~2453) instead of `Tenant.resolve`": correct, and equivalent (no bug).

---

## 3. Target design

### 3.1 Placement after this plan

```
@awthaq/ports   SessionStore, UserStore, AccountStore, VerificationStore, AuditLogStore, RelayCursorStore (plan 23)
                 (ports, Ref adapters, pure contract helpers)                                   unchanged
@awthaq/sql     <X>StoreSql.ts      one module per store: statements + sealing hook + Tenant.resolve
                                    + dialect branches + read routing + SqlStore classification
                CoreStoresSql.ts    the bundle: every core SQL store + SqlTransaction.layerSql   NEW
                internal/CoreSealing.ts   PiiCodec + account-token codec, moved verbatim          NEW (private)
                internal/traced.ts  the EOTS-008 span helper                                     NEW (private)
                Models, CoreMigrations, ReadRouting, SqlStore, StoreFailure, SealedColumn,
                TenantScope, TenantScoped, RateLimiterStoreSql                                   unchanged
                Repositories.ts                                                                  DELETED
@awthaq/core    Persistence.memory (unchanged), Persistence.sql = CoreStoresSql.layer
@awthaq/test    StoreContract (+ the moved cases), runners on Ref, SQLite, WAL, libSQL (NEW), Postgres
```

The seam stays where plan 02 put it: the store port. What is removed is the repository `Context.Service` beneath each adapter. With one adapter per repository and no other caller, it was a hypothetical seam: it cost a second shape per row (`AccountIdentityRow` vs `AccountStore.AccountIdentity`, `AuditLogRow` vs `AuditLogStore.AuditRow`, `Models.Session` vs `SessionStore.SessionRecord`), a translation per call, and split every primitive's correctness argument across two files. Each adapter is now a deep module: a small interface (its port) over everything SQL-specific.

### 3.2 Anatomy of an adapter (`SessionStoreSql.ts`, the largest)

```ts
// @awthaq/sql — SessionStoreSql
//
// Plan 02 / plan 16 (ADR-EA-041, ADR-EA-014): the SQL adapter of `SessionStore`. It owns every
// statement over `sessions` (moved verbatim from the former `Repositories.ts`), the opt-in sealing
// of `ipAddress`/`userAgent` (CSG-006), the tenant stamp, the Postgres advisory locks, the read
// routing of `listLive` (ADR-EA-024) and the failure classification. Atomicity per primitive is as
// before (the header block of today's file, kept).

import { Encryption, SessionStore, SqlTransaction, Tenant } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Model from "effect/unstable/schema/Model";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlModel from "effect/unstable/sql/SqlModel";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as CoreSealing from "./internal/CoreSealing.ts";
import { traced } from "./internal/traced.ts";
import { makeModels, resolveDialect, type Session } from "./Models.ts";
import * as ReadRouting from "./ReadRouting.ts";
import * as SqlStore from "./SqlStore.ts";
import { StoreUnavailable } from "./StoreFailure.ts";

/** ESR-010: the page size `listLive` drains with (was `Repositories.MAX_PAGE_SIZE`). */
const PAGE = 200;

const make = (pii: Option.Option<CoreSealing.PiiCodec>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = makeModels(yield* resolveDialect(sql));
    const crud = yield* SqlModel.makeRepository(models.Session, {
      tableName: "sessions",
      spanPrefix: "Sessions",
      idColumn: "id",
    });
    const router = yield* ReadRouting.makeRouter;
    const { write, read, once } = SqlStore.make(sql);
    const sealing = CoreSealing.sessionColumns(sql, models, pii); // conceal / reveal + lazy write-back

    // ---- statements: moved verbatim from Repositories.ts:1538-1826 --------------------------
    const pageOn = router.route((client) => SqlSchema.findAll({ /* … :1539-1569 … */ }));
    const touchQuery = SqlSchema.findOneOption({ /* … :1603-1632 … */ });
    const tombstoneQuery = SqlSchema.findOne({ /* … :1733-1747 … */ });
    // … deleteAllForUserExcept, deleteAllByUser, deleteExpired, liveIds, deleteReturning,
    //   markReused, revokeFamily, reauthenticate (:1649-1826) …

    /** One row as the port's record, PII revealed (and lazily re-sealed) on the way. */
    const record = (row: Session) => Effect.map(sealing.reveal(row), toRecord);

    return SessionStore.SessionStore.of({
      insert: ({ session, supersedes, maxLive }) => {
        const persist = Effect.gen(function* () {
          if (Option.isSome(maxLive)) {
            yield* sql.onDialectOrElse({
              pg: () => sql`SELECT pg_advisory_xact_lock(hashtext(${`session-cap:${session.userId}`}))`,
              orElse: () => Effect.void,
            });
          }
          const ancestor = /* tombstoneQuery(…) → Option, exactly as SessionStoreSql.ts:102-114 */;
          const tenantId = yield* Tenant.resolve(Option.none());
          const columns = yield* sealing.conceal(session.id, {
            ipAddress: Option.getOrNull(session.ipAddress),
            userAgent: Option.getOrNull(session.userAgent),
          });
          const inserted = yield* models.Session.insert
            .makeEffect({
              id: session.id,
              tenantId: Option.getOrNull(tenantId),
              ...columns,
              /* the remaining fields exactly as SessionStoreSql.ts:117-136 */
            })
            .pipe(Effect.orDie, Effect.flatMap(crud.insert), Effect.flatMap(record));
          /* eviction exactly as SessionStoreSql.ts:142-151, over liveIdsQuery and crud.delete */
          return { inserted, superseded: /* Option.map(ancestor, …) */, evicted };
        });
        return (
          Option.isNone(supersedes) && Option.isNone(maxLive)
            ? persist
            : SqlTransaction.transactional(sql)(persist)
        ).pipe(write("SessionStore.insert", { capture: true }));
      },
      // get, rotate, flagReuse, remove, removeForUser, listLive, reauthenticate, purgeExpired:
      // the bodies of SessionStoreSql.ts:167-314 with each `repo.x(...)` replaced by the statement
      // it ran, and every returned row passed through `record`.
    });
  });

/** Plaintext `ipAddress`/`userAgent`. Requires `SqlClient`. */
export const layer = Layer.effect(SessionStore.SessionStore, make(Option.none()));

/** CSG-006 (opt-in): `ipAddress`/`userAgent` sealed at rest (AAD `session:<id>:<field>`). Requires `SqlClient | Encryption`. */
export const layerSealedPii = Layer.effect(
  SessionStore.SessionStore,
  Effect.flatMap(Encryption.Encryption, (encryption) =>
    make(Option.some(CoreSealing.sealedPii(encryption))),
  ),
);
```

Rules every adapter follows (the executor applies them store by store):

- **Moved code is moved, not rewritten.** Each `SqlSchema` query, its `Request`/`Result` schema, its comments (ESR-003, PPS-002, SEA-005, ADR-EA-016 …) and its `traced(...)` span name move unchanged. Code that is moved keeps the existing `const x: Shape["x"] = …` style it had; **new** code (each primitive now written inside `Store.of({...})`) gets its parameter types from `Store.of` and carries no annotation. No `as`.
- **One decode path per row.** A statement that returns a Model-class row (`User`, `Session`, `VerificationToken`) is mapped once, by the adapter's `record` (reveal, then the existing `toRecord`/`toStored`/`toTokenRow`). A statement that already selects a column subset (account identity, audit rows, the relay cursor) may decode straight into the port record with `Schema.OptionFromNullOr` in its `Result` schema (rc.116 `Schema.ts:12858`), deleting `toIdentity`/`toAuditRow`; that is the executor's call where it removes a mapper and changes no SQL.
- **One tenant spelling.** Every insert primitive calls `Tenant.resolve(explicit)` once and binds `Option.getOrNull(...)`: `Option.none()` for users, accounts, sessions, tokens and reservations (their ports carry no explicit tenant), `row.tenantId` for the audit append.
- **No `NoSuchElementError` crosses the adapter.** Where the repository used `SqlSchema.findOne` and the adapter caught `NoSuchElementError` to make `None` (`SessionStoreSql.ts:113`, `:170`, `:201`; `UserStoreSql.ts:133`, `:177`, `:195`; `AccountStoreSql.ts:140`), the moved statement becomes `findOneOption` where its only caller wanted an `Option`. `crud.findById` (`SqlModel`) still raises it; wrap it once (`findByIdOption`).
- **Spans unchanged.** `Users.findByEmail`, `Sessions.touch`, `VerificationTokens.tryConsume`, … are statement spans and keep their names and id-only attributes (EOTS-008, BEH-EA-199); `SqlStore` still labels failures by primitive (`SessionStore.insert`).

### 3.3 The sealing module (`packages/sql/src/internal/CoreSealing.ts`, private)

Moved verbatim, so plan 17 replaces one module:

| Moved from | Content |
|---|---|
| `Repositories.ts:84-124` | `PiiCodec`, `sealedPii(encryption)` (null-and-warn on `DecryptionFailed`/`UnknownKeyId`, `adoptPlaintext: true`) |
| `:247`, `:1440` | `userMetadataAad`, `sessionAad` |
| `:787-835`, `:854-898` | `TokenField`, `AccountTokenUndecryptable` (now module-private: only `AccountStoreSql` sees it, and it maps it to `TokensRead.Undecryptable`), `tokenAad`, `encryptToken`, the strict `readColumn` |
| `:800-814` | `AccountsRepositoryConfig` (`{ reencryptOnRead }`, default on), the same `Context.Reference` value and key; re-exported publicly from `CoreStoresSql` (§3.4) |
| `:318-350`, `:1452-1509` | the per-table helpers `userColumns(sql, models, pii)` and `sessionColumns(sql, models, pii)`: `conceal`, `reveal` and the lazy compare-and-swap write-back (`UPDATE users SET metadata …`, `UPDATE sessions SET "ipAddress" …`), unchanged |

The accounts write-back (`persistRefreshed`, `:919-932`) and `decryptRowWith` (`:934-960`) move into `AccountStoreSql` with the strict path only; `readColumnDegraded` and `decryptRow` are deleted with the dead `findById`/`listByUser`/`insert` (§2.1). Lazy re-encryption on the strict read (`readProviderTokens`) is unchanged.

### 3.4 The bundle (`packages/sql/src/CoreStoresSql.ts`) and `Persistence.sql`

```ts
// @awthaq/sql — CoreStoresSql
//
// Plan 16 (ADR-EA-041 decisions 3 and 4): every core SQL store over ONE ambient `SqlClient`, plus
// `SqlTransaction.layerSql` over the same client (INV-EA-017). `@awthaq/core`'s `Persistence.sql`
// is this function. Swapping one store stays legal (ADR-EA-014): merge another adapter after it.

import { SqlTransaction } from "@awthaq/ports";
import * as Layer from "effect/Layer";
import * as AccountStoreSql from "./AccountStoreSql.ts";
import * as AuditLogStoreSql from "./AuditLogStoreSql.ts";
import * as RelayCursorStoreSql from "./RelayCursorStoreSql.ts";
import * as SessionStoreSql from "./SessionStoreSql.ts";
import * as UserStoreSql from "./UserStoreSql.ts";
import * as VerificationStoreSql from "./VerificationStoreSql.ts";

export interface Options {
  /** CSG-006: seal `users.metadata` and `sessions.ipAddress`/`userAgent` at rest. Default `false`. Provider tokens are always sealed. */
  readonly encryptPii?: boolean;
}

/** Requires `SqlClient | Encryption` (the accounts adapter seals provider tokens). */
export const layer = (options?: Options) =>
  Layer.mergeAll(
    options?.encryptPii === true ? UserStoreSql.layerSealedPii : UserStoreSql.layer,
    options?.encryptPii === true ? SessionStoreSql.layerSealedPii : SessionStoreSql.layer,
    AccountStoreSql.layer,
    VerificationStoreSql.layer,
    AuditLogStoreSql.layer,
    RelayCursorStoreSql.layer,
    SqlTransaction.layerSql,
  );

/** SMS-002 / KRS-002: whether a read that finds a stale-key value re-seals it (default on). Plan 17 folds it into `SealedColumn.SealedColumnConfig`. */
export { AccountsRepositoryConfig } from "./internal/CoreSealing.ts";
```

```ts
// packages/core/src/Persistence.ts (the SQL half)
import { CoreStoresSql } from "@awthaq/sql";

export type SqlOptions = CoreStoresSql.Options;
export type SqlRequirements = SqlClient.SqlClient | Encryption.Encryption;
/** Every SQL store over ONE `SqlClient`, and `SqlTransaction.layerSql` over the same client. */
export const sql = CoreStoresSql.layer;
```

- The conditional union of two layers type-checks because `Layer`'s `RIn` is covariant (`out RIn`), as plan 02's bundle relied on.
- With no repository services in any adapter's inferred type, the TS2883 declaration-emit problem plan 02 met on its transitional layers cannot arise; if it does, use the documented explicit-type exception.
- The per-store layers stay public. A deployment that swaps the session store for a KV adapter composes the other SQL stores itself (`Layer.merge(CoreStoresSql.layer(), KvSessionStore.layer)` is the documented form, §10 Q2).

### 3.5 Every SQL adapter's requirements after the plan

| Layer | Requires |
|---|---|
| `UserStoreSql.layer`, `SessionStoreSql.layer`, `VerificationStoreSql.layer`, `AuditLogStoreSql.layer`, `RelayCursorStoreSql.layer` | `SqlClient` |
| `UserStoreSql.layerSealedPii`, `SessionStoreSql.layerSealedPii`, `AccountStoreSql.layer` | `SqlClient \| Encryption` |
| `CoreStoresSql.layer(options)` | `SqlClient \| Encryption` |

### 3.6 Fault injection without a repository double (`packages/sql/test/support/FaultySql.ts`)

The adapter tests today replace one repository method with a failing one (`SessionStoreSql.test.ts:57-68`, `:194-212`; same in the four other files and `VerificationSteps.ts:886-899`). With no repository, the fault goes where it happens in production: the SQL client. `@awthaq/sql`'s tests cannot import `@awthaq/test` (it depends on `@awthaq/sql`), so the helper lives in `packages/sql/test/support/` beside `RotatingKeys.ts`.

```ts
// Test support (plan 16): a SQLite `SqlClient` whose statements can be made to fail, so an adapter's
// failure mapping and retries are tested at the seam a database outage really crosses.
export interface Faults {
  /** The next `count` statements whose SQL matches `matching` fail with `reason` (default: any statement). */
  readonly failNext: (input: {
    readonly count: number;
    readonly reason: SqlErrorReason;
    readonly matching?: RegExp;
  }) => Effect.Effect<void>;
  /** How many statements matching `pattern` were attempted since the last `reset`. */
  readonly attempts: (pattern: RegExp) => Effect.Effect<number>;
  readonly reset: Effect.Effect<void>;
}

export class FaultControl extends Context.Service<FaultControl, Faults>()("test/sql/FaultControl") {}

/** Wraps a real SQLite client: `SqlClient.make` over `real.reserve`, every `Connection.execute*` checked against the plan first. */
export const layer = (real: Layer.Layer<SqlClient.SqlClient>) => /* Layer<SqlClient | FaultControl> */;
```

Built with `SqlClient.make({ acquirer, compiler: Statement.makeCompilerSqlite(), spanAttributes: [] })` (rc.116 `unstable/sql/SqlClient.ts:111-161`, `Statement.ts:1089`), the acquirer being the real client's `reserve` mapped through a decorator over the `Connection` methods, and `Reactivity` provided. Every adapter test's "down" and "busy" cases use it: `failNext({ count: 2, reason: new LockTimeoutError(…), matching: /INSERT INTO "?sessions/ })` replaces `withInsert`, and `failNext({ count: Infinity, reason: new UnknownError(…) })` replaces each `DownRepository`.

**Fallback if the decorator is impractical** with the single-connection sqlite driver: a down store is the renamed table (`ALTER TABLE sessions RENAME TO sessions_down`: SQLite answers "no such table", `classifySqliteError` makes it `UnknownError`, `StoreFailure` makes it `StoreUnavailable`, so every primitive of that store fails with its label); and the three busy-retry cases (`SessionStoreSql.test.ts:155-190`) are dropped, since `SqlStore.test.ts:27-63` already proves `write` retries and `read`/`once` do not, and each adapter's choice of wrapper is visible in its source. Record the choice in "Decisions taken".

---

## 4. Phased migration

Phase gate: `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, plus `pnpm test:pg` from Phase 1 on (SQL adapters change). Plan gate: `pnpm check && pnpm test:pg`. One ticket per phase in `.scratch/sql-store-adapters/issues/`.

**Preconditions.** Plan 23 is merged (`RelayCursorRepository` and the `EventRelay` import are gone; `RelayCursorStoreSql` exists). Re-run `grep -rn "Repositories" packages/*/src packages/*/test features examples scripts` and add any new site to the phase that owns its store.

### Phase 0: housekeeping and the failing pin

1. Delete `packages/sql/src/Repositories.ts-E` (untracked; `rm`, nothing to stage).
2. Delete the dead wiring of §2.5 (every row marked "dead"), including `SqlApp.ts`'s and `CliWorld.ts`'s `EncryptionLive` if nothing else uses it. No behaviour change; each suite still passes over `Persistence.sql()`.
3. Add `packages/test/test/StoreContract.libsql.test.ts` (`runOnSql("libSQL file", LibsqlFileClient)`, the `file:` temp-database layer from `Repositories.libsql.test.ts:17-21`) and `@effect/sql-libsql` to `packages/test/package.json` devDependencies (`pnpm workspace:sync`). **This is the pin:** the README claims libSQL passes the shared cases, but the real bar since plan 02 never ran there. If a case fails, it is a live bug of that store; fix it in that store's phase below and record it in "Decisions taken". If every case passes, the claim is now true.
4. Docs that are wrong today regardless of this plan: `README.md:348` (name the stores that still have a `layerMemory`: `RateLimiter`, `ChallengeStore`, the plugin record stores, and `Persistence.memory`), `packages/sql/README.md:9-25` (the "What ships" `Repositories` row and the `PersistenceLive` block become "`Persistence.sql()` composes the five SQL store adapters; provide a `SqlClient` and `Encryption`"), `:11` (29 migrations), `:194` (`idToken` too; identity reads never decrypt tokens), `packages/sql/package.json:5` ("Models, SQL store adapters, migration records"), `spec/overview.md:48` (same wording), `spec/appendices/04-sqlite-embedded-deployment.md:15` ("`Persistence.sql()` compositions"). `pnpm check:readmes`.

### Phase 1: substrate and the bundle (additive)

1. `packages/sql/src/internal/traced.ts`: the `traced` helper (`Repositories.ts:63-72`), moved; `Repositories.ts` imports it.
2. `packages/sql/src/internal/CoreSealing.ts` (§3.3); `Repositories.ts` imports the moved pieces from it, so nothing is duplicated while the stores migrate.
3. `packages/sql/src/CoreStoresSql.ts`: for now the body of today's `Persistence.sql` (the adapters over the repository layers), plus the `AccountsRepositoryConfig` re-export. Export from `index.ts`.
4. `packages/core/src/Persistence.ts`: `sql = CoreStoresSql.layer`; drop the `Repositories` import.
5. `packages/test/test/support/storeContract.ts`: `sqlStores` becomes `CoreStoresSql.layer().pipe(Layer.provide(EncryptionLive), Layer.provideMerge(client), Layer.provideMerge(migrated))`.
6. `packages/sql/test/support/FaultySql.ts` (§3.6) with its own small test (`packages/sql/test/FaultySql.test.ts`: a matched statement fails with the given reason, an unmatched one runs, a transaction on the decorated client commits).
7. `.changeset/core-stores-sql-bundle.md` (`@awthaq/sql` minor, `@awthaq/core` patch): "`CoreStoresSql.layer({ encryptPii? })` is the SQL store bundle; `Persistence.sql` is it."

### Phases 2-6: one store per phase

The same steps for each, in plan 02's order (the smallest first; sessions last, after users, because they share the PII hook and sessions carry the read routing and both advisory locks):

| Phase | Store | Repository section deleted | `CoreStoresSql` change |
|---|---|---|---|
| 2 | AuditLog | `Repositories.ts:2218-2488` | drop `AuditLogRepositoryLive` from the provide list |
| 3 | Verification (tokens + reservations) | `:1869-2216` | drop both verification repositories |
| 4 | Accounts | `:667-1279` (keeping nothing but what §3.3 already moved) | drop `AccountsRepositoryLive` |
| 5 | Users | `:126-665` | `UserStoreSql.layer` / `layerSealedPii` by option |
| 6 | Sessions | `:1281-1867` | `SessionStoreSql.layer` / `layerSealedPii` by option; the provide list is now empty and is removed |

Steps, per store:

1. **Move the statements into `<X>StoreSql.ts`** (§3.2 rules): models, `crud` where the repository used `SqlModel.makeRepository` (users, accounts, sessions; verification and audit used only hand-written statements), routers (audit, sessions), the dialect branches, the savepoint/lock statements, the sealing hook. Replace the store's `Tenant.stamp`/`TenantContext` site(s) (§2.4) by `Tenant.resolve`. Delete the store's section of `Repositories.ts`, its dead methods (§2.1) included.
   - Phase 2 specifics: `inSavepoint` (`:2443-2450`) moves beside `append`; `likeEscape` and the `FOR UPDATE` branch beside `rewriteReferencing`.
   - Phase 3: tokens and reservations become one adapter (they already are one port). `present`'s `afterUnit` miss charge (`VerificationStoreSql.ts:90-103`) is unchanged.
   - Phase 4: delete `insert`, `findById`, `listByUser`, `readColumnDegraded`, `decryptRow`; `readProviderTokens` maps the strict read's undecryptable column straight to `TokensRead.Undecryptable`.
   - Phase 5: `insertOrHolder` builds its insert from the adapter's own `models` (was `repo.models`, `UserStoreSql.ts:89`); the declared-field statements (`readFields`, `writeFieldsReturning`, `userFieldScalar`, `:254-316`, `:590-626`) move as they are. Delete `insert` and `delete`.
   - Phase 6: both advisory locks now sit beside the statements they serialize; `MAX_PAGE_SIZE` and `Cursor` become module-private (`PAGE`, a local cursor type).
2. **`packages/sql/test/contract.ts`:** remove the store's repository from `repositoriesLayer` and delete or move its cases per §5.3 (moved cases land in `StoreContract.<port>` in the same commit).
3. **Dialect-specific cases** of `Repositories.test.ts`, `.file.test.ts` and `.postgres.test.ts` for this store move per §5.2.
4. **`packages/sql/test/<X>StoreSql.test.ts`:** the repository doubles become `FaultySql` (§3.6); the failure-mapping assertions (operation label per primitive, no `cause` field) are unchanged. Phase 4 also absorbs the live cases of `AccountsTokenReadPath.test.ts` (§5.2) and deletes that file; phases 5 and 6 rewrite their half of `PiiEncryption.test.ts` over `layer` vs `layerSealedPii`.
5. **Other test users of that repository:** `packages/test/test/ReadRouting.test.ts` (phases 2 and 6), `packages/sql/test/TenantScope.postgres.test.ts` (phases 5 and 6, then the file uses `CoreStoresSql.layer()`), `features/step-definitions/VerificationSteps.ts:886-901` (phase 3: the "store that cannot claim atomically" scenario renames `verification_reservations` instead of doubling the repository), `TenancyWorld.ts`/`TenancySteps.ts:508-520` (phase 5, §4 Phase 7 item 3), `PersistenceStratum*`/`PersistenceMigrationSteps`/`PersistenceTypeGates` (phases 5 and 6, see Phase 7 item 3 for their new subjects).
6. **Changeset** `.changeset/sql-store-adapters-<store>.md` (`@awthaq/sql` minor): "`Repositories.<X>Repository` and its layer are removed: `<X>StoreSql.layer` owns its statements. Migration: compose `CoreStoresSql.layer()` / `Persistence.sql()`; a repository method had no caller outside its adapter."

Each phase is green on its own: the remaining stores still run over the remaining repositories, and every adapter test and contract runner passes. Phase gate plus `pnpm test:pg`.

### Phase 7: delete the module, retarget the specs, finish the docs (breaking)

1. Delete `packages/sql/src/Repositories.ts` (by now only its header is left) and `index.ts:26`; rewrite `index.ts:3-18` to list the store adapters, `CoreStoresSql` and the substrate modules. Rewrite the comments of §2.2 (`CoreMigrations.ts:237`, `:246`; `ReadRouting.ts:5-9`; `Models.ts:228`, `:463`, `:591`; `passkey/src/PasskeyCredentials.ts:7`).
2. Delete `packages/sql/test/contract.ts`, `Repositories.test.ts`, `Repositories.file.test.ts`, `Repositories.libsql.test.ts`, `Repositories.postgres.test.ts` (every case is gone or moved by now; §5.4). `scripts/test-pg.sh:21`: replace `Repositories.postgres.test.ts` with `ReadRouting.postgres.test.ts` and `CoreMigrations.postgres.test.ts`; add `packages/test/test/StoreContract.libsql.test.ts` nowhere (it needs no server).
3. **BDD** (`features/`), each scenario unchanged in id, reworded to the ports:
   - REQ-EA-090/091/092 (`01-contract-and-persistence/05-persistence-stratum.feature:60-80`, rule BEH-EA-035): "A core store adapter is a layer over the ambient `SqlClient` that owns its statements" (the step asserts `SessionStoreSql.ts` builds with `SqlModel.makeRepository`/`SqlSchema` and resolves `SessionStore` from a layer needing only `SqlClient`); "A single-statement primitive opens no transaction; a multi-statement primitive opens exactly one unit, a savepoint inside a caller's" (count `sql.transaction` spans around `UserStore.getByEmail` (0) and `AccountStore.deleteUnlessLast` (1, and still 1 inside an outer `SqlTransaction.transactional`, where it is a savepoint)); REQ-EA-092 unchanged.
   - REQ-EA-093/094/095 (rule BEH-EA-036): the subject becomes `UserStore.listPage({ after, limit })`, the one port that pages by cursor (`PersistenceMigrationSteps.ts:70-80` paginates users instead of sessions).
   - `PersistenceTypeGates.ts` `keyset-only-no-offset`: `// @ts-expect-error` on `users.listPage({ after: Option.none(), limit: 10, offset: 20 })` (an excess property of an object literal) over `UserStore.UserStoreShape`.
   - REQ-EA-821 (`28-tenancy.feature:90-93`): "An explicit tenant on an audit row wins over the ambient one": `AuditLogStore.append` with `tenantId: Some("tenant-explicit")` under ambient `"tenant-a"`, read back through `select` (§10 Q4).
   - `PersistenceStratumWorld.ts:51-61` builds `CoreStoresSql.layer()` over its SQLite client; BEH-EA-033/034 steps read rows through the ports (`UserStore.get`) or the raw table.
4. **Spec, ADRs, traceability** (§6). `docs/plugin-authoring.md`: the "Record stores and bundles" paragraph (`:193-211`) notes that core's SQL stores have the same one-layer shape as a plugin's `layerSql`.
5. **Docs:** `packages/sql/README.md` "What ships" (the adapters, `CoreStoresSql`), "Opt in to PII column encryption" (`:203-209`: `Persistence.sql({ encryptPii: true })` or `UserStoreSql.layerSealedPii`/`SessionStoreSql.layerSealedPii`; `CoreStoresSql.AccountsRepositoryConfig` for the re-seal knob), "Read replicas" (`:211-223`: the classified reads are `SessionStore.listLive` with `consistency: "eventual"` and `AuditLogStore.select`/`pageAfter`; the session adapter captures causal tokens on its writes), "Testing" (`:225-232`: `StoreContract` on five runners), `:35` (libSQL passes `StoreContract`, `StoreContract.libsql.test.ts`), `:81`, `:104`, `:161` (the test files they name); `packages/test/src/LaggingReplica.ts:44`; root `README.md:283`. `pnpm check:readmes`.
6. `.changeset/sql-repositories-removed.md` (§6.4).

Gate: plan gate, `pnpm test:bdd`, `pnpm spec:verify:strict`, `pnpm package:smoke` (the `@awthaq/sql` export map changed), `pnpm test:pg`.

---

## 5. Test plan

Replace, don't layer: a store primitive's behaviour is proven once, by `StoreContract`, on every adapter and dialect. A SQL-only property is proven once, beside the adapter that has it. Nothing tests a repository, because there is none.

### 5.1 New and moved `StoreContract` cases (`packages/test/src/StoreContract.ts`)

- `users`: "updateProfile never writes the status, and setStatus is the only writer of it" (from `contract.ts` SCP-001; extends today's `updateProfile` case).
- `users`: "the directory is global: a user stamped under tenant A is found by id, email and phone under tenant B and with no tenant" (from DRS-005; BEH-EA-232).
- `accounts`: "getByKey and listByUser are global across tenants" (DRS-005, accounts half).
- `verification`: "reserve stamps the ambient tenant" cannot be read back through the port; it moves to the adapter (§5.2).
- Runners: `StoreContract.libsql.test.ts` (new, Phase 0) beside the memory, SQL, WAL and Postgres ones; all five ports plus `relayCursor` (plan 23).

### 5.2 Adapter tests (`packages/sql/test/`)

| File | Cases (moved from) |
|---|---|
| `AuditLogStoreSql.test.ts` | failure mapping over `FaultySql` (was a repository double); "an empty retention allow-list sends no statement" (kept); "an append inside a Postgres transaction that fails does not abort it" stays where ADR-EA-037 tests it |
| `VerificationStoreSql.test.ts` | failure mapping; SOS-004 "a reissue racing a miss never charges the new token" (kept, over `FaultySql`/statements); BEH-EA-122 "a token with no payload stores the literal `null` and reads back `None`" (`contract.ts:608`); DRS-001 "reserve and upsertLive stamp the ambient tenant, NULL when none" (raw rows; `contract.ts` DRS-001); PPS-003 query plan (`Repositories.test.ts:404`) |
| `AccountStoreSql.test.ts` | failure mapping; tokens ciphertext at rest incl. `idToken` (BAM-008, `contract.ts:833`; "Ticket 18", `:241`); "writeProviderTokens re-seals under the row's AAD" (`:288`); from `AccountsTokenReadPath.test.ts` (deleted): a tampered token is `Undecryptable` (reason `DecryptionFailed`), a token under a key missing from the keyset is `Undecryptable` (`UnknownKeyId`), `writeProviderTokens` heals an undecryptable token without reading it, `writeCredentialHash` never touches the tokens, `readProviderTokens` re-seals a stale-kid token, the retired key can then be dropped, `reencryptOnRead: false` leaves it stale. Deleted with the dead path: "findById degrades only the unreadable column to null" and the identity-read degrade cases |
| `UserStoreSql.test.ts` | failure mapping; metadata at rest (kept); insertOrHolder retry and give-up (kept, over `FaultySql`); casIdentity collision in a transaction (kept); PPS-007 "casIdentity is one statement" (`Repositories.test.ts:172`); BEH-EA-041 "a mixed-case stored address (an import) is found by its lowercased form; the unique index is on `lower(email)`" (`contract.ts:98`) |
| `SessionStoreSql.test.ts` | insert failure, supersede rollback, busy retry ×3, non-retryable (kept, over `FaultySql`); failure mapping; PPS-002 query plan (`Repositories.test.ts:384`) |
| `PiiEncryption.test.ts` | rewritten over `UserStoreSql`/`SessionStoreSql` `layer` vs `layerSealedPii`: plain stores as given, sealed stores ciphertext and read plaintext, plaintext rows adopted and sealed on read, a tampered envelope reads as `None` with a warning, `reencryptOnRead: false` |
| `CoreStoresSql.test.ts` (new) | over the bundle: EOTS-008 "statement spans parent `sql.execute`" and "no span attribute carries an email, identifier or hash" (`Repositories.test.ts:81`, `:119`, driven through the ports); SEA-005 "every persisted SQLite timestamp is fixed-width ISO-8601" (`:212`) and "keyset order equals epoch order across rollovers" (`:347`, through `UserStore.listPage`); "the bundle builds over a `SqlClient` and `Encryption` and provides all six stores and `SqlTransaction`" |
| `SqliteWal.test.ts` (new) | from `Repositories.file.test.ts`: journal mode is WAL; two connections racing `SessionStore.rotate` (one rotates); two connections racing `VerificationStore.reserve` (one wins). Two `CoreStoresSql.layer()` builds over one file |
| `ReadRouting.postgres.test.ts` (new) | "captureToken reads a real LSN; an eventual read then pins the primary" (`Repositories.postgres.test.ts:272`), over `SessionStore` |
| `CoreMigrations.postgres.test.ts` (new) | "re-running coreMigrations on a migrated database applies nothing (regclass codec)" (`:302`) |
| `Models.test.ts` | + BEH-EA-034 "`passwordHash`/tokens never appear in the JSON variant" (`contract.ts:213`; a model property, no database) |
| `FaultySql.test.ts` (new) | the helper itself (§4 Phase 1) |

`packages/test/test/ReadRouting.test.ts` keeps every case, driven through `SessionStore.listLive` (consistency, lag, read-your-writes after `insert`/`remove`) and `AuditLogStore.select` instead of the repositories.

### 5.3 The 28 `contract.ts` cases

| Case (line) | Fate |
|---|---|
| BEH-EA-033 Users insert with a generated UuidV7 id (`:81`) | deleted: the dead `insert`; ids are minted by the domain (S-16/U-9, `Users.test.ts`) |
| BEH-EA-041 findByEmail case-insensitive (`:98`) | moved: `UserStoreSql.test.ts` |
| FAMS-002 email-less rows persist; email and phone unique (`:112`) | deleted: `StoreContract.users` "insertOrHolder answers Held … never for an anonymous user" |
| SCP-003 insertIfAbsent None on conflict (`:143`) | deleted: same contract case |
| SCP-001 setStatus only writer of status (`:170`) | moved: `StoreContract.users` (§5.1) |
| BEH-EA-034 sensitive fields not in JSON (`:213`) | moved: `Models.test.ts` |
| Ticket 18 tokens round-trip, ciphertext at rest (`:241`) | moved: `AccountStoreSql.test.ts` |
| writeTokens re-encrypts under the row's AAD (`:288`) | moved: `AccountStoreSql.test.ts` |
| BEH-EA-043 findIdentityByKey at most one row (`:327`) | deleted: `StoreContract.accounts` "insertIfAbsent is exclusive per (providerId, subject, issuer)" |
| BEH-EA-050 sessions persist only the hash (`:353`) | deleted: the port receives a hash; `Sessions.test.ts` proves the domain stores no secret (verify the BEH-EA-050 case exists there before deleting; else move it there) |
| BEH-EA-036 listByUser pages by (createdAt, id) (`:384`) | deleted: `StoreContract.sessions` "listLive … in creation order … drains more rows than one page holds" |
| BEH-EA-054 deleteAllForUserExcept (`:439`) | deleted: "removeForUser … except `keep`" |
| ticket 02 deleteAllByUser (`:477`) | deleted: same |
| ticket 01 touch CAS, one of two racers (`:514`) | deleted: "rotate under concurrency" |
| BEH-EA-057/060 token hashed at rest, looked up by identifier (`:576`) | deleted: the port receives a hash; `Verification.test.ts` |
| BEH-EA-122 payload JSON text, default literal null (`:608`) | moved: `VerificationStoreSql.test.ts` |
| RRS-003 tombstone/markReused/reauthenticate decode; revokeFamily live-only (`:646`) | deleted: the `flagReuse` and `reauthenticate` contract cases |
| RelayCursor (`:819`) | moved by plan 23 |
| BAM-008 idToken round-trip, ciphertext (`:833`) | moved: `AccountStoreSql.test.ts` |
| CSG-003 deleteExpiredBefore bounded, counted (`:744`) | deleted: the three `purgeExpired`/`deleteBefore` contract cases; batching is `SqlStore.drainBatches` (`SqlStore.test.ts:77`) |
| SMS-002 listByUser omits expired and tombstoned (`:900`) | deleted: "listLive is exactly the live rows" |
| ESR-010 clamps limit 0 to 1 (`:926`), negative limit (`:940`), caps at MAX_PAGE_SIZE (`:953`) | deleted: the page size is the adapter's constant, never a caller's input; the port's `limit` is "honours the limit" |
| TIR-008/GC-005 deleteReturning once, owner only (`:974`) | deleted: "remove answers the owner once, refuses a foreign owner" and "remove under concurrency" |
| DRS-001 every insert stamps the ambient tenant (`:1085`) | deleted for users, accounts, sessions, tokens, audit (each port's contract has a "stamps the ambient tenant" case); reservations moved to `VerificationStoreSql.test.ts` |
| DRS-005 login lookups stay global (`:1123`) | moved: `StoreContract.users`/`accounts` (§5.1) |
| ESR-002 tombstone applies only to a live row (`:1155`) | deleted: "insert with supersedes naming … a tombstoned … row founds a fresh family" |

### 5.4 Deleted files, by name

`packages/sql/test/contract.ts`, `Repositories.test.ts`, `Repositories.file.test.ts`, `Repositories.libsql.test.ts`, `Repositories.postgres.test.ts`, `AccountsTokenReadPath.test.ts`. The dead-wiring lines of §2.5 (not files).

### 5.5 Coverage the plan must not lose

- Every dialect: `StoreContract` on SQLite `:memory:`, WAL, libSQL (new) and Postgres; the quoted-identifier cases of `Repositories.postgres.test.ts` are subsumed because every primitive's statements run on Postgres under `test:pg`.
- Every sealing behaviour of `PiiEncryption.test.ts` and the live half of `AccountsTokenReadPath.test.ts`.
- EOTS-008, SEA-005, PPS-002/003/007, SEA-004 two-connection locking.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs (each with a Document Control revision and a change-history line)

- `spec/behaviors/05-persistence-stratum.md` → rev 1.6.
  - Banner `:17`: "Implemented in `@awthaq/sql` (`Models.ts`, the five store adapters and `CoreStoresSql.ts`, `CoreMigrations.ts`; tests `packages/sql/test` and `@awthaq/test`'s `StoreContract`, on SQLite, libSQL and Postgres)".
  - BEH-EA-033 `:40`: "Each store adapter resolves the dialect once from the ambient `SqlClient`" (was "each repository layer … exposes the resulting `models`").
  - BEH-EA-034 `:63`: the opt-in is `Persistence.sql({ encryptPii: true })` (`UserStoreSql.layerSealedPii`/`SessionStoreSql.layerSealedPii`).
  - BEH-EA-035 retitled "**A core store adapter owns its statements over the ambient `SqlClient`; a multi-statement primitive opens one unit, never the caller's boundary**". REQUIREMENT: "A core SQL store adapter MUST build its statements (`SqlModel.makeRepository` CRUD and `SqlSchema` queries) inside its own layer, over the ambient `SqlClient`, with no intermediate public service. A primitive that is one statement MUST NOT open a transaction; a primitive that is several statements MUST run them in one `SqlTransaction.transactional(sql)` unit, which is a savepoint inside a caller's transaction and so never moves the caller's boundary. Composing two primitives is the domain service's job." The OHS-002 paragraph (`:83`) becomes the general rule for plugin records too; the read-replica (`:85`) and span (`:87`) paragraphs name the adapters (`SessionStore.listLive`, `AuditLogStore.select`/`pageAfter`). Update the anchor everywhere it is linked (`spec/traceability.md:167`, `:170`; `spec/decisions/028-infrastructure-error-policy.md:61`).
  - BEH-EA-036 retitled "Pagination is keyset-only; no store port accepts an offset"; the code block shows `UserStore.listPage({ after, limit })`; PPS-002/ESR-010 paragraph: the session adapter pages internally at a fixed size.
  - BEH-EA-325 `:201` ("exactly as a core repository does") → "as a core store adapter does".
- `spec/behaviors/28-tenancy.md` → rev 1.8. BEH-EA-231: REQUIREMENT "Every core store adapter's insert into `users`, `accounts`, `sessions`, `verification_tokens`, `verification_reservations` and `auth_audit_log` MUST stamp `"tenantId"` through `Tenant.resolve`: the explicit value where the port carries one (`AuditLogStore.append`), otherwise the ambient `TenantContext`, otherwise `NULL`. …" (§10 Q4). Prose `:43`: "Stamping happens in the store adapter, SQL and `Ref` alike, the one place every insert passes through."

### 6.2 Decisions

- **ADR-EA-041 rev 1.3** (rev 1.2 is plan 23's). Decision 3: "the SQL adapters, each owning its statements, sealing hook, tenant stamp and dialect branches, live in `@awthaq/sql` (stratum 3); there is no repository layer beneath them (plan 16)". Decision 4: `Persistence.sql` is `@awthaq/sql`'s `CoreStoresSql.layer`. Decision 6: the runners include libSQL. Alternatives: add "**(d) SQL adapters over repositories** (plan 02's interim choice). Reversed by plan 16: each repository had one caller, so the second seam bought no substitution; it doubled every row shape and split each primitive's atomicity argument across two files." Revision note.
- **ADR-EA-004 rev 1.3**, Consequences: "`SqlModel.makeRepository` and `SqlSchema` are used inside each store and record adapter; no repository is a public module (plan 16)."
- **ADR-EA-024 rev 1.2**: Context `:19`, decision 1 `:23`, decision 5 `:27`, alternatives `:31`: "store adapters" for "repositories" (`makeRouter` is called by the session and audit adapters at construction). No decision changes.
- **ADR-EA-016**, implemented line `:62`, and **ADR-EA-018**, implemented line `:68`: name `VerificationStoreSql.ts` / the store adapters instead of `Repositories.ts`; a change-history line each, no decision change.
- **ADR-EA-037**: if decision 7 names `AuditLogRepository`, name `AuditLogStoreSql.append`.
- **ADR-EA-014**: no change (it already says `SessionStore` plus a SQL adapter).

### 6.3 Overview and traceability

- `spec/overview.md` (next revision after plan 23's 1.10): Persistence row `:48` (Phase 0 wording, plus `CoreStoresSql`); the Ports rows `:145-149` already name the `*StoreSql` adapters.
- `spec/traceability.md` (next revision): delete the `Repositories.test.ts` row (`:222`) and the `Repositories.postgres.test.ts` references (`:167`, ADR-EA-024 row → `ReadRouting.postgres.test.ts`; `:218` prose); add rows for `CoreStoresSql.test.ts`, `SqliteWal.test.ts`, `ReadRouting.postgres.test.ts`, `CoreMigrations.postgres.test.ts`, `FaultySql.test.ts`, `StoreContract.libsql.test.ts`; the ADR-EA-041 row (`:179`) adds the libSQL runner and `CoreStoresSql.test.ts`; the §5 prose at `:190` ("over `@awthaq/sql`'s repositories") becomes "the SQL adapters, each owning its statements"; the BEH-EA-035/036 and BEH-EA-231 rows point at the reworded scenarios. `pnpm spec:verify:strict` (check 10 needs every named test file to exist).
- `features/traceability.md`: REQ-EA-090/091/093/094/095/821 descriptions.

### 6.4 Changesets (ADR-EA-034)

- Phase 1: `.changeset/core-stores-sql-bundle.md` (§4).
- Phases 2-6: `.changeset/sql-store-adapters-<store>.md` (§4).
- Phase 7: `.changeset/sql-repositories-removed.md`, `"@awthaq/sql": minor` (fixed group, pre-1.0):
  > `Repositories` is removed from `@awthaq/sql`: each core store adapter (`UserStoreSql`, `AccountStoreSql`, `SessionStoreSql`, `VerificationStoreSql`, `AuditLogStoreSql`) owns its statements, and `CoreStoresSql.layer({ encryptPii? })` is the bundle `Persistence.sql()` re-exports (ADR-EA-041 rev 1.3, BEH-EA-035).
  >
  > Migration: replace any `Repositories.*Live` wiring with `Persistence.sql()` (or `CoreStoresSql.layer()`); `UsersRepositoryEncryptedLive`/`SessionsRepositoryEncryptedLive` → `Persistence.sql({ encryptPii: true })` or `UserStoreSql.layerSealedPii`/`SessionStoreSql.layerSealedPii`; `Repositories.AccountsRepositoryConfig` → `CoreStoresSql.AccountsRepositoryConfig`. Repository methods that only tests called (`UsersRepository.insert`/`delete`, `AccountsRepository.insert`/`findById`/`listByUser`, `VerificationRepository.insert`/`findById`/`delete`) have no replacement; use the store ports.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| A moved statement changes by accident (a quoted identifier, a dialect branch) | Statements move verbatim; every primitive runs on Postgres in `StoreContract.sql.test.ts` under `test:pg` and on libSQL in the new runner; diff each phase's SQL text against the deleted section |
| Sealing regresses (a column written in plaintext, a lost re-seal) | `CoreSealing` is moved, not rewritten; `PiiEncryption.test.ts` and the moved token cases keep every assertion; `TestAuth.runSealedColumnTests` is plan 17's |
| Read replicas lose routing | The adapter calls `ReadRouting.makeRouter` in the same build as before; `ReadRouting.test.ts` (lagging replica) and `ReadRouting.postgres.test.ts` (real LSN) keep running |
| Tenancy stamping changes | `Tenant.resolve(Option.none())` equals the replaced `Tenant.stamp`/`TenantContext` forms for inputs with no explicit tenant; each port's "stamps the ambient tenant" contract case and `TenantScope.postgres.test.ts` guard it |
| Losing dialect coverage when `contract.ts` goes | §5.3 maps every case; the libSQL runner is added in Phase 0, before anything is deleted |
| `FaultySql` cannot wrap the sqlite driver cleanly | The fallback in §3.6; retry semantics stay proven in `SqlStore.test.ts` |
| Dashboards keyed on span names | Span names are unchanged (EOTS-008) |
| A large diff conflicts with plans touching the same adapters (17, 22) | Order 23 → 16 → 17 (§8); one store per phase keeps each PR reviewable |
| External code that composed `Repositories` | Pre-1.0; the `Migration:` line; plan 02 Q1 found no external consumer |

**Rollback.** No phase changes the schema. Phases 0-1 are additive. Each store phase reverts alone (its repository section and contract cases come back, `CoreStoresSql` provides the repository again). Phase 7 reverts the module deletion and the spec wording.

---

## 8. Interactions with other plans

- **Plan 23 (relay-cursor-store): runs first.** It removes `RelayCursorRepository` and `EventRelay`'s import of `@awthaq/sql`, adds `RelayCursorStoreSql` (the first adapter with no repository, the template for §3.2) and adds the cursor to `Persistence.sql()`. This plan then includes it in `CoreStoresSql` and covers `relayCursor` on libSQL.
- **Plan 17 (core-sealed-columns): runs after this plan.** 17 moves the six hand-sealed columns onto `SealedColumn` (new AAD convention, `sweepAll`). Doing 16 first means 17 edits one private module (`internal/CoreSealing.ts`) and the three adapters' `conceal`/`reveal` call sites, and rewrites `PiiEncryption.test.ts`/`AccountStoreSql.test.ts` once, over the ports; doing 17 first would have it rewrite `Repositories.ts` code and repository-level tests that this plan then moves and rewrites again. This plan changes no AAD, envelope, failure policy or knob (only the knob's export path, re-exported from `CoreStoresSql`; 17 may fold `AccountsRepositoryConfig` into `SealedColumnConfig`). If the user orders 17 first, this plan moves whatever 17 leaves and skips `CoreSealing`.
  - **Conflict to reconcile:** plan 17 (its §8 and Q8) recommends the opposite order, 17 first, because it deletes about 300 lines of hand sealing from `Repositories.ts` (`PiiCodec`, the compare-and-swaps, `AccountTokenUndecryptable`, `AccountsRepositoryConfig`, the degraded token reads) and changes the port shapes before this plan writes its contract cases. Both orders work; this plan supports either. With 17 first, this plan changes as follows: Phase 1 creates no `internal/CoreSealing.ts` and re-exports no `AccountsRepositoryConfig` (§10 Q1 is moot); Phases 4-6 move 17's `SealedColumn.codec` declarations instead of the codec helpers; the `PiiEncryption.test.ts` and token-read rewrites in §5.2 become "keep 17's cases, retarget them from the repositories to the ports"; the §5.3 rows that 17 already deleted are skipped. The orchestrator picks the order (§10 Q7).
- **Plan 22 (table-ddl-locality, amends ADR-EA-004):** both amend ADR-EA-004; whichever lands second takes the next revision. 22 concerns plugin tables; `CoreMigrations.ts` is untouched here. If 22 extends DDL locality to core tables, the self-contained adapters are the natural home.
- **Plan 24 (memory-records-over-sqlite):** if it ever covers core stores, `CoreStoresSql.layer()` over `:memory:` is what would replace `Persistence.memory`; this plan makes that bundle self-contained. No conflict.
- **Plan 15 (host-composition):** consumes `Persistence.sql()`, whose value and requirements are unchanged.
- **Plans 02, 05, 08 (done):** plan 02's interim decision is closed; plan 05's `SqlStore`/`StoreFailure`/`SealedColumn` substrate is reused unchanged; plan 08's `TestAuth` SQL mode already uses `Persistence.sql()`.
- **Plans 11-14, 18-21:** they use the services, not the adapters; no overlap.

---

## 9. Acceptance checklist

- [ ] `packages/sql/src/Repositories.ts` and `Repositories.ts-E` do not exist; `grep -rn "Repositories" packages/*/src packages/*/test features examples scripts docs README.md packages/*/README.md` finds nothing but history (changesets, `.planning`).
- [ ] Each `*StoreSql.ts` owns its statements; no adapter references another module's `models`; `grep -rn "repo\.models" packages/sql/src` is empty.
- [ ] Every SQL insert primitive stamps through `Tenant.resolve`; `grep -n "Tenant.stamp\|TenantContext" packages/sql/src/*StoreSql.ts` is empty.
- [ ] `CoreStoresSql.layer({ encryptPii? })` exists; `Persistence.sql` is it; `UserStoreSql`/`SessionStoreSql` export `layer` and `layerSealedPii`.
- [ ] `contract.ts` and the five repository/token-read test files are deleted; every case is accounted for per §5.3.
- [ ] `StoreContract` passes on `Ref`, SQLite `:memory:`, WAL, libSQL and Postgres.
- [ ] `PiiEncryption.test.ts`, `CoreStoresSql.test.ts`, `SqliteWal.test.ts`, the adapter tests and `ReadRouting.test.ts` pass; `ReadRouting.postgres.test.ts` and `CoreMigrations.postgres.test.ts` pass under `test:pg`.
- [ ] REQ-EA-090/091/093/094/095/821 pass over the ports; the BEH-EA-036 type gate targets `UserStore.listPage`.
- [ ] BEH-EA-033..036/325 (rev 1.6) and BEH-EA-231 (rev 1.8) are revised; ADR-EA-041 rev 1.3, ADR-EA-004 rev 1.3, ADR-EA-024 rev 1.2 and the ADR-EA-016/018 implemented lines are updated; overview and traceability are updated; `pnpm spec:verify:strict` passes.
- [ ] `packages/sql/README.md`, `package.json` description, `index.ts` header, root `README.md:283`/`:348`, `spec/overview.md:48` and the SQLite appendix describe the shipped composition; `pnpm check:readmes` passes.
- [ ] No `as`; no return-type annotation on a new Effect/Layer const.
- [ ] Changesets per §6.4; `pnpm check && pnpm test:pg` green.

---

## 10. Open questions only the user can answer

1. **The re-seal knob.** Keep `AccountsRepositoryConfig` (re-exported from `CoreStoresSql`) until plan 17, or fold it into `SealedColumn.SealedColumnConfig.resealOnRead` now? Default: keep it; plan 17 owns sealing configuration.
2. **Per-store SQL layers stay public?** Default: yes. ADR-EA-014 lets a deployment swap the session store (a KV adapter) and keep the other SQL stores, and the PII choice is per store.
3. **Where the bundle lives.** Default: `@awthaq/sql` `CoreStoresSql`, re-exported as `Persistence.sql` (the store-contract runners and `@awthaq/sql`'s own tests need it without `@awthaq/core`). The alternative is keeping it only in core and duplicating it in the test support.
4. **BEH-EA-231's explicit tenant.** The requirement promises an explicit tenant on every core insert, but only the audit log port carries one. Narrow the spec to the audit log (default; no caller wants more), or add an explicit `tenantId` to `NewUser`, `NewSession`, `NewToken` and the account and reservation primitives?
5. **Span names.** Keep the statement spans as named today (`Users.findByEmail`, default), or rename them after the port primitive (`UserStore.getByEmail`) now that the repository is gone? Renaming breaks any trace query keyed on them.
6. **A libSQL failure in Phase 0.** If `StoreContract.libsql` finds a primitive that misbehaves on libSQL, fix it in this plan (default), or record libSQL as "migrations only" in the README driver table?
7. **Order against plan 17.** Default: 23 → 16 → 17, for the reasons in §8. Choose 17 first only if the AAD unification is more urgent than the refactor.
