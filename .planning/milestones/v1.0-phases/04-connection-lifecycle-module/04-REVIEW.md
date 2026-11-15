---
phase: 04-connection-lifecycle-module
reviewed: 2026-11-14T14:45:00Z
depth: deep
files_reviewed: 20
files_reviewed_list:
  - packages/organization/src/OrganizationConnectionLifecycle.ts
  - packages/organization/src/DomainClaims.ts
  - packages/organization/src/OrganizationConnections.ts
  - packages/organization/src/OrganizationSystem.ts
  - packages/organization/src/index.ts
  - packages/organization/src/records.ts
  - packages/saml/src/SamlConnections.ts
  - packages/saml/src/Saml.ts
  - packages/organization/test/OrganizationConnectionLifecycle.test.ts
  - packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts
  - packages/organization/test/ConnectionLifecyclePins.test.ts
  - packages/organization/test/RecordsBoundary.test.ts
  - packages/organization/test/contract/DomainClaims.ts
  - packages/saml/test/SamlLifecyclePins.test.ts
  - packages/saml/test/SamlDomainClaims.test.ts
  - packages/scim/test/ScimConnectionOrphan.test.ts
  - .changeset/connection-lifecycle-module.md
  - packages/organization/README.md
  - spec/behaviors/28-tenancy.md
  - spec/behaviors/29-saml-sp.md
findings:
  critical: 0
  warning: 2
  info: 6
  total: 8
  necessity: 1
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-11-14
**Depth:** deep
**Files Reviewed:** 20
**Status:** issues_found

## Summary

I read the five production files in full and traced them across modules. That covered `SqlStore.atomically`, `OrganizationDirectory.delete`, `OrganizationDeletion`, `ConnectionRecords` (create, update, remove, rewrite) and `SamlAdmin`. I also read the diffs of the old and new store code, the three Wave 0 pin suites, the lifecycle suite, the Postgres race suite and the DomainClaims contract. The organization and SAML lifecycle and claim tests pass here on memory and SQLite (42 and 10 tests). The Postgres race suite is skipped without `AWTHAQ_POSTGRES_URL`, so I reviewed it by reading only.

No Critical issue survived verification. Every locked decision holds in the source:

- **Gate:** it is `findActive` on create and update, and absent on remove (Lifecycle:116-127, 180, 200, 218-222).
- **Indistinguishable:** a suspended and a missing organization produce the same `protocol.refuse(GONE)` after one read each.
- **Lock key:** `organization_domain_claim:org:<id>` is a bound parameter. The prefix is fixed, so it is injective, and `hashtextextended` collisions only add serialisation.
- **Lock lifetime:** the lock is taken inside `claim`'s savepoint and released with the outermost transaction. On a successful claim the lock is held through the re-check and the write (SqlStore:65-76).
- **Insert order:** owner rows are inserted sorted and read in caller order (DomainClaims:176-185).
- **Create re-check:** it runs in-lock after the claim.
- **Compensation:** it runs inside the transaction (Lifecycle:171).
- **Events:** the lifecycle publishes none.
- **Imports and SCIM:** `organization` imports no SAML type, and SCIM sources are untouched (`git diff --stat` on `packages/scim/src` is empty).
- **Error tags:** the protocol error tags and `onTaken` mapping are preserved.

I traced the lock order for four races and found no cycle:

- **Create vs delete-organization:** create takes L(org) and then writes the connection row. Deletion removes members, invitations, teams, roles and active context first (Directory:355-360), and only then takes L(org) through the order -1 hook, so it queues behind create. The in-lock `findActive` sees the committed deletion.
- **Update vs remove:** both take L(org) first.
- **Remove vs refresh, and update without domains:** these run no L. They take the connection row and then its domain rows, the same order as `remove` and `rewrite` (ConnectionRecords:620-647, 721-730).
- **Two organizations:** the insert order is globally sorted, and the delete-orphans step runs after all inserts.

The two warnings below are the verified defects. The info items are quality and test-strength points.

## Warnings

### WR-01: Memory-twin compensation re-creates a claim for a connection that a concurrent removal just deleted (orphan)

**File:** `packages/organization/src/OrganizationConnectionLifecycle.ts:162-172, 194-222` (also `packages/organization/src/DomainClaims.ts:97-142`)
**Issue:** The in-transaction compensation is the only rollback the memory twin has, and it restores `previous` unconditionally. Two interleavings leave a permanent claim on a deleted connection in the memory twin.

- **Update vs remove:**
  1. The update's `claim(new)` succeeds.
  2. A concurrent `remove` releases the claim and deletes the row.
  3. The update's `write` fails `NotFound`, and `onError` runs `reclaim(previous)`.
  4. The claim is re-inserted for a connection that no longer exists.
- **Remove vs remove:** both callers pass `records.findById`.
  1. Caller A releases and deletes.
  2. Caller B's `release` is a no-op.
  3. B's `records.remove` fails `NotFound`, and B's compensation re-claims `previous`.

In memory `claim` is a plain `Ref.modify` with no existence check, so the orphan stays and locks the domains against every other organization. The old `withRelease` could not do this, because it released only after a successful row removal.

The lifecycle header (lines 14-18) and the changeset ("no domain stays claimed by a deleted connection") state this as fixed. That holds for SQL only, where the rollback discards the compensation. `previous` is also read outside the lock (`OrganizationConnections.ts:557-566`, `SamlConnections.ts:511-518`). A stale value can restore a domain set that a concurrent update has since changed.

Test gap: `OrganizationConnectionLifecycle.test.ts` covers "failed write keeps the previous claim" only with a write that fails and no concurrent release. The memory-leg and SQL-leg tests therefore cannot see this.

**Fix:** Compensate only when the failure is not "the connection is gone". The simplest safe change is to let the protocol descriptor say so, and skip the compensation for it:
```ts
// ConnectionProtocol
readonly isGone?: (error: unknown) => boolean; // ConnectionRecordNotFound / SamlConnections/NotFound

// unit(): compensate unless the write reported the connection gone
body.pipe(Effect.onError((cause) =>
  Cause.isFailure(cause) && protocol.isGone?.(Cause.squash(cause)) === true
    ? Effect.void
    : Effect.ignore(compensate)))
```
Alternatively give the memory `claim` a `connectionExists` guard. Add a lifecycle test whose `write` is `Effect.andThen(claims.release(org, "c1"), Effect.fail(NotFound))`, and assert that `canClaim(other, domain)` is true afterwards on the memory leg.

### WR-02: The connection write runs under the org-wide advisory lock and an open transaction, and it seals the client secret through the `Encryption` / `KeyProvider` port

**File:** `packages/organization/src/OrganizationConnectionLifecycle.ts:182-190, 204-208` with `packages/organization/src/ConnectionRecords.ts:252-257, 654-659, 707-713`
**Issue:**
- Before the phase, the owner-row locks were taken inside the unit only. Now the per-organization lock, which every claim and release of that organization takes, is held until commit.
- On the OIDC path, the lock is held across `records.create` and `records.update`. These run `secrets.seal`, `SecureRandom` and `patchSecret` before their SQL. `KeyProvider` is documented as KMS-shaped (`ports/src/KeyProvider.ts:9-11, 35`), so a slow or remote key service holds the lock and the transaction connection. The organization's deletion transaction also blocks on this lock at the order -1 hook, so a slow KMS can stall a deletion while it holds row locks on the cascade.
- Sealing needs only the connection id, which `prepare` already has. It does not need to run under the lock.

**Fix:** Seal in `prepare`, outside the lock and the transaction, and pass the already-sealed value in `write`. This means `ConnectionRecords.create/update` accepting a pre-sealed secret, as `patchSecret` already models. If that is too large for this phase, record it in `04-FINDINGS.md` as a known limit and keep the write free of external IO in the lifecycle's contract comment.

## Info

### IN-01: Swallowed compensation hides its own failures and double-logs on a poisoned Postgres transaction

**File:** `packages/organization/src/OrganizationConnectionLifecycle.ts:171`
**Issue:** `Effect.onError(() => Effect.ignore(compensate))` handles two cases.
- **Body failed on a SQL error:** the Postgres transaction is aborted. `compensate` starts with `SAVEPOINT`, which fails `current transaction is aborted`. `orStoreUnavailable` logs the cause again, so every failed write logs a second spurious error.
- **Compensation hits a defect:** `ignore` handles only the failure channel, so the defect replaces the original typed error in the exit.

On SQL the compensation is also redundant. The transaction rolls back anyway, and it re-takes the lock and re-inserts rows first.

**Fix:** Skip compensation when the cause carries a `SqlError`. Alternatively expose a "needs compensation" flag on `SqlTransaction`, so only the twin without a real transaction compensates. Use `Effect.exit` plus `Effect.ignoreCause` so a compensation defect cannot mask the original cause.

### IN-02: `Effect.die` on `SamlDomainTaken` in `refreshMetadata` guards a state that cannot occur (necessity)

**File:** `packages/saml/src/SamlConnections.ts:489-490`
**Issue:** The refresh passes `domains: undefined`. `lifecycle.update` then runs only `write` and never calls `claim` (Lifecycle:202-203), so `Taken` cannot be produced. The `catchTag("SamlDomainTaken", Effect.die)` exists only to narrow a generic error union. If the guard is ever reached, it turns a reachable-looking state into a process-level defect.
**Category:** necessity
**Fix:** Give `PreparedUpdate` a discriminated shape. For example, an `update` overload for the "no domains" case returns `Effect<A, Refused | E | EP | StoreUnavailable>`, with no `Taken`. Then delete the `catchTag` and the `Effect.die`. Evidence: Lifecycle:202-203.

### IN-03: The Postgres race oracle never asserts the create outcome, and nothing runs it by default

**File:** `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts:267-291`
**Issue:**
- The deletion-vs-create case asserts only `createIsNotStoreUnavailable`. It would pass if create returned a defect, or an unexpected tag, as long as no rows remain. The expected outcome is `InvalidConnection` ("the organization does not exist") from the in-lock re-check, so assert it.
- The deletion-race case forces the interleaving with `Effect.sleep(100ms)` against a 0.5s trigger. On a slow runner the outer `findActive` can already see the deletion, so the in-lock re-check path is never exercised and the case passes anyway.
- The whole file is skipped when `AWTHAQ_POSTGRES_URL` is unset. The opposite-order deadlock fix, the sorted inserts and the in-lock re-check therefore have no default CI evidence.
- The contract cases "opposite order" and "one organization's connections ... opposite order" in `contract/DomainClaims.ts` are vacuous on memory and SQLite (single writer).

**Fix:** Assert `outcome(created) === "InvalidConnection"`. Make the interleaving deterministic, for example by gating the create on a latch that the delete's trigger releases, instead of wall-clock sleeps. Wire a Postgres job into CI, or record the manual run in the verification notes.

### IN-04: The store-level normaliser has no cap on domain count or length, and it is now the one shared normaliser

**File:** `packages/organization/src/OrganizationConnectionLifecycle.ts:64-76`
**Issue:** The 50-domain cap exists only in the SAML HTTP schema (`SamlApi.ts:248-253`). `normalizeDomains` is now the single entry point for SAML and OIDC, and for the application calling the store directly. OIDC has no HTTP surface and no cap. `claim` then runs 3N statements (N inserts, N reads, N claim inserts), plus a `DELETE` and a drop-orphans step, serially under the organization lock. The DOMAIN regex also accepts labels longer than 63 characters and names longer than 253.
**Fix:** Move the cap and the length rules into `normalizeDomains`:
```ts
if (normalized.length > 50) return Effect.fail(protocol.refuse("at most 50 email domains"));
// and in the regex test: domain.length <= 253 && every label <= 63
```

### IN-05: `RecordsBoundary` scanner matches only the `import { ... } from` form

**File:** `packages/organization/test/RecordsBoundary.test.ts:25-40`
**Issue:** The regex matches `import {…} from "@awthaq/organization(/records)?"` only. `import * as DomainClaims from "@awthaq/organization/records"`, `export … from`, `import("…")` and `require` all bypass it. The spec revision note and ADR-EA-040 present this test as the guarantee that "no plugin claims a domain except through the lifecycle". It is weaker than that claim.
**Fix:** Also scan for any specifier `@awthaq/organization/records`, whatever the import form:
```ts
if (/["']@awthaq\/organization\/records["']/.test(text)) offenders.push(...)
```

### IN-06: The exposed `create` trusts a caller-supplied `connectionId`, and a claim is replaced by `(connectionId, organizationId)` only

**File:** `packages/organization/src/OrganizationConnectionLifecycle.ts:46-51, 185`; `packages/organization/src/DomainClaims.ts:186`
**Issue:** `Prepared.connectionId` is the protocol's own id. `claim` deletes every claim row with that `connectionId` and organization, whatever its protocol. A plugin that passes the id of another protocol's live connection in the same organization wipes and replaces that connection's claim. The ids are uuidv7 today, so there is no live bug. The service is exposed to any plugin that depends on `Organization` (ADR-EA-040), so this is an unstated precondition. The README paragraph also lacks a separator before `OrganizationConnectionLifecycle` ("... all read) `OrganizationConnectionLifecycle` (...)").
**Fix:** Either key the claim delete on `(connectionId, organizationId, protocol)`, or document that the id must be freshly generated. Add the missing comma in `packages/organization/README.md`.

## Checked and found sound

- **Error precedence:** OIDC update is gate, then `findById`, as before. OIDC create is gate, then uuid, then validate, then normalise, as before. SAML create is now gate-first, which is the intended change from `directory.find`. SAML update and refresh are `get`, then gate, then validate. `ensureSigningKey` still runs after commit, as it did before.
- **Leak check:** a suspended and a missing organization take one `findActive` read and return one identical refusal. The `InvalidSamlConnectionRequest` mapping in `SamlAdmin` is unchanged and already declared on update and refresh.
- **Deletion hooks:** `claimsOnOrganizationDelete` has order -1 and id `organization.domainClaims`, and the protocol hooks (order 0) now only remove rows. A failure in either rolls the whole deletion back. No other contribution uses a negative order.
- **Root export:** `DomainClaims` was removed from the `@awthaq/organization` root and kept at `./records`. The changeset covers the migration (0.x, minor). No remaining consumer imports it from the root.
- **Type safety:** there are no `as`, `any` or `!` shortcuts in the new or changed `src`. The only `Effect.die` is the one in IN-02, and the pre-existing `InvalidSigningKey` one.
- **Domain edge cases:** case-folding, de-duplication in first-seen order, an empty list (a lock and a transaction are taken, nothing is claimed) and the first-foreign-domain order all behave as the lifecycle and pin suites assert. A trailing dot and an underscore are refused by the unchanged regex.
- **Pre-existing test tautology, out of scope:** `SamlDomainClaims.test.ts:~158` contains `assert.isTrue(Option.isSome(Option.some(rival)))`.

---

_Reviewed: 2026-11-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_

Not run: the Postgres race suite (no `AWTHAQ_POSTGRES_URL` here), `tsc -b`, and the BDD features. WR-01 is by trace rather than by an executed reproduction, and I did not edit tests to reproduce it.
