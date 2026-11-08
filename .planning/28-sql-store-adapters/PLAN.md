# Plan 28: SQL store adapters, residual gaps after plan 16 (fold `Repositories` into the adapters)

| | |
|---|---|
| Status | **Residual plan.** The candidate ("fold the core repositories into their store adapters") is already implemented on `architecture/deepening-plans-2`, by plan 16 (`.planning/16-sql-store-adapters/PLAN.md`, phases 0-7, commits `bb72df50`…`6b68edcc`, 2026-10-18), plan 23 (`RelayCursorStore` is a store port, `1c0d1a7a`…`6a28c4dd`) and plan 17 (core sealed columns on `SealedColumn`, `89d12ef8`…`5cbf528b`). This plan does not repeat them. It covers only the three gaps they leave against the 2026-11-08 review's target and requirements (§1). |
| Source | Architecture review of 2026-11-08 (`/improve-codebase-architecture`), which read `main`. `main` does not contain plans 16, 17 and 23. |
| Strength | Worth exploring, as a residual: one test-matrix gap, one live-bug remnant, and one ADR sentence |
| Dependency category | local-substitutable (SQLite `:memory:`, SQLite WAL, libSQL `file:` and Postgres behind one SQL adapter per port) |
| Wave / position | After `architecture/deepening-plans-2` merges with `main` (in progress). Tickets 01 and 02 are independent of every other plan. Ticket 03 lands with plan 25 (record-store-contract), or folds into it (§8). |
| Touches | `@awthaq/test` (a `StoreContract` runner), `@awthaq/organization` and `@awthaq/saml` (one classification call each), `spec/decisions/041-domain-store-ports.md`, `scripts/test-pg.sh` |
| Wire change | On libSQL only: a domain an OIDC connection already holds answers `ConnectionDomainTaken` instead of 503. On every driver: a SAML domain insert that fails on a non-unique constraint stops being reported as `SamlDomainTaken`. |
| Verified | 2026-11-08. **(1)** `architecture/deepening-plans-2` at `5a0e8df4`, read as committed objects (`git show 5a0e8df4:<path>`). The working tree has an in-progress merge of `main` (396 staged and 69 unstaged files), so its files were not used as evidence. **(2)** `main` at `935d15ee`, whose source equals `ede063d8`, for the probe results quoted in §2.3. `packages/sql/src/Repositories.ts` exists on `main` and does not exist on the branch (`git show 5a0e8df4:packages/sql/src/Repositories.ts` reports "does not exist"; the working tree has no `Repositories*` file). |

Vocabulary and conventions: as in `.planning/README.md`. No `as`, no return type annotation on a new Effect or Layer const, tests are replaced rather than layered, and a changeset with `Migration:` goes with every package-visible change. The phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, plus `pnpm test:pg` (Docker is installed; CI's `check` job sets `AWTHAQ_POSTGRES_URL`).

---

## 1. Summary, goals, non-goals

### Summary

On `architecture/deepening-plans-2`, each core SQL store adapter owns its statements. `Repositories.ts` is deleted. `@awthaq/sql` exports one bundle, `CoreStoresSql.layer({ encryptPii? })`, which `Persistence.sql` is. Each PII-bearing adapter exports `layer` and `layerSealedPii`. `RelayCursorStore` is a port in `@awthaq/ports` with `RelayCursorStoreSql`. `StoreContract` runs on the `Ref` adapters, SQLite, a WAL file, libSQL and Postgres. ADR-EA-041 is at revision 1.3 ("the SQL adapters own their statements … there is no repository layer", alternative (d)). Plan 16 also fixed the libSQL unique-violation bug that this plan's independent probe found on `main`: `StoreFailure.isUniqueViolation` was added in phase 0.

Measured against the 2026-11-08 target and requirements, three things are still open:

1. **The contract never runs on the sealed bundle.** "PII encryption becomes an adapter option" is done (`layerSealedPii`, `CoreStoresSql.layer({ encryptPii: true })`). But the "StoreContract is the safety net" requirement does not cover that option. `packages/test/test/support/storeContract.ts` builds `CoreStoresSql.layer()` only. `CoreSealedColumns.test.ts` runs `TestAuth.runSealedColumnTests` (the sealing mechanism) over `encryptPii: true`, not `StoreContract`. So the 36 `users` and `sessions` cases have never run against the adapter configuration that seals.
2. **Two plugin adapters still classify a unique violation by hand.** `organization/src/ConnectionRecords.ts:566` tests `reason._tag === "UniqueViolation"`, the exact check plan 16 replaced in core because libSQL reports `ConstraintError`. `saml/src/SamlRecords.ts:762` accepts **any** `ConstraintError` as "taken". That catches the SQLite primary-key clash it was written for, but also a foreign-key, NOT NULL or CHECK failure.
3. **ADR-EA-041 decision 5 does not state the one adapter shape.** Its text still names `SqlStore.write`/`read` (it is `SqlStore.make(sql)` → `write`/`read`/`once`). It says nothing about plugin records sharing the core adapters' shape. Today 0 plugin records modules use `SqlStore.make`. The convergence itself is plan 25's work, so this ticket only writes the rule down, with plan 25.

### Goals

- **G1** `StoreContract.users` and `StoreContract.sessions` pass on `CoreStoresSql.layer({ encryptPii: true })` on SQLite and Postgres, in every later gate.
- **G2** No source file outside `packages/sql/src/StoreFailure.ts` classifies a unique violation by `reason._tag`. Every caller uses `StoreFailure.isUniqueViolation`.
- **G3** ADR-EA-041 decision 5 describes the substrate as it is (`SqlStore.make`) and states the one SQL adapter shape that core stores and plugin records share.

### Non-goals

- **Anything plan 16, 17 or 23 already did:** the fold, the bundle, the per-store layers, `RelayCursorStore`, core sealing on `SealedColumn`, the libSQL runner and the `isUniqueViolation` fix in core. Also the ADR-EA-041 revision 1.3 for decisions 3 and 4, the BEH-EA-035/036/231 rewrites and the README changes.
- **A deprecation step for `Repositories`** (the review asked for one, per ADR-EA-034). Plan 16 removed the module with breaking changesets (`refactor(sql)!`, phases 2-6). ADR-EA-034 §2 allows that before 1.0, and `@awthaq/sql` is `private: true` and unpublished, so no consumer could have seen it. Nothing to backfill.
- **Moving the plugin records adapters onto `SqlStore.make`** (plan 25).
- **Any change to `isUniqueViolation`'s message-based rule** (§10 Q2).

---

## 2. Verified current state

### 2.1 Re-measurement commands (run on the merged tree; on the branch before the merge, prefix paths with `git show 5a0e8df4:`)

```bash
# Plan 16 is done: no repository module, one bundle, per-store layers
ls packages/sql/src/Repositories* 2>/dev/null | wc -l                            # 0
grep -n "^export const layer\|^export const layerSealedPii" packages/sql/src/{User,Session}StoreSql.ts
grep -n "Revision |" spec/decisions/041-domain-store-ports.md                    # 1.3

# Gap 1: the contract runner builds the plain bundle only, and nothing runs StoreContract sealed
grep -n "CoreStoresSql.layer(" packages/test/test/support/storeContract.ts       # one call, no options
rg -n "StoreContract" packages/test/test/CoreSealedColumns.test.ts | wc -l       # 0
rg -n "encryptPii" packages/test/test packages/sql/test features/step-definitions # CoreSealedColumns, CoreStoresSql.test, PersistenceStratumWorld only

# Gap 2: hand-written unique-violation checks outside StoreFailure
rg -n '"UniqueViolation"|"ConstraintError"' packages/*/src --glob '!packages/sql/src/StoreFailure.ts'
#   packages/organization/src/ConnectionRecords.ts:566   reason._tag === "UniqueViolation"
#   packages/saml/src/SamlRecords.ts:762                 "UniqueViolation" || "ConstraintError"

# Gap 3: decision 5's text, and plugin use of SqlStore.make
sed -n '/^\*\*5\./p' spec/decisions/041-domain-store-ports.md                    # names SqlStore.write/read
rg -l "SqlStore\.make" packages/*/src | grep -v "^packages/sql" | wc -l           # 0
```

### 2.2 What plan 16 (with 17 and 23) delivered, checked against the 2026-11-08 target

| Review target or requirement | On `architecture/deepening-plans-2` | Evidence |
|---|---|---|
| Each `*StoreSql` owns its statements | Done | `11416585` "SessionStoreSql owns its statements and both advisory locks; Repositories is deleted"; `ed1ac91f`, `6d3a955a`, `0a449314`, `79909faf` for the other four |
| PII encryption is an adapter option | Done (`layer` / `layerSealedPii`; `CoreStoresSql.layer({ encryptPii })`) | `UserStoreSql.ts:510-513`, `SessionStoreSql.ts:645-648`, `CoreStoresSql.ts` at `5a0e8df4` |
| Repositories stop being public; classify each | Done: all seven removed, including `RelayCursorRepository` | plan 16 §3, Decisions taken; plan 23 `6a28c4dd` |
| ADR-EA-041 revision line | Done for decisions 3 and 4 (revision 1.3, alternative (d)); **decision 5 not revised** | `041-domain-store-ports.md` Change History at `5a0e8df4`; gap 3 |
| `StoreContract` is the safety net on SQLite and Postgres at every phase | Done for the plain bundle, and libSQL added; **not run on the sealed bundle** | `bb72df50`; `support/storeContract.ts:79`; gap 1 |
| Breaking removal, with deprecation per ADR-EA-034 | Removed with breaking changesets; no deprecation step (moot, see non-goals) | `refactor(sql)!` commits |
| Coordinate with the core sealed-columns item (now plan 30) | **Already done** on the branch by plan 17: core columns are `SealedColumn`s under the canonical AAD | `b97c8c20`, `9416e17a`, `5cbf528b` |
| Coordinate with the contract runner (now plan 25) so core and plugin adapters share one shape | Core side done; plugin side open (0 plugin modules on `SqlStore.make`; two inline unique checks) | gaps 2 and 3 |

### 2.3 Evidence for the three gaps

- **Gap 1.** On `main`, a read-only probe ran `StoreContract.users` and `StoreContract.sessions` against the encrypted repository variants (what `main`'s `Persistence.sql({ encryptPii: true })` composes). It passed 36 of 36. The probe imported the built `lib/` by absolute path and wrote nothing to the repository. On the branch, plan 17 changed sealing to cross the ports as `Sealed<A>`. The contract cases already read those values through `opened(...)` (`StoreContract.ts:81-82`, used at :1185, :1548), so they are adapter-agnostic. Nothing runs them on the sealed configuration, though, so whether they pass there is unverified.
- **Gap 2, `ConnectionRecords`.** `replaceDomains` (`ConnectionRecords.ts:556-569`) maps `UniqueViolation` to `ConnectionDomainTaken` and passes every other error on to the store-failure mapping. On libSQL a duplicate domain arrives as `ConstraintError` (plan 16 phase 0 found this for `users`), so the clash answers `StoreUnavailable` (503) instead of `ConnectionDomainTaken`. The mechanism is the same as the confirmed core case. It was **not run**, because `@awthaq/organization` has no libSQL test.
- **Gap 2, `SamlRecords`.** `claimDomains` (`SamlRecords.ts:753-768`) maps `UniqueViolation || ConstraintError` to `SamlDomainTaken`. The comment explains why: SQLite reports a PRIMARY KEY clash as a generic constraint error. But a foreign-key failure on `"connectionId"`, or a NOT NULL failure, would also be reported to the caller as "domain taken". SQLite's message for a PRIMARY KEY clash is "UNIQUE constraint failed: …", which `isUniqueViolation`'s message rule (`StoreFailure.ts:57-75` at `5a0e8df4`) already accepts. So switching narrows the mapping without losing the case it exists for. `SamlRecords.test.ts:125,159` pins that case.
- **Gap 3.** Decision 5 at `5a0e8df4`: "`@awthaq/sql`'s `SqlStore.write`/`read` wrap `StoreFailure` …". The module exports `make(sql)`, which returns `{ write, read, once }` (`SqlStore.ts`). No decision says a plugin records adapter follows the same rules, and `docs/plugin-authoring.md` § Contract still prescribes `StoreFailure.orStoreUnavailable` per method.

### 2.4 Evidence corrections (against the review text)

| Review claim | Correction |
|---|---|
| The repositories remain in `@awthaq/sql` | True on `main` (`935d15ee`); false on `architecture/deepening-plans-2`, where plan 16 deleted them. |
| "e.g. `RelayCursorRepository`" has a real second caller | False. Its one production caller was core's `EventRelay.layerCursorSql`. Plan 23 made `RelayCursorStore` a port and removed the repository. |
| ADR-EA-041 §5 says adapters are built "over the existing repositories" | That clause was in decision **3**, and revision 1.3 already rewrote it. Decision 5 is the substrate decision, and it is the one still stale (gap 3). |
| The core sealed-columns item still needs doing (plan 30) | Done on the branch by plan 17 (ADR-EA-019 revision 1.3, BEH-EA-339). |
| `SessionsRepository` had 17 methods | On `main` it has 14 methods plus `models`. Moot on the branch. |

---

## 3. Target design

### 3.1 A sealed runner beside the plain ones (ticket 01)

```ts
// packages/test/test/support/storeContract.ts
const sqlStores = <E>(
  client: Layer.Layer<SqlClient.SqlClient, E>,
  options: CoreStoresSql.Options = {},
) =>
  CoreStoresSql.layer(options).pipe(
    Layer.provide(EncryptionLive),
    Layer.provideMerge(client),
    Layer.provideMerge(migrated(client)),
  );

/** The ports whose SQL adapter has a sealing option: the only ones `encryptPii` changes. */
export const runSealedOnSql = <E>(label: string, client: Layer.Layer<SqlClient.SqlClient, E>) => {
  StoreContract.run(framework, {
    adapter: `UserStore (${label}, encryptPii)`,
    layer: sqlStores(client, { encryptPii: true }),
    cases: StoreContract.users,
  });
  StoreContract.run(framework, {
    adapter: `SessionStore (${label}, encryptPii)`,
    layer: sqlStores(client, { encryptPii: true }),
    cases: StoreContract.sessions,
  });
};
```

```ts
// packages/test/test/StoreContract.sealed.test.ts (new)
// The contract on the bundle that seals users.metadata and sessions.ipAddress/userAgent
// (CSG-006). SQLite `:memory:` by default; a Postgres schema under `pnpm test:pg`.
import * as TestSql from "../src/TestSql.ts";
import { runSealedOnSql } from "./support/storeContract.ts";

runSealedOnSql("SQL", TestSql.layer("store_contract_sealed"));
```

`runOnSql` and its callers keep their signatures. `sqlStores(client)` with no options builds what it builds today.

### 3.2 One classification rule (ticket 02)

```ts
// packages/organization/src/ConnectionRecords.ts (replaceDomains)
Effect.mapError((error) => (StoreFailure.isUniqueViolation(error) ? domainTaken(domain) : error)),

// packages/saml/src/SamlRecords.ts (the domain insert)
Effect.mapError((error) =>
  StoreFailure.isUniqueViolation(error) ? new SamlDomainTaken({ domain }) : error,
),
```

Both modules already import `StoreFailure` from `@awthaq/sql`; if one does not, the import is added. The SAML comment is rewritten. A primary-key clash is a unique violation to `isUniqueViolation` (SQLite says "UNIQUE constraint failed"). Any other constraint failure goes to the store-failure mapping, like everywhere else (ADR-EA-028).

### 3.3 ADR-EA-041 decision 5, revised (ticket 03)

> **5. One adapter substrate, one adapter shape.** A SQL store adapter (a core `<Port>Sql`, or a plugin's records `layerSql`) is one module over the ambient `SqlClient`:
> - It resolves the dialect once (`Models.resolveDialect`; codecs from `Models.makeModels`/`dialectFields`).
> - It declares its own statements (`SqlSchema`, and `SqlModel.makeRepository` for generated CRUD).
> - It runs each primitive through `SqlStore.make(sql)`. `write`: classified by `StoreFailure` (an outage is `StoreUnavailable`; a decode failure or a refused statement is a defect), with a transient failure retried at the top level only, never inside a caller's transaction. `read`/`once`: the same classification, never retried, for reads and for writes whose repetition would change their answer. The label is `<Port>.<primitive>`.
> - It treats a constraint failure as a domain outcome only through `StoreFailure.isUniqueViolation`, whatever the driver called it.
> - It opens `SqlTransaction.transactional(sql)` only to make one primitive atomic: a savepoint inside a caller's (OHS-002).
> - It captures the causal token on writes that change a replica-eligible listing (ADR-EA-024).
> - It stamps the tenant through `Tenant.stamp`/`Tenant.resolve` (core tables) or `TenantScoped` (plugin tables).
> - It seals through `SealedColumn`.
>
> The core adapters follow it (plan 16), and the plugin records adapters follow it from plan 25. The tenant-stamp rule is `Tenant.stamp`/`Tenant.resolve` in `@awthaq/ports`, used by both adapter families.

Change History line (revision 1.4, or the next free number if plan 25 revises the ADR first):

> `1.4 (YYYY-MM-DD): decision 5: the substrate is SqlStore.make (write/read/once); one SQL adapter shape for core stores and plugin records, unique violations classified by StoreFailure.isUniqueViolation (architecture plans 28 and 25)`

`docs/plugin-authoring.md` § Contract replaces "pipe each method through `StoreFailure.orStoreUnavailable`" with the `SqlStore.make` rule, **only when plan 25 has moved the plugins**. Until then the doc describes what the code does.

---

## 4. Phased migration

One phase. The tickets are independent of each other. Track them as `.scratch/28-sql-store-adapters/issues/NN-*.md`.

### 01 — `StoreContract` on the sealed bundle (users, sessions)

- **Files:** `packages/test/test/support/storeContract.ts`, `packages/test/test/StoreContract.sealed.test.ts` (new), `scripts/test-pg.sh` (add the new file beside `StoreContract.sql.test.ts`).
- **Change:** §3.1. If a case fails on the sealed bundle, it is a live bug in the sealed path. Fix it in the adapter (`UserStoreSql`/`SessionStoreSql` or `CoreSealedColumns`), not in the case, and record it under Decisions taken.
- **Done when:** the new file reports 36 passing cases (14 `UserStore` + 22 `SessionStore`) on SQLite and under `pnpm test:pg`. `rg -n "encryptPii: true" packages/test/test/support/storeContract.ts` returns 1 line. The plain runners' counts are unchanged.
- **Gate:** `pnpm vitest run packages/test/test/StoreContract.*.test.ts && pnpm test:pg && pnpm typecheck && pnpm lint && pnpm knip`. Changeset: `pnpm changeset --empty` (tests only), unless a fix lands, which then gets a patch changeset naming the bug.

### 02 — The last inline unique-violation checks use `StoreFailure.isUniqueViolation`

- **Files:** `packages/organization/src/ConnectionRecords.ts` (`replaceDomains`), `packages/saml/src/SamlRecords.ts` (the domain insert and its comment), `packages/saml/test/SamlRecords.test.ts` (one new case), `.changeset/plugin-unique-violation.md`.
- **Change:** §3.2. New SAML case: an insert that fails a non-unique constraint is not `SamlDomainTaken`. For example, a domain row whose `"connectionId"` names no connection, if the table declares the foreign key; otherwise a NOT NULL violation through a raw insert in the test.
- **Done when:** `rg -n '"UniqueViolation"|"ConstraintError"' packages/*/src --glob '!packages/sql/src/StoreFailure.ts'` returns 0 (baseline: 2, at `ConnectionRecords.ts:566` and `SamlRecords.ts:762`). `ConnectionRecords.test.ts:100,134`, `OrganizationConnections.test.ts:221` and `SamlRecords.test.ts:125,159` still pass on SQLite and Postgres. The new SAML case passes.
- **Gate:** `pnpm vitest run packages/organization packages/saml && pnpm test:pg && pnpm typecheck && pnpm lint`. Changeset (patch, `@awthaq/organization`, `@awthaq/saml`): "Fix: on libSQL a domain another OIDC connection holds answers `ConnectionDomainTaken`, not 503; a SAML domain insert that fails a non-unique constraint is no longer reported as `SamlDomainTaken`. Migration: none. ADR-EA-028, ADR-EA-041."

### 03 — ADR-EA-041 decision 5: the substrate as it is, and one adapter shape

- **Files:** `spec/decisions/041-domain-store-ports.md` (decision 5, Document Control, Change History), `spec/traceability.md` (revision line), and, conditionally, `docs/plugin-authoring.md` § Contract.
- **Change:** §3.3.
- **Done when:** decision 5 names `SqlStore.make` and `isUniqueViolation`. `rg -n "SqlStore.write/" spec/decisions/041-domain-store-ports.md` returns 0. `pnpm spec:verify:strict` passes.
- **Gate:** `pnpm spec:verify:strict && pnpm check:readmes`. Changeset: `pnpm changeset --empty`.

| # | Title | Phase | Depends on |
|---|---|---|---|
| 01 | `StoreContract` on the sealed bundle (users, sessions) | 1 | the `main` merge |
| 02 | The last inline unique-violation checks use `StoreFailure.isUniqueViolation` | 1 | the `main` merge |
| 03 | ADR-EA-041 decision 5: the substrate as it is, and one adapter shape | 1 | plan 25's plugin convergence (or folds into it) |

---

## 5. Test plan

- **New:** `StoreContract.sealed.test.ts`: 36 cases on SQLite, and the same 36 on Postgres under `test:pg`. One SAML case: a non-unique constraint failure is not "taken".
- **Unchanged and still the bar:** the plain `StoreContract` runners (Ref, SQLite, WAL, libSQL, Postgres); `CoreSealedColumns.test.ts` (the sealing mechanism over `encryptPii: true`); `StoreFailure.test.ts:145-172` (`isUniqueViolation`, including the libSQL message).
- **Deleted:** nothing. The gaps are missing coverage, not duplicated coverage.
- **libSQL for the plugin fix:** not added to `@awthaq/organization`, which would need a new devDependency. The rule is proven once in `StoreFailure.test.ts`, the grep gate in ticket 02 keeps every caller on it, and the core libSQL runner proves the driver's error shape end to end.
- **Shrinkage:** none intended. Inline classification sites go from 2 to 0.

---

## 6. Spec, ADR, traceability, BDD, docs, changesets

| Artifact | Change |
|---|---|
| ADR-EA-041 | Decision 5 rewritten (§3.3); revision 1.4 (or next); Change History line |
| `spec/traceability.md` | Revision bump; the ADR-EA-041 row adds `packages/test/test/StoreContract.sealed.test.ts` |
| BEH-EA-034 (05-persistence-stratum, the CSG-006 paragraph) | One sentence: "the store contract runs on the sealed bundle (`StoreContract.sealed.test.ts`)"; Document Control bump |
| BEH-EA-325 | Add: "a constraint failure is a domain conflict only through `StoreFailure.isUniqueViolation`"; Document Control bump |
| BDD | None. No behaviour a scenario covers changes on SQLite or Postgres. |
| `docs/plugin-authoring.md` | Only with plan 25 (ticket 03) |
| Changesets | Ticket 01: empty, or a patch if it finds a bug. Ticket 02: patch, `Migration: none`. Ticket 03: empty. |

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| Ticket 01 finds a failing case on the sealed bundle | That is the point of the ticket. Fix the adapter, not the case, and record it. |
| The SAML switch drops the primary-key clash on some driver | `SamlRecords.test.ts:125,159` pin it on SQLite and Postgres. The libSQL message is the same SQLite text `isUniqueViolation` reads. |
| `isUniqueViolation` reads a message, so a locale or driver that rewords it would miss | Pre-existing (plan 16's choice); §10 Q2. |
| Merge conflicts with the in-progress `main` merge | Start after the merge commits. The tickets touch four source files and one test helper. |

**Rollback:** each ticket is a `git revert` (no schema, no data, no public export changes).

---

## 8. Interactions with other plans

| Plan | Interaction |
|---|---|
| 16 (branch) | Parent: this plan exists only because plan 16 is done; every other part of the 2026-11-08 candidate is plan 16's. |
| 17 (branch) | Already moved core sealing onto `SealedColumn`; ticket 01 tests its sealed path through the store contract. |
| 23 (branch) | Already made `RelayCursorStore` a port; nothing left. |
| 24 (branch, memory records over SQLite) | No overlap. |
| **25** record-store-contract | Moves plugin records onto atomic primitives and a shared, data-driven runner. It should also adopt decision 5's shape (`SqlStore.make`, `isUniqueViolation`). Ticket 03 is written with it, or folds into it. If plan 25 rewrites `ConnectionRecords`/`SamlRecords` first, ticket 02 folds into it. `runSealedOnSql` (ticket 01) uses the same runner, so plan 25's generalisation should keep a sealed variant. |
| **30** speculative-followups | Its "core sealed columns under `SealedColumn`" item is **already done** on the branch by plan 17. |
| 26, 27, 29 | No interaction. |

---

## 9. Acceptance checklist

- [ ] `pnpm vitest run packages/test/test/StoreContract.sealed.test.ts` reports 36 passing cases; `pnpm test:pg` runs it on Postgres.
- [ ] `scripts/test-pg.sh` lists `packages/test/test/StoreContract.sealed.test.ts`.
- [ ] `rg -n '"UniqueViolation"|"ConstraintError"' packages/*/src --glob '!packages/sql/src/StoreFailure.ts'` returns 0.
- [ ] The new SAML case (a non-unique constraint failure is not `SamlDomainTaken`) passes, and `SamlRecords.test.ts`/`ConnectionRecords.test.ts` still pass on SQLite and Postgres.
- [ ] ADR-EA-041 decision 5 names `SqlStore.make` and `isUniqueViolation`; `pnpm spec:verify:strict` passes.
- [ ] `pnpm check` passes.

---

## 10. Open questions only the user can answer

1. **Does `architecture/deepening-plans-2` merge into `main`?** Default: yes, and this residual plan runs after it. If the branch were abandoned, the whole candidate would be open on `main` again, and the right plan would be to port branch plans 23, 17 and 16 there, not this one.
2. **Keep `isUniqueViolation`'s message test ("UNIQUE constraint failed")?** The alternative is libSQL's structured `extendedCode: "SQLITE_CONSTRAINT_UNIQUE"` / `rawCode: 2067`, which the 2026-11-08 probe saw on `@effect/sql-libsql` 4.1.2. Default: keep the message (it also covers node:sqlite's primary-key clash) and add the structured fields as a second test only if an upstream `effect` fix lands.
3. **Should the sealed runner cover the WAL-file and libSQL backends too?** Default: no. Sealing is driver-independent; SQLite `:memory:` and Postgres are enough.

---

## Decisions taken (implementation record)

### Wave 0: tickets 01–02, PR #48 (merged 2026-11-08)

- Ticket 01: `StoreContract.sealed.test.ts` runs the contract on `CoreStoresSql.layer({ encryptPii: true })` (`runSealedOnSql`, listed in `scripts/test-pg.sh`). All 38 cases (not the plan's 36) pass on SQLite and Postgres; no bug on the sealed path.
- Ticket 02: organization and SAML classify through `StoreFailure.isUniqueViolation`. Red first: `ConnectionRecords` on a libSQL file failed 2 cases with `StoreUnavailable` (the 503 confirmed); a trigger refusing the SAML domain insert came back `SamlDomainTaken`.
- Q2 (recommended): the message rule stays in `isUniqueViolation`. Q3 (recommended): the sealed runner covers SQLite and Postgres only.
- Deviations: §3.2's snippet would narrow `SqlError` out of the error type (type guard in a ternary), so the fix uses `Effect.catchIf((e) => StoreFailure.isUniqueViolation(e), …)`. §5 said not to add libSQL to organization; `@effect/sql-libsql` became a dev dependency to reproduce the 503. The SAML table has no foreign key, so its case uses `TestSql.injectFailure` (red on SQLite only; Postgres already answered `StoreUnavailable`).
- Ticket 03 is still open and lands with plan 25.

### Ticket 03, with plan 25 (branch `feat/record-store-contract`)

- ADR-EA-041 decision 5 rewritten as §3.3 ("one adapter substrate, one adapter shape"), in revision 1.5, the same revision that adds plan 25's decision 9 (1.4 had been taken by plan 15). It also names `SqlStore.atomically` as the multi-row variant of the transactional rule, and says which plugin stores already follow the shape (organization) while the rest still pipe through `orStoreUnavailable`.
- `docs/plugin-authoring.md` § Contract keeps `orStoreUnavailable` (most plugins still use it, as the ticket's condition requires); the record-store and multi-statement sections teach `SqlStore.atomically`.

