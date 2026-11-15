# Phase 4: Connection-lifecycle module - Pattern Map

**Mapped:** 2026-11-14
**Files analyzed:** 19
**Analogs found:** 18 / 19 (the SQL race test has only a partial analog)

All analog paths below were checked as git-tracked source. Line numbers are from reads this session; re-read before editing.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/organization/src/OrganizationConnectionLifecycle.ts` (NEW) | service (exposed) + deletion contribution | CRUD / request-response | `DomainClaims.ts` (withClaim/withRelease) + `OrganizationConnections.ts` (layerStore, `connectionsOnOrganizationDelete`) | role-match |
| `packages/organization/src/DomainClaims.ts` (MOD: lock, sorted inserts, drop withClaim/withRelease) | store primitive | CRUD | `MembershipRecords.ts:678`, `TeamRecords.ts:1014` (`SqlStore.atomically`) | exact |
| `packages/organization/src/OrganizationSystem.ts` (MOD: add to `services` + `layer`) | config / registry | n/a | itself (lines 22-44) | exact |
| `packages/organization/src/Organization.ts` (MOD: `contributes` gets the deletion hook) | config | event-driven | `contributes` in same file | exact |
| `packages/organization/src/index.ts` (MOD: drop `DomainClaims`, add service) | barrel | n/a | itself (lines 10-29) | exact |
| `packages/organization/src/records.ts` (MOD: comment at line 19) | barrel | n/a | itself | exact |
| `packages/organization/src/OrganizationConnections.ts` (MOD: OIDC store uses lifecycle) | service | CRUD | itself (claimed 428-444, remove 574-590, hook 626-642) | exact |
| `packages/saml/src/SamlConnections.ts` (MOD) | service | CRUD | `OrganizationConnections.ts` layerStore | role-match |
| `packages/saml/src/Saml.ts` (MOD: deletion hook, `ports`) | plugin wiring | event-driven | itself 723-745 | exact |
| `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` (NEW, Postgres-only race) | test | concurrency | `core/test/AuthEventsUnitOfWork.test.ts:219`, `organization/test/OrganizationSql.test.ts`, `TenantMiddleware.test.ts:203` | partial |
| `packages/organization/test/OrganizationConnections.test.ts`, `DomainClaims.test.ts`, `contract/DomainClaims.ts` (MOD: pins, additive cases) | test | CRUD | themselves | exact |
| `packages/saml/test/SamlDomainClaims.test.ts` (MOD: root import to `/records`) | test | CRUD | `features/step-definitions/TenancyWorld.ts:49` (already on `/records`) | exact |
| `features/features/13-enterprise-federation/29-saml-sp.feature` (MOD: new scenarios) | BDD | request-response | Rule `@BEH-EA-318`, scenarios at ~line 631-665 | exact |
| `features/step-definitions/SamlFederationSteps.ts` (MOD: suspended step) | BDD steps | request-response | same file 1086-1088, 1208-1210; `ScimSteps.ts:311-321` | exact |
| `features/step-definitions/{OrganizationWorld,QadiOrganizationFixture}.ts` (MOD: imports, tag unions) | test world | n/a | `TenancyWorld.ts:49,300` | exact |
| `spec/behaviors/{29-saml-sp,28-tenancy}.md`, `spec/decisions/040-...md`, `spec/traceability.md`, `spec/models/09-sso.md` (MOD) | spec | n/a | their own Revision/Change History rows | exact |
| `.changeset/connection-lifecycle-module.md` (NEW) | changeset | n/a | `.changeset/keyset-page-module.md` | exact |
| `.planning/phases/04-.../04-BASELINE.md` (NEW) | doc | n/a | `.planning/phases/03-keyset-page-module/03-BASELINE.md` | exact |
| `packages/scim/**` | none | n/a | zero diff, proof only | n/a |

## Pattern Assignments

### `OrganizationConnectionLifecycle.ts` (service, CRUD)

**Analog A, the sequence to absorb:** `packages/organization/src/DomainClaims.ts:210-239`
```typescript
export const withClaim = <A, E, R, Taken>(claims, transaction, input, previous, write, onTaken: (domain: string) => Taken) =>
  transaction.withTransaction(Effect.andThen(claims.claim(input), write)).pipe(
    Effect.onError(() =>
      (previous === undefined
        ? claims.release(input.organizationId, input.connectionId)
        : claims.claim({ ...input, domains: previous })
      ).pipe(Effect.ignore),
    ),
    Effect.mapError((error) => (error instanceof DomainClaimTaken ? onTaken(error.domain) : error)),
    Effect.catchTag("SqlError", StoreFailure.storeUnavailable("DomainClaims.withClaim")),
  );
```
Copy compensation, `onTaken` mapping and `SqlError` mapping verbatim. For remove, flip to claims-first: `release` then `records.remove`, with a compensating re-`claim({domains: previous})` on error (memory twin).

**Analog B, the gate to hoist:** `OrganizationConnections.ts:446-455`
```typescript
const requireActiveOrganization = (organizationId: string) =>
  directory.findActive(organizationId).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new InvalidConnection({ reason: "the organization does not exist" })),
      onSome: () => Effect.void,
    })),
  );
```
In the service the failure becomes `descriptor.refuse("the organization does not exist")`. Gate runs before `prepare`, create and update only, never remove.

**Service definition style** (`DomainClaims.ts:72-74`):
```typescript
export class DomainClaims extends Context.Service<DomainClaims, DomainClaimsShape>()(
  "awthaq/organization/records/DomainClaims",
) {}
```
New key: `awthaq/plugin/organization/ConnectionLifecycle`. Exposed services use the `awthaq/plugin/<id>/<name>` keys (see `OrganizationDirectory` for the `.layer` static pattern consumed at `OrganizationSystem.ts:35-43`).

**Deletion contribution to move into the module** (`OrganizationConnections.ts:626-642`):
```typescript
export const connectionsOnOrganizationDelete = OrganizationDeletion.contribute({
  id: "organization.oauthConnections",
  make: Effect.gen(function* () {
    const records = yield* ConnectionRecords.ConnectionRecords;
    const claims = yield* DomainClaims.DomainClaims;
    const map = yield* OrganizationConnections;
    return {
      inTransaction: (organizationId: string) =>
        Effect.andThen(records.removeAllForOrganization(organizationId), claims.releaseAllForOrganization(organizationId)),
      afterCommit: map.invalidate,
    };
  }),
});
```
New module hook: `contribute({ id, order: -1, make })` yielding only `claims.releaseAllForOrganization`. The OIDC and SAML hooks keep only row removal.

**Transaction as a service:** `yield* SqlTransaction.SqlTransaction` then `transaction.withTransaction(...)` (as at `OrganizationConnections.ts:424`). Never write `sql.withTransaction(` (`scripts/check-transactions.mjs` regex `\bsql\s*\.\s*withTransaction\s*\(`).

**Descriptor (house-style analog `Keyset.ts:1-40`):** a header comment naming the requirement id (`CONN-01, BEH-EA-317/318`), a declaration interface owned by the consumer, the module derives everything. Descriptor: `{ protocol, refuse, taken }` per RESEARCH; generics on errors so no `as` and no SAML import.

---

### `DomainClaims.ts` lock (store primitive)

**Analog:** `packages/sql/src/SqlStore.ts:65-76` (`atomically`), callers `MembershipRecords.ts:678`:
```typescript
) => SqlStore.atomically(sql, `organization_membership:org:${organizationId}`)(effect);
```
and `TeamRecords.ts:1014`: `SqlStore.atomically(sql, \`organization_team:org:${organizationId}\`)`.

Apply to `layerSql` `claim`/`release`/`releaseAllForOrganization` in place of `SqlTransaction.transactional(sql)(...)` at `DomainClaims.ts:160,180,190`, key `organization_domain_claim:org:${organizationId}`. Keep `.pipe(unavailable("claim"))` suffixes. Two-phase claim: insert owner rows in sorted order via `ON CONFLICT (domain) DO NOTHING` (today line 164 inside the loop), then read owners in INPUT order and fail `taken` on the first foreign one (today lines 166-169). `SqlStore` import is `@awthaq/sql`, already imported there (`StoreFailure, TenantScoped`).

---

### `OrganizationSystem.ts` and `index.ts` (registry)

Add `OrganizationConnectionLifecycle.OrganizationConnectionLifecycle` to `services` (lines 22-31) and `.layer` to the `Layer.mergeAll(...)` at 34-40 or a `provideMerge` after `OrganizationDirectory` (it depends on directory, claims, SqlTransaction; `SqlTransaction` is already in `CoreRequirements`, line 50-54). `index.ts`: delete line 11 `export * as DomainClaims ...`; add `export * as OrganizationConnectionLifecycle from "./OrganizationConnectionLifecycle.ts";`. `records.ts:23` keeps its `DomainClaims` export.

---

### `OrganizationConnections.ts` / `SamlConnections.ts` (service, CRUD)

OIDC `claimed(...)` helper (428-444), `requireActiveOrganization` (446-455) and the `remove` at 574-590 collapse to calls into the lifecycle service. `layerStore` stops requiring `DomainClaims`, `SqlTransaction`, `OrganizationDirectory` (lines 423-427). OIDC remove needs a `findById` read for `previous`. SAML: `directory.find` at `SamlConnections.ts:331` is replaced by the gate; `claimed` at 221-232 and `withRelease` at 512 move to the service; its duplicated `normalizeDomains` (line 93) is deleted for the module's. `refreshMetadata` routes through the update gate with `domains: undefined`. Events stay in `SamlAdmin` and in the OIDC store after the call returns (see line 586+ emit after `map.invalidate`).

### `Saml.ts:723-745` (deletion hook)

Drop `const claims = yield* DomainClaims.DomainClaims;` and the `Effect.andThen(claims.release(...))`; keep `records.remove` with `catchTag("SamlRecordNotFound", () => Effect.void)`. `ports` at line 790 may drop `SqlTransaction` (assumption A1; verify manifest tests).

---

### `OrganizationConnectionLifecycle.sql.test.ts` (test, Postgres-only)

**Gate idiom (live clock needed for `pg_sleep`):** `it.live.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)(...)`. Existing forms: `it.effect.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)(` at `core/test/AuthEventsUnitOfWork.test.ts:219`; `describe.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)(` at `organization/test/TenantMiddleware.test.ts:203`.

**Layer** (`OrganizationSql.test.ts:12-22`):
```typescript
const OrganizationSqlLive = TestAuth.layer(Auth.make([Organization.Organization]), {
  records: "sql",
  suite: "organization_OrganizationSql",
  services: Organization.config({ ... }),
});
```
Use suite `organization_ConnectionLifecycle`. Imports `{ TestAuth, TestSql } from "@awthaq/test"`, `assert, describe, it from "@effect/vitest"`. Count rows with the `countRows(sql, table)` helper at `OrganizationSql.test.ts:34`. Keep to 2-3 fibers (`TestSql` `maxConnections: 4`). Assert `StoreUnavailable` count = 0, plus claim/owner/connection row counts 0. Run command: `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq pnpm vitest run <file>` (not `scripts/test-pg.sh`, which uses alpine and port 55432; it forbids naming test files, per `pnpm check:contract-tests`).

---

### BDD `29-saml-sp.feature` + `SamlFederationSteps.ts`

**Scenario style** (feature ~631-665, Rule `@BEH-EA-318`): untagged scenarios first, then `python3 features/scripts/allocate-req-ea.py`; compose from existing steps:
```gherkin
Scenario: ...
  Given the organization "acme" exists
  And the administrator gate allows every action
  And the organization "acme" is suspended        # NEW step
  When ...
  Then the refresh is refused as "InvalidSamlConnectionRequest"
```
**Steps to copy next to** `SamlFederationSteps.ts:1086-1088` (`Given("the organization {string} exists", ... yield* organizationOf(name))`) and `:1208-1210`. New suspended step modelled on `ScimSteps.ts:311-321`:
```typescript
Given("the organization of {string} is suspended", function* (name: string) {
  const world = yield* World;
  ...
  yield* organizations.setSuspended(platformGrant, connection.organizationId, Option.some(yield* DateTime.now));
```
RESEARCH prefers `OrganizationDirectory.suspend(OrganizationActor.platformAdmin(...), {organizationId})` through the SAML World's `inApp`; either is acceptable, pick the one reachable from `SamlWorld`.

---

### Spec bumps

Document Control: `| Revision | 1.14 |` (`29-saml-sp.md:7`) must equal the newest Change History version at line 13 (check 14). Append `<br> 1.15 (2026-11-14): BEH-EA-317/318: ...` to the end of the single `Change History` row, bump Revision in the same edit. `040-plugin-exposes-domain-services.md`: line 13 row, Revision 1.2 to 1.3, plus a revision note under Consequences (the 1.1 `PasswordCredential` note is the pattern). Same for `28-tenancy.md` 1.14 to 1.15, `spec/traceability.md` 1.92 to 1.93, `09-sso.md` 1.2 to 1.3 if edited. Then `pnpm spec:verify:strict`.

### Changeset `.changeset/connection-lifecycle-module.md`

Format of `.changeset/keyset-page-module.md` (lines 1-12): YAML frontmatter `"@awthaq/organization": minor`, `"@awthaq/saml": minor` (+ `@awthaq/test`/`@awthaq/qadi` only if touched), blank line, one descriptive paragraph, blank line, then `Migration:` paragraph, here: `DomainClaims` is no longer exported from the `@awthaq/organization` root; use `OrganizationConnectionLifecycle`, import `DomainClaims` from `@awthaq/organization/records` only to compose bundles or in tests; `DomainClaims.withClaim` and `withRelease` are removed. One candidate, one changeset.

## Shared Patterns

### Error mapping to preserve
`DomainClaimTaken` to protocol error (`ConnectionRecords.ConnectionDomainTaken({domain})`, `SamlRecords.SamlDomainTaken`); `SqlError` to `StoreFailure.storeUnavailable("<Module>.<op>")` (`DomainClaims.ts:226`). No new tags (`check:error-tags` baseline 163/137 at Phase 3, re-record).

### Org-scoped advisory lock key
`<table>:<scope>:<id>`, `SqlStore.atomically(sql, key)`; no-op on SQLite.

### Events post-commit, outside the module
OIDC store emits after the unit returns; `SamlAdmin` emits after `store.*` returns. The lifecycle service has no event field.

### Gate text
`"the organization does not exist"`, identical for suspended and missing.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| Race harness (`pg_sleep` trigger + forked update/remove) in the `.sql.test.ts` | test | concurrency | No existing interleaving test; compose `Rendezvous` (`packages/test/src`) or statement-level trigger (failure injection by triggers is the idiom in `OrganizationSql.test.ts` header comment) |

## Metadata

**Analog search scope:** `packages/{organization,saml,sql,ports,core,scim}`, `features/`, `spec/`, `.changeset/`, `scripts/`
**Pattern extraction date:** 2026-11-14
