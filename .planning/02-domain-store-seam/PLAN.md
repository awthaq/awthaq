# Plan 02: One domain implementation over a store seam

> **Cross-plan reconciliation (orchestrator, after all plans were written):** see `.planning/README.md` § Cross-plan reconciliations. In short: 05 lands first and owns `StoreFailure` in `@awthaq/sql`; the tenant-stamp rule lives in `@awthaq/ports` as `Tenant.stamp` (02's placement), and 05's `TenantScoped` calls it; 02's `SqlStore.read/write` wraps 05's `StoreFailure` rather than classifying `SqlError` again.


| | |
|---|---|
| Strength | Strong |
| Dependency category | local-substitutable, plus ports and adapters |
| Wave | D (after 01, 03 and 05; before 08). Phase 0 has no dependencies and can ship in Wave A. |
| Fixes live bugs | SQL `revoke` race · SQL `reauthenticate` lost update · reuse event published more than once (both twins) · `auth.session.superseded.userId` drift · Postgres `Accounts.unlink` write skew (BEH-EA-045) · `Verification.reserve` boundary drift · non-atomic SQL verification miss · double `emailVerified` announcement in SQL |
| Touches | `@awthaq/ports` (new store ports and memory adapters), `@awthaq/sql` (SQL adapters), `@awthaq/core` (one domain implementation per module, `Persistence` bundles), `@awthaq/test` (store contract), README, examples, spec |

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality** (codebase-design glossary). Domain terms come from `spec/glossary.md`. Conventions are in `.planning/README.md` and apply in full: no `as` anywhere (that includes `as const`; see §3.9), no return-type annotations on new Effect/Layer consts, tests replaced rather than layered, a changeset with a `Migration:` section for every package-visible change, and the phase and plan gates.

All line numbers were checked on 2026-10-13 against `main` at `38bcd1b`. They will drift as Waves A to C land, so re-locate code by symbol and use the numbers only to find it.

---

## 1. Summary, goals, non-goals

### Summary

Each of the five core persistence-backed modules (`Sessions`, `Users`, `Accounts`, `Verification`, `AuditLog`) ships two complete implementations of one interface. `layerMemory` is built on a `Ref`. `layerSql` is built on `@awthaq/sql` repositories. Each implementation restates every domain rule: hashing, expiry, rotation and its grace window, supersede, reuse detection, eviction, events, hooks, error mapping and announcements. The two copies have drifted. §2 lists more than 40 behavioural differences, and at least 9 of them are live bugs.

This plan writes each module **once**, over a narrow **store port**. Every primitive on the port is atomic by contract. Each port has two small **adapters**: a `Ref` adapter in `@awthaq/ports`, and a SQL adapter in `@awthaq/sql` built over the existing repositories. Matched **bundles** (`Persistence.memory`, `Persistence.sql(options)`) supply every store plus the right `SqlTransaction`, so a composition can no longer mix a memory store with a SQL transaction by accident. Domain tests run once, on the `Ref` adapters. A public store contract (`@awthaq/test` `StoreContract`) runs on every adapter, including Postgres under `test:pg`, and is the bar any third-party adapter must clear, such as the KV `Sessions` backend that ADR-EA-014 allows.

### Goals

1. **One rule, one place.** Every domain rule lives in exactly one implementation. No comment of the form "see `layerMemory`" survives. There are 11 today: 7 in `Sessions.ts` and 2 each in `Users.ts` and `Verification.ts`. The review counted 18; the true count is 11.
2. **Atomic store primitives.** Every read-modify-write the domain relies on is a single primitive whose atomicity is part of its contract and proven by the contract suite on every adapter, concurrency included.
3. **Fix the drift and the live bugs.** For each difference, choose one canonical behaviour (§3.8), justify it against a BEH-EA, INV-EA or ADR-EA id, and test it once.
4. **The domain stops depending on persistence internals.** No `Model.Override`, `JSON.stringify(amr)`, `actingAsType` column, `repo.models` or `SqlError` appears in core domain code. `Sessions.ts`, `Users.ts`, `Accounts.ts`, `Verification.ts` and `AuditLog.ts` no longer import `@awthaq/sql`.
5. **Matched bundles.** The README quickstart drops from "six repositories plus five `layerSql` layers plus `SqlTransaction.layerSql`" to one `Persistence.sql()` call. TestAuth and examples use `Persistence.memory` and `Persistence.sql()`.
6. **ADR-EA-014 made real.** A KV `Sessions` backend means implementing `SessionStore`, which has nine primitives, and passing `StoreContract.sessions`. It no longer means writing a third 500-line copy of `Sessions`.

### Non-goals

- **No schema change.** Every fix in this plan is a query or code change. There is no new migration, which keeps rollback code-only (§7).
- **The public service interfaces stay the same.** `SessionsShape`, `UsersShape`, `AccountsShape`, `VerificationShape` and `AuditLogShape` keep their members and error channels. The one exception is the `list` options type, which moves from `@awthaq/sql` to `@awthaq/ports` with an identical shape. Behaviour changes are the canonical choices in §3.8.
- **No sharding and no app-level tenant filtering of reads.** Both stay as ADR-EA-018 has them; §10 asks Q4.
- **No migration of `effect/unstable/sql` to `effect/sql`.** `../effect` HEAD (4.0.1) has moved SQL out of `unstable`, but the repository pins `effect@4.0.0-rc.117`. Every API named here was verified against the installed rc.117 sources (`node_modules/.pnpm/effect@4.0.0-rc.117/node_modules/effect/src`): `Ref.modify` (Ref.ts:797), `Effect.tx` and `TxRef`, `SqlClient.withTransaction` and `SqlClient.transactionService` (unstable/sql/SqlClient.ts:57,64), `Layer` with `out RIn` (Layer.ts:54), `Schema.UnknownFromJsonString` (Schema.ts:9209) and `Schema.Json` (Schema.ts:16082).
- **No KV adapter.** This plan only makes one possible and testable.
- **No move of `RelayCursorStore`** (EventRelay) into `@awthaq/ports`. It already follows the port shape; aligning it is a follow-up, not a dependency.
- **No new domain bundle.** A "core domain services" bundle (Users, Accounts, Sessions and Verification plus AuthEvents over AuditLog) belongs to plan 08 (§8).

---

## 2. Verified current-state inventory

Abbreviations: **S** `packages/core/src/Sessions.ts` · **U** `packages/core/src/Users.ts` · **A** `packages/core/src/Accounts.ts` · **V** `packages/core/src/Verification.ts` · **L** `packages/core/src/AuditLog.ts` · **R** `packages/sql/src/Repositories.ts` · **M** `packages/sql/src/Models.ts`. "Mem" is `layerMemory` and "Sql" is `layerSql`.

### 2.0 Shape of the problem

| Module | Lines | Mem layer | Sql layer | Shared helpers already written once |
|---|---|---|---|---|
| Sessions | 1764 | S:711-1224 | S:1244-1764 (`toSessionView` S:1226) | `matchedSecret` 84, `unionAmr` 200, `parseAmr` 211, `refuseSelfActingAs` 295, `isLiveAt` 544, `newestActivityFirst` 557, `evictionOrder` 578, `publishIssued` 595, `traceIssue` 613, `traceVerify` 629 |
| Users | 1301 | U:550-894 | U:952-1258 (`toIdentity` 902, `toUserRecord` 918) | `normalize*` 411-416, conflict mappers 418-438, `statusFields` 455, `pickFields` 402, `attributesChangedAnnouncer` 539, `beforeUserDeleteVeto` 39 |
| Accounts | 730 | A:262-479 | A:554-730 (`toAccountRecord` 481, `tokenSetToRow` 498, `rowToProviderTokenSet` 530) | key builder 244 |
| Verification | 603 | V:263-453 | V:464-603 (`toTokenView` 455) | `isExpired` 210, `validBudget` 217, `mintValue` 232 |
| AuditLog | 576 | L:420-487 | L:493-576 | `actorOf` 163-276, `toStoredRow` 307, `decodeRow` 333, scrub 361-384, `newestFirst` 386, `matchesFilter` 393 |

**Where SQL leaks into the domain.**
- `repo.models.Session.insert.makeEffect`, `Model.Override(idleExpiresAt)` and `JSON.stringify(input.amr ?? [])` (S:1307-1324).
- Reads of the `actingAsType` and `actingAsId` columns (S:1236-1239, S:1503).
- `SessionId = SqlModels.SessionId` (S:49), `UserId = SqlModels.UserId` (U:56) and `AccountId = SqlModels.AccountId` (A:30).
- `SqlReadRouting.ReadOptions` in the public `SessionsShape.list` (S:490).
- `VerificationToken.insert.makeEffect` (V:475-508).

**Dependency direction.** `@awthaq/core` depends on `@awthaq/sql` (`packages/core/package.json:30`), and `@awthaq/sql` depends only on `@awthaq/ports`. `spec/overview.md` §Packages puts Ports at stratum 2, Persistence at 3 and Domain at 4, so core→sql is legal today. Six core files import `@awthaq/sql` beyond the five modules: EventRelay, Migrations, Phone, HttpApiTypes and the two registries, using types only.

**Composition hazard.** README:118-134 makes an application assemble six repositories and five `layerSql` layers by hand, then add `SqlTransaction.layerSql` separately (README:178-182). `AccountErasure` (`Erasure.ts:122-136`) wraps the core cascade in `SqlTransaction.withTransaction`. If any one of the five modules is swapped for `layerMemory`, that module's writes silently leave the transaction (U:799-805 for Users, for example).

### 2.1 Sessions

Interface `SessionsShape`, S:334-534, has 11 members.

| Op | Mem | Sql | Repository methods |
|---|---|---|---|
| `issue` | S:724-851 | S:1260-1384 | `tombstone` R:1645, `models…makeEffect`, `insert` R:1426, `listLiveIds` R:1621, `delete` |
| `verify` (with legacy bridge) | S:879-1053, bridge 864 | S:1407-1566, bridge 1392 | `findById` R:1443, `markReused` R:1661, `revokeFamily` R:1664, `touch` R:1551 |
| `revoke` | S:1081 (`removeOne` 1057) | S:1570-1593 | `findById` then `delete` |
| `revokeOwned` | S:1094 | S:1595-1609 | `deleteOwned` R:1624 |
| `revokeOthers` | S:1107 | S:1611 | `deleteAllForUserExcept` R:1566 |
| `revokeAll` | S:1122 | S:1625 | `deleteAllByUser` R:1581 |
| `purgeExpired` | S:1135 | S:1639 | `deleteExpiredBefore` R:1601 with `drainBatches` |
| `list` | S:1162 | S:1684 (`drainLive` 1659) | `listByUser` R:1490 (the only replica-routed read, R:1455) |
| `findOwned` | S:1173 | S:1693 | `findById` |
| `isLive` | S:1182 | S:1719 | via `findOwned` |
| `reauthenticate` | S:1185-1208 | S:1722-1748 | `findById` then `reauthenticate` R:1686 |

**Behavioural differences.** S-1 to S-4 are the drift the review reported, now confirmed. S-5 onward are new.

| # | Difference | Mem | Sql | Bug? |
|---|---|---|---|---|
| S-1 | `auth.session.superseded.userId` | the ancestor's `userId` (S:835) | `input.userId` (S:1363) | Drift. The values differ whenever `supersedes` names another user's session, and **both twins allow that** (S-5). |
| S-2 | `reauthenticate` amr union | one atomic `Ref.modify` (S:1188) | `findById` then compute the union then `UPDATE` (S:1728-1737). Concurrent step-ups lose one method. | **Live SQL bug** (THS-003: monotone). |
| S-3 | `revoke` | one atomic `Ref.modify` (S:1061) | `findById` then `delete`, no transaction (S:1571-1577). Two concurrent revokes both find the row, both delete, and both publish `auth.session.revoked`. | **Live SQL bug** (TIR-008: exactly one event). |
| S-4 | "reuse published once" (doc S:420-425) | `Ref.get` (S:898), then the check on a stale snapshot (S:931), then a separate `Ref.update` (S:933). Two fibers can both publish. | `markReused` is an unconditional `UPDATE` (R:1655-1659), and `revokeFamily` is a second statement outside any transaction (S:1462-1463). | **Live bug in both.** |
| S-5 | `supersedes` ownership | the ancestor is filtered on `supersededAt` only (S:769-771); another user's live session can be tombstoned | `tombstone` checks `supersededAt IS NULL` only (R:1640) | **Shared hardening gap** (INV-EA-018). The only caller (`Password.ts:1673`) passes the caller's own session, so it is latent. |
| S-6 | rotation loser path | re-reads and returns the current row as authenticated with no liveness re-check (S:1029-1036). A row tombstoned or expired concurrently is returned as valid. | same (S:1539-1547) | Shared latent bug (BEH-EA-052/053). |
| S-7 | rotation CAS guard | `secretHash` only (S:1010) | `secretHash` only (R:1545-1546). A tombstoned row can still be rotated. | Shared; harden. |
| S-8 | `list` bound | unbounded | stops at `LIST_LIMIT` = 1000 with a warning (S:1666-1680) | Drift (BEH-EA-054 "exhaustive, bounded"). |
| S-9 | `list` `consistency` option | ignored | replica-eligible when `"eventual"` (R:1498) | Expected; must be stated in the contract. |
| S-10 | memory pruning | `pruneExpiredAbove` drops expired rows once the map exceeds 10 000 (S:765, `internal/pruneExpired.ts:13`). `verify` then answers `SessionNotFound` instead of `SessionExpired` and skips `auth.session.expired`. | rows persist until `purgeExpired` | Drift above 10k rows only. |
| S-11 | retry | none | `retryTransient` only on `issue` (S:1355) and `touch` (S:1538). `revoke`, `reauthenticate`, `markReused` and the evictions are never retried. | Inconsistent (ADR-EA-028 §Transient retry). |
| S-12 | eviction under concurrency | exact (one `Ref.modify`) | transiently `limit + 1` on Postgres READ COMMITTED (documented, S:1328-1330) | Accepted; must be a contract clause. |
| S-13 | tenant isolation of reads | none | none in application code. Postgres RLS applies only inside `TenantScope.withTenant` (TenantScope.ts:117-131). | Same in application code; RLS is adapter-specific. |
| S-14 | tenant stamp | `Tenant.TenantContext` read in the domain (S:732) | `stampTenant` in the repository (R:86, 1429) | Equivalent today; the rule is written twice. |
| S-15 | error mapping | only the crypto `PlatformError` becomes `StoreUnavailable` (S:850, 1052). `revoke`, `list` and the rest cannot fail. | `SqlError` becomes `StoreUnavailable` at 11 sites; `SchemaError` dies | Expected (ADR-EA-028); the mapping is written per operation. |
| S-16 | SQL id/clock source | domain `crypto.randomUUIDv7`, one `now` | the same, but `createdAt`/`lastActiveAt`/`authenticatedAt` come from Model defaults (M:346-377) | Benign today: the values are equal under `TestClock` and differ by microseconds on a real clock. |
| S-17 | legacy bridge | `resolve`, then `issue`, then `consume`, not atomic (S:864-877). Two concurrent presentations of one legacy token mint two sessions. | same (S:1392-1405) | Shared gap. The bridge port has no claim primitive (`LegacySessionBridge.ts`). Out of scope; reported in §10 (Q9). |
| S-18 | `reauthenticate` on a dead session | succeeds on tombstoned or expired rows | same | Shared. **Plan 10 owns the fix.** §3.2 gives the primitive a `liveAt` guard so that fix is one argument. |
| S-19 | events inside a caller's transaction | n/a | `revokeAll` inside `Erasure` publishes before commit | **Plan 10 owns this.** A single implementation means the fix lands once. |

### 2.2 Users

Interface `UsersShape`, U:252-383, has 15 members. Mem is U:550-894 and Sql is U:952-1258. The repository is R:176-704: `UsersRepositoryLive` at R:706 and `UsersRepositoryEncryptedLive` at R:716.

| Op | Mem | Sql | Repository methods |
|---|---|---|---|
| `create` | U:582-622 | U:997-1031 | `insert` R:402 |
| `createOrGet` | U:624-630 | U:1056-1081 | `insertIfAbsent` R:465, then `findByEmail`/`findByPhone` |
| `findById` / `findByEmail` / `findByPhone` | U:562-578 | U:1033-1051 | R:416, 430, 447 |
| `updateProfile` | U:664-683 | U:1086-1093 | `updateProfile` R:540 |
| `verifyEmail` / `verifyPhone` | U:685-728 | U:1099-1130 | R:574, 592 |
| `promoteIdentity` | U:730-747 | U:1132-1152 | R:623 |
| `changeEmail` | U:749-777 | U:1154-1174 | R:651 |
| `setStatus` | U:779-790 | U:1176-1193 | R:678 |
| `delete` | U:799-805 | U:1195-1199 | SqlModel `delete` |
| `list` | U:844-874 | U:1201-1210 | `listPage` R:496 |
| `getFields` / `setFields` | U:807-842 | U:1212-1238 | `readFields` R:328, `writeFields` R:355 |

| # | Difference | Bug? |
|---|---|---|
| U-1 | **`updatedAt`.** Mem never changes it after `create`. Sql bumps it on `updateProfile`, both `verify*`, `promoteIdentity`, `changeEmail` and `setStatus`, but not on `setFields`. No test asserts it. | Drift |
| U-2 | **`verifyEmail` concurrency.** Sql reads, checks "already verified", then runs an unconditional `UPDATE` (R:563-579). Two concurrent calls both announce `["emailVerified"]` through `AfterUserAttributesChanged`. Mem announces once. | **Live SQL bug** (AAPS-005) |
| U-3 | **`changeEmail` announcement.** Sql decides whether to announce from the stale pre-read `emailVerified` (U:1172). Mem is exact. | Live SQL bug |
| U-4 | **`getFields`/`setFields` error precedence.** Mem returns `UserNotFound` before `UnknownUserField` and the other validation errors; Sql returns them in the opposite order. | Drift |
| U-5 | **`delete` on a vanished row.** Sql deletes 0 rows and reports success. Mem unindexes a stale snapshot (U:803-804): a concurrent `changeEmail` leaves a dangling `byEmail` entry, and a racing delete-then-create can remove another user's index entry. | Sql: wrong success. Mem: index corruption. |
| U-6 | **`setFields` orphans.** Mem writes fields for a user deleted mid-call, because users and fields are two separate `Ref`s. Sql writes and then re-reads non-atomically (it can return another writer's values, or fail `UserNotFound` after the announcement fired). | Both |
| U-7 | **`create` duplicate inside a Postgres transaction.** Sql's `UniqueViolation` aborts the enclosing transaction; `createOrGet` avoids this deliberately (U:1053-1055). Mem leaves the transaction usable. | Sql hazard |
| U-8 | **`createOrGet` can die.** If the holder is deleted between the two statements, Sql dies with the `CreateOrGetRowVanished` defect (U:1073-1078). `ON CONFLICT DO NOTHING` without a target also swallows a primary-key conflict. | Sql defect path |
| U-9 | **Id source.** Mem uses `Crypto.randomUUIDv7`, and its `PlatformError` becomes `StoreUnavailable`. Sql uses `Model.UuidV7Insert` (clock plus `Uuid.v7String`), which cannot fail. | Drift (ADR-EA-028 claims both) |
| U-10 | **`list` input.** Neither layer clamps `limit`. A non-integer dies in Sql (`Schema.Int`) and is accepted by Mem. A negative value makes Mem `slice(0, -n)` and gives Sql a negative `LIMIT`. | Shared gap |
| U-11 | **Directory RLS.** With `enableRls({ includeDirectory: true })` inside `withTenant`, Sql reads are tenant-narrowed. Mem's never are. | Adapter-specific (BEH-EA-232/233) |
| U-12 | **Lazy re-encryption.** An encrypted Sql read can write (R:384-396). Mem cannot. | Adapter-specific, accepted |
| U-13 | **Shared AAPS-005 deviations.** `updateProfile` and `setStatus` always announce, even with no change. `verifyPhone` and `promoteIdentity` never announce. | Shared, not drift (§10 Q6) |
| U-14 | **Double veto.** `Erasure` runs `BeforeUserDelete`, then `Users.delete` runs it again (U:802, 1197). | Shared; **plan 03 owns it** |
| U-15 | **Stale doc.** U:941-951 says a non-unique `SqlError` "is left to die". It is mapped to `StoreUnavailable` (U:1009-1013). | Doc |

### 2.3 Accounts

Interface `AccountsShape`, A:136-226, has 10 members. `AccountsPolicy` is read per operation through `Tenant.configInForce` (A:267, 563). The repository, R:729-1213, always requires `Encryption`. Token AAD is `providerId:userId:field` (R:880).

| Op | Mem | Sql | Repository methods |
|---|---|---|---|
| `link` | A:269-318 | A:565-593 | `insert` R:1016 |
| `findByProviderSubject` | A:320-333 | A:595-605 | R:1160-1169 |
| `listByUser` | A:335-340 | A:607-611 | R:1195-1204 |
| `findById` | A:388-399 | A:613-622 | R:1060 |
| `findCredentialHash` | A:401-408 | A:656-671 | `findById` (a full row with token decrypt) |
| `updateCredentialHash` | A:410-422 | A:676-685 | `updatePasswordHash` R:1085 |
| `findProviderTokens` | A:424-431 | A:687-700 | `findTokensById` R:1063 (strict) |
| `updateProviderTokens` | A:433-445 | A:705-715 | `findAad` R:1098, then `updateProviderTokens` R:1129 |
| `unlink` | A:342-386 | A:624-651 | `withTransaction(findById → listByUser → delete)` |
| `deleteAllByUser` | A:447-464 | A:653 | R:1177 |

| # | Difference | Bug? |
|---|---|---|
| A-1 | **`unlink` write skew on Postgres.** At READ COMMITTED, two concurrent unlinks of a user's two **different** accounts each count two siblings and both commit, leaving zero accounts. SQLite and libSQL are safe only because their drivers open `BEGIN IMMEDIATE` (sqlite-node `SqliteClient.ts:350`, libsql `transaction("write")`). The comment at A:548-553 claims race safety. | **Live Postgres bug** (BEH-EA-045) |
| A-2 | **`issuer: ""`.** Mem returns `Some("")`; Sql stores `''` and returns `None`. Both treat it as "no issuer" in the unique key. | Drift |
| A-3 | **`updatedAt`.** `updateCredentialHash` and `updateProviderTokens` bump it in Sql and not in Mem. | Drift |
| A-4 | **Token side effects on identity reads.** Sql identity reads (`findByProviderSubject`, `findById`, `listByUser`, and `unlink`'s sibling count) decrypt all three token columns and may write a lazy re-encryption, on the sign-in hot path. | Sql cost and side effect |
| A-5 | **`listByUser` order.** Sql has no `ORDER BY`; Mem uses `HashMap` order. | Shared gap |
| A-6 | **Tenant.** Mem's state has no tenant field. Sql stamps the directory row (BEH-EA-231 claims memory twins "stamp the same fields"). | Drift (spec claim false) |
| A-7 | **`ProviderTokensUnreadable`.** Only Sql can produce it (decryption). | Adapter-specific, accepted |
| A-8 | **Id and clock.** Mem uses `crypto.randomUUIDv7` and one `now`. Sql uses Model defaults (two clock reads). | Benign drift |
| A-9 | **BEH-EA-044** (a password `subject` equals the `userId`) is enforced by neither layer. | Shared (out of scope; noted) |

### 2.4 Verification

Interface `VerificationShape`, V:138-191, has 6 members. Mem is V:263-453: a token map and a reservation map, one `Ref` each. Sql is V:464-603. The repositories are at R:1736-1974 (tokens) and R:1983-2075 (reservations). Migration 5's partial unique index `verification_tokens_live_identifier ON (identifier) WHERE consumedAt IS NULL` is what makes `upsertLive` atomic (ADR-EA-016).

| Op | Mem | Sql | Repository methods |
|---|---|---|---|
| `issue` | V:275-317 | V:475-508 | `makeEffect`, then `upsertLive` R:1886 |
| `consume` | V:319-397 (one `Ref.modify`, constant-time compare, removes on hit) | V:510-551 | `tryConsume` R:1939, then `recordFailedAttempt` R:1957 |
| `recordMiss` | V:401-402 (publish only) | V:553-563 | `recordFailedAttempt`, then publish |
| `reserve` | V:404-424 | V:565-578 | `claim` R:2043 |
| `deleteAllByUser` | V:426-429 | V:580-583 | R:1892 |
| `purgeExpired` | V:431-449 (two `Ref.modify`s) | V:587-599 | R:1912, R:2064, `drainBatches` |

| # | Difference | Bug? |
|---|---|---|
| V-1 | **`reserve` boundary.** At `expiresAt == now`, Mem treats the reservation as expired (`now < expiresAt` is the live test, V:409) and returns **true**. Sql's `WHERE … "expiresAt" < now` (R:2038) treats it as live and returns **false**. With `ttl = 0`, Mem always grants and Sql always refuses. | **Live drift** (BEH-EA-061/063: expired iff `now >= expiresAt`, as `isExpired` V:210 says) |
| V-2 | **Miss atomicity.** Sql's `tryConsume` and `recordFailedAttempt` are two statements with no transaction; a reissue in between charges the **new** token. Mem spends the attempt in the same atomic step (V:345-362). | **Live Sql bug** (SOS-004, BEH-EA-062) |
| V-3 | **`deferMiss`.** Mem spends the attempt (and may burn the token) even with `deferMiss` and skips only the event. Sql spends nothing until `recordMiss`. | Drift (PV-220) |
| V-4 | **Consumed rows.** Mem deletes a row on a hit or a burn. Sql sets `consumedAt` and keeps the row (forensics, BEH-EA-061). BEH-EA-062's text ("the row MUST be gone afterward") matches Mem, not the shipped Sql. | Drift plus spec text |
| V-5 | **Rollback.** Inside a caller's `SqlTransaction`, Sql's consume is rolled back with the caller. Mem's removal is permanent, so the token burns when completion fails. | Mem-only (**plan 07 owns the protocol**; §3.6 adds the optional `TxRef` phase) |
| V-6 | **Payload.** Mem keeps it by reference, so a `DateTime`, `bigint`, `undefined` field or class instance survives. Sql round-trips it through JSON (M:420-456), changing or losing such values, or dying with `SchemaError`. | Drift |
| V-7 | **Tenant.** Mem's state has no tenant field. Sql stamps the ambient tenant only, ignores an explicit value, and re-stamps on reissue (R:1887). | Drift (BEH-EA-231) |
| V-8 | **Cross-tenant reissue under Postgres RLS.** `ON CONFLICT` targets a row the policy hides, so the reissue fails, which maps to `StoreUnavailable`. This is inferred from Postgres semantics, not run. | Adapter-specific; open (§10 Q4) |
| V-9 | **Reservations survive `deleteAllByUser`** in both layers, and they hold the normalized email address as identifier text. | Shared erasure gap (ADR-EA-031; reported to plan 03) |
| V-10 | **Clock.** Sql's `createdAt` comes from a second clock read (a Model default). | Benign drift |
| V-11 | **Memory pruning** above 10k entries. | Same class as S-10 |
| V-12 | **Stale ADR text.** ADR-EA-016 line 23 says `findByIdentifier` orders by `createdAt`; it is now live-only. | Doc |

### 2.5 AuditLog

Interface `AuditLogShape`, L:117-154, has 5 members. AuditLog is deliberately **not** built on `AuditChain` (L:36-38): the table must stay rewritable under GDPR Art. 17, so no hash-chain diff applies. The repository is at R:2098-2316 and the migration at CoreMigrations.ts:320-355 (`id` is the primary key; `payload` is TEXT).

| Op | Mem | Sql | Repository methods |
|---|---|---|---|
| `record` | L:425 (append) | L:498-507 | `insert` R:2283 |
| `list` | L:430-434 | L:509-520 | `list` R:2291 (eventual by default) |
| `replay` | L:436-457 | L:522-542 | `page` R:2297 (eventual) |
| `pseudonymizeActor` | L:459-472 (one `Ref.modify`) | L:544-560 | `listReferencing` R:2306, then N × `rewrite` R:2311 |
| `purge` | L:474-483 | L:562-572 | `deleteOccurredBefore` R:2277 with `drainBatches` |

| # | Difference | Bug? |
|---|---|---|
| L-1 | **`list` decodes before filtering.** Mem decodes every row before the filter, so one undecodable row anywhere fails every `list`. Sql decodes only matching rows. | Mem bug |
| L-2 | **Duplicate `eventId`.** Mem appends a second row. Sql hits the primary key, and the `UniqueViolation` is reported as `StoreUnavailable` (an outage), logged as an audit-write failure. | Drift; Sql misclassifies |
| L-3 | **Tenant on direct `record`.** Mem stores `published.tenantId`. Sql uses `input.tenantId ?? ambient` (R:2286), which falls back to the ambient tenant even when the caller passed an explicit `null`. Harmless today because `AuthEvents.publish` stamps first (AuthEvents.ts:212-224). | Latent drift |
| L-4 | **`purge({ eventTags: [] })`** renders `IN ()`. SQLite accepts it; **Postgres fails** with a syntax error, which maps to `StoreUnavailable`. Mem deletes nothing. `Retention` guards against this (Retention.ts:121-122); the public API does not. | Postgres bug |
| L-5 | **Invalid `replay` `batchSize`.** A negative value makes Mem drop the last row, gives SQLite unlimited rows, and is a Postgres error. Nothing validates it. | Shared gap |
| L-6 | **`pseudonymizeActor` atomicity.** Sql runs N+1 statements with no transaction of its own, so a standalone failure leaves rows half-rewritten. (It is idempotent, so a rerun converges.) | Sql |
| L-7 | **`pseudonymizeActor` under Postgres RLS.** Inside `withTenant`, only the current tenant's rows are rewritten. Mem rewrites every tenant. Erasure is therefore incomplete across tenants on Postgres. | Adapter-specific (§10 Q7) |
| L-8 | **`replay` order.** Sql's `ORDER BY id` uses the column collation, which on a non-"C" Postgres database is locale-dependent. Mem uses UTF-16 order. | Latent |
| L-9 | **`captureToken` is never called** by any domain service, only by tests (ReadRouting.test.ts:169, Repositories.postgres.test.ts:279). Eventual reads of `AuditLog.list` and `Sessions.list` have no read-your-writes guard in production. | Shared gap (ADR-EA-024 §3) |
| L-10 | **Actor match.** Mem matches a substring of `actorUserId` and of the payload object. Sql matches `actorUserId` by equality and the payload JSON text with `LIKE`. Equivalent for UUIDs. | Benign; state it in the contract |

### 2.6 Tests today (per backend)

| File | Shape | Disposition (§5) |
|---|---|---|
| `packages/core/test/Sessions.test.ts` (1778 lines) | `suite`/`eventsSuite`/`reuseSuite`/`capSuite`/`graceSuite`, each run twice (787-788, 1307-1314, 1525-1526); SQL-only blocks at 1559-1700 (MA-004, SEA-002), 1726 (atomic supersede), 1758 (list past one page) | domain suites run once on Ref; SQL-only blocks move to the adapter and contract suites |
| `Users.test.ts` (678) | `suite` × 2 (579-580, SQL leg via `TestSql`); GC-004 race 587-646; MA-004 648-678 | same |
| `Accounts.test.ts` (604) | × 2 (536-537); SMS-002 541; MA-004 575 | same |
| `Verification.test.ts` (662) | × 2 (487-488); memory pruning 490; MA-004 511-569; PV-220 587-648 | same |
| `AuditLog.test.ts` (838) | × 2 (692-693); SQL decode 695; down store 777-778 | same |
| `HooksWiringMemory.test.ts` / `HooksWiringSql.test.ts` | the same BEH-EA-095 delete-veto scenario | merged into `Users.test.ts`, or deleted by plan 03 |
| `UserAttributesHookMemory.test.ts` / `…Sql.test.ts` | the same AAPS-005 scenario, line for line | merged into `Users.test.ts` |
| `UserFields.test.ts` | suite × 2 (338-339) plus SQL generated columns (344) | domain once; generated-column cases stay SQL-adapter cases |
| `Retention.test.ts`, `AccountErasure.test.ts` | memory vs SQLite composition suites | kept as **composition** tests over `Persistence.memory` and `Persistence.sql()` |
| `packages/sql/test/contract.ts` (1450) | repository-level dialect cases, run by `Repositories{,.file,.libsql,.postgres}.test.ts` | cases whose subject becomes a store primitive move to `StoreContract`; codec, encryption, index and migration cases stay |

---

## 3. Target design

### 3.1 Placement: where the ports, adapters and bundles live

```
stratum 1  @awthaq/api      StoreUnavailable (unchanged)
stratum 2  @awthaq/ports    Ids, Store, SessionStore, UserStore, AccountStore, VerificationStore,
                            AuditLogStore: interfaces, records, pure contract helpers and the Ref adapters
                            (`layerMemory`), next to SqlTransaction and RateLimiter's store
stratum 3  @awthaq/sql      SessionStoreSql, UserStoreSql, AccountStoreSql, VerificationStoreSql,
                            AuditLogStoreSql: SQL adapters over the existing repositories; SqlStore helpers
stratum 4  @awthaq/core     Sessions, Users, Accounts, Verification, AuditLog: ONE implementation each
                            (`layer`), requiring only its port; Persistence.memory / Persistence.sql(options)
tools      @awthaq/test     StoreContract: public adapter contract (cases as data)
```

**Decision: put the ports in `@awthaq/ports` (stratum 2), not in core and not in sql.** Three options were weighed:

| Option | Dependency graph | Verdict |
|---|---|---|
| (a) Ports in core, SQL adapters in sql | sql→core while core→sql, a **package cycle**. Breaking it means removing every core→sql import first (EventRelay, Migrations, Phone, registries, the bundle). `tsc -b` refuses circular project references, and `pnpm circular` (madge over `packages/*/src`) flags the file cycle. | Rejected |
| (b) Ports and both adapters in `@awthaq/sql` (the overview row for stratum 3 still says "memory twins") | no cycle, but a KV backend would have to depend on a package named `sql` to implement `SessionStore` | Rejected: ADR-EA-014's "Sessions is a port" would stay nominal |
| (c) **Ports in `@awthaq/ports`, the memory adapter beside each port, SQL adapters in `@awthaq/sql`** | ports→api (2→1, new and legal), sql→ports (existing), core→ports and core→sql (existing). No cycle. | **Chosen.** This is the exact precedent of `RateLimiter.RateLimiterStore` (port and `layerStoreMemory` in ports; `RateLimiterStoreSql` in sql). A KV package depends on `@awthaq/ports` only. |

Consequences of (c):
- `@awthaq/ports` gains a dependency on `@awthaq/api`, which brings in `StoreUnavailable`. `@awthaq/api` depends only on `effect`, so no cycle can form. Update `packages/ports/package.json`, `packages/ports/tsconfig.json` references and `pnpm workspace:sync`.
- **The id brands move down to `@awthaq/ports` `Ids.ts`**: `UserId`, `AccountId`, `SessionId`, `VerificationTokenId` and `E164`, all as `Schema` brands exactly as in M:28-43. `@awthaq/sql` `Models.ts` re-exports them (`export const UserId = Ids.UserId; export type UserId = Ids.UserId`), so MA-008 (one brand per id) still holds and every plugin's `SqlModels.UserId` keeps compiling. Core's `Brand.nominal` constructors (S:50, U:57, A:31) keep their names and switch their type source to `Ids`.
- **`Consistency` and `ReadOptions` move to ports `Store.ts`**, with `@awthaq/sql` `ReadRouting.ts` re-exporting them. `SessionsShape.list` then takes the ports type, which has an identical shape.
- **The tenant-stamp rule moves to ports `Tenant.ts`** as `Tenant.stamp(explicit)`, so memory adapters, SQL adapters and plan 05's plugin substrate share one rule (§8):
  ```ts
  /** BEH-EA-231: an explicit non-null tenant wins, else the ambient TenantContext, else none. */
  export const stamp = (explicit: Option.Option<string>) =>
    Effect.gen(function* () {
      return Option.isSome(explicit) ? explicit : yield* TenantContext
    })
  ```
  `stampTenant` (R:86) becomes a thin row wrapper over it. In rc.117 a `Context.Reference` is yielded directly (`yield* Tenant.TenantContext`, as `ImpersonationRecords.ts:350` does) and has no `.asEffect()`.
- After this plan, core's dependency on `@awthaq/sql` remains only in `Persistence.ts`, `EventRelay.ts`, `Migrations.ts`, `Phone.ts` (which moves to `Ids.E164` in Phase 1) and the registries' `UserId` type (also moves). Removing the package edge entirely is a follow-up, not a goal.

### 3.2 `SessionStore` (`packages/ports/src/SessionStore.ts`)

```ts
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import type { SessionId, UserId } from "./Ids.ts"
import { pruneExpiredAbove } from "./internal/pruneExpired.ts"
import * as Tenant from "./Tenant.ts"
import type { Consistency, StoreUnavailable } from "./Store.ts"

export interface ActingAs { readonly type: string; readonly id: string }

/** The persisted image of a session. Opaque strings for `amr`: the domain narrows with `isAuthMethod`. */
export interface SessionRecord {
  readonly id: SessionId
  readonly userId: UserId
  readonly secretHash: string
  readonly createdAt: DateTime.Utc
  readonly authenticatedAt: DateTime.Utc
  readonly lastActiveAt: DateTime.Utc
  readonly absoluteExpiresAt: DateTime.Utc
  readonly idleExpiresAt: DateTime.Utc
  readonly ipAddress: Option.Option<string>
  readonly userAgent: Option.Option<string>
  readonly actingAs: Option.Option<ActingAs>
  readonly amr: ReadonlyArray<string>
  readonly tenantId: Option.Option<string>
  readonly previousSecretHash: Option.Option<string>
  readonly previousSecretExpiresAt: Option.Option<DateTime.Utc>
  readonly familyId: SessionId
  readonly supersededBy: Option.Option<SessionId>
  readonly supersededAt: Option.Option<DateTime.Utc>
  readonly reusedAt: Option.Option<DateTime.Utc>
}

/** What `insert` writes. The store adds tenantId (Tenant.stamp), familyId and the tombstone fields. */
export interface NewSession {
  readonly id: SessionId
  readonly userId: UserId
  readonly secretHash: string
  readonly at: DateTime.Utc // createdAt = authenticatedAt = lastActiveAt
  readonly absoluteExpiresAt: DateTime.Utc
  readonly idleExpiresAt: DateTime.Utc
  readonly ipAddress: Option.Option<string>
  readonly userAgent: Option.Option<string> // already capped by the domain (CSD-003)
  readonly actingAs: Option.Option<ActingAs>
  readonly amr: ReadonlyArray<string>
}

export type RotateOutcome =
  | { readonly _tag: "Rotated"; readonly session: SessionRecord }
  | { readonly _tag: "Lost"; readonly current: Option.Option<SessionRecord> }

export interface SessionStoreShape {
  /**
   * ATOMIC (one Ref.modify / one transaction):
   *  1. if `supersedes` is Some AND that row is live-by-tombstone (supersededAt None) AND its userId
   *     equals session.userId: tombstone it (supersededBy = session.id, supersededAt = session.at);
   *  2. insert `session`, familyId = the tombstoned row's familyId, else session.id;
   *  3. if `maxLive` is Some AND session.actingAs is None: delete the least-recently-active surplus of the
   *     user's OTHER live (isLive at session.at), non-acting-as sessions so that live count <= maxLive
   *     (order: lastActiveAt asc, then id asc; `evictionOrder` below is the reference).
   * Concurrency: two inserts naming the same `supersedes` tombstone it at most once (the loser founds a
   * fresh family). On Postgres READ COMMITTED two racing inserts may leave maxLive + 1 transiently; the
   * next insert evicts back. A Ref adapter is exact.
   */
  readonly insert: (input: {
    readonly session: NewSession
    readonly supersedes: Option.Option<SessionId>
    readonly maxLive: Option.Option<number>
  }) => Effect.Effect<
    {
      readonly inserted: SessionRecord
      readonly superseded: Option.Option<SessionRecord>
      readonly evicted: ReadonlyArray<SessionRecord>
    },
    StoreUnavailable
  >

  /** Point read, ALWAYS authoritative (ADR-EA-014, ADR-EA-024 §2). None for an absent row. */
  readonly get: (id: SessionId) => Effect.Effect<Option.Option<SessionRecord>, StoreUnavailable>

  /**
   * CAS: applies iff the row exists, secretHash === expectedSecretHash AND supersededAt is None.
   * `Lost` carries the row as it is now (authoritative), so the caller re-applies liveness.
   */
  readonly rotate: (input: {
    readonly id: SessionId
    readonly expectedSecretHash: string
    readonly secretHash: string
    readonly previous: Option.Option<{ readonly hash: string; readonly expiresAt: DateTime.Utc }>
    readonly lastActiveAt: DateTime.Utc
    readonly idleExpiresAt: DateTime.Utc
  }) => Effect.Effect<RotateOutcome, StoreUnavailable>

  /**
   * ONCE-ONLY + ATOMIC: iff the row is tombstoned AND reusedAt is None: set reusedAt = at AND delete
   * every non-tombstoned row sharing its familyId, in the same unit; returns Some exactly once per row
   * across all concurrent callers, None otherwise.
   */
  readonly flagReuse: (
    id: SessionId,
    at: DateTime.Utc,
  ) => Effect.Effect<
    Option.Option<{ readonly familyId: SessionId; readonly userId: UserId }>,
    StoreUnavailable
  >

  /** ATOMIC single delete, ownership-checked when `owner` is Some. The deleted row, or None (absent or foreign, indistinguishable). */
  readonly remove: (
    id: SessionId,
    owner: Option.Option<UserId>,
  ) => Effect.Effect<Option.Option<SessionRecord>, StoreUnavailable>

  /** Deletes every row of `userId` (tombstones included) except `keep`. Returns the count. */
  readonly removeForUser: (
    userId: UserId,
    keep: Option.Option<SessionId>,
  ) => Effect.Effect<number, StoreUnavailable>

  /**
   * Exactly the rows `isLive(row, now)` accepts, at most `limit`, `truncated` when more exist.
   * `consistency: "eventual"` MAY read a replica (SQL adapter) and MUST be ignored by any adapter with no
   * replica concept; every other primitive is authoritative, with no override (ADR-EA-024 §2).
   */
  readonly listLive: (input: {
    readonly userId: UserId
    readonly now: DateTime.Utc
    readonly limit: number
    readonly consistency: Consistency
  }) => Effect.Effect<
    { readonly items: ReadonlyArray<SessionRecord>; readonly truncated: boolean },
    StoreUnavailable
  >

  /**
   * ATOMIC: authenticatedAt = at; amr = unionMethods(stored, addAmr). Applies iff the row exists AND,
   * when `liveAt` is Some, isLive(row, liveAt) (plan 10 passes Some; this plan passes None, today's behaviour).
   */
  readonly reauthenticate: (input: {
    readonly id: SessionId
    readonly at: DateTime.Utc
    readonly addAmr: ReadonlyArray<string>
    readonly liveAt: Option.Option<DateTime.Utc>
  }) => Effect.Effect<Option.Option<SessionRecord>, StoreUnavailable>

  /** CSG-003: deletes every row (tombstones included) whose absolute OR idle expiry < before. Adapters may batch. */
  readonly purgeExpired: (before: DateTime.Utc) => Effect.Effect<number, StoreUnavailable>
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreShape>()(
  "awthaq/ports/SessionStore",
) {}

// Pure contract helpers, exported so every adapter and the domain share ONE definition (SMS-002/ESS-005):
export const isLive = (row: SessionRecord, now: DateTime.Utc) => /* body of S:544-554 */
export const evictionOrder = (limit: number, existing: ReadonlyArray<{ readonly id: string; readonly lastActiveAt: DateTime.Utc }>) => /* S:578-592 */
export const unionMethods = <A extends string>(existing: ReadonlyArray<A>, additions: ReadonlyArray<A>) => /* S:200-208 */

/** Ref adapter. One Ref<HashMap<SessionId, SessionRecord>>; every primitive is exactly one Ref.modify. */
export const layerMemory = Layer.effect(SessionStore, Effect.gen(function* () { /* §3.2.1 */ }))
```

Notes:
- `isLive` replaces `isLiveAt` (S:544). Core's `Sessions.unionAmr` stays a public export: `export const unionAmr = SessionStore.unionMethods<AuthMethod>`, with the generic instantiation inferred.
- `maxLive` is a number, not a policy object. `ConcurrentSessionPolicy.onExceed` has only `"evictOldest"`, so the store contract fixes LRU. A new policy would be a new contract clause, not a callback.
- **`get` and `remove` deliberately return the full row.** The domain needs `userId` for the event payload (S-3), and the rotation loser path needs the current row (S-6).

#### 3.2.1 Ref adapter sketch (no `as`, no annotations)

```ts
export const layerMemory = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const state = yield* Ref.make(HashMap.empty<SessionId, SessionRecord>())

    const insert = Effect.fnUntraced(function* (input: Parameters<SessionStoreShape["insert"]>[0]) {
      const tenantId = yield* Tenant.stamp(Option.none())
      return yield* Ref.modify(state, (s) => {
        const pruned = pruneExpiredAbove(s, input.session.at, (r) => r.absoluteExpiresAt)
        const ancestor = Option.flatMap(input.supersedes, (id) =>
          Option.filter(HashMap.get(pruned, id), (r) => Option.isNone(r.supersededAt) && r.userId === input.session.userId))
        const inserted = { ...fromNew(input.session, tenantId),
          familyId: Option.match(ancestor, { onNone: () => input.session.id, onSome: (r) => r.familyId }) }
        // tombstone, evict and insert exactly as S:796-824, using evictionOrder and isLive
        …
        return [{ inserted, superseded: ancestor, evicted }, next] // contextual typing makes this a tuple
      })
    })
    // get/rotate/flagReuse/remove/removeForUser/listLive/reauthenticate/purgeExpired: one Ref.modify each.
    return SessionStore.of({ insert, get, rotate, flagReuse, remove, removeForUser, listLive, reauthenticate, purgeExpired })
  }),
)
```

`flagReuse` in memory is the S-4 fix by construction. The check (`supersededAt` is Some and `reusedAt` is None), the mark and the family delete run in one `Ref.modify`, which returns `Option.some({ familyId, userId })` only on the call that marked the row.

#### 3.2.2 SQL adapter (`packages/sql/src/SessionStoreSql.ts`)

The adapter is built over `SessionsRepository`, so `SessionsRepositoryEncryptedLive` still swaps in (CSG-006). It requires `SessionsRepository | SqlClient.SqlClient`.

| Primitive | SQL | Statements |
|---|---|---|
| `insert` | `sql.withTransaction`, used only when `supersedes` or `maxLive` is Some (today's S:1352 optimisation): `UPDATE sessions SET "supersededBy"=?, "supersededAt"=? WHERE id=? AND "supersededAt" IS NULL AND "userId"=? RETURNING *` (repository `tombstone` gains `userId`), then insert (`repo.insert`, which owns `Model.Override`, the `actingAs*` columns and `JSON.stringify(amr)`), then `listLiveIds` and `delete` per evicted id | 1 to 3+k |
| `get` | `repo.findById`, with `NoSuchElementError` mapped to `None` | 1 |
| `rotate` | the existing `touch` CAS with `AND "supersededAt" IS NULL` added; on `None`, a `findById` for `Lost.current` | 1 (2 when lost) |
| `flagReuse` | `withTransaction`: `UPDATE sessions SET "reusedAt"=? WHERE id=? AND "supersededAt" IS NOT NULL AND "reusedAt" IS NULL RETURNING "familyId", "userId"`; then, if a row came back, `DELETE FROM sessions WHERE "familyId"=? AND "supersededAt" IS NULL` | 1 to 2 |
| `remove` | `DELETE FROM sessions WHERE id=? [AND "userId"=?] RETURNING *` (SQLite 3.35+ and Postgres both support `RETURNING`; `deleteOwned` R:1625 and `deleteExpiredQuery` R:1590 already use it), then `revealSession` | 1 |
| `removeForUser` | `DELETE … WHERE "userId"=? [AND id != ?] RETURNING id`, counted | 1 |
| `listLive` | `listByUser` pages drained up to `limit + 1`; `truncated = rows > limit`; routed by `consistency` (R:1455) | ⌈limit/200⌉ |
| `reauthenticate` | a **lock-free CAS loop**: `get` the row, compute `unionMethods`, then `UPDATE … SET "authenticatedAt"=?, amr=? WHERE id=? AND amr=? [AND live predicate] RETURNING *`; on 0 rows re-read and retry, up to 5 times, else `StoreUnavailable` (contention). Dialect-neutral: there is no JSON function and no `FOR UPDATE`. | 2 (more under contention) |
| `purgeExpired` | `drainBatches` over `deleteExpiredBefore` (moves from core `internal/purgeBatches.ts` to `@awthaq/sql` `internal/`) | ⌈n/1000⌉ |

Every primitive runs through one adapter helper (§3.7 `SqlStore.write`/`read`), which:
1. maps `SqlError` to `StoreUnavailable({ operation: "SessionStore.<primitive>" })`, logging the cause once (ADR-EA-028 §1). `SchemaError` and `NoSuchElementError` die unless the primitive maps them to `None`.
2. applies `retryTransient()` to write primitives **only when no caller transaction is open**, detected with `Effect.serviceOption(sql.transactionService)` (rc.117 `SqlClient.ts:64`; `None` means top-level). Inside a caller's transaction the retry belongs to the caller: a Postgres deadlock aborts the whole transaction, so retrying a savepoint would be wrong. This widens S-11 to every write primitive, consistently.
3. wraps the write primitives that change what `listLive` returns (`insert`, `remove`, `removeForUser`, `flagReuse`) in `ReadRouting.captureToken`, which is a no-op without a replica. This wires L-9 for the device-list-after-revoke case that ADR-EA-024's alternatives name.

A multi-statement primitive opens its own `sql.withTransaction`, which becomes a savepoint when a caller's transaction is open. That is the OHS-002 bounded exception in BEH-EA-035, extended from "a plugin records service" to "a store adapter primitive" (spec update in §6).

### 3.3 `UserStore` (`packages/ports/src/UserStore.ts`)

```ts
/** Flat persisted image; the domain maps (email, phone) to the UserIdentity union (U:902's rule, written once). */
export interface StoredUser {
  readonly id: UserId
  readonly email: Option.Option<string> // always lowercased by the domain
  readonly emailVerified: boolean
  readonly phone: Option.Option<E164>
  readonly phoneVerified: boolean
  readonly name: string
  readonly image: Option.Option<string>
  readonly metadata: Option.Option<string> // sealed by the SQL adapter when encryption is on
  readonly status: "active" | "suspended"
  readonly statusReason: Option.Option<string>
  readonly suspendedUntil: Option.Option<DateTime.Utc>
  readonly tenantId: Option.Option<string> // stamped by the adapter (Tenant.stamp)
  readonly createdAt: DateTime.Utc
  readonly updatedAt: DateTime.Utc
}

/** Moved from R:168-174 (ADR-EA-035). */
export interface UserFieldColumn { readonly name: string; readonly kind: "text" | "real" | "boolean" }
export type UserFieldScalar = string | number | boolean
export type FieldValues = ReadonlyMap<string, UserFieldScalar>

export type Keep<A> = { readonly _tag: "Keep" } | { readonly _tag: "Set"; readonly value: A } | { readonly _tag: "Clear" }

/** The identity columns a CAS compares and writes. */
export interface IdentityColumns {
  readonly email: Option.Option<string>
  readonly emailVerified: boolean
  readonly phone: Option.Option<E164>
  readonly phoneVerified: boolean
}

export interface UserStoreShape {
  /**
   * ATOMIC per identity key (lowercased email; E.164 phone). Anonymous (both None) is never Held.
   * MUST NOT abort an enclosing transaction (SQL: INSERT … ON CONFLICT DO NOTHING RETURNING *, then the
   * holder SELECT; a vanished holder retries the insert up to 3 times, never a defect).
   */
  readonly insertOrHolder: (row: StoredUser) => Effect.Effect<
    { readonly _tag: "Inserted"; readonly user: StoredUser } | { readonly _tag: "Held"; readonly holder: StoredUser },
    StoreUnavailable
  >
  readonly get: (id: UserId) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>
  readonly getByEmail: (lowercased: string) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>
  readonly getByPhone: (phone: E164) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>
  /** One statement; bumps updatedAt = at. None when absent. */
  readonly updateProfile: (input: {
    readonly id: UserId; readonly name: string
    readonly image: Keep<string>; readonly metadata: Keep<string>; readonly at: DateTime.Utc
  }) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>
  /**
   * CAS on the four identity columns. Updated when they still equal `expected`; Stale(current) when they
   * moved; Taken when `next` collides with another user's key (the SQL adapter wraps the UPDATE in its own
   * savepoint, so a Postgres unique violation does not abort the caller's transaction); Missing when absent.
   */
  readonly casIdentity: (input: {
    readonly id: UserId; readonly expected: IdentityColumns; readonly next: IdentityColumns; readonly at: DateTime.Utc
  }) => Effect.Effect<
    | { readonly _tag: "Updated"; readonly user: StoredUser }
    | { readonly _tag: "Stale"; readonly current: StoredUser }
    | { readonly _tag: "Taken" }
    | { readonly _tag: "Missing" },
    StoreUnavailable
  >
  readonly setStatus: (input: {
    readonly id: UserId; readonly status: "active" | "suspended"
    readonly reason: Option.Option<string>; readonly until: Option.Option<DateTime.Utc>; readonly at: DateTime.Utc
  }) => Effect.Effect<Option.Option<StoredUser>, StoreUnavailable>
  /** ATOMIC: removes the row AND its field values in one step. true iff a row was removed. */
  readonly delete: (id: UserId) => Effect.Effect<boolean, StoreUnavailable>
  /** Ascending (createdAt, id), strict keyset after `cursor`, at most limit + 1 read; limit is validated by the domain. */
  readonly listPage: (input: {
    readonly after: Option.Option<{ readonly createdAt: DateTime.Utc; readonly id: string }>; readonly limit: number
  }) => Effect.Effect<{ readonly items: ReadonlyArray<StoredUser>; readonly next: Option.Option<{ readonly createdAt: DateTime.Utc; readonly id: string }> }, StoreUnavailable>
  /** None = user absent; an unset field is absent from the map; booleans normalized (SQLite 0/1). */
  readonly readFields: (id: UserId, columns: ReadonlyArray<UserFieldColumn>) => Effect.Effect<Option.Option<FieldValues>, StoreUnavailable>
  /** ATOMIC write + post-state of `returning` (SQL: one UPDATE … RETURNING); bumps updatedAt. None = absent, nothing written. */
  readonly writeFields: (input: {
    readonly id: UserId; readonly values: ReadonlyMap<string, UserFieldScalar | null>
    readonly returning: ReadonlyArray<UserFieldColumn>; readonly at: DateTime.Utc
  }) => Effect.Effect<Option.Option<FieldValues>, StoreUnavailable>
}
```

- **Ref adapter:** one `Ref<{ byId; byEmail; byPhone; fields }>`, so users and their fields share one atomic state. That fixes U-5 and U-6 by construction.
- **SQL adapter** (`UserStoreSql.ts`, over `UsersRepository`): `casIdentity` is `UPDATE users SET … WHERE id=? AND email IS NOT DISTINCT FROM ? AND "emailVerified"=? AND phone IS NOT DISTINCT FROM ? AND "phoneVerified"=? RETURNING *`. SQLite spells `IS NOT DISTINCT FROM` as `IS`, so use `sql.onDialectOrElse`. If no row comes back, `get` decides between `Stale` and `Missing`. A unique violation inside the adapter's own savepoint becomes `Taken`.
- **Domain:** `verifyEmail`, `verifyPhone`, `promoteIdentity` and `changeEmail` become "read, apply the rule, `casIdentity`, retry on `Stale`" (at most 3 times, then `StoreUnavailable("Users.<op>")`). The announcement fires only after `Updated` and is computed from `expected` versus `next`. That makes it exact once (fixes U-2 and U-3).

### 3.4 `AccountStore` (`packages/ports/src/AccountStore.ts`)

```ts
export interface AccountIdentity {
  readonly id: AccountId; readonly userId: UserId; readonly providerId: string; readonly subject: string
  readonly issuer: string // "" = none; the domain maps "" ⇄ Option.none() (fixes A-2)
  readonly tenantId: Option.Option<string>; readonly createdAt: DateTime.Utc; readonly updatedAt: DateTime.Utc
}
export interface ProviderTokens { /* the ProviderTokenSet fields, Redacted, plaintext at this seam */ }
export interface NewAccount extends Omit<AccountIdentity, "tenantId"> {
  readonly credentialHash: Option.Option<Redacted.Redacted<string>>
  readonly tokens: Option.Option<ProviderTokens>
}

export interface AccountStoreShape {
  /** ATOMIC on (providerId, subject, issuer). None = taken. Adapter encrypts tokens and stamps tenant. */
  readonly insertIfAbsent: (row: NewAccount) => Effect.Effect<Option.Option<AccountIdentity>, StoreUnavailable>
  /** Identity-only reads: NO token decryption, NO write on the read path (fixes A-4). */
  readonly getByKey: (providerId: string, subject: string, issuer: string) => Effect.Effect<Option.Option<AccountIdentity>, StoreUnavailable>
  readonly get: (id: AccountId) => Effect.Effect<Option.Option<AccountIdentity>, StoreUnavailable>
  /** Ordered (createdAt, id) (fixes A-5). */
  readonly listByUser: (userId: UserId) => Effect.Effect<ReadonlyArray<AccountIdentity>, StoreUnavailable>
  /** Outer None = no such account. */
  readonly readCredentialHash: (id: AccountId) => Effect.Effect<Option.Option<Option.Option<Redacted.Redacted<string>>>, StoreUnavailable>
  /** Strict path; Undecryptable only from adapters that encrypt (A-7). A lazy re-encrypt is allowed here. */
  readonly readProviderTokens: (id: AccountId) => Effect.Effect<
    Option.Option<{ readonly _tag: "Tokens"; readonly tokens: Option.Option<ProviderTokens> } | { readonly _tag: "Undecryptable" }>,
    StoreUnavailable
  >
  /** Both bump updatedAt = at (fixes A-3). false = absent. */
  readonly writeCredentialHash: (id: AccountId, hash: Redacted.Redacted<string>, at: DateTime.Utc) => Effect.Effect<boolean, StoreUnavailable>
  readonly writeProviderTokens: (id: AccountId, tokens: ProviderTokens, at: DateTime.Utc) => Effect.Effect<boolean, StoreUnavailable>
  /**
   * ATOMIC against concurrent sibling deletes (fixes A-1): LastAccount when the user would be left with
   * zero accounts and !allowZero.
   * SQL: withTransaction{ Postgres: SELECT id FROM accounts WHERE "userId"=? FOR UPDATE (via
   * onDialectOrElse); SQLite/libSQL: BEGIN IMMEDIATE already serializes; count; delete }.
   */
  readonly deleteUnlessLast: (id: AccountId, allowZero: boolean) => Effect.Effect<
    { readonly _tag: "Deleted" } | { readonly _tag: "NotFound" } | { readonly _tag: "LastAccount"; readonly userId: UserId },
    StoreUnavailable
  >
  readonly deleteByUser: (userId: UserId) => Effect.Effect<number, StoreUnavailable>
}
```

The SQL adapter needs a token-free identity query (`SELECT id, "userId", "providerId", subject, issuer, "tenantId", "createdAt", "updatedAt" FROM accounts …`), added to `AccountsRepository` as `findIdentity*`. The token columns are touched only by `readProviderTokens` and `writeProviderTokens`. On Postgres, the `FOR UPDATE` lock in `deleteUnlessLast` locks the user's existing account rows, which is enough for BEH-EA-045: a concurrent `link` can only add accounts, never take the count to zero.

### 3.5 `VerificationStore` (`packages/ports/src/VerificationStore.ts`)

```ts
export interface TokenRow {
  readonly id: VerificationTokenId; readonly identifier: string; readonly userId: Option.Option<UserId>
  readonly valueHash: string; readonly createdAt: DateTime.Utc; readonly expiresAt: DateTime.Utc
  readonly payloadJson: Option.Option<string> // domain encodes/decodes with Schema.UnknownFromJsonString (fixes V-6)
  readonly maxAttempts: Option.Option<number>; readonly attempts: number
  readonly consumedAt: Option.Option<DateTime.Utc>; readonly tenantId: Option.Option<string>
}

export interface VerificationStoreShape {
  /** ATOMIC: replaces the identifier's UNCONSUMED row; consumed history is kept (both adapters, fixes V-4). Adapter stamps tenant. */
  readonly upsertLive: (row: Omit<TokenRow, "consumedAt" | "attempts" | "tenantId">) => Effect.Effect<TokenRow, StoreUnavailable>
  /**
   * ONE atomic step (fixes V-2): Hit = the live, unexpired (expiresAt > now) row whose valueHash matches is
   * marked consumedAt = now. Miss with spendOnMiss: a live budgeted row spends one attempt and is burned
   * (consumedAt = now) when attempts reach maxAttempts. Miss without spendOnMiss: nothing written.
   * Comparison: the Ref adapter compares in constant time (ACS-002); SQL compares in the predicate (the
   * accepted exception documented at R:1783-1785).
   */
  readonly present: (input: {
    readonly identifier: string; readonly valueHash: string; readonly now: DateTime.Utc; readonly spendOnMiss: boolean
  }) => Effect.Effect<{ readonly _tag: "Hit"; readonly row: TokenRow } | { readonly _tag: "Miss" }, StoreUnavailable>
  /** recordMiss's half: the atomic spend/burn on the live, budgeted row of `identifier` (fixes V-3). */
  readonly spendAttempt: (identifier: string, now: DateTime.Utc) => Effect.Effect<void, StoreUnavailable>
  /** ATOMIC claim. Canonical (fixes V-1): an existing reservation is expired iff existing.expiresAt <= now. */
  readonly claim: (input: { readonly identifier: string; readonly expiresAt: DateTime.Utc; readonly now: DateTime.Utc }) => Effect.Effect<boolean, StoreUnavailable>
  readonly deleteByUser: (userId: UserId) => Effect.Effect<number, StoreUnavailable>
  readonly purgeExpired: (before: DateTime.Utc) => Effect.Effect<number, StoreUnavailable> // tokens + reservations
}
```

SQL `present`: the two existing statements (`tryConsume`, then `recordFailedAttempt` when `spendOnMiss`) inside the adapter's own `withTransaction`. A single `UPDATE … CASE … RETURNING` is possible but harder to keep dialect-neutral; take it only if `test:pg` shows contention. SQL `claim` changes R:2038 to `WHERE verification_reservations."expiresAt" <= ${now}`.

### 3.6 `AuditLogStore` (`packages/ports/src/AuditLogStore.ts`)

```ts
export interface AuditRow {
  readonly id: string; readonly eventTag: string; readonly actorUserId: Option.Option<string>
  readonly occurredAt: DateTime.Utc; readonly correlationId: Option.Option<string>
  readonly tenantId: Option.Option<string>
  readonly payloadJson: string // the domain owns encode/decode (one codec for both adapters)
}
export interface AuditFilter {
  readonly eventTags: Option.Option<ReadonlyArray<string>>; readonly actorUserId: Option.Option<string>
  readonly from: Option.Option<DateTime.Utc>; readonly to: Option.Option<DateTime.Utc> // inclusive
}

export interface AuditLogStoreShape {
  /** Idempotent on id (fixes L-2): false when the id already exists. SQL: INSERT … ON CONFLICT(id) DO NOTHING RETURNING id. */
  readonly append: (row: AuditRow) => Effect.Effect<boolean, StoreUnavailable>
  /** Newest-first (occurredAt desc, id desc); filters BEFORE the domain decodes (fixes L-1); replica-eligible. */
  readonly select: (filter: AuditFilter, consistency: Consistency) => Effect.Effect<ReadonlyArray<AuditRow>, StoreUnavailable>
  /** Ascending by id in BYTE order (Postgres: ORDER BY id COLLATE "C"; fixes L-8), strictly after `after`. */
  readonly pageAfter: (input: {
    readonly after: Option.Option<string>; readonly eventTag: Option.Option<string>; readonly limit: number
  }, consistency: Consistency) => Effect.Effect<ReadonlyArray<AuditRow>, StoreUnavailable>
  /**
   * ALL-OR-NOTHING (fixes L-6): every row whose actorUserId equals userId OR whose payloadJson contains
   * userId (L-10, stated) is passed to `rewrite` (pure, domain-owned scrub); a Some result replaces
   * (actorUserId, payloadJson). SQL: own withTransaction { SELECT … FOR UPDATE (Postgres) ; UPDATE each }.
   */
  readonly rewriteReferencing: (
    userId: string,
    rewrite: (row: AuditRow) => Option.Option<{ readonly actorUserId: Option.Option<string>; readonly payloadJson: string }>,
  ) => Effect.Effect<number, StoreUnavailable>
  /** eventTags is non-empty by type (fixes L-4; `import type * as Array from "effect/Array"`). Adapters may batch; returns the total. */
  readonly deleteBefore: (input: {
    readonly cutoff: DateTime.Utc
    readonly eventTags: Option.Option<Array.NonEmptyReadonlyArray<string>>
    readonly exceptTags: ReadonlyArray<string>
  }) => Effect.Effect<number, StoreUnavailable>
}
```

`append` is **not** wrapped in `captureToken`: it runs on every event, and the extra `pg_current_wal_insert_lsn()` call per event is too costly when a replica is configured. `AuditLog.list` stays eventual and stale-tolerant by classification, as ADR-EA-024 already says. This is a recorded decision (§7, risk R3).

Passing a pure function into `rewriteReferencing` is the only higher-order primitive in the design. It is allowed because the function is pure and total, which `Ref.modify` and a SQL loop inside a transaction can both execute atomically. The scrub logic (`replaceDeep`, `blankFields`, the alias) stays domain-owned and is written once.

### 3.7 Shared adapter substrate

| Helper | Home | Used by |
|---|---|---|
| `StoreUnavailable` (a re-export of `Api.StoreUnavailable`), `Consistency`, `ReadOptions` | `@awthaq/ports` `Store.ts` | every port signature; core `Errors.StoreUnavailable` stays an alias |
| `Tenant.stamp(explicit)` | `@awthaq/ports` `Tenant.ts` | both adapter families and plan 05 |
| `pruneExpired`, `pruneExpiredAbove` | `@awthaq/ports` `internal/pruneExpired.ts` (moved from core) | Ref adapters |
| `SqlStore.write(operation)`, `SqlStore.read(operation)`: `SqlError` to `StoreUnavailable` (cause logged once), `SchemaError` dies, `retryTransient` only at top level, `captureToken` opt-in | `@awthaq/sql` `SqlStore.ts` (**reuse plan 05's module if it exists under another name**) | SQL adapters and plan 05's plugin substrate |
| `retryTransient` | moves to `@awthaq/sql` `SqlStore.ts`; core `Errors.retryTransient` stays a re-export (used by `packages/oauth/src/ProviderHttp.ts`) | |
| `drainBatches` | `@awthaq/sql` `internal/purgeBatches.ts` (moved from core) | SQL `purgeExpired`/`deleteBefore` |
| `storeUnavailable(operation)` for crypto `PlatformError` | stays in core `Errors.ts` | domain only |

**Operation labels.** `StoreUnavailable.operation` is visible on the wire and asserted by tests (`Sessions.test.ts:1602`, `Users.test.ts:675`, `Verification.test.ts:543`, `Accounts.test.ts:601`, `Authentication.test.ts:124`, and `ScimWorld.ts:49`). Adapters log the precise primitive label (`SessionStore.flagReuse`), and the domain relabels the failure to the service operation with one helper, `relabel("Sessions.verify")` (a `catchTag("StoreUnavailable", …)`), so wire labels are unchanged.

### 3.8 Canonical behaviour for each drift item

| Id | Canonical behaviour | Justification |
|---|---|---|
| S-1 / S-5 | `superseded.userId` is the **superseded row's** `userId`. A `supersedes` naming another user's session (or a tombstoned one) tombstones nothing and founds a fresh family. Store clause: ownership is checked inside the atomic insert. | BEH-EA-053 (rotation of the caller's own session); INV-EA-018 (an id alone never acts on a session); RRS-008 (the event describes the tombstoned row). |
| S-2 | Atomic union; `amr` never loses a method. | THS-003 in 07-sessions.md ("never removing one, monotone"); BEH-EA-258. |
| S-3 | One `DELETE … RETURNING`; exactly one `auth.session.revoked` per removed row; the loser gets `SessionNotFound`. | TIR-008 (BEH-EA-101 events, "exactly one … after the delete"); BEH-EA-054. |
| S-4 | `flagReuse` is once-only and atomic with the family revocation; `auth.session.reuse` and the `family` revoke are published exactly once per tombstoned row. | RRS-003 (S:419-425); BEH-EA-053. |
| S-6 / S-7 | `rotate` requires `supersededAt IS NULL`. The loser re-applies the liveness check on `Lost.current`: tombstoned, expired or absent gives `SessionNotFound`/`SessionExpired`, otherwise it answers `rotated: none`. | BEH-EA-052/053; ADR-EA-014 property 1 (revocation is authoritative on the next read). |
| S-8 | Both adapters bound the listing at `LIST_LIMIT` (`truncated` is logged by the domain). | BEH-EA-054 ("exhaustive … bounded by `LIST_LIMIT`"). |
| S-9 | Contract: `consistency` is a hint; adapters without replicas ignore it; only `listLive` takes it. | ADR-EA-024 §2. |
| S-10 / V-11 | Contract: a store MAY drop a row only once it is past its absolute expiry. The domain treats an absent row as `SessionNotFound`. Documented as a permitted difference (no `auth.session.expired` for a pruned row). | TMS-004 (memory DoS bound); BEH-EA-061 analogue. |
| S-11 | Every SQL write primitive is retried on transient errors at top level only. | ADR-EA-028 §Transient retry. |
| S-12 | Contract: exact for a serializing adapter; `maxLive + 1` transiently allowed under Postgres READ COMMITTED. | SMS-003 as shipped. |
| S-13 / U-11 / V-8 / L-7 | No application-level tenant filter on reads (status quo); RLS stays an adapter-specific backstop. **§10 Q4.** | ADR-EA-018 Decisions 4 and 5. |
| S-14 / A-6 / V-7 / L-3 | **Every** adapter stamps through `Tenant.stamp`: an explicit `Some` wins, else the ambient tenant. The memory adapters now carry `tenantId` for accounts, tokens and reservations too. `AccountRecord` gains no public field (non-goal); the value is stored for parity and export. | BEH-EA-231 ("memory twins stamp the same fields", made true). |
| S-16 / U-9 / A-8 / V-10 | The **domain** mints every id (`crypto.randomUUIDv7`, mapped to `StoreUnavailable` via `storeUnavailable`) and reads the clock **once** per operation; adapters persist exactly what they are given (`Model.Override`/explicit insert values live inside the SQL adapter). | ADR-EA-028 §2 (both layers fail alike); deterministic tests under `TestClock`. |
| U-1 / A-3 | `updatedAt = at` on **every** row write, `setFields` included (ADR-EA-035 fields are `users` columns). | The field's meaning; Sql is the documented production behaviour. |
| U-2 / U-3 | `casIdentity`; announcements fire exactly once and are computed from `expected` versus `next`. | AAPS-005 (announce exactly when an attribute changed); BEH-EA-042. |
| U-4 | Validation errors (`UnknownUserField`, `UserFieldNotWritable`, `InvalidUserFieldValue`) come before `UserNotFound`: pure checks run before I/O. | BEH-EA-048; cheaper and enumeration-neutral. |
| U-5 | `delete` on an absent row is `UserNotFound`; the Ref adapter unindexes the **current** row inside the modify. | BEH-EA-046; GC-004. |
| U-6 | `writeFields` returns its own post-state atomically; there are no orphans. | BEH-EA-048. |
| U-7 / U-8 | `insertOrHolder` never aborts an enclosing transaction and never dies on a vanished holder (bounded retry). | INV-EA-017 (the caller's transaction domain stays usable); ADR-EA-028 §3 (defects are only for invariant breaks). |
| U-10 | The domain validates `limit` as an integer in `[1, MAX_PAGE_SIZE]` (clamped, as sessions do). | BEH-EA-036 / ESR-010. |
| A-1 | `deleteUnlessLast` is atomic on every adapter. | **BEH-EA-045.** |
| A-2 | `issuer: ""` and an absent issuer are both `Option.none()` in `AccountRecord`. | BEH-EA-043 (the key treats them alike). |
| A-4 | Identity reads never decrypt or write tokens. | BEH-EA-125 (tokens are read only where needed); sign-in latency. |
| A-5 | `listByUser` is ordered by `(createdAt, id)`. | BEH-EA-036 (deterministic order). |
| V-1 | A reservation is expired iff `now >= expiresAt`; the domain requires `ttl > 0` (a defect otherwise, consistent with `validBudget`). | BEH-EA-061/063; `isExpired` V:210. |
| V-2 | One atomic `present`. | SOS-004; BEH-EA-062. |
| V-3 | `deferMiss` defers the spend as well as the event; `recordMiss` spends. **§10 Q5 confirms the intent.** | PV-220 as implemented in Sql and tested at V-test:587-648. |
| V-4 | Consumed rows are kept by both adapters; BEH-EA-062's text becomes "MUST NOT be consumable again". | BEH-EA-061 "As shipped" (forensics). |
| V-5 | Out of scope for this plan's default path (plan 07); optional Phase 8 (`TxRef`). | INV-EA-017 / DRS-006. |
| V-6 | The payload round-trips through `Schema.UnknownFromJsonString` in the domain on both adapters; a non-JSON payload is a defect on both. | BEH-EA-122 ("round-tripping … verbatim"). |
| V-9 | Reported to plan 03 (erasure should also clear reservations naming the user's address); `VerificationStore` gains no primitive for it here. | ADR-EA-031. |
| L-1 | Filter first, decode second, on both adapters. | BEH-EA-100. |
| L-2 | Idempotent append; a duplicate `eventId` is not an outage. | ADR-EA-028 §2 (only infrastructure failures map to `StoreUnavailable`); BEH-EA-102 (dedupe on `eventId`). |
| L-4 | `NonEmptyReadonlyArray` by type, and the domain short-circuits `[]` to 0. | Type-system first (README conventions). |
| L-5 | `batchSize` is validated as a positive integer (a defect otherwise). | BEH-EA-102. |
| L-6 | `rewriteReferencing` is all-or-nothing. | ESA-005; ADR-EA-031 (erasure is atomic). |
| L-8 | Byte-order id comparison on every adapter. | BEH-EA-102 (checkpoint by id). |
| L-9 | Session writes capture the causal token; audit appends do not (cost). | ADR-EA-024 §3 and its alternatives section. |

### 3.9 The single domain implementation

Each module exports **one** `layer` that requires its port, and the twins disappear (temporary aliases during migration, §4). Sketch for Sessions (`packages/core/src/Sessions.ts`):

```ts
import { LegacySessionBridge, SessionStore } from "@awthaq/ports"
// no "@awthaq/sql" import

export const layer = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore
    const crypto = yield* Crypto.Crypto
    const builtConfig = yield* SessionConfig
    const configNow = Tenant.configInForce(SessionConfig, builtConfig)
    const events = yield* AuthEvents.AuthEvents
    const bridge = yield* LegacySessionBridge.LegacySessionBridge

    const issue = Effect.fnUntraced(
      function* (input: IssueInput) {
        const config = yield* configNow
        yield* refuseSelfActingAs(input)
        const id = SessionId(yield* crypto.randomUUIDv7)
        const secret = toHex(yield* crypto.randomBytes(32))
        const secretHash = yield* hashSecret(crypto, secret)
        const now = yield* DateTime.now
        const absoluteExpiresAt = DateTime.addDuration(now, input.absoluteDuration ?? config.absolute)
        const { inserted, superseded, evicted } = yield* store.insert({
          session: {
            id, userId: input.userId, secretHash, at: now, absoluteExpiresAt,
            idleExpiresAt: input.actingAs === undefined
              ? DateTime.min(DateTime.addDuration(now, config.idle), absoluteExpiresAt)
              : absoluteExpiresAt,
            ipAddress: Option.fromNullishOr(input.request?.ip),
            userAgent: Option.fromNullishOr(cappedUserAgent(input.request?.userAgent)),
            actingAs: Option.fromNullishOr(input.actingAs),
            amr: input.amr ?? [],
          },
          supersedes: Option.fromNullishOr(input.supersedes),
          maxLive: input.actingAs === undefined
            ? Option.map(Option.fromNullishOr(config.maxConcurrent), (p) => p.limit)
            : Option.none(),
        })
        if (Option.isSome(superseded)) {
          yield* events.publish({ _tag: "auth.session.superseded", sessionId: superseded.value.id,
            supersededBy: id, familyId: superseded.value.familyId, userId: superseded.value.userId })
        }
        for (const gone of evicted) yield* publishRevoked(gone, "one", "limitEvicted")
        const view = toView(inserted)
        yield* publishIssued(events, view, inserted.familyId, view.actingAs)
        return { session: view, token: Redacted.make(`${id}.${secret}`) }
      },
      Effect.catchTag("PlatformError", storeUnavailable("Sessions.issue")),
      relabel("Sessions.issue"),
    )
    // verify: parse, then hash, then store.get, then matchedSecret, then tombstone? store.flagReuse(id, now) →
    //   publish reuse + family revoke iff Some, then expiry, then actingAs, then the throttle, then
    //   store.rotate; on Lost, re-check isLive(current), as decided in §3.8 (S-6).
    // revoke/revokeOwned: store.remove(id, owner) → None ⇒ SessionNotFound; Some(row) ⇒ one event.
    // reauthenticate: store.reauthenticate({ id, at: now, addAmr: amr ?? [], liveAt: Option.none() }).
    return Sessions.of({ issue: traceIssue(issue), verify: traceVerify(verify), revoke, revokeOwned,
      revokeOthers, revokeAll, purgeExpired, list, findOwned, isLive, reauthenticate })
  }),
)
```

- `Sessions.of({...})` checks every member against `SessionsShape` without annotating the consts. That keeps both conventions: no `: SessionsShape["issue"]` annotations and no `as`.
- `Ref.modify` callbacks return array literals that are **contextually typed** as tuples by `modify`'s `(a: A) => readonly [B, A]` parameter. The `as const` the twins use today (S:824, 1011, 1026, 1074, 1077, 1192, 1198) disappears from library source.
- The requirement sets after the refactor are inferred, never annotated:
  - `Sessions.layer` needs `SessionStore | Crypto | AuthEvents` (the bridge is a `Context.Reference`).
  - `Users.layer` needs `UserStore | Crypto | Hooks.BeforeUserDelete`; plan 03 may drop the last one.
  - `Accounts.layer` needs `AccountStore | Crypto`.
  - `Verification.layer` needs `VerificationStore | Crypto | AuthEvents`.
  - `AuditLog.layer` needs `AuditLogStore` only (`Random` for aliases is a default service).

### 3.10 Persistence bundles (`packages/core/src/Persistence.ts`)

```ts
import { AccountStore, AuditLogStore, SessionStore, SqlTransaction, UserStore, VerificationStore } from "@awthaq/ports"
import { AccountStoreSql, AuditLogStoreSql, Repositories, SessionStoreSql, UserStoreSql, VerificationStoreSql } from "@awthaq/sql"

/** Test-grade, single-process (TRBS-005). Matched: Ref stores + SqlTransaction.layerNoop. */
export const memory = Layer.mergeAll(
  UserStore.layerMemory, AccountStore.layerMemory, SessionStore.layerMemory,
  VerificationStore.layerMemory, AuditLogStore.layerMemory, SqlTransaction.layerNoop,
)

export interface SqlOptions {
  /** CSG-006: seal users.metadata and sessions.ipAddress/userAgent at rest. Default false. */
  readonly encryptPii?: boolean
}

/** Matched: every SQL store over ONE SqlClient + SqlTransaction.layerSql (INV-EA-017). Requires SqlClient | Encryption. */
export const sql = (options?: SqlOptions) =>
  Layer.mergeAll(
    UserStoreSql.layer, AccountStoreSql.layer, SessionStoreSql.layer,
    VerificationStoreSql.layer, AuditLogStoreSql.layer, SqlTransaction.layerSql,
  ).pipe(
    Layer.provide(Layer.mergeAll(
      options?.encryptPii === true ? Repositories.UsersRepositoryEncryptedLive : Repositories.UsersRepositoryLive,
      options?.encryptPii === true ? Repositories.SessionsRepositoryEncryptedLive : Repositories.SessionsRepositoryLive,
      Repositories.AccountsRepositoryLive,
      Repositories.VerificationRepositoryLive,
      Repositories.VerificationReservationsRepositoryLive,
      Repositories.AuditLogRepositoryLive,
    )),
  )
```

- The conditional union of two repository layers typechecks because `Layer`'s `RIn` is covariant (rc.117 `Layer.ts:54`, `out RIn`). The bundle requires `SqlClient | Encryption` either way, since `AccountsRepositoryLive` already needs `Encryption`.
- **Swapping one store, which is legal under ADR-EA-014, is explicit.** `Layer.merge(Persistence.sql(), KvSessionStore.layer)`: the later layer wins in the merged context. A non-SQL store is outside the `SqlTransaction`, so per ADR-EA-031 its erasure participation must be idempotent and retry-safe; deleting sessions is.
- The repositories stay exported from `@awthaq/sql` for advanced compositions and plugins. Their methods that only the old twins used are removed in Phase 7: `markReused` (unconditional), `deleteOwned` (replaced by a `delete … RETURNING`), and the Accounts and Verification methods with no caller (`update`, `findByIdentifier`, `insert`, `delete`). Knip flags any that remain.

---

## 4. Phased migration

Every phase is one mergeable PR (or a small stack), green on the phase gate:
`pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Add `pnpm test:pg` whenever a SQL adapter or repository changes, `pnpm workspace:check` whenever package dependencies change, and `pnpm spec:verify:strict` whenever spec files change. The plan's final gate is `pnpm check` plus `pnpm test:pg`.

Track execution as `.scratch/domain-store-seam/issues/NN-*.md` tickets (one per numbered step below, `Status: ready-for-agent`, `Blocked by:` per the dependency notes).

**Transitional aliases.** From Phase 2 to Phase 6, each migrated module keeps
`export const layerMemory = layer.pipe(Layer.provide(XStore.layerMemory))` and
`export const layerSql = layer.pipe(Layer.provide(XStoreSql.layer))`. Each SQL adapter requires exactly the repositories the old `layerSql` required (plus `SqlClient`), so the 568 references in 161 files (tests, features, examples, README, TestAuth) keep compiling unchanged until Phase 7 rewrites them in one mechanical pass. The aliases are the only place a domain module still imports `@awthaq/sql` during the transition.

### Phase 0: hotfix the live bugs in place (independent; can ship in Wave A)

No seam yet. Fix each bug in **both** twins where it applies, each fix its own commit, each with a regression test added to the module's existing two-layer suite so it runs on Ref and SQLite (and Postgres where noted). These tests later become domain or contract tests (§5) and are not rewritten.

| Step | Files | Change | Regression test (added to the shared suite) |
|---|---|---|---|
| 0.1 revoke atomic | R (Sessions repository), S:1570-1609 | New `SessionsRepository.deleteReturning(id, userId?)` running `DELETE FROM sessions WHERE id = ? [AND "userId" = ?] RETURNING "userId"`, returning `Option<UserId>`. `revoke` and `revokeOwned` both use it. Remove `deleteOwned`. | "TIR-008: two concurrent revokes of one session publish exactly one auth.session.revoked, and the other fails SessionNotFound" (`Effect.all([...], { concurrency: 2 })`) |
| 0.2 reauthenticate CAS | R:1670-1690, S:1722-1748 | The repository's `reauthenticate` gains `expectedAmr`: `WHERE id = ? AND amr = ?`. The core SQL path loops read, union, CAS up to 5 times. | "THS-003: concurrent reauthenticate(['otp']) and reauthenticate(['hwk']) both land in amr" |
| 0.3 reuse once | R:1655-1668, S:928-953, S:1458-1477 | Replace `markReused` with `markReusedOnce` (`… AND "supersededAt" IS NOT NULL AND "reusedAt" IS NULL RETURNING "familyId","userId"`). Run it with `revokeFamily` in `sql.withTransaction`, and publish only when a row came back. Memory: move the check, the mark and the family delete into **one** `Ref.modify` returning a boolean. | "RRS-003: two concurrent presentations of one tombstoned token publish exactly one auth.session.reuse and one family revoke" |
| 0.4 supersede ownership and superseded userId | R:1630-1649 (`tombstone` gains `userId`), S:766-771, S:1294-1305, S:1357-1364 | Tombstone only a row owned by `input.userId`. Publish `superseded.userId` from the tombstoned row, which is now equal to `input.userId` by construction. | "INV-EA-018: issue({ supersedes: another user's session }) founds a fresh family, publishes no superseded event, and the foreign session still verifies"; "RRS-008: auth.session.superseded.userId is the superseded row's user" |
| 0.5 Postgres unlink skew | A:624-651, R (`AccountsRepository.lockByUser`) | Inside the existing transaction, first run `sql.onDialectOrElse({ pg: () => sql\`SELECT id FROM accounts WHERE "userId" = ${userId} FOR UPDATE\`, orElse: () => Effect.void })`. | "BEH-EA-045: concurrent unlinks of a user's two accounts leave at least one". Move `Accounts.test.ts`'s SQL leg onto `TestSql.layer("core_Accounts")` (as `Users.test.ts:28` does) and add the file to `scripts/test-pg.sh`. **The test proves the fix only under `test:pg`.** |
| 0.6 reserve boundary | R:2038, V:404-424 | SQL `<=`; both layers refuse `ttl <= 0` (a defect, like `validBudget`). | "BEH-EA-063: a reservation is expired at exactly its expiresAt" (`TestClock.adjust(ttl)`), on both layers |
| 0.7 verification miss | V:510-563, V:319-402 | SQL: `tryConsume` plus `recordFailedAttempt` inside `sql.withTransaction`. Memory: with `deferMiss`, spend nothing; `recordMiss` spends on the live, budgeted row (V-3 canonical). | "SOS-004: a reissue racing a miss never charges the new token" (SQL); "PV-220: deferMiss spends no attempt until recordMiss" (moved from SQL-only at V-test:587 into the shared suite) |
| 0.8 SQL verifyEmail double announce | R:574-590, U:1099-1114 | `verifyEmail`'s `UPDATE` gains `AND "emailVerified" = false AND email IS NOT NULL RETURNING *`, and the domain announces only when a row came back. | "AAPS-005: two concurrent verifyEmail calls announce emailVerified once" |

- **Changesets:** `@awthaq/core` and `@awthaq/sql` patch, "fix: atomic session revoke, reauthenticate, reuse detection and supersede ownership; Postgres-safe unlink; reserve boundary; atomic verification miss". There are no `Migration:` steps (compatible fixes), but name the behaviour changes: a foreign `supersedes` no longer tombstones; `deferMiss` no longer spends in memory; a reservation is free at exactly `expiresAt`.
- **Spec:** BEH-EA-053 (ownership note), BEH-EA-045 (Postgres note), BEH-EA-063 (boundary), and the RRS-003 sentence in 07-sessions.md (once-only now holds), each with a Document Control revision and a `spec/traceability.md` row for the new test names.
- **Gate:** the phase gate plus `pnpm test:pg`.

### Phase 1: substrate (no behaviour change)

1.1 Add `packages/ports/src/Ids.ts`, moving the brands from M:28-43 (`UserId`, `AccountId`, `SessionId`, `VerificationTokenId`, `E164` and its filter). `Models.ts` re-exports them. Point `Phone.ts`, `DataExportRegistry.ts`, `ErasureRegistry.ts`, `HttpApiTypes.ts` and the core `Brand.nominal` aliases at `Ids`.

1.2 Add `packages/ports/src/Store.ts`: `StoreUnavailable` (`export import StoreUnavailable = Api.StoreUnavailable`, the form core uses at `Errors.ts:23`), `Consistency` and `ReadOptions`. `ReadRouting.ts` re-exports `Consistency` and `ReadOptions`. Add `@awthaq/api` to `packages/ports/package.json` dependencies and to its tsconfig references, then run `pnpm workspace:sync`.

1.3 Add `Tenant.stamp` to `packages/ports/src/Tenant.ts`; `stampTenant` (R:86) delegates to it.

1.4 Move `internal/pruneExpired.ts` to ports and `internal/purgeBatches.ts` to sql, re-pointing their imports. Move `retryTransient` to `@awthaq/sql` `SqlStore.ts`, which also gains `write` and `read` (§3.7). Core `Errors.ts` re-exports `retryTransient`.

1.5 Add `packages/test/src/StoreContract.ts`, exporting `StoreContract.cases` as data (`ReadonlyArray<{ name: string; run: Effect<void, unknown, never> }>`), so `@awthaq/test` needs no runtime vitest dependency. Add `packages/test/test/StoreContract.memory.test.ts` and `StoreContract.sql.test.ts` (the latter over `../../sql/test/support/TestSql.ts`, so `test:pg` reruns it on Postgres; add it to `scripts/test-pg.sh`). They start empty and each later phase adds its port's cases.

1.6 Update the overview's surface block (`surface:ports`) for `Ids`, `Store` and, in later phases, each store. `spec/scripts/check-drift.mjs` diffs it.

- **Changeset:** `@awthaq/ports` minor (new modules, new dependency on `@awthaq/api`), `@awthaq/sql` patch (re-exports). No `Migration:` steps.
- **Gate:** the phase gate plus `pnpm workspace:check` and `pnpm package:smoke`.

### Phase 2: AuditLog → `AuditLogStore` (the smallest store)

2.1 Add `packages/ports/src/AuditLogStore.ts`: interface, `AuditRow`, `AuditFilter`, and `layerMemory` (one `Ref<ReadonlyArray<AuditRow>>`; idempotent append; filter on rows; byte-order paging).

2.2 Add `packages/sql/src/AuditLogStoreSql.ts` over `AuditLogRepository`. The repository gains:
- `insertIfAbsent` (`ON CONFLICT(id) DO NOTHING RETURNING id`)
- `pageAfter` with `COLLATE "C"` on Postgres
- `deleteOccurredBefore`, which now takes a non-empty tag list
- `rewriteReferencing`, run inside `withTransaction` with `FOR UPDATE` on Postgres

2.3 Rewrite `AuditLog.ts` as a single `layer` (L:410-576 collapses), plus the transitional aliases. The domain keeps `actorOf`, encode/decode, scrub, alias, filter validation and `drainBatches`. Fixes L-1 to L-8.

2.4 Tests:
- `AuditLog.test.ts` runs its `suite` once over `layer` plus `AuditLogStore.layerMemory`.
- The SQL decode suite (`:695`) becomes a domain case that seeds a malformed `AuditRow` through the memory store.
- The down-store suite (`:777`) moves to `packages/sql/test/AuditLogStoreSql.test.ts`, which checks that a `SqlError` becomes `StoreUnavailable` and that a duplicate id returns `false`.
- Add `StoreContract.auditLog` (§5.1) and delete the contract.ts cases at `:927` and `:970`, which are now in the store contract.

- **Changeset:** `@awthaq/core` and `@awthaq/ports` minor, `@awthaq/sql` minor. `Migration:` an AuditLog record with a duplicate `eventId` is now ignored instead of failing; `purge` takes a non-empty `eventTags` or none.
- **Gate:** the phase gate plus `test:pg`.

### Phase 3: Verification → `VerificationStore`

3.1 `packages/ports/src/VerificationStore.ts` with `layerMemory`: one `Ref<{ tokens: HashMap<identifier, TokenRow>; history: ReadonlyArray<TokenRow>; reservations }>`. Consumed rows move to `history` and are purged by `purgeExpired`.

3.2 `packages/sql/src/VerificationStoreSql.ts` over both repositories: `present` runs in its own transaction, `claim` uses `<=`, `upsertLive` takes an explicit `id` and `createdAt`, and the `payloadJson` passthrough uses a new repository query that binds the TEXT column directly.

3.3 Rewrite `Verification.ts` as one implementation: `mintValue`, hashing, `validBudget`, `ttl > 0`, the payload codec, `TokenConsumed`, the events, and `deferMiss` → `spendOnMiss`.

3.4 Tests:
- `Verification.test.ts` runs once on Ref.
- The memory-pruning case (`:490`) moves to `packages/ports/test/VerificationStore.test.ts`.
- MA-004 (`:511-569`) moves to `packages/sql/test/VerificationStoreSql.test.ts`.
- The contract.ts Verification cases (`:727-1000` block) move to `StoreContract.verification`.

- **Changeset:** minor. `Migration:` none in the API. Behaviour: a non-JSON payload is a defect on every backend; memory keeps consumed rows until a purge.
- **Gate:** the phase gate plus `test:pg`.

### Phase 4: Accounts → `AccountStore`

4.1 `packages/ports/src/AccountStore.ts` with `layerMemory` (one `Ref<State>` as A:230-237, plus `tenantId`).

4.2 `packages/sql/src/AccountStoreSql.ts`. Repository additions: the identity-only `findIdentityById`, `findIdentityByKey` and `listIdentitiesByUser` (`ORDER BY "createdAt", id`), and `deleteUnlessLast` (moving 0.5's lock in here). `findAad` stays internal to `writeProviderTokens`.

4.3 Rewrite `Accounts.ts`: issuer normalization, `AccountsPolicy` through `configInForce`, record mapping and domain errors.

4.4 Tests:
- `Accounts.test.ts` runs once on Ref.
- SMS-002 undecryptable (`:541`) and MA-004 (`:575`) move to `AccountStoreSql.test.ts`.
- The concurrent-unlink case from 0.5 becomes a `StoreContract.accounts` case, so it runs on Postgres through `StoreContract.sql.test.ts`.
- `AccountsTokenReadPath.test.ts` stays (it covers encryption specifics) and adds the case "identity reads never decrypt".

- **Changeset:** minor. Behaviour: `issuer: ""` reads as none; `listByUser` is ordered; `updatedAt` bumps on credential and token writes in every backend.
- **Gate:** the phase gate plus `test:pg`.

### Phase 5: Users → `UserStore` (coordinate with plan 03)

5.1 `packages/ports/src/UserStore.ts` with `layerMemory` (one combined `Ref`).

5.2 `packages/sql/src/UserStoreSql.ts` over `UsersRepository`. Repository additions: `casIdentity` (a dialect-branched `IS NOT DISTINCT FROM`), `insertOrHolder` (bounded retry), `writeFields … RETURNING` with the returned columns, and `delete … RETURNING id`.

5.3 Rewrite `Users.ts`. The pure helpers that exist today (U:402-469) stay. Add the CAS-retry wrappers for the identity operations, validation-first field errors, `limit` validation, and `updatedAt` everywhere. If plan 03 has landed and `Users.delete` is no longer public, `UserStore.delete` is what `AccountErasure` calls for the user row (§8).

5.4 Tests:
- `Users.test.ts` runs once on Ref.
- Merge `UserAttributesHookMemory.test.ts` and `UserAttributesHookSql.test.ts` into a `describe("AAPS-005")` block in `Users.test.ts`, then **delete both files**.
- Merge `HooksWiringMemory.test.ts` and `HooksWiringSql.test.ts` into `Users.test.ts`'s delete block and **delete both**. Skip this if plan 03 already moved the veto, in which case the files are already gone.
- GC-004 (`:587-646`) becomes `StoreContract.users` "delete vs writeFields never orphans" plus "concurrent delete removes once".
- MA-004 (`:648`) moves to `UserStoreSql.test.ts`.
- `UserFields.test.ts` runs its domain suite once; the generated-column cases (`:344`) stay as SQL adapter cases.

- **Changeset:** minor. `Migration:` field-error precedence (validation before `UserNotFound`); `delete` on an absent user fails `UserNotFound`; `updatedAt` bumps on every write, `setFields` included.
- **Gate:** the phase gate plus `test:pg`.

### Phase 6: Sessions → `SessionStore` (after plan 01)

6.1 `packages/ports/src/SessionStore.ts` (§3.2) with `layerMemory`.

6.2 `packages/sql/src/SessionStoreSql.ts` (§3.2.2). Repository changes: `tombstone(userId)` (from 0.4), `markReusedOnce`, `deleteReturning` (from 0.1), the `touch` guard `AND "supersededAt" IS NULL`, and `reauthenticate` with an expected `amr` and an optional live predicate.

6.3 Rewrite `Sessions.ts`:
- Delete S:649-1764's two layers and `toSessionView`/`SessionRow`.
- Keep the public helpers (`isAuthMethod`, `unionAmr`, `isStale`, the constants, `SessionConfig`) and the tracing wrappers.
- The token parse/format, `matchedSecret`, the expiry checks, the bridge, the events, the S-6 loser re-check and the S-8 truncation warning are written once.
- `SessionsShape.list`'s third parameter becomes `Store.ReadOptions` from `@awthaq/ports` (the same shape).

6.4 Tests:
- `Sessions.test.ts`: every `suite`/`eventsSuite`/`reuseSuite`/`capSuite`/`graceSuite` runs **once** over `layer` plus `SessionStore.layerMemory`; drop lines 788, 1308, 1311, 1314 and 1526.
- MA-004 and SEA-002 (`:1559-1700`) move to `packages/sql/test/SessionStoreSql.test.ts` (`FlakyInsertRepository` and `BusyInsertRepository` now wrap the repository beneath the adapter).
- The crypto `PlatformError` case (`:1713`) stays as a domain case.
- "atomic supersede (layerSql)" (`:1726`) and "list past one page" (`:1758`) move to `StoreContract.sessions`.
- `SessionsWebCrypto.test.ts` and `LegacySessionBridge.test.ts` switch to `Sessions.layer` plus `SessionStore.layerMemory`.

- **Changeset:** minor. `Migration:` `Sessions.list`'s `options` type now comes from `@awthaq/ports` (`Store.ReadOptions`); the shape is identical, so no code change is needed unless a caller imported `ReadRouting.ReadOptions` for it, which still works as a re-export.
- **Gate:** the phase gate plus `test:pg`, then `pnpm test:bdd` (the features use sessions heavily).

### Phase 7: bundles, rename and documentation (the one breaking phase)

7.1 Add `packages/core/src/Persistence.ts` (§3.10) and export it from `packages/core/src/index.ts`. Update the header comment at `index.ts:21-25`.

7.2 **Remove** `layerMemory` and `layerSql` from the five modules. A scripted rewrite (`scripts/codemods/02-persistence.mjs`, committed with the PR and deleted after) replaces:
- `X.layerMemory` with `X.layer` plus `Persistence.memory` provided once at the composition root
- `X.layerSql` with `X.layer` plus `Persistence.sql()`

Hand-review the non-test sites: README ×10, `examples/sql-server/app.ts` ×5, the ADR-EA-016 text ×6, `spec/traceability.md`, `packages/jwt/README.md`, and the doc comments in `packages/core/src/{Auth.ts:483,index.ts,Users.ts,Accounts.ts}` and `packages/sql/src/{Models.ts,Repositories.ts}`. Test sites keep their structure; where a suite used both twins, it now uses one.

7.3 `packages/test/src/TestAuth.ts:131-145`: `MemoryStores` uses `Persistence.memory` plus the four domain `layer`s, and drops `SqlTransaction.layerNoop` (it is in the bundle). `memoryFoundation` (`:169`) uses `AuditLog.layer` over `AuditLogStore.layerMemory` and stays public. Plan 08 deepens it further.

7.4 README:
- Replace `RepositoriesLive` and `CoreLive` (README:118-134) with
  ```ts
  const CoreLive = Layer.mergeAll(Users.layer, Accounts.layer, Sessions.layer, Verification.layer).pipe(
    Layer.provideMerge(AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layer))),
    Layer.provideMerge(Persistence.sql().pipe(Layer.provide(EncryptionLive))),
    Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated), Layer.provideMerge(NodeCrypto.layer),
  )
  ```
- Remove `SqlTransaction.layerSql` from `ServicesLive` (README:180), since it is in the bundle.
- Add a "Persistence" paragraph: the matched bundles, `encryptPii`, swapping one store (ADR-EA-014), and the fact that mixing stores across bundles leaves the swapped store outside `SqlTransaction`.
- `packages/sql/test/ReadmeQuickstart.test.ts` and `fixtures/readme-quickstart.ts` follow (this test compiles the README block).

7.5 `examples/sql-server/app.ts:111-145` and `examples/memory-server`: use the bundles. Run `pnpm check:readmes`.

7.6 Remove the repository methods that no longer have a caller (`markReused`, `update`/`findByIdentifier`/`insert`/`delete` where knip reports them).

- **Changeset (breaking, pre-1.0 per ADR-EA-034 §2):** every package in the fixed group bumps. The `Migration:` section must say:
  > `Users.layerMemory`, `Accounts.layerMemory`, `Sessions.layerMemory`, `Verification.layerMemory`, `AuditLog.layerMemory` and their `layerSql` twins are removed. Use `X.layer` and provide `Persistence.memory` (tests, single process) or `Persistence.sql({ encryptPii? })` (production) once. `Persistence.sql()` includes `SqlTransaction.layerSql`, so remove your own. The six `Repositories.*Live` layers no longer need to be assembled by hand. `Repositories.SessionsRepository.markReused` is replaced by `markReusedOnce`. ADR-EA-041, ADR-EA-014 rev 1.3, BEH-EA-035/053/054/062/231.
- **Gate:** the plan gate, `pnpm check` plus `pnpm test:pg`.

### Phase 8 (optional; needs §10 Q3): transactional memory

`Persistence.memory`'s state moves to `TxRef`. Each store primitive is `Effect.tx(...)` (rc.117 `Effect.ts:24701`; a nested `Effect.tx` joins the outer one). `Persistence.memory`'s `SqlTransaction` becomes `{ withTransaction: (effect) => Effect.tx(effect) }`. This gives memory compositions real rollback (closing V-5, DRS-006 and INV-EA-017's memory caveat in `SqlTransaction.ts:36-45`, and the Erasure-on-memory gap).

**Hazard:** `Effect.tx` **re-runs** the body on conflict, including non-transactional effects such as event publishes and crypto inside it. Ship it only with plan 10's "events after commit" in place, and with a guard test that a conflicting erasure publishes `auth.user.deleted` once.

---

## 5. Test plan

### 5.1 Store contract (`@awthaq/test` `StoreContract`, run on every adapter)

Runners:
- `packages/test/test/StoreContract.memory.test.ts`
- `packages/test/test/StoreContract.sql.test.ts`, over `TestSql`: SQLite `:memory:` by default and Postgres under `test:pg` (added to `scripts/test-pg.sh`)
- a WAL-file SQLite run in `StoreContract.file.test.ts`, reusing `Repositories.file.test.ts`'s setup for realistic SQLite locking

Every case below is a named entry in `StoreContract.<port>`. "Concurrent" cases run N = 8 calls under `Effect.all(…, { concurrency: "unbounded" })` and assert exact counts. They are meaningful on Postgres (a pooled client) and on the Ref adapter (fiber interleaving at every `yield*`).

**sessions**
1. insert founds a family (`familyId = id`) and stamps the ambient tenant; an explicit tenant is not accepted on `NewSession` (stamp is ambient-only for sessions).
2. supersede tombstones a live, owned row and inherits `familyId`.
3. supersede of a foreign-user row, a tombstoned row or an absent row founds a fresh family and returns `superseded: None`.
4. **concurrent:** 8 inserts naming one `supersedes` produce exactly 1 `superseded: Some`.
5. `maxLive`: evicts the least-recently-active row (ties broken by id) and never evicts acting-as rows; an acting-as insert never triggers eviction.
6. **concurrent:** 8 inserts with `maxLive = 2` leave at most 3 live rows at once on Postgres, exactly 2 on serializing adapters, and 2 after one more insert.
7. `get` round-trips every field: `amr` order, `actingAs`, both expiries, `previous*`.
8. rotate CAS succeeds once; a second rotate with the old hash returns `Lost(current)`; rotating a tombstoned row returns `Lost`.
9. **concurrent:** 8 rotates with the same expected hash produce exactly 1 `Rotated`.
10. flagReuse returns Some exactly once, marks `reusedAt`, deletes live family rows, keeps the tombstones, and leaves another family untouched.
11. **concurrent:** 8 flagReuse calls produce exactly 1 Some.
12. flagReuse on a live (non-tombstoned) row returns None and changes nothing.
13. remove returns the row; a second remove returns None; remove with a foreign owner returns None and leaves the row.
14. **concurrent:** 8 removes of one id produce exactly 1 Some.
15. removeForUser with and without `keep` returns the count and removes tombstones too.
16. listLive is exactly the `isLive` rows (absolute and idle boundaries at `now == expiry` are not live, tombstones excluded), honours `limit` with `truncated`, and drains more than 200 rows (the old `:1758` case).
17. **concurrent:** reauthenticate with disjoint `addAmr` sets yields the union of all of them (8-way).
18. reauthenticate with `liveAt: Some` on a tombstoned or expired row returns None and writes nothing.
19. purgeExpired removes rows with `absolute < before` or `idle < before`, tombstones included, and returns the count.

**users**
1. insertOrHolder inserts a new user and returns `Held` for an existing email (case-insensitive) or phone; anonymous users are never Held.
2. **concurrent:** 8 inserts of one email produce exactly 1 `Inserted`.
3. insertOrHolder inside a caller transaction that later commits: a `Held` outcome left the transaction usable (Postgres: no aborted transaction).
4. casIdentity returns `Updated`, then `Stale(current)` on an outdated `expected`, `Taken` on a collision, and `Missing` on an absent user.
5. **concurrent:** 8 verify CASes produce exactly 1 `Updated`.
6. updateProfile keep/set/clear for image and metadata, bumping `updatedAt`.
7. setStatus bumps `updatedAt`.
8. delete returns true then false; field values are gone with the row.
9. **concurrent:** delete racing writeFields leaves no orphaned fields, and writeFields on a deleted user returns None.
10. writeFields returns its own post-state; null clears a field; booleans round-trip (SQLite 0/1).
11. listPage orders by `(createdAt, id)` with equal `createdAt` values and pages strictly.
12. Tenant stamping applies; directory reads take no tenant predicate (BEH-EA-232).

**accounts**
1. insertIfAbsent succeeds once per `(provider, subject, issuer)` key; `""` and absent collide; the 8-way concurrent version yields exactly 1 Some.
2. Identity reads never return tokens; on the SQL adapter they issue no `UPDATE` (assert with a statement-counting `SqlClient` wrapper, or `AccountsRepositoryConfig.reencryptOnRead` set to true plus a stale-key row).
3. listByUser is ordered.
4. Writing the credential hash or the provider tokens bumps `updatedAt`; writing for an absent account returns false.
5. deleteUnlessLast returns LastAccount on the last account, Deleted when `allowZero`, NotFound when absent.
6. **concurrent:** unlinking two distinct accounts of a 2-account user leaves exactly 1 (the A-1 regression on Postgres).
7. deleteByUser returns the count.

**verification**
1. upsertLive replaces the live row and keeps the consumed one; 8 concurrent upserts for one identifier leave exactly 1 live row.
2. present returns Hit once; a second Hit attempt returns Miss; an expired row (`now == expiresAt`) is a Miss.
3. **concurrent:** 8 presents of the right value produce exactly 1 Hit (BEH-EA-062).
4. A miss with `spendOnMiss` spends an attempt and burns the token at `maxAttempts`; a miss without it writes nothing.
5. A reissue racing a miss never charges the new token.
6. spendAttempt works.
7. claim is exclusive while live and free at exactly `expiresAt`; the 8-way concurrent claim yields exactly 1 true.
8. deleteByUser includes consumed rows.
9. purgeExpired covers tokens and reservations.
10. `payloadJson` round-trips byte for byte.

**auditLog**
1. append is idempotent on id.
2. select orders newest-first with id tiebreak, applies inclusive bounds and combined filters, and never surfaces a row outside the filter (a malformed row is excluded by the filter, not decoded).
3. pageAfter uses byte order, including ids that differ only in case or hyphen position, strictly after `after`.
4. rewriteReferencing is all-or-nothing (inject a failing row on SQL by passing a `rewrite` that dies on the k-th row: nothing is changed), idempotent, and matches actor equality or payload containment.
5. deleteBefore with tags, with except-tags, and with no tags; returns the count; never deletes rows at or after the cutoff.

### 5.2 Domain suites (run once, on the Ref adapters)

- `Sessions.test.ts`, `Users.test.ts`, `Accounts.test.ts`, `Verification.test.ts` and `AuditLog.test.ts` keep every behavioural case, now one leg each. The Phase 0 regression tests stay as domain cases (exact-one events, the union, ownership).
- **Infrastructure-failure cases (MA-004)** become domain cases over a store double built with `Layer.mock(SessionStore.SessionStore, { insert: () => Effect.fail(new StoreUnavailable({ operation: "SessionStore.insert" })) })`. They assert that the domain relabels the failure to `"Sessions.issue"` and publishes nothing. The `SqlError`-to-`StoreUnavailable` mapping is asserted once per adapter, in `packages/sql/test/<X>StoreSql.test.ts`.
- **New domain cases:**
  - S-6: tombstoning concurrently with a rotation loser yields `SessionNotFound`. Drive it with a store double whose `rotate` returns `Lost(Some(tombstoned))`.
  - S-8: the truncation warning is logged; capture it with `Logger`.
  - U-4: error precedence.
  - L-1: a malformed row outside the filter does not fail `list`.

### 5.3 Files deleted or merged (by name)

| File | Fate |
|---|---|
| `packages/core/test/HooksWiringMemory.test.ts`, `HooksWiringSql.test.ts` | merged into `Users.test.ts` (or deleted by plan 03), then **deleted** |
| `packages/core/test/UserAttributesHookMemory.test.ts`, `UserAttributesHookSql.test.ts` | merged into `Users.test.ts` `describe("AAPS-005")`, then **deleted** |
| `packages/sql/test/contract.ts` | keeps the dialect, codec, encryption, index, migration, DRS-001/005 and ESR-010 cases. Cases for `tombstone`, `touch`, `deleteOwned`, `listLiveIds`, `reauthenticate`, `insertIfAbsent` (users), `upsertLive`, `tryConsume`, `claim`, `findByProviderSubject`, AuditLog `list` and `deleteOccurredBefore` **move** to `StoreContract`. |
| SQL-only `describe` blocks in the five core suites | move to `packages/sql/test/{Session,User,Account,Verification,AuditLog}StoreSql.test.ts` |
| `Retention.test.ts`, `AccountErasure.test.ts` | kept; the memory leg uses `Persistence.memory` and the SQLite leg uses `Persistence.sql()`. The SQLite atomicity case (`AccountErasure.test.ts:324`) is the one place cross-store atomicity is proven, so it stays. |

### 5.4 `test:pg` coverage

Add to `scripts/test-pg.sh`:
- `packages/test/test/StoreContract.sql.test.ts` (every concurrent case above on a real pool)
- `packages/core/test/Accounts.test.ts`, in Phase 0 only; it leaves the list again in Phase 4, when the case lives in the contract
- the five `packages/sql/test/*StoreSql.test.ts` files where they use `TestSql`

`packages/core/test/Users.test.ts` leaves the list in Phase 5 because its SQL leg is gone. The behaviour it covered is in the contract.

---

## 6. Spec, ADR, traceability and documentation

| Artifact | Change |
|---|---|
| **New ADR-EA-041** "Core domain services are written once over atomic store ports" (`spec/decisions/041-domain-store-ports.md`, plus `index.yaml`) | Records §3.1 (placement, options a/b/c), the atomic-primitive rule, the bundles, the adapter substrate, the contract suite as the adapter bar, the operation-label rule, and the rejected alternatives: (a) the package cycle; (b) the KV backend depending on `sql`; keeping the twins with a shared helper module, rejected because helpers already exist (§2.0) and the drift lives in the I/O sequencing, which only an atomic seam fixes. |
| **ADR-EA-014** rev 1.3 | Decision: "`Sessions` is a port" now means `SessionStore` in `@awthaq/ports`. A backend implements its nine primitives and passes `StoreContract.sessions`. Consequences: the "memory layers are single-process" paragraph now names `Persistence.memory`; "a future KV layer" becomes "a `SessionStore` adapter". Status stays "Accepted, implemented". |
| ADR-EA-016 rev 1.3 | Replace the `layerMemory`/`layerSql` wording with Ref and SQL adapters, and record V-1 (`<=`). Line 23 (`findByIdentifier` ordering) is stale; fix it. |
| ADR-EA-018 | Decision 3: stamping lives at the store adapters through `Tenant.stamp` (both families). |
| ADR-EA-024 | Decision 2's primary-pinned list moves verbatim into the store contracts. Decision 3: `captureToken` is wired by `SessionStoreSql`'s write primitives and deliberately not by `AuditLogStoreSql.append`. |
| ADR-EA-028 | Rollout: the mapping now happens at the store seam (`SqlStore.write`/`read`); the domain relabels; `retryTransient` applies to every top-level write primitive. |
| ADR-EA-031 | The core cascade goes through the stores, matched by the bundle. Record V-9 for plan 03. |
| BEH-EA-035 (05-persistence-stratum) | Extend OHS-002's bounded exception to store adapter primitives. Rename the "read replicas" paragraph to the store contracts. |
| BEH-EA-053 (07-sessions) | Ownership of `supersedes` (S-5); the atomic unit is now "one store primitive". |
| BEH-EA-052 | Rotation is a CAS that requires a live row; the loser re-checks liveness (S-6). |
| BEH-EA-054 | Both adapters bound at `LIST_LIMIT`; "identically in both Layers" becomes "identically on every adapter (StoreContract.sessions 16)". |
| 07-sessions RRS-003 text, BEH-EA-101 (13-events) session paragraph | Reuse is once-only (S-4); exactly one `revoked` per removed row (S-3); `superseded.userId` (S-1). |
| BEH-EA-258 / THS-003 note | The amr union is atomic (S-2). |
| BEH-EA-045 | Atomic on every adapter, with the Postgres lock named (A-1). |
| BEH-EA-043 | `issuer: ""` is the same as absent (A-2). |
| BEH-EA-061/062/063 (08-verification-tokens) | Consumed rows are kept and never consumable again (V-4); the reservation boundary (V-1); `deferMiss` (V-3). |
| BEH-EA-100/102 (13-events) | Idempotent append (L-2); byte-order replay (L-8). |
| BEH-EA-231 (28-tenancy) | "Every store adapter stamps": true for Ref adapters too. |
| BEH-EA-193 (25-testing-harness) | TestAuth composes `Persistence.memory`. |
| `spec/overview.md` rev 1.3 | Ports surface block and table: the new modules. Persistence row: "Models, repositories, migration records, SQL store adapters" (drop "memory twins"). Domain table: add `Persistence`. Update the Ports row text. |
| `spec/traceability.md` | Rows 123/124/130/134 (INV-EA-007/008/014/018) now name the store adapters; the test map rows at 185/189/191/192 point at `StoreContract` plus the single-leg suites; add StoreContract rows for ADR-EA-014/016/024/028; add ADR-EA-041. |
| `features/` | `SessionWorld.ts`, `DomainWorld.ts`, `PersistenceStratumWorld.ts` and the other step-definition worlds that build `layerMemory`/`layerSql` are rewritten by the Phase 7 codemod. Scenarios under `01-contract-and-persistence` and `02-domain` that say "both layers" are reworded to "every store adapter". |
| `packages/core/src/index.ts:21-25`, the header comments of the five modules (S:4-7, U:4, A:4, V:4/21, L:10) | Describe one implementation over a port. |
| `docs/plugin-authoring.md` | One paragraph: plugin records follow the same port/adapter shape (plan 05's substrate). Point to `StoreContract` as the bar. |
| Changesets | Phase 0: patch. Phases 1-6: minor, with `Migration:` notes where behaviour changes. Phase 7: breaking. The exact text is in §4. |

---

## 7. Risks, mitigations and rollback

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Extra round trips.** Paths that get more expensive: `rotate` loses a race (one extra read, only on a lost race); `flagReuse` becomes a transaction of 2 statements (rare path); `reauthenticate` is read plus CAS (the same 2 as today, more only under contention); `casIdentity` is read plus CAS (the same as today's read-then-write). Paths that get cheaper: `revoke` (2 statements to 1), identity reads on Accounts (no token decrypt or write-back on the sign-in path), and `create` duplicates (no aborted Postgres transaction). The hot path (`verify` without rotation) stays one `get`. | Benchmark `verify` and `issue` p50/p99 before and after Phase 6 with a Postgres pool (`pnpm test:pg` plus a micro-benchmark script under `scripts/bench/sessions.mjs`, not committed to CI). Accept ±5%. |
| R2 | **Transaction boundaries.** An adapter primitive that opens its own `withTransaction` becomes a savepoint inside a caller's transaction; a rollback to the savepoint leaves the caller usable. `retryTransient` must not run inside a caller's transaction. | Use the `transactionService` detection (§3.2.2), backed by a contract case "a primitive inside a caller's transaction that fails leaves the caller committable" and an adapter test that a busy error inside a caller's transaction is **not** retried. |
| R3 | **Replica routing.** Only `listLive`, `select` and `pageAfter` are eligible; everything else must stay authoritative. | Put it in the contract text, and add an adapter test with `ReplicaSqlClient` pointing at a client that fails every query, proving that only those three primitives route there (reusing `packages/test/src/LaggingReplica.ts`). Wire `captureToken` on session writes; the audit stays stale-tolerant (decided). |
| R4 | **Tenancy.** Moving the stamp from repository to adapter could double-stamp or drop it. | Use `Tenant.stamp` in one place per adapter; keep the contract cases sessions 1 and users 12; keep the existing DRS-001 case in contract.ts at the repository level. |
| R5 | **Codemod churn.** 568 references in 161 files. | The transitional aliases make Phases 2-6 non-breaking; Phase 7 is mechanical and reviewable as one diff; `pnpm test:bdd` and `examples/*/test` guard composition. |
| R6 | **Phase order versus plans 01, 03 and 05** (merge conflicts in `Sessions.ts` and `Users.ts`). | Follow the README's order. Phase 0 lands first, Phases 2-4 do not touch Sessions or Users, and Phase 5 waits for 03 and Phase 6 waits for 01. |
| R7 | **Strata.** The new ports→api edge and the moved brands could create a cycle. | `pnpm circular` (both passes) and `tsc -b` in the Phase 1 gate. `@awthaq/api` has no workspace dependency. |
| R8 | **Memory behaviour changes surprise tests in other packages** (consumed tokens retained, `updatedAt` bumps, `deferMiss`). | Each is a named `Migration:` line; Phase 0 and the module phases run the full `pnpm test`. |

**Rollback.** No phase adds a migration or changes a column, so every phase reverts with `git revert` alone.
- Phases 0-6 keep the public layer names (the aliases), so reverting one module's phase leaves the others working.
- Phase 7 is the only breaking change. Reverting it restores the aliases and the README.
- Phase 8 is gated and independently revertible.

---

## 8. Interactions with other plans

| Plan | Interaction | Decision |
|---|---|---|
| **01** sign-in/sign-up | Collapses seven `sessions.issue` call sites into one `SignIn` path; this plan changes only `Sessions`' implementation. | Phase 6 waits for 01. 01 changes no `SessionsShape` member except possibly the error channel of callers. If 01 adds a `SignIn` that calls `issue` inside a transaction, the adapter's savepoint and no-retry-when-nested rules (R2) cover it. |
| **03** erasure | Makes `Users.delete` non-public; erasure becomes the only cascade. | `UserStore.delete` (atomic: the row plus its fields; boolean result) is the primitive `AccountErasure` uses for the user row. AccountErasure keeps calling the domain services for accounts, sessions, verification and the audit log, because those own events. If 03 lands before Phase 5 and adds a private deletion path to both twins, Phase 5 collapses it into `UserStore.delete`. The double veto (U-14) is 03's. Reservation erasure (V-9) is reported to 03. |
| **05** plugin substrate | Shares the error mapping, transient retry and tenant stamping with plugin records. | Shared: `@awthaq/ports` `Store.StoreUnavailable`, `Consistency` and `ReadOptions`; `Tenant.stamp`; `@awthaq/sql` `SqlStore.write`/`read`/`retryTransient`. **05 lands first (Wave C); if it already created these helpers under other names, this plan adopts its names and §3.7 is renamed accordingly.** `StoreContract` and 05's plugin contract share the runner style (cases as data). |
| **06** rate limits | None. `RateLimiterStore` is the precedent this plan follows. | No change. |
| **07** `Verification.redeem` | Redeem owns the transaction protocol around `consume`. | `VerificationStore.present` is the primitive redeem uses (one atomic step). The memory burn on a rolled-back transaction (V-5) is solved by 07's protocol or by Phase 8 (`TxRef`), whichever comes first. If 07 lands before Phase 3, Phase 3 rebases `redeem` onto `present`. |
| **08** test composition | Consumes the matched bundles. | `Persistence.memory` and `Persistence.sql(options)` are the bundles 08 composes with plugin `records` bundles. A "core domain services" bundle (four domain layers plus AuthEvents over AuditLog) is 08's to add. `StoreContract` sits next to `runPluginContractTests`. |
| **09** event definitions | Event payloads move to the schema. | The session, verification and audit events are published from one place per module after this plan, so 09 edits one site per event instead of two. |
| **10** standalone fixes | "reauthenticate on dead sessions", "fresh-session gate", "events from rolled-back tx". | `SessionStore.reauthenticate` takes `liveAt`; 10 passes `Some(now)`, which is a one-line change in the domain. "Events after commit" is a domain-level mechanism that, after this plan, needs applying once per module (a prerequisite for Phase 8). If 10 lands first in the twins, Phases 5-6 carry its behaviour into the single implementation and its tests become domain cases. |

---

## 9. Acceptance checklist

- [ ] No `layerMemory`/`layerSql` export remains in `packages/core/src/{Sessions,Users,Accounts,Verification,AuditLog}.ts`; each exports one `layer` requiring only its store port, plus Crypto/AuthEvents/hooks as listed in §3.9.
- [ ] `grep -rn "@awthaq/sql" packages/core/src/{Sessions,Users,Accounts,Verification,AuditLog}.ts` returns nothing. So does `grep -rn "Model.Override\|JSON.stringify\|actingAsType\|SqlError\|repo\.models" ` on those files.
- [ ] No "see `layerMemory`" or "`layerMemory`'s" cross-reference remains in core source.
- [ ] No `as` (including `as const`) and no return-type annotation on a new Effect/Layer const in any file this plan adds or rewrites.
- [ ] Five ports are in `@awthaq/ports`, each with `layerMemory`. Five SQL adapters are in `@awthaq/sql`. `Persistence.memory` and `Persistence.sql(options)` are in `@awthaq/core`.
- [ ] `StoreContract` is exported from `@awthaq/test` and passes on Ref, SQLite `:memory:`, SQLite WAL file and Postgres (`pnpm test:pg`), concurrency cases included.
- [ ] Every drift item in §2 has a canonical behaviour (§3.8) and a test name in §5 or a named owner plan (S-17 → §10 Q9, S-18 → plan 10, S-19 → plan 10, U-14 → plan 03, V-5 → plan 07 or Phase 8, V-9 → plan 03, A-9 → noted).
- [ ] The Phase 0 regression tests exist and pass on both twins (before Phase 2) and as domain or contract cases (after).
- [ ] The four duplicated test files are deleted; each core domain suite has one leg.
- [ ] README quickstart: `Persistence.sql()` replaces the six repositories, the five `layerSql` layers and `SqlTransaction.layerSql`; `ReadmeQuickstart.test.ts` passes.
- [ ] ADR-EA-041 is added; ADR-EA-014, 016, 018, 024, 028 and 031 are revised; the BEH-EA entries in §6 carry Document Control revisions; `spec/traceability.md` is updated; `pnpm spec:verify:strict` passes.
- [ ] Changesets exist for every phase; Phase 7's carries the `Migration:` text in §4.
- [ ] `pnpm check` passes and `pnpm test:pg` passes.
- [ ] The benchmark from R1 is recorded in the Phase 6 PR description (verify/issue p50/p99 before and after, Postgres).

---

## 10. Open questions (facts only you know)

1. **External consumers.** Do any private applications or branches outside this repository compose `X.layerSql`/`layerMemory` or the six `Repositories.*Live` directly? That decides whether Phase 7's `Migration:` text is enough or a temporary deprecation alias is worth keeping, despite ADR-EA-034 §2 allowing an immediate break.
2. **Is a KV `SessionStore` on the roadmap** (Redis or another backend)? If yes, `StoreContract` is public from day one, as planned. If no, it could stay test-internal, but the plan recommends public either way, because ADR-EA-014 names third-party backends.
3. **Transactional memory (Phase 8).** Do you want `Persistence.memory` to roll back on failure (via `TxRef`), accepting that a conflicting transaction re-runs its body, so it needs plan 10's after-commit events first? Or should memory stay "atomic per primitive only", as `SqlTransaction.layerNoop` documents?
4. **Tenant filtering of partitioned reads.** ADR-EA-018 says WHERE-discipline is "the whole story" on SQLite, but no repository filters reads by tenant: isolation exists only under Postgres RLS inside `withTenant`. Should the stores filter `sessions`, `verification_*` and `auth_audit_log` reads by the ambient tenant (S-13, V-8)? That is a product decision with a real behaviour change: a session from tenant A would stop verifying under tenant B's context.
5. **`deferMiss` intent (PV-220).** The plan takes SQL's meaning: a deferred miss spends nothing until `recordMiss`. Memory currently spends at once. Please confirm that is the intended semantics.
6. **AAPS-005 completeness.** Should `updateProfile`/`setStatus` announce only when a value actually changed, and should `verifyPhone`/`promoteIdentity` announce (that is, is `phoneVerified` policy-readable)? Left unchanged by this plan (U-13) unless you say so.
7. **Erasure across tenants under RLS.** `pseudonymizeActor` and `Verification.deleteAllByUser` act only on the current tenant when run inside `TenantScope.withTenant` on Postgres (L-7). Should erasure always run tenant-unscoped (the GUC unset), or is per-tenant erasure intended?
8. **`updatedAt` on `setFields`.** The plan bumps it (U-1 canonical). Does anything downstream (SCIM `meta.lastModified`, exports) rely on field writes *not* touching it?
9. **Legacy session bridge single-use (S-17).** The bridge's `consume` returns `void`, so two concurrent presentations of one better-auth token can mint two sessions. Is that acceptable for a migration window, or should the `LegacySessionBridge` port gain an atomic `claim`? That would be a separate change to `@awthaq/migrate-better-auth`.

---

## 11. Decisions taken (execution)

Open questions were answered with the plan's recommended default; where the plan gave none, the richest option with a real caller. The plan was written before plans 01, 03, 05, 06, 07 and 09 landed, so it was stale in several places (listed under each phase).

### Open questions (section 10)

1. **Q1 (external consumers of `layerSql`/`layerMemory`):** no deprecation alias; the break is immediate (ADR-EA-034 section 2 allows it, and no consumer outside this repository is known).
2. **Q2 (KV `SessionStore`):** `StoreContract` is public from day one (exported from `@awthaq/test`, cases as data).
3. **Q3 (transactional memory, phase 8):** not done. Memory stays "atomic per primitive". Plans 01 (`SignUp`'s unit) and 07 (`redeem`'s held-row compensation) already give a memory composition a way to leave nothing behind, and `Effect.tx` re-runs its body on conflict, including publishes and crypto, which would need every service re-audited. ADR-EA-041 lists it as a rejected alternative to revisit.
4. **Q4 (tenant filtering of partitioned reads):** no application-level filter; status quo (RLS is the backstop under `withTenant`).
5. **Q5 (`deferMiss`):** moot. Plan 10 item 5 and plan 07 removed `deferMiss`, `recordMiss` and `ConsumeOptions`.
6. **Q6 (AAPS-005 completeness):** unchanged (`updateProfile`/`setStatus` still always announce; `verifyPhone`/`promoteIdentity` still do not).
7. **Q7 (erasure across tenants under RLS):** unchanged; no tenant-unscoped erasure here.
8. **Q8 (`updatedAt` on `setFields`):** bumped (the plan's canonical U-1).
9. **Q9 (legacy bridge single-use):** unchanged and reported (the bridge port has no atomic claim; a separate change to `@awthaq/migrate-better-auth`).

### Phase 0 (hotfixes in place)

- **0.7 was stale.** Plan 10 item 5 and plan 07 removed `deferMiss`/`recordMiss`, and the miss spend already runs in the unit of work's `afterUnit` lane (so it survives a caller's rollback). The remaining bug was that the spend targeted the identifier, so a reissue between the miss and the spend charged the new token. Fix: `layerSql`'s claim reads the live row first (`findByIdentifier`) and `recordFailedAttempt` is pinned to that row's id (a reissue replaces the live row and its id, so it finds nothing). This costs one extra indexed read per claim; the plan's `sql.withTransaction` suggestion would not have helped under Postgres READ COMMITTED (the second statement takes a fresh snapshot), so it was not used. Regression test: "SOS-004: a reissue racing a miss never charges the new token".
- **`reserve` with `ttl <= 0` is not a defect.** `MagicLink`/`EmailOtp`'s `resendWindow: Duration.zero` is a valid way to disable the throttle, so a defect would be a regression. `expiresAt <= now` makes both layers grant at once, which is the consistent behaviour the plan wanted.
- **0.2 reauthenticate:** the repository takes an optional expected `amr` (compare-and-swap); the core loop re-checks liveness and ownership after each lost swap, so a dead row is still `SessionNotFound` and only genuine contention is `StoreUnavailable` (five attempts).
- **0.3:** `markReusedOnce` replaces `markReused`; the family revocation runs through `SqlTransaction.transactional` (the repo's `check:transactions` guard bans a bare `sql.withTransaction`).
- **0.5:** `AccountsRepository.lockByUser` (a no-op off Postgres); `Accounts.test.ts` now builds its database with `TestSql.layer("core_Accounts")` and is in `scripts/test-pg.sh`.
- **0.8:** `UsersRepository.verifyEmail` answers `Option<User>`; on `None` the domain re-reads and returns the current record without announcing (a vanished user is `UserNotFound` from that re-read).
- Plan 10 item 3 had already made `reauthenticate` refuse a dead session (S-18), so the `liveAt` guard in the plan's section 3.2 is already today's behaviour; `SessionStore.reauthenticate` keeps `liveAt` as a required `DateTime` guard rather than an option.

### Phase 1 (substrate)

- **Plan 05 landed first, so its names win** (README reconciliation): `StoreFailure` (with `retryTransient`, `orStoreUnavailable`) already lives in `@awthaq/sql`, and `Tenant.stamp` already exists in `@awthaq/ports` with a row-shaped signature (`{ tenantId: string | null }`). Plan 02's Option-shaped rule is added beside it as `Tenant.resolve(explicit: Option<string>)` rather than changing `stamp`. `SqlStore.write`/`read` is a thin wrapper over `StoreFailure` (the plan's own instruction), plus `drainBatches`.
- `PruneExpired` is its own public ports module (`packages/ports/src/PruneExpired.ts`), not `internal/`: core's twins use it until phase 7, and a third-party `Ref` adapter may too. `drainBatches` lives in `SqlStore` (public `@awthaq/sql` module) for the same reason.
- `StoreUnavailable` is declared in `@awthaq/ports` `Store.ts` as `Api.StoreUnavailable` (a second `export import` of the same class), so the port signatures do not import `@awthaq/sql`.
- `StoreContract` needs no `StoreContract.memory/sql/file.test.ts` runner files until a port has cases; phase 1 ships `StoreContract.test.ts` (the runner's own test) and each phase adds its runner entries. Cases never read the ambient clock (every primitive takes the instant it judges at), so they run on `Effect.runPromise`.
- The ports surface block in `spec/overview.md` lists `Ids`, `Store` and `PruneExpired`.
- ADR-EA-041 is written in phase 1 (status "Accepted") and moves to "Accepted — implemented" with phase 7.

### Phase 2 (AuditLog)

- `AuditFilter` has a single `eventTag` (not the plan's `eventTags` list): `AuditLog.list` filters by one tag, so a list would be speculative.
- The repository's `payload` is now the JSON text end to end (`Models.AuditLogRow.payload: Schema.String`), not a decoded `unknown`: the domain is the one codec, and an event does not pay for a decode and re-encode in the adapter on every publish. `AuditLogRepository.insert` became `insertIfAbsent` (`ON CONFLICT (id) DO NOTHING RETURNING id`, answering `boolean`), keeping the ADR-EA-037 savepoint inside a transaction. The plan's `append` is not wrapped in `captureToken`, as decided there.
- `SqlStore.make(sql)` (not top-level `SqlStore.write`/`read`): binding the client keeps a store primitive's requirement empty, as the port declares, and `capture` provides the captured client to `captureToken`.
- The transitional `AuditLog.layerSql` carries an explicit `Layer` type (the TS2883 exception: declaration emit cannot name `AuditLogRepository` through the adapter's inferred type); it is removed with the alias in phase 7.
- `relabel(operation)` lives in core `Errors.ts` (a `catchIf` over `StoreUnavailable`), so every domain operation names itself on the wire while an adapter names its primitive.
- `Layer.mock` (effect rc.116) builds the store double for the outage cases; the policy cases (`bestEffort`/`required`) moved onto it.
- `StoreContract` runners: `StoreContract.memory/sql/file.test.ts` share `packages/test/test/support/storeContract.ts`, where each later phase adds its port; `StoreContract.sql.test.ts` is in `scripts/test-pg.sh`. The contract uses `node:assert/strict`, so `@awthaq/test` still needs no test runner at runtime.
- Deleted from `packages/sql/test/contract.ts`: the two repository-level audit cases ("filters by an occurredAt range and round-trips the payload", "deleteOccurredBefore removes only rows older than the cutoff for the given tags"); both are `StoreContract.auditLog` cases now and run on Postgres under `test:pg`.
- Erasure under RLS (L-7) and `captureToken` on appends (L-9) are unchanged, per the plan.
