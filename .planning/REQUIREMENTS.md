# Requirements: awthaq

**Defined:** 2026-11-14
**Core Value:** Composition is checked by the compiler: a missing plugin, port or duplicate slot is a compile error, not a runtime surprise.

## v1.0 Requirements

Milestone "Architecture Deepening, batch 3". Each maps to roadmap phases. Research: `.planning/research/SUMMARY.md`. Defaults taken on open decisions are listed under "Decisions taken".

### CLI views (C5)

- [ ] **CLI-01**: Maintainer can render every `plugin` view (hooks, rules, events, graph) through one views module that resolves `--format` and `--json` once, with identical output to today (graph: `dot` beats `--json`; hooks/rules/events have no dot branch)
- [ ] **CLI-02**: A mode x (text, `--format json`, `--json`, dot) test matrix pins current CLI output before the refactor
- [ ] **CLI-03**: `ConfigList` is removed from the package export and inlined, with a changeset carrying a `Migration:` line and `spec/behaviors/26-cli.md` (lines 46, 398) updated and Revision bumped
- [ ] **CLI-04**: `Migration.apply` and `Openapi` use the same `Output` seam where it costs no behavior change

### TestAuth split (C4)

- [ ] **TEST-01**: `packages/test/src/TestAuth.ts` is split into modules under `internal/` (composition, session/CSRF minting, app harness, contract runner) and `TestAuth.ts` stays as a facade; the exported `TestAuth.*` name set is identical before and after
- [ ] **TEST-02**: `buildContext` is kept and `migratedSchema` still calls `TestSql.schemaOf`
- [ ] **TEST-03**: The open-app counter stays beside `serve`/`openApps`, and `LeakGuard` accounting is unchanged
- [ ] **TEST-04**: `spec/behaviors/25-testing-harness.md` and `spec/traceability.md` cite the new implementation locations while keeping cited test file names

### Keyset page (C1)

- [ ] **KEY-01**: A keyset-page module in `@awthaq/ports` owns limit clamp (1..200, default 50), `limit + 1` handling, next-cursor derivation and the in-memory comparator derived from the declared order
- [ ] **KEY-02**: Users, organizations and impersonations adopt it, with one page contract (the store primitive owns `+1`; `OrganizationRecords.listPage` and `AdminTenants` change in one commit)
- [ ] **KEY-03**: A SQL row-value predicate builder in `@awthaq/sql` replaces the expanded-`OR` spellings and refuses mixed-direction orders
- [ ] **KEY-04**: Cursors stay byte-identical per listing (`startedAt` vs `createdAt`), proven by a golden test against today's three schemas
- [ ] **KEY-05**: `StoreContract`/`RecordsContract` gain page-order cases (ties by id, exactly-full final page, sub-millisecond timestamps, mixed-case ids) and `pnpm test:pg` passes in CI
- [ ] **KEY-06**: Duplicate `pageLimit`/`listLimit`/`MAX_PAGE_SIZE` copies are deleted (verified by grep), and the post-page admin gate stays in the caller
- [ ] **KEY-07**: Membership offset paging, `SessionStore.listLive`, SCIM paging, audit log and webhook deliveries are explicitly untouched
- [ ] **KEY-08**: `spec/overview.md` `surface:ports` lists the module; BEH-EA-036 is amended to scope "store ports" to core ports; keyset id ordering is declared collation-stable by construction with a mixed-case `test:pg` case

### Connection lifecycle (C2)

- [ ] **CONN-01**: An exposed organization service owns the SAML/OIDC connection lifecycle (claim domain then connection row in one transaction, release on delete and on organization deletion), parameterized by a protocol descriptor
- [ ] **CONN-02**: Create and update refuse a suspended organization for both SAML and OIDC (`findActive`); remove does not check; a failing scenario lands first and BEH-EA-237/318 are amended
- [ ] **CONN-03**: BEH-EA-317 holds: claim first, claim and row atomic, memory twin compensates, no event is emitted for a rolled-back claim
- [ ] **CONN-04**: The module takes `SqlTransaction` as a service (`check:transactions` passes), keeps protocol error tags and `onTaken`, and imports no SAML types into `organization`
- [ ] **CONN-05**: `DomainClaims` leaves the organization root export; ADR-EA-040 gets a revision line; a Postgres update-vs-remove race case asserts outcome counts
- [ ] **CONN-06**: SCIM is excluded except the shared active-organization gate and deletion hook; the SCIM `createConnection` orphan case is recorded as a finding

### Table list (C6)

- [ ] **CAT-01**: One core-table list in `@awthaq/sql` (name, owner, tenancy, sealed) is the source that `Auth.ts`, `LaggingReplica` and `TenantScope.coverage` project from
- [ ] **CAT-02**: `auth_relay_cursor` and `rate_limit_buckets` are classified (included or documented as excluded)
- [ ] **CAT-03**: The catalogue carries no column types or DDL (ADR-EA-004), the `core -> sql` edge stays, and a declaration-list snapshot protects sealed AADs
- [ ] **CAT-04**: If only the `LaggingReplica` copy proves real after re-grep, ship it as a minimal fix and close the candidate

### Record-store scaffolding (C7, gated)

- [ ] **REC-01**: Plan 24 Track A is recorded closed (ADR-EA-041 revision note) and ADR-EA-046's fate is decided before any scaffolding work starts
- [ ] **REC-02**: A spike on `DeviceClientRecords`, `ApiKeyClientRecords`, `ApiKeyRecords` and `DeviceGrantRecords` yields a go/no-go; no-go if fewer than ~5 files share a helper
- [ ] **REC-03**: On go, shared comparators, tenant-visibility plumbing, `unavailable(op)` labelling, a dialect wire row helper and `SqlStore.make` adoption replace the repeated scaffolding, with no `*Shape` change
- [ ] **REC-04**: Every `layerMemory` stays one `Ref<State>`; lock-key strings and operation labels stay byte-identical; `docs/plugin-authoring.md` and `examples/plugin-template/` update last

### World scaffold (C3)

- [ ] **WORLD-01**: All Worlds are classified; a scaffold in `features/step-definitions/shared/` wraps `TestAuth.layer` for the shared tail (`lazyApp`, `TestClock`, capture layers) in the Worlds that repeat it
- [ ] **WORLD-02**: The five hand-wired exempt Worlds are not migrated; `LeakGuard` accounting and the compile-error-on-missing-plugin gate are kept; no second host composer is created

### Credentials (C8)

- [ ] **CRED-01**: `server/src/Credentials.ts` is split into files under `server/src/internal/` with every `Credentials.*` name still on the public namespace and ADR-EA-042 untouched

### Cross-cutting gates

- [ ] **GATE-01**: Every phase passes `tsc -b`, `pnpm test`, `pnpm test:bdd`, `pnpm circular`, `pnpm spec:verify:strict`, `pnpm check:error-tags`, `pnpm check:transactions`, `pnpm coverage` floors and `pnpm knip` against the recorded baseline; `tsc -b` runs before every cross-package vitest run
- [ ] **GATE-02**: The knip baseline (3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`, `.reports/`, untracked `.claude/`) is recorded before Phase 1
- [ ] **GATE-03**: Every package-visible change ships one changeset per candidate with a `Migration:` line for breaking exports; spec Revision and Change History are bumped together
- [ ] **GATE-04**: Phases touching SQL (keyset, lifecycle, record scaffolding) are verified on Postgres in CI and record "not run locally"

## Future Requirements

Deferred; tracked but not in this milestone.

### Keyset follow-ups

- **KEY-F1**: Convert `MembershipRecords` offset paging to keyset (wire change)
- **KEY-F2**: Opaque cursor tokens

### SCIM

- **CONN-F1**: Bring SCIM into the connection lifecycle if it gains domains and update

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replacing memory twins with SQLite `:memory:` | SQLite cannot reproduce Postgres races; plan 25 and ADR-EA-041 decision 9 keep two adapters |
| A second plugin-list-to-host composer | `TestAuth.layer` is the host (BEH-EA-342, ADR-EA-044) |
| Reopening ADR-EA-042 | Landed days ago; C8 is a file split only |
| New dependencies or version bumps | Research found none needed |
| `SqlModel.makeRepository` | Unstable and lacks tenancy, sealed columns, leases and the memory twin |
| Cursor wire change | Kept byte-identical by decision |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CLI-01 | Phase 1 | Pending |
| CLI-02 | Phase 1 | Pending |
| CLI-03 | Phase 1 | Pending |
| CLI-04 | Phase 1 | Pending |
| TEST-01 | Phase 2 | Pending |
| TEST-02 | Phase 2 | Pending |
| TEST-03 | Phase 2 | Pending |
| TEST-04 | Phase 2 | Pending |
| KEY-01 | Phase 3 | Pending |
| KEY-02 | Phase 3 | Pending |
| KEY-03 | Phase 3 | Pending |
| KEY-04 | Phase 3 | Pending |
| KEY-05 | Phase 3 | Pending |
| KEY-06 | Phase 3 | Pending |
| KEY-07 | Phase 3 | Pending |
| KEY-08 | Phase 3 | Pending |
| CONN-01 | Phase 4 | Pending |
| CONN-02 | Phase 4 | Pending |
| CONN-03 | Phase 4 | Pending |
| CONN-04 | Phase 4 | Pending |
| CONN-05 | Phase 4 | Pending |
| CONN-06 | Phase 4 | Pending |
| CAT-01 | Phase 5 | Pending |
| CAT-02 | Phase 5 | Pending |
| CAT-03 | Phase 5 | Pending |
| CAT-04 | Phase 5 | Pending |
| REC-01 | Phase 6 | Pending |
| REC-02 | Phase 6 | Pending |
| REC-03 | Phase 6 | Pending |
| REC-04 | Phase 6 | Pending |
| WORLD-01 | Phase 7 | Pending |
| WORLD-02 | Phase 7 | Pending |
| CRED-01 | Phase 7 | Pending |
| GATE-01 | Phase 1 | Pending |
| GATE-02 | Phase 1 | Pending |
| GATE-03 | Phase 1 | Pending |
| GATE-04 | Phase 3 | Pending |

**Coverage:**
- v1.0 requirements: 37 total
- Mapped to phases: 37
- Unmapped: 0 ✓

GATE-01, GATE-03 and GATE-04 bind every relevant phase; each is mapped to the phase that first establishes it (GATE-01/02/03 to Phase 1, GATE-04 to Phase 3, applying also to Phases 4 and 6). REC-03 and REC-04 are conditional on the Phase 6 spike go decision.

## Decisions taken (defaults, open to adjustment)

- SAML suspended-organization gate: `findActive` on create and update, none on remove (user-confirmed)
- Cursor wire format: byte-identical per listing (user-confirmed)
- Postgres id collation: declare collation-stable by construction, not `COLLATE "C"`, unless CI shows drift
- BEH-EA-036: amend wording; Membership offset paging stays
- C3 scaffold lives in `features/step-definitions/shared` only
- `plugin list --format dot` precedence preserved exactly

---
*Requirements defined: 2026-11-14*
*Last updated: 2026-11-14 after roadmap creation (traceability filled)*
