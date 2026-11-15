---
phase: "03"
slug: keyset-page-module
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on (high) severity
threats_open: 0
asvs_level: 1
block_on: high
created: "2026-11-14"
---

# Phase 03 - Security (Keyset-page module)

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Verified against the code at HEAD (`31514568`) with the phase base `e74a8a9a`. ASVS level 1 (the mitigation is present at the cited location), block on high.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| HTTP client -> admin listing routes (`/admin`, `/admin/users`, `/admin/organizations`) | untrusted `limit` and `cursor` query values | page size, base64url JSON cursor (`createdAt`/`startedAt`, `id`) |
| admin caller -> listing gates | who may page users, organizations and episodes | caller identity, per-row episode decision |
| decoded cursor / declaration -> SQL text | cursor fields reach the WHERE clause; column names and directions become SQL text | cursor values (bound), column names (module constants) |
| tenant-scoped admin caller -> impersonation history | a tenant administrator sees only their tenant's episodes | episode rows with `tenantId` |
| `limit` -> store read size | an in-process caller or decoded wire value chooses a read size | integer |
| spec / changeset -> third-party store authors | what an outside adapter follows | documentation |
| working tree / phase branch -> committed record and main | baseline output, golden literals, phase-close evidence | paths, counts, test literals |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation (evidence) | Status |
|-----------|----------|-----------|----------|-------------|-----------------------|--------|
| T-03-01 | Information disclosure | 03-BASELINE.md raw output | low | mitigate | Baseline holds gate summaries, knip lists, grep lines, docker status only (`03-BASELINE.md:178`); the phase diff touches nothing under `.claude/`, `.reports/`, `.scratch/` (every changed path is in `.planning/`, `packages/{ports,sql,core,admin,organization,test}/{src,test}`, `spec/`, `features/`, `.changeset/`). See note N3 for the one literal pasted | closed |
| T-03-02 | Tampering | golden literals (KEY-04 oracle) | medium | mitigate | `packages/admin/test/KeysetCursors.test.ts` has an independent `Buffer` derivation (`:23`); history is two commits with 0 deletions (`667e9918` +476/-0, `b5bc1360` +84/-0), so append-only | closed |
| T-03-03 | Elevation of privilege | `AdminTenants.listOrganizations` gate before paging; `Admin.list` per-row gate after paging | high | mitigate | `gate.collection(caller, "listOrganizations")` is the first statement (`packages/admin/src/AdminTenants.ts:191`); `Admin.list` still calls `gate.visibleEpisodes` after the page (`packages/admin/src/Admin.ts:990`, `internal/AdminGate.ts:405-415`); `Admin.ts` and `internal/AdminGate.ts` are byte-unchanged since `e74a8a9a`; pins `KeysetHttp.test.ts:137` (403 before paging), `KeysetPins.test.ts:370` (replay under another tenant). See note N2 | closed |
| T-03-04 | Denial of service | `limit` on the admin routes | medium | mitigate | `LimitSchema` is `isInt` + `isBetween(MIN_LIMIT, MAX_LIMIT)` (`AdminApi.ts:161-167`) and is the only limit schema used by the users, impersonation and organization routes (`AdminApi.ts:180,188`, `AdminTenantsApi.ts:21,58`); pins `KeysetHttp.test.ts:123` (0, 201, 2.5, garbage cursor -> 400 on organizations), `:151` (users 201 -> 400, 200 -> 200), `KeysetPins.test.ts:114` (10_000 clamps to 200). Tests re-run in this audit: 57/57 pass | closed |
| T-03-05 | Denial of service | `Keyset.paginate` read size | medium | mitigate | `const size = limit(request.limit)` then `take: size + 1` (`packages/ports/src/Keyset.ts:112-113`); `limit` truncates, clamps to 1..200 and sends non-finite to 50 (`Keyset.ts:22-25`), so take is 3..201 for any input; tests `packages/ports/test/Keyset.test.ts:112` (clamp table), `:137-160` (take table) | closed |
| T-03-06 | Tampering | type safety of the declaration | low | mitigate | `key` ties `order`, `row`, `cursor` to one `V` (`Keyset.ts:63-69`); `@ts-expect-error` cases `packages/ports/test/Keyset.types.test.ts:71,78`; no `as` casts or `any` in `Keyset.ts` / `KeysetSql.ts` (grep, import lines excluded) | closed |
| T-03-07 | Tampering (SQL injection) | `KeysetSql.after` / `orderBy` | high | mitigate | Columns only via `sql(k.column)` identifier escaping (`packages/sql/src/KeysetSql.ts:43,49`); values only via template parameters (`:44`); direction picks one of two fixed keywords (`:34,45,49`); no `sql.unsafe` / `.unsafe(` in `KeysetSql.ts`, `Keyset.ts`, `UserStoreSql.ts`, `OrganizationRecords.ts`, `ImpersonationRecords.ts`. Column literals are module constants (`UserStore.ts:185`, `OrganizationRecords.ts:55`, `ImpersonationRecords.ts:183`); cursor values are encoded by the Request schemas (`wire.nullableDateTime`, `Schema.NullOr(Schema.String)`) and passed to `seek.after` (`UserStoreSql.ts:203`, `OrganizationRecords.ts:444`, `ImpersonationRecords.ts:685`). Tests `packages/sql/test/KeysetSql.test.ts:161` (compiled params, no OR), `:212` (a quoted column is escaped, `DROP` only as a bound param) | closed |
| T-03-08 | Denial of service / integrity | mixed-direction or wrong-arity seek | medium | mitigate | `make` throws `Defects.InvalidConfiguration` on mixed direction (`KeysetSql.ts:26-33`); `after` throws `Defects.InvariantViolation` on arity mismatch (`:37-42`); tests `KeysetSql.test.ts:186,199`. All three seeks are module-level constants (`UserStoreSql.ts:58`, `OrganizationRecords.ts:301`, `ImpersonationRecords.ts:204`), so a bad declaration fails on import | closed |
| T-03-09 | Denial of service | `Users.list` read size after the clamp moved into the store | medium | mitigate | Clamp runs in `Keyset.paginate` in both adapters (memory `UserStore.ts:377`, SQL `UserStoreSql.ts:488`); `usersPage` takes `take` and is reachable only through `paginate` (`UserStoreSql.ts:189-205`); `StoreContract` case "listPage normalises the limit" (`packages/test/src/internal/storeContract/users.ts:580`); KeysetPins 51/201/10_000 cases. See note N1 | closed |
| T-03-10 | Information disclosure / integrity | users page skipping or repeating rows | medium | mitigate | Contract cases `users.ts:555` (ties by id, every limit 1..8, `ceil(7/limit)` pages), `:598` (exactly-full page), mixed-case and canonical-id cases; cursor bytes pinned by the golden (T-03-02). Postgres leg is a CI-only confirmation (note N4) | closed |
| T-03-11 | Elevation of privilege / information disclosure | `AdminTenants.listOrganizations` (cross-tenant read) | high | mitigate | Gate first (`AdminTenants.ts:191`); the read goes through `orgs.listPage(platformGrant, request)` (`OrganizationDirectory.ts:219-220`, `platformGrant = TenantScoped.crossTenant(...)` at `:44`) and `TenantScoped.liftOn(sql, grant)` in the SQL fetch (`OrganizationRecords.ts:456`); 403 pin `KeysetHttp.test.ts:137`; AdminTenants tests `:46,74,113` | closed |
| T-03-12 | Denial of service / integrity | increment applied twice or never | medium | mitigate | `AdminTenants.listOrganizations` has no `+ 1` and no slice any more (`AdminTenants.ts:189-197`); the only increment is `Keyset.ts:113`; stores call `paginate` (`OrganizationRecords.ts:245,450`); sweep `KeysetPins.test.ts:146` (`ceil(7/limit)`), exactly-full `:156`, `AdminTenants.test.ts:74,113`; `pageLimit` / `MAX_PAGE_SIZE` / `DEFAULT_PAGE_SIZE` have no remaining references in the changed packages | closed |
| T-03-13 | Information disclosure | `ImpersonationRecords.list` tenant confinement under a replayed cursor | high | mitigate | SQL: `conditions = [TenantScoped.predicate(sql, "tenantId", r.seen), ...active, ...seek.after(...)]` joined by one `sql.and` (`ImpersonationRecords.ts:679-687`), the seek is an AND-ed row-value comparison with no OR; memory filters by tenant (`TenantScoped.matches`) before `Keyset.window` (`:449-453`); `liftFor(grant)` retained on the fetch (`:753-772`); contract case "an org-a cursor replayed under org-b answers only org-b rows" (`packages/admin/test/contract/ImpersonationRecords.ts:675`); domain pin `KeysetPins.test.ts:370`. Postgres leg is CI-only (note N4) | closed |
| T-03-14 | Denial of service | wire `limit` bound after removing the admin constant | medium | mitigate | `LimitSchema` references `Keyset.MIN_LIMIT` / `Keyset.MAX_LIMIT` (`AdminApi.ts:163-166`); `MAX_PAGE_SIZE` now appears only in `packages/webhooks/src/WebhooksApi.ts` (its own, untouched); pins `KeysetHttp.test.ts:123,151` | closed |
| T-03-15 | Repudiation / tampering | BEH-EA-036 and the Migration line drifting from the code | low | mitigate | `.changeset/keyset-page-module.md` names each removed export (`byCreation`, `pageLimit`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `next` -> `nextCursor`); `spec/behaviors/05-persistence-stratum.md` revision 1.14 states the module, collation and precision premises; `spec:verify:strict` is recorded as passing in `03-08-SUMMARY.md` (not re-run in this audit) | closed |
| T-03-16 | Tampering / repudiation | phase-close evidence | medium | mitigate | Allowlist: no changed path outside the allowed roots (checked in this audit); `knip.json`, `package.json`, `pnpm-lock.yaml` unchanged; golden append-only (T-03-02); `KeysetPins.test.ts` and `KeysetHttp.test.ts` each have one commit with 0 deletions (`d04d6d62` +436/-0, `ba8bdc15` +165/-0); Postgres items listed as open CI confirmations in `03-09-SUMMARY.md` | closed |
| T-03-SC | Tampering | npm/pip/cargo installs (plans 03-01 to 03-09) | low | accept | Logged under Accepted Risks as AR-03-01; the diff of `knip.json`, `package.json` and `pnpm-lock.yaml` against the phase base is empty and no `package.json` appears in the phase's changed paths | closed |

*Status: open, closed, open (below high threshold, non-blocking)*
*Severity: critical > high > medium > low; only open threats at or above `high` count toward `threats_open`*

### Unregistered flags

None of the nine SUMMARY `## Threat Flags` sections reports new attack surface ("None" in each). The notes below are the auditor's observations; none is a new unmitigated surface.

- **N1 (informational, low).** `Users.list` no longer clamps in the domain (`packages/core/src/Users.ts`, `list` passes `limit: input?.limit` straight to `store.listPage`). The clamp lives only in `Keyset.paginate`, so a third-party `UserStore` that hand-writes `listPage` without it would read an unclamped size for an in-process caller. The HTTP edge still bounds the wire to 1..200 (`AdminApi.ts:161`), and the changeset Migration line requires `Keyset.paginate` plus the new `StoreContract` cases. Covered by T-03-09; no action required.
- **N2 (documentation drift, low).** T-03-03's text says the gate files "stay byte-unchanged". `Admin.ts` and `internal/AdminGate.ts` are; `AdminTenants.ts` was edited by plan 03-06 on purpose (increment and trim removed) and its `gate.collection` line is unchanged and first.
- **N3 (informational, low).** `03-BASELINE.md:180` quotes the CI service-container Postgres URL (user and password both `awthaq`, host `localhost`), the literal at line 50 of the CI workflow `check.yml`. It is already public in the repo and not a secret, but T-03-01 said no environment values; consider shortening it to "the CI service URL".
- **N4 (verification gap, not a code gap).** Postgres was not run locally (daemon down, `AWTHAQ_POSTGRES_URL` unset; `03-BASELINE.md:178`). The tenant-replay contract case, tie sweeps and collation checks ran on memory and SQLite here and on Postgres only in CI. Treat the CI run as a required confirmation for T-03-10 and T-03-13 before merge.

### Answers to the audit questions

1. **SQL injection.** Columns reach SQL only through `sql(k.column)` (`KeysetSql.ts:43,49`) from module-level declarations; direction is the closed `"asc" | "desc"` union (`Keyset.ts:46`); cursor values and `LIMIT` are bound parameters (`KeysetSql.ts:44`, `UserStoreSql.ts:205`, `OrganizationRecords.ts:446`, `ImpersonationRecords.ts:687`). `sql.unsafe` is absent from every changed SQL file.
2. **Tenant confinement.** The impersonation seek is AND-ed with the tenant predicate (`ImpersonationRecords.ts:679-687`); memory filters before windowing (`:449-453`). Users and organizations have no tenant predicate by design (platform-wide listings, same as `e74a8a9a`), so there is nothing for a replayed cursor to cross; the organization read keeps its `CrossTenant` witness (`OrganizationRecords.ts:456`). An empty condition list renders `1=1` (effect `Statement.ts:808`, test `KeysetSql.test.ts:153`), so the no-cursor query returns the same set as before.
3. **Access control.** `gate.collection` before paging for organizations (`AdminTenants.ts:191`) and users (`Admin.ts:728`); `gate.visibleEpisodes` after the page (`Admin.ts:990`); 403 pin `KeysetHttp.test.ts:137`.
4. **Input validation.** `LimitSchema` 1..200 and the cursor schemas (`AdminApi.ts:151-157,183-190`, `AdminTenantsApi.ts:48-54`) are unchanged apart from the bound constants; tampered cursor -> 400 pinned (`KeysetHttp.test.ts:123-133`); `Keyset.limit` clamps as defence in depth; at most 201 rows are fetched (`Keyset.ts:113`).
5. **Secrets and logging.** The phase diff adds no `console`, `Effect.log*`, secret, token or key literal; `Keyset.ts` and `KeysetSql.ts` contain no logging.
6. **Unsigned cursors (KEY-F2).** Cursor schemas are not in the phase diff, so nothing is weakened; signing stays deferred.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-03-01 | T-03-SC | The phase installs and bumps no package (REQUIREMENTS.md Out of Scope); lockfile and manifests are unchanged, so there is no supply-chain surface to review | plan 03-01..03-09 threat models; recorded by the secure-phase audit | 2026-11-14 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-14 | 17 | 17 | 0 | gsd-security-auditor (ASVS 1, block_on high) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-14 (Postgres legs pending CI confirmation, note N4)
