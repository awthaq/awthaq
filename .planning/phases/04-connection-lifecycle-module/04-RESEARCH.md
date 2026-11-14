# Phase 4: Connection-lifecycle module - Research

**Researched:** 2026-11-14
**Domain:** Effect v4 service refactor over Postgres/SQLite record stores (SAML + OIDC connection lifecycle, domain claims, suspended-organization policy)
**Confidence:** HIGH on inventory, lock hypothesis and policy (read in the repo, reproduced on Postgres 16.16); MEDIUM on spec/example fan-out (grep-level, listed as pin tasks)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

(CONTEXT.md has no `## Decisions` heading; the section is `### Claude's Discretion` plus `### Decided autonomously`. Both are copied verbatim below. Everything in "Already decided" is locked, not open.)

All implementation choices are at Claude's discretion: this is a structural refactor with technical success criteria. The user's standing instruction is the cleanest end state, not the simplest; complexity is accepted. Already decided (REQUIREMENTS.md "Locked decisions", user-confirmed during milestone setup), not open:

- Suspended-organization gate: `findActive` on create and update for both SAML and OIDC; no check on remove. A suspended organization and a missing organization stay indistinguishable to the caller. A failing scenario in `features/**/29-saml-sp.feature` lands first (before the `src` change) and then passes; BEH-EA-237/318 are amended.
- BEH-EA-317 holds: claim first; claim and connection row atomic; the memory twin compensates (releases the claim when the connection write fails); no event is emitted for a rolled-back claim.
- The module takes `SqlTransaction` as a service so `pnpm check:transactions` passes; protocol error tags and the `onTaken` hook are preserved byte-for-byte; `organization` imports no SAML types (the protocol descriptor is supplied by the SAML/OIDC callers).
- `DomainClaims` leaves the organization root export (`packages/organization/src/index.ts`); consumers move to the new service surface.
- SCIM is out of scope except the shared gate and deletion hook; the SCIM `createConnection` orphan case is documented as a finding in the phase artifacts.
- A Postgres update-vs-remove race case asserts outcome counts (not order). Postgres is available locally through the Debian `postgres:16` container at `postgres://postgres:pw@localhost:55433/awthaq` (same image CI uses); run with `AWTHAQ_POSTGRES_URL`. Record the run and also keep the "CI confirmation open" note since hosted CI cannot run (no git remote).
- Research hypotheses to settle before planning: whether claim-then-connection ordering can deadlock between concurrent update and remove (lock-order), and where the event is emitted relative to commit.
- Changeset with a `Migration:` line for the root-export removal; ADR-EA-040 revision line; spec Revision and Change History bumped together; one candidate, one changeset.
- Wave 0 records the gate baseline and a pin matrix of today's behaviour (claim/release semantics, error tags, `onTaken`) and lands the failing suspended-org scenario before any `src` change, as in Phases 1-3.
- Strata: `api < ports < sql < core < server < qadi < plugins < cli/test/features`; `pnpm circular` counts type-only imports.
- Executors do not run `requirements.mark-complete`; verification gates that need Postgres use the local container.

Decided autonomously:
- [Policy scope] Q: "Is the suspended check a policy of the service or of each caller?" -> Selected: "Of the service: one `findActive` gate on create and update inside the lifecycle module, so SAML and OIDC cannot diverge" - one decided policy is the phase goal
- [Existing public export] Q: "Keep a deprecated `DomainClaims` alias?" -> Selected: "No: pre-1.0 and unpublished; remove it and record the `Migration:` line" - consistent with Phases 1 and 3
- [Open design] Q: "Service shape, descriptor fields, file layout?" -> Selected: "Left to research and the planner under the cleanest-end-state rule; only a product-level or public-wire question is escalated"

### Claude's Discretion
Service shape, descriptor fields, file layout, lock design, test layout (see Recommendation sections below).

### Deferred Ideas (OUT OF SCOPE)
- CONN-F1: bring SCIM into the connection lifecycle if it gains domains and update (future requirement).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CONN-01 | Exposed organization service owns the SAML/OIDC connection lifecycle, parameterized by a protocol descriptor | Service shape 1 (template-method service), "Service shape" section; ADR-EA-040 expose mechanics |
| CONN-02 | Create/update refuse a suspended org (SAML+OIDC), remove does not check; failing scenario first; BEH-EA-237/318 amended | Policy matrix, Wave 0 scenario plan, spec bump list |
| CONN-03 | BEH-EA-317: claim first, atomic, memory twin compensates, no event for a rolled-back claim | Atomicity section, event placement finding, lock experiments 1-4 |
| CONN-04 | `SqlTransaction` as a service, error tags and `onTaken` preserved, no SAML types in `organization` | Descriptor design, `check:transactions` analysis, no-SAML grep |
| CONN-05 | `DomainClaims` leaves root export; ADR-EA-040 revision line; Postgres update-vs-remove race asserts counts | Public surface, race test plan, spec bumps |
| CONN-06 | SCIM unchanged except shared gate + deletion hook; orphan recorded as FINDING | SCIM section (zero-diff proof) |
| GATE-04 | SQL-touching phases verified on Postgres, recorded "not run locally" for CI | Environment + Validation sections (local container run recorded, CI confirmation stays open) |
</phase_requirements>

## Summary

Today the OIDC store (`packages/organization/src/OrganizationConnections.ts`) and the SAML store (`packages/saml/src/SamlConnections.ts`) each re-implement the same sequence: validate, normalise domains, claim through `DomainClaims.withClaim`, write the row, release through `DomainClaims.withRelease`. The two copies have drifted in three observable ways: SAML create uses `directory.find` (raw, accepts a suspended organization) while OIDC uses `findActive`; SAML update and remove have no organization check at all (a suspended organization is refused only incidentally when a `roleMapping` is supplied, through `checkRoleCeiling` -> `requireActive`); and SAML `refreshMetadata` writes without any gate. `DomainClaims` is exported from the `@awthaq/organization` root only because `RecordsBoundary.test.ts` refuses names matching `/\w*Records$/`, which `DomainClaims` does not match.

**The lock-order hypothesis is confirmed, not speculative.** The service-level composition inverts the record stores' row-first order. `withClaim` claims first then writes the row; `withRelease` removes the row first then releases claims. On Postgres an update racing a remove produces `ERROR: deadlock detected` (reproduced, Experiment 1). The obvious fix (release first, then row) removes the deadlock but leaves an orphan claim and owner row because of READ COMMITTED statement snapshots (Experiment 2). The fix that works (Experiment 3) is a lock taken inside `DomainClaims` for claim, release and release-all, plus the order claims-first-then-row in every operation including remove and organization deletion. A second, pre-existing deadlock also exists between two organizations claiming the same two domains in opposite order (Experiment 4); the fix is to take owner-row inserts in sorted order.

**The event-placement hypothesis is settled by reading, no change needed.** Both protocols already emit after the claim-and-row unit returns (OIDC inside its store after `claimed(...)` returns, SAML inside `SamlAdmin` after `store.create/update/remove` returns), so no event is published for a rolled-back claim (ADR-EA-049). The lifecycle module must therefore not own events; it returns, the protocol layer emits. This keeps the descriptor free of event types and keeps `organization` free of SAML types.

**Primary recommendation:** Add one exposed service `OrganizationConnectionLifecycle` (key `awthaq/plugin/organization/ConnectionLifecycle`) built as a template-method over a small protocol descriptor `{ protocol, refuse, taken }`. It owns the `findActive` gate (create/update only), the claim + compensation + release, the single `DOMAIN` normaliser, and the claim release on organization deletion. Move the Postgres serialisation into `DomainClaims.layerSql` via `SqlStore.atomically(sql, "organization_domain_claim:org:<organizationId>")`, order every operation claims-first, then connection row, and prove it with a Postgres-only race test that is run red against unfixed `src` first.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Suspended/missing organization gate on connection create/update | API / Backend (organization lifecycle service) | — | One policy in one service so SAML and OIDC cannot diverge (locked decision) |
| Domain claim, compensation, release | API / Backend (organization lifecycle service) | Database (claim tables, advisory lock) | Multi-row invariant owned by record-store primitive (ADR-EA-041 dec. 9); the service orchestrates |
| Cross-organization uniqueness of a domain | Database / Storage (`organization_domain_owner` primary key) | — | Enforced by PK; the lock only removes the deadlock and the snapshot race |
| Connection row persistence | Database / Storage (protocol record stores) | — | Stays in `ConnectionRecords` / `SamlRecords`; unchanged |
| Event emission (created/updated/deleted) | API / Backend (protocol layer: OIDC store, `SamlAdmin`) | — | ADR-EA-049: events stay with the protocol; after commit |
| Protocol validation, id generation, signing key, cache invalidation | API / Backend (protocol layer) | — | Protocol-specific; passed to the module as `prepare` effect |
| Release of domains on organization deletion | API / Backend (module-owned `OrganizationDeletion` contribution) | Database | Single owner for release; runs inside `OrganizationDirectory.delete`'s transaction |
| Failing-first BDD scenario | Test (features) | — | Lands in Wave 0 before any `src` change |

## Standard Stack

No new packages. Everything below is already a workspace dependency. **Package Legitimacy Audit: not applicable (nothing installed).**

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| effect | 4.1.2 [VERIFIED: pre-compaction repo read, Effect v4 `Context.Service`, `Layer`, `Data.TaggedError`] | Services, layers, tagged errors | The whole repo is Effect v4 |
| `@awthaq/ports` `SqlTransaction` | in-repo (`packages/ports/src/SqlTransaction.ts`) | Transaction as a service; `layerNoop` memory twin, `layerSql` real | ADR-EA-037; `check:transactions` bans `sql.withTransaction(` elsewhere |
| `@awthaq/sql` `SqlStore.atomically(sql, key)` | in-repo (`packages/sql/src/SqlStore.ts:65-76`) | Transaction + `pg_advisory_xact_lock(hashtextextended(key,0))`, no-op on SQLite | ADR-EA-041 dec. 9; key convention `<table>:<scope>:<id>` |
| `@awthaq/test` `RecordsContract`, `TestAuth`, `TestSql`, `Rendezvous` | in-repo | Contract suites on memory+SQL; Postgres schema per suite when `AWTHAQ_POSTGRES_URL` set | Existing idiom (`OrganizationSql.test.ts`) |
| vitest / `@effect/vitest` | in-repo | `it.effect`, `it.live`, `.skipIf` | Postgres-only gate idiom at `packages/core/test/AuthEventsUnitOfWork.test.ts:219` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Org-level lock inside `DomainClaims` (recommended) | New `exclusive(org, effect)` op on `DomainClaimsShape` | Needs a new contract verdict and widens the shape; rejected |
| Org-level key | Connection-level key (what Experiment 3 verified) | Does not cover same-org opposite-order creates or the deletion hook; org-level strictly covers it, at the cost of serialising one organization's connection writes (acceptable: admin-rate operations) |
| Template-method service | Primitives-only service / generic repository | See "Service shape"; both rejected |

**Installation:** none.

## Architecture Patterns

### System Architecture Diagram

```
 SamlAdmin (HTTP/admin)                OIDC admin surface
   create/update/remove                  create/update/remove
        |  (validate, ids, errors)            |
        v                                     v
 SamlConnections.layerStore        OrganizationConnections.layerStore
   builds `prepare` effect            builds `prepare` effect
        \                                   /
         v                                 v
   OrganizationConnectionLifecycle   (exposed, key awthaq/plugin/organization/ConnectionLifecycle)
     create/update:  [1] directory.findActive(org)  --None--> descriptor.refuse("the organization does not exist")
                     [2] run caller's prepare (validate, normalise via module, id)
                     [3] SqlTransaction.withTransaction:
                           DomainClaims.claim  (org-level advisory lock, sorted owner inserts)
                           --> caller's write (records.create/update)
                         onError: memory twin compensates (release / re-claim previous)
                         DomainClaimTaken --> descriptor.taken(domain)   (onTaken preserved)
     remove:         SqlTransaction.withTransaction:
                           DomainClaims.release(org, connection)   (same lock)
                           --> caller's records.remove
                         (NO findActive check)
        |
        v  (returns after COMMIT)
   protocol layer emits event (OIDC store / SamlAdmin)  + map.invalidate / ensureSigningKey

 OrganizationDirectory.delete (one transaction)
     --> OrganizationDeletion registry (order, then id)
           order -1: module-owned contribution: DomainClaims.releaseAllForOrganization
           protocol contributions: records.removeAllForOrganization (OIDC, SAML, SCIM)
     --> events after commit
```

### Recommended Project Structure
```
packages/organization/src/
├── OrganizationConnectionLifecycle.ts   # NEW: service + descriptor type + normalizeDomains + deletion contribution
├── DomainClaims.ts                      # keeps claim/release/releaseAllForOrganization (lock added); withClaim/withRelease move into the service (then deleted as exports)
├── OrganizationConnections.ts           # OIDC store: now requires the lifecycle service
├── OrganizationSystem.ts                # + lifecycle in `services` and `layer`
├── records.ts                           # keeps `DomainClaims` subpath export; comment at line 19 updated
└── index.ts                             # - DomainClaims export, + OrganizationConnectionLifecycle export
packages/saml/src/
├── SamlConnections.ts                   # drops DomainClaims/SqlTransaction/OrganizationDirectory requirements
└── Saml.ts                              # samlOrganizationDeletion no longer calls claims.release; ports may drop SqlTransaction
```

### Pattern 1: Template-method lifecycle service
**What:** The module owns the invariant sequence; the protocol supplies only what differs (a `prepare` effect and a `write` effect) and a descriptor of error constructors.
**When to use:** Every create/update/remove of an OIDC or SAML connection.
**Example (shape sketch, planner refines names):**
```typescript
// Source: derived from DomainClaims.withClaim (packages/organization/src/DomainClaims.ts) + OrganizationConnections.ts create/update
export interface ConnectionProtocol<Refused, Taken> {
  readonly protocol: string;                      // "oauth" | "saml": the value today's claim rows store
  readonly refuse: (reason: string) => Refused;   // InvalidConnection | InvalidSamlConnection
  readonly taken: (domain: string) => Taken;      // ConnectionDomainTaken | SamlDomainTaken (the preserved onTaken)
}
// create: gate -> prepare -> claim -> write ; update: gate -> prepare -> claim? -> write ; remove: release -> write
```

### Anti-Patterns to Avoid
- **Event inside the module / inside the transaction:** ADR-EA-049 keeps events post-commit with the protocol; an in-transaction emit would publish for a rolled-back claim.
- **Release-first without a lock:** removes the deadlock but orphans a claim and owner (Experiment 2).
- **Connection-level lock only:** misses same-org opposite-order creates and the deletion hook.
- **`as` assertions in `packages/*/src`:** forbidden by the repo; the descriptor's generic error types remove the need.
- **Importing `@awthaq/saml` types into `organization`:** `pnpm circular` counts type-only imports, and the strata forbid it.

## Per-protocol inventory (divergences)

Line numbers are from files read in full this session (before the context reset); re-read before editing. Verbatim quotes only where the value is load-bearing.

| Concern | OIDC (`packages/organization/src/OrganizationConnections.ts`) | SAML (`packages/saml/src/SamlConnections.ts`) | Divergence |
|---------|----------------------------------------------------------------|-----------------------------------------------|------------|
| Org gate on create | `requireActiveOrganization` (446-455) uses `directory.findActive`, fails `new InvalidConnection({ reason: "the organization does not exist" })` | `create` (330-395) calls `directory.find` at line 331 (raw) | **SAML accepts a suspended org** |
| Org gate on update | Gate first (512-574) | None; `get(id)` then validations (407-459). Suspended org refused only if `roleMapping` supplied (`validatedRoleMapping` -> `authority.checkRoleCeiling` -> `directory.requireActive` -> mapped to `invalid("the organization does not exist")`) | **SAML update has no gate** |
| Org gate on remove | None | None (`get` then `withRelease`, 509-523) | same (policy: none) |
| `refreshMetadata` | n/a | 461-491, no claim, no gate, `catchTag("SamlDomainTaken", Effect.die)` | SAML only |
| Claim on update | only when `emailDomains` defined, `previous: current.emailDomains` | only when `emailDomains` defined, `previous: current.emailDomains` | same |
| protocol value in claim | `"oauth"` | `"saml"` | descriptor field |
| `onTaken` | `new ConnectionRecords.ConnectionDomainTaken({domain})` | builds `SamlRecords.SamlDomainTaken` | descriptor field `taken` |
| Remove ordering | `withRelease(records.remove)`: row first, then claims | `get` then `withRelease(records.remove)`: row first, then claims | both inverted vs. record stores' own order; this is the deadlock source |
| Org deletion | `connectionsOnOrganizationDelete` (626-642): `inTransaction` = `records.removeAllForOrganization` then `claims.releaseAllForOrganization`; `afterCommit: map.invalidate` | `samlOrganizationDeletion` (`Saml.ts` 723-745): per connection `records.remove` then `claims.release` | module becomes the single owner of the claims release |
| Domain normaliser | `normalizeDomains` + `DOMAIN` regex (338-348) | byte-identical copy | duplicate; one copy moves into the module |
| Events | emitted in the store after `claimed(...)` returns (post-commit) | emitted in `SamlAdmin` after `store.create/update/remove` returns (post-commit) | both already correct |
| Public error mapping | `InvalidConnection`, `ConnectionRecordNotFound`, `ConnectionDomainTaken` | `InvalidSamlConnection` -> `InvalidSamlConnectionRequest{reason}`; `SamlDomainTaken` -> `SamlDomainAlreadyRouted{domain}`; NotFound -> `SamlConnectionNotFound` (`SamlAdmin.ts`) | tags preserved; nothing renamed |

`SamlAdmin.createConnection` already answers an out-of-tenant organization as `invalid("the organization does not exist")` [CITED: packages/saml/src/SamlAdmin.ts], which is the text the gate must reuse.

Current root export, quoted: `export * as DomainClaims from "./DomainClaims.ts";` [VERIFIED: packages/organization/src/index.ts:11]. The `records.ts` subpath also exports it (`export * as DomainClaims from "./DomainClaims.ts";`, line 23) [VERIFIED: packages/organization/src/records.ts:23]; the comment at `records.ts:19` reads `OrganizationConnectionStore and SamlConnectionStore (BEH-EA-317)` and must be updated [VERIFIED: packages/organization/src/records.ts:19].

## Policy (suspended organization)

| Operation | Check | Failure (identical for suspended and missing) |
|-----------|-------|-----------------------------------------------|
| create (SAML, OIDC) | `directory.findActive` first, before any validation | `descriptor.refuse("the organization does not exist")` |
| update (SAML, OIDC) | `findActive` after the by-id read (NotFound first), before validations | same |
| `refreshMetadata` (SAML) | route through the update gate with `domains: undefined` (no claim) | same (error union already contains `InvalidSamlConnection`) |
| remove | none | still works for a suspended organization |
| runtime flows (`usableConnection`, `Saml.ts` 826-840) | already `findActive` | unchanged |

**Indistinguishability.** Both protocols already carry one reason string, `"the organization does not exist"`, for missing and for suspended (OIDC test: `packages/organization/test/OrganizationConnections.test.ts` 312-335 "create and update refuse an unknown or suspended organization"). One nuance to pin in Wave 0: for SAML update by id, a missing organization means the connection itself is NotFound (organization deletion removes its connections in the same transaction, BEH-EA-235), so the missing-org case surfaces as `SamlConnectionNotFound`, the suspended case as `InvalidSamlConnectionRequest`. A caller cannot probe organization existence through update because the connection id is the probe, and the id already proves existence in the caller's tenant. Record this as a deliberate non-divergence, and pin it.

**Error precedence preserved.** The gate runs before the caller's `prepare` validations (today's SAML create checks the organization before name/IdP/URL checks). SAML update becomes `get` (NotFound), gate, validations; this adds the gate, it reorders nothing else.

**Where the scenario goes.** `features/features/13-enterprise-federation/29-saml-sp.feature` (699 lines) under the `@BEH-EA-318` Rule (line 583 is `@BEH-EA-317`; line 631 is `@BEH-EA-318`; line 680 `@BEH-EA-347`). Write the scenarios untagged, then run `python3 features/scripts/allocate-req-ea.py` (assigns REQ ids, regenerates `features/traceability.md`). Wiring: `29-saml-sp.steps.test.ts` with `samlSteps`, `samlFederationSteps`, `SamlWorld`'s `WorldLive`. No "organization is suspended" step exists in the SAML World; add `the organization {string} is suspended` to `SamlFederationSteps.ts` using `OrganizationDirectory.suspend(OrganizationActor.platformAdmin(Users.UserId(..)), {organizationId})` through `inApp` (`ScimSteps.ts:311-321` suspends via `OrganizationRecords.setSuspended(platformGrant, ...)` as the alternative). Existing reusable steps: "the organization {string} exists", "the connection {string} exists", "the administrator gate allows every action", "the organization {string} tries a {word} connection for the domain {string}". Scenarios: create refused, update refused, remove still works, suspended vs missing return identical reason text (REQ-EA-1242 comparison style). OIDC has no feature file; its refusal is covered by `OrganizationConnections.test.ts` (extend with update/remove-while-suspended pins).

Wave 0 leaves `pnpm test:bdd` red by exactly those new rows; the baseline records that.

## Atomicity and lock-order (settled by experiment)

Environment: local `awthaq-p3-pg` (postgres:16, Debian, 16.16, port 55433), scratch schema `r4_scratch` (dropped afterwards; verified 0 rows in `pg_namespace`), `deadlock_timeout=300ms`, interleaving with `pg_sleep`. Tables modelled as `organization_domain_owner`, `organization_domain_claim`, `saml_connection`, `saml_connection_domain`. Scripts are in `/private/tmp/claude-502/-Users-mohammadalmechkor-Projects-Perso-awthaq/77238ac1-76b0-4bb3-a3a7-ec012e7983a4/scratchpad/p4/` (ephemeral).

| # | Setup | Result | Meaning |
|---|-------|--------|---------|
| 1 | Today: update = claim then row; remove = row then release | `ERROR: deadlock detected`, update is the victim, remove succeeds | **Hypothesis confirmed.** The update would surface as `StoreUnavailable`. |
| 2 | Remove = release then row, no lock | no deadlock, but final state connection rows 0, claims 1, owners 1 | **Orphan.** Remove's `DELETE claim WHERE connectionId` blocked on update's uncommitted claim rows and, under READ COMMITTED, did not see the claim rows the update then committed. |
| 3 | Claim and release both start with `pg_advisory_xact_lock(hashtextextended('organization_domain_claim:connection:c1',0))`; remove = release then row | no deadlock; connection 0, claims 0, owners 0, domain rows 0; update completes | **The fix.** |
| 4 | Two organizations claim domains x, y in opposite order | `deadlock detected` | **Pre-existing hazard** in `DomainClaims.claim` (owner-row inserts). Fix: acquire in sorted order. |

**Recommended lock design.** Inside `DomainClaims.layerSql`, wrap `claim`, `release` and `releaseAllForOrganization` in `SqlStore.atomically(sql, "organization_domain_claim:org:<organizationId>")` [CITED: key convention `<table>:<scope>:<id>`, ADR-EA-041 decision 9; mechanism `packages/sql/src/SqlStore.ts:65-76`]. Org-level (not connection-level) because it also serialises same-org opposite-order creates and the deletion hook against a concurrent create. `DomainClaimsShape` stays unchanged, so the `RecordsContract` suite only gains cases. No-op on SQLite.

**Sorted acquisition (Experiment 4 fix) without changing the named domain.** `DomainClaimTaken` names the first domain in INPUT order that another org owns (memory twin does the same). So: phase 1 inserts all owner rows as `INSERT ... ON CONFLICT (domain) DO NOTHING` in sorted order; phase 2 reads owners in input order and fails `taken` on the first foreign one. Pin the "first in input order" behaviour in Wave 0 before touching the loop.

**Order everywhere: claims first, then connection row.** create/update (already), remove (flip), organization deletion (module contribution at `order: -1` runs before protocol `removeAllForOrganization`). This matches why `ConnectionRecords.ts`/`SamlRecords.ts` keep row-first *internally* (comments "C6 ... the opposite order deadlocks an update racing this removal on Postgres", "Plan 25 ticket 22"): those orders are inside a single record-store call and are unchanged; the service-level order is what the lock now makes safe.

**Remove needs `previous` domains.** In the memory twin a failed remove must compensate by re-claiming, so `remove(orgId, connId, previous, removeEffect)` takes the connection's current domains. SAML already has `current` from `get`; the OIDC store must add a `findById` read (a miss stays `ConnectionRecordNotFound`).

**Memory-twin hazard (pitfall, not a blocker).** In update-vs-remove on the memory twin, update's compensation `claim(previous)` can re-create a claim for an already-removed connection (orphan, memory only; SQL rolls the whole transaction back). The race case is therefore SQL-only; add a sequential memory compensation test instead.

**Event placement (hypothesis settled).** Post-commit already holds in both protocols (OIDC after `claimed(...)` returns; SAML in `SamlAdmin` after the store call). `AuthEvents` additionally queues state-change events inside a `SqlTransaction.transactional` unit (BEH-EA-321). No change; add a pin that a `DomainClaimTaken`-rolled-back create emits nothing.

**Residual risks to record (not fixed).**
- Org deletion vs a concurrent create: the gate read precedes the lock, so a create that passed `findActive` can land a connection after the deletion cleared the org's claims (orphan connection). Narrow window; record as a finding. (A re-check of `findActive` inside the transaction under the lock would close it; the planner may opt in as a cheap addition because the lock is already held.)
- `OrganizationDirectory.delete` calls `requireActive` first, so a suspended organization cannot be deleted through it (out of scope, pre-existing).

## Service shape (candidates)

1. **Template-method exposed service (RECOMMENDED).** `OrganizationConnectionLifecycle`, key `awthaq/plugin/organization/ConnectionLifecycle`. Descriptor `ConnectionProtocol<Refused, Taken> { protocol; refuse; taken }`. API: `create(protocol, organizationId, prepare)`, `update(protocol, organizationId, prepare)`, `remove(protocol, organizationId, connectionId, previous, removeEffect)`, `normalizeDomains(protocol, raw)`. `prepare` is an `Effect<{ connectionId, domains, write }>` (update: `domains | undefined` plus `previous`). The module owns gate, claim, lock, compensation, release, the single `DOMAIN` normaliser (invalid-domain error through `refuse`), and the module-owned `OrganizationDeletion.contribute({ id, order: -1, make })`. Events, validation, id generation, `map.invalidate`, `ensureSigningKey` stay in the protocol layers, so there is no event field in the descriptor.
2. **Primitives-only service** (moved `withClaim`/`withRelease` plus a `requireActive` helper). Rejected: it does not enforce one policy; callers could skip the gate again.
3. **Generic store-wrapping repository** (descriptor carries record functions). Rejected: descriptor becomes wide and leaks protocol input types into `organization`.

**Requirement changes after the refactor.** `OrganizationConnections.layerStore` requires the lifecycle instead of `DomainClaims`, `SqlTransaction` and `OrganizationDirectory`. `SamlConnections.layerStore` requires the lifecycle and drops `DomainClaims`, `SqlTransaction`, `OrganizationDirectory`. `Saml.ts:790` `ports: [RateLimiter, SqlTransaction, XmlSignature]` may drop `SqlTransaction` (`SamlRecords` uses only the static `transactional(sql)`); verify against the plugin manifest tests before dropping [ASSUMED]. Every test/World that provided `DomainClaims.layerMemory` plus a stub directory must add the lifecycle layer.

**ADR-EA-040 mechanics.** `AuthPlugin.layer(..., { exposes: { services, layer } })`; exposed keys are `awthaq/plugin/<id>/<name>`; `ExposesComplete` requires each exposed service to be in `OrganizationSystem.services`; a dependent lists the exposer in `dependsOn` (SAML already has `dependsOn: [Organization.Organization]`, `Saml.ts:791`). Add the lifecycle to `OrganizationSystem.services` and `.layer` (`packages/organization/src/OrganizationSystem.ts`), and to `Organization.ts` `contributes` for the deletion hook (currently `Layer.mergeAll(organizationErasure, organizationExport, organizationInvitationRetention)`).

**`SqlTransaction` and `check:transactions`.** The script only bans the regex `\bsql\s*\.\s*withTransaction\s*\(` outside `ports/src/SqlTransaction.ts` [CITED: scripts/check-transactions.mjs]. The module takes `SqlTransaction` as a service and calls `transaction.withTransaction(...)` (the service method), which does not match the regex. `DomainClaims.layerSql` uses `SqlTransaction.transactional(sql)` today; `SqlStore.atomically` is already the sanctioned primitive. Run `pnpm check:transactions` as a gate.

## Deletion hooks and the SCIM finding

`OrganizationDeletion` registry: `contribute({ id, order?, make })`; handlers run `inTransaction` inside `OrganizationDirectory.delete`'s single `sqlTransaction.withTransaction`, sorted by order then id, registry freezes on first read [CITED: packages/organization/src/OrganizationDeletion.ts, OrganizationDirectory.ts]. OIDC and SAML hooks each currently release their own claims; after the refactor the module's `order: -1` contribution releases all claims for the organization once, and the protocol contributions only remove rows (SAML's per-connection `claims.release` loop in `Saml.ts` 723-745 simplifies to the row removal and its dependent keys/sessions).

**SCIM (CONN-06): zero diff in `packages/scim`, prove with `git diff --stat -- packages/scim`.** "Shared gate" = `OrganizationDirectory.findActive`, which SCIM already uses (`ScimConnections.ts:143` in `ScimAuthenticationLive`, unknown or suspended organization returns the generic 401). "Shared deletion hook" = the existing `OrganizationDeletion.contribute` (`Scim.ts:612-619`: `scimOrganizationDeletion = { inTransaction: records.removeAllForOrganization }`).

**FINDING to record (not fix):** `ScimConnectionStore.create` (`ScimConnections.ts:93-103`) never consults the directory, and `ScimRecords.ts:196-212` (memory) / `:662-676` (SQL) do no existence check; no `REFERENCES` or `FOREIGN KEY` exists in scim/saml/organization `src` (the `scim_connection` table is created at `Scim.ts:512-536`). Calling it with an unknown `organizationId` inserts a `scim_connection` row. The bearer token cannot authenticate (`findActive` None gives 401), but the deletion cleanup only runs for an existing organization, so the orphan row stays forever. Optionally add a characterization pin; do not fix (CONN-F1 deferred).

## Public surface, migration and spec bumps

**Code.**
- Remove `export * as DomainClaims` from `packages/organization/src/index.ts:11`; keep it in `records.ts:23`; export the new service from the root. Delete `DomainClaims.withClaim`/`withRelease` and any other newly unused exports (knip must not gain unused exports). No deprecated alias.
- Update imports of `DomainClaims` from the root: `features/step-definitions/OrganizationWorld.ts` (lines 11, 99) and `QadiOrganizationFixture.ts` (lines 8, 102) (both in `OrganizationServiceNames` type unions: switch to `@awthaq/organization/records` and add the new service tag), `packages/saml/test/SamlDomainClaims.test.ts:5,134`, `features/step-definitions/TenancyWorld.ts:49,300` (already on `/records`). `examples/{sql,memory}-server/app.ts` have `OrganizationServices` unions that likely need the new tag for declaration emit [ASSUMED: membership unverified; pin by `tsc -b` in Wave 1].
- `packages/organization/test/RecordsBoundary.test.ts` refuses only `/\w*Records$/` from the root; consider extending it to name `DomainClaims` so the leak cannot recur (optional, cheap).
- No new error tags: reuse `DomainClaimTaken`, `InvalidConnection`, `InvalidSamlConnection`, `ConnectionDomainTaken`, `SamlDomainTaken`, `StoreUnavailable`. `check:error-tags` must stay 163/137 (Phase 3 baseline; re-record at HEAD).

**Changeset** (format per `.changeset/keyset-page-module.md`: frontmatter minor bumps, a body, a `Migration:` paragraph; one `fixed` group of 29 packages). `Migration:` line content: `DomainClaims` is no longer exported from the `@awthaq/organization` root; use the new `OrganizationConnectionLifecycle` service (exposed by `Organization.layer`), and import `DomainClaims` from `@awthaq/organization/records` only to compose bundles or in tests; `DomainClaims.withClaim` and `withRelease` are removed. Name bumped packages (organization, saml, plus test/qadi only if touched).

**Spec bumps, together, in one commit each with Revision equal to the newest Change History version (check 14):**

| File | From | To | Content |
|------|------|----|---------|
| `spec/behaviors/29-saml-sp.md` | 1.14 | 1.15 | BEH-EA-317: replace "Known limit: memory twin ... Postgres relies on the owner row's primary key, not on a lock" with the lock and ordering text; BEH-EA-318: suspended-organization policy, closing paragraph on update-vs-remove stays true and is now enforced |
| `spec/behaviors/28-tenancy.md` | 1.14 | 1.15 | BEH-EA-237 amended (and BEH-EA-235 if the wording needs to say "SAML too"; it already says "The store MUST refuse an organization that is unknown or suspended" for OIDC) |
| `spec/decisions/040-plugin-exposes-domain-services.md` | 1.2 | 1.3 | Revision note under Consequences (existing pattern): new exposed `ConnectionLifecycle`, `DomainClaims` out of the root |
| `spec/traceability.md` | 1.92 | 1.93 | Rows near lines 227 and 401 mention `DomainClaims.test.ts` / `SamlDomainClaims.test.ts`; keep every cited path existing (check 10); add the new race test file |
| `spec/models/09-sso.md` | 1.2 | 1.3 (if edited) | Line 65 mentions `DomainClaims` |
| `features/traceability.md` | generated | regenerated | by `allocate-req-ea.py` |

Also check `spec/decisions/023-enterprise-federation-packages.md:13` (mentions `DomainClaims`), `spec/decisions/index.yaml` (revision tracking, unverified) and `packages/organization/README.md` (`check:readmes`). `spec/overview.md` has only the `surface:ports` block (96-129; check 13), so it is unaffected [VERIFIED: spec/overview.md structure read]. No new BEH id, so no check 17. REQ-EA tags unique (check 15). Run `pnpm spec:verify:strict` after edits.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Serialising claim operations | A new mutex, `Ref`/`Semaphore`, or raw `pg_advisory_xact_lock` calls | `SqlStore.atomically(sql, key)` | Already a transaction plus the advisory lock, no-op on SQLite, tested by `SqlStore.test.ts` |
| Transactions | `sql.withTransaction(...)` | `SqlTransaction` service (`withTransaction`, `transactional(sql)`) | `check:transactions` bans the raw call; `layerNoop` gives the memory twin |
| Deadlock avoidance across domains | Retry-on-deadlock loop | Sorted lock acquisition | Retry hides the bug; sorted order removes it |
| Race harness | `setTimeout` choreography | `Rendezvous` (`packages/test/src`) plus a Postgres statement-level trigger with `pg_sleep` to force the interleave | Deterministic; outcome counts, not order |
| Domain uniqueness | An application-level check | `organization_domain_owner` primary key + `ON CONFLICT DO NOTHING` | Already the source of truth; the lock only removes the deadlock |
| Contract coverage | Ad-hoc tests | `RecordsContract` (every operation needs a verdict) | Enforced by `check:contract-tests` (21 classes) |

**Key insight:** the invariant is two tables plus one row written in different orders by different callers. The fix is one ordering and one lock owned in one place, not more guards at each caller.

## Common Pitfalls

### Pitfall 1: Fixing the deadlock by flipping remove only
**What goes wrong:** orphan claim and owner row (Experiment 2: connection 0, claims 1, owners 1).
**Why:** READ COMMITTED statement snapshots; the blocked DELETE does not see rows the other transaction commits after the wait.
**How to avoid:** lock inside `DomainClaims` plus claims-first everywhere. **Warning sign:** the race test's final-state counts for claims/owners are non-zero.

### Pitfall 2: Memory twin race parity
**What goes wrong:** memory compensation re-creates a claim for a removed connection. **How to avoid:** the race case is SQL-only; add a sequential compensation test (create fails, claim released; update fails, previous domains restored; remove fails, claim restored).

### Pitfall 3: Changing which domain `DomainClaimTaken` names
**Why it matters:** `onTaken(domain)` is preserved byte-for-byte; sorting the insert loop naively changes the named domain. **How to avoid:** two-phase claim (sorted insert, input-order owner read); pin first.

### Pitfall 4: Gate after validation
**What goes wrong:** error precedence changes (SAML create validates after the org check today). **How to avoid:** gate first, then `prepare`.

### Pitfall 5: `refreshMetadata` forgotten
It writes a connection with no gate; leave it ungated and the "suspended organization cannot mutate" claim is false. Route it through the update gate with `domains: undefined`.

### Pitfall 6: Public-surface fan-out
Root-import sites in `OrganizationWorld.ts`, `QadiOrganizationFixture.ts`, `SamlDomainClaims.test.ts`, and declaration-emit unions in the examples. Run `tsc -b` before cross-package vitest (repo rule).

### Pitfall 7: Postgres-only test under TestClock
`it.effect` uses TestClock; `pg_sleep` interleaving needs real time: use `it.live.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)`. `TestSql` has `maxConnections: 4` and `RecordsContract` uses `CONCURRENCY=8`: keep the race to two or three fibers.

### Pitfall 8: Deadlock reported as `StoreUnavailable`
A deadlocked update surfaces as `storeUnavailable("DomainClaims.withClaim")` (SqlError mapped). The race test must assert `StoreUnavailable` count = 0, otherwise a deadlock-victim looks like a legitimate failure.

## Code Examples

### Postgres-only race test skeleton
```typescript
// Source: idiom at packages/core/test/AuthEventsUnitOfWork.test.ts:219 (skipIf) and packages/organization/test/OrganizationSql.test.ts (TestAuth.layer sql mode)
// Layer: TestAuth.layer(Auth.make([Organization.Organization]), { records: "sql", suite: "connection_lifecycle_race" })
it.live.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)("update racing remove: outcome counts", () =>
  Effect.gen(function* () {
    // 1. CREATE TRIGGER (statement-level BEFORE UPDATE, pg_sleep(0.3)) on organization_oauth_connection
    // 2. fork update; sleep 50ms; run remove; join both with Effect.result
    // 3. assert: removes succeeded = 1; update is success | ConnectionRecordNotFound; StoreUnavailable = 0
    // 4. assert connection rows = 0, claim rows = 0, owner rows = 0, domain-table rows = 0
  }));
```
Second case: two organizations claim the same two domains in opposite order; assert no `StoreUnavailable` and exactly one winner per domain.

### Gate failure text (must be byte-identical for suspended and missing)
```typescript
// Source: OrganizationConnections.ts:446-455 (requireActiveOrganization), quoted value
new InvalidConnection({ reason: "the organization does not exist" })
```

## State of the Art

| Old Approach | Current Approach | When | Impact |
|--------------|------------------|------|--------|
| Each protocol composes `withClaim`/`withRelease` | One exposed service parameterised by descriptor | This phase | One gate, one lock, one normaliser |
| Postgres relies on owner PK only ("Known limit" in BEH-EA-317) | Advisory lock via `SqlStore.atomically` | This phase (ADR-EA-041 dec. 9 primitive) | Update-vs-remove no longer deadlocks |

**Deprecated/outdated:** the BEH-EA-317 "Known limit" sentence; the `DomainClaims` root export.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `Saml.ts` `ports` can drop `SqlTransaction` without breaking manifest tests | Service shape | A manifest test fails; keep the port (harmless) |
| A2 | `examples/{sql,memory}-server/app.ts` `OrganizationServices` unions need the new tag | Public surface | `tsc -b` fails on declaration emit; add the tag |
| A3 | `spec/decisions/index.yaml` tracks revisions | Spec bumps | Check 14 or index drift fails; edit it |
| A4 | The exact existing wording of `spec/traceability.md` rows at 227/401 | Spec bumps | Edit conflicts; re-read before editing |
| A5 | BEH-EA-237 amendment wording | Spec bumps | Planner drafts it; user can adjust |
| A6 | Memory-twin race is not deterministically reproducible | Pitfall 2 | A flaky memory race test; keep the race SQL-only |
| A7 | An in-lock `findActive` re-check closes the org-deletion-vs-create orphan | Residual risks | Window stays open; documented as a finding |

## Open Questions

None blocking. Three planner choices, all within discretion: (1) re-check `findActive` inside the lock to close the deletion-vs-create window (recommended if cheap); (2) extend `RecordsBoundary.test.ts` to name `DomainClaims`; (3) org-level vs connection-level lock key (recommended org-level; Experiment 3 verified connection-level, org-level is a strict superset and must be re-verified by the race test).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | everything | yes | v26.13.0 | — |
| pnpm | gates | yes | 11.20.0 | — |
| tsc | `tsc -b` | yes | 7.0.2+effect-tsgo.0.67.4 | — |
| python3 | `allocate-req-ea.py` | yes | 3.15.2 | — |
| Docker `awthaq-p3-pg` (postgres:16 Debian 16.16, port 55433) | race test, GATE-04 | yes (running; many leftover `t_*` schemas from Phase 3) | 16.16 | none needed; CI confirmation stays open |
| `psql` on host | ad-hoc SQL | no | — | `docker exec awthaq-p3-pg psql -U postgres -d awthaq` |

`AWTHAQ_POSTGRES_URL` is unset in the shell; pass `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` explicitly. CI uses the `postgres:16` service (user `awthaq`, db `awthaq_test`) via `pnpm check`; `scripts/test-pg.sh` uses alpine and a different port, so do not use it for this phase. Hosted CI cannot run (no git remote): record "run locally on awthaq-p3-pg, CI confirmation open".

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest + `@effect/vitest`; cucumber-style BDD wiring under `features/` |
| Config | per-package vitest configs; `tsc -p tsconfig.test.json` |
| Quick run | `pnpm vitest run packages/organization/test/OrganizationConnections.test.ts packages/organization/test/DomainClaims.test.ts packages/saml/test/SamlDomainClaims.test.ts` |
| Postgres run | `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq pnpm vitest run packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts packages/organization/test/Contract.test.ts` |
| Full suite | `pnpm test`, `pnpm test:bdd`, then the gate list below |

### Phase Requirements to Test Map
| Req | Behavior | Test Type | Command | Exists |
|-----|----------|-----------|---------|--------|
| CONN-02 | SAML create/update refuse suspended; remove works; suspended == missing text | BDD (failing first) | `pnpm test:bdd` filtered to `29-saml-sp` | Wave 0 (new rows) |
| CONN-02 | OIDC create/update refuse suspended; remove works | unit | `OrganizationConnections.test.ts` | extend (312-335 exists) |
| CONN-03 | claim then row atomic; memory compensation (create/update/remove); no event for rolled-back claim | unit (memory, SQLite) | `DomainClaims.test.ts`, new lifecycle test | extend |
| CONN-03/05 | update-vs-remove outcome counts; opposite-order two-org claims | integration (Postgres only) | see Postgres run | Wave 0 (red first) |
| CONN-01/04 | one service, descriptor, error tags and `onTaken` byte-identical | unit + `check:error-tags` | gate | pin in Wave 0 |
| CONN-05 | `DomainClaims` not in root; no SAML types in `organization` | grep + `tsc -b` + `pnpm circular` + knip | `grep -rniE "@awthaq/saml\|SamlRecords\|SamlDomainTaken\|InvalidSamlConnection" packages/organization/src` (today: two comment hits only, `OrganizationActor.ts:24`, `OrganizationMigrations.ts:464`) | exists |
| CONN-06 | SCIM unchanged | `git diff --stat -- packages/scim` empty | git | n/a |
| Contract | `DomainClaims` suite still passes with lock | RecordsContract | `packages/organization/test/contract/DomainClaims.ts` via `Contract.test.ts` | exists (additive cases) |

### Sampling Rate
- Per task commit: quick run plus `tsc -b`.
- Per wave merge: `pnpm test`, `pnpm test:bdd`, Postgres run.
- Phase gate: every gate below green (or equal to the Wave 0 baseline where pre-existing red).

### Gates and baseline (Wave 0 records at HEAD `6d51ad78`; Phase 3 counts are reference only)
`tsc -b`; `tsc -p tsconfig.test.json`; `pnpm circular` (counts type-only imports); `check:error-tags` (163/137); `check:transactions`; `check:contract-tests` (21 classes); `lint`; `format:check`; `check:readmes`; `workspace:check`; `test:bdd`; `pnpm test`; `coverage` (floors 89/83/84/90); `spec:verify:strict` (PASS 32); `knip` (pre-existing exit 1: 39 `.claude/` files plus 3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`; must gain nothing new); `package:smoke`. Known intermittent: passkey `ChallengeStore` consume test (re-run once). Source: `.planning/phases/03-keyset-page-module/03-BASELINE.md`.

### Pin matrix (Wave 0, before any `src` change)
1. `claim` input-order "first foreign domain" named in `DomainClaimTaken` (memory and SQL).
2. `withClaim` compensation: create releases, update restores `previous`.
3. `onTaken` mapping: OIDC `ConnectionDomainTaken{domain}`, SAML `SamlDomainTaken` -> `SamlDomainAlreadyRouted{domain}`.
4. SAML create today accepts a suspended organization (characterise, then it flips with the failing scenario); SAML update/remove have no organization check.
5. Missing vs suspended text identical (`"the organization does not exist"`) for both protocols; SAML by-id update of a missing org is NotFound.
6. Deletion frees domains for both protocols (`OrganizationConnections.test.ts` 362-395, `SamlOrganizationDeletion.test.ts`).
7. No event for a create rejected by the claim (both protocols).
8. SCIM `create` with unknown organizationId inserts a row (characterization of the FINDING).

### Wave 0 Gaps
- [ ] New untagged scenarios in `29-saml-sp.feature` under `@BEH-EA-318` and the "is suspended" step in `SamlFederationSteps.ts`; run `allocate-req-ea.py`; BDD red by exactly those rows.
- [ ] `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` (race, opposite-order two-org), run red against unfixed `src`, red output recorded.
- [ ] Baseline file `04-BASELINE.md` and pin tests.

### Suggested wave structure (planner may adjust)
- **Wave 0:** baseline, pin matrix, failing scenario, red race test.
- **Wave 1:** `DomainClaims` lock + sorted acquisition + contract cases; lifecycle service + descriptor + normaliser + deletion contribution; expose in `OrganizationSystem`.
- **Wave 2:** migrate OIDC store, then SAML store (incl. `refreshMetadata`, `Saml.ts` deletion hook), remove `withClaim`/`withRelease`, fix test/World/example providers.
- **Wave 3:** root-export removal and import fan-out; spec bumps, changeset, README; full gate re-run; Postgres run recorded with "CI confirmation open".

## Security Domain

`security_enforcement` is not disabled; applicable controls:

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (SCIM bearer auth untouched) | — |
| V4 Access Control | yes | Suspended/missing organization gate (`findActive`); tenant isolation of claim tables (existing tenancy contract cases) |
| V5 Input Validation | yes | Single shared domain normaliser (`DOMAIN` regex) in the module; invalid input fails through the descriptor's `refuse` |
| V6 Cryptography | no | — |

| Threat | STRIDE | Mitigation |
|--------|--------|------------|
| Organization-existence probing via different errors | Information disclosure | One identical reason for suspended and missing; pin test |
| Cross-organization domain hijack (routing another org's domain to attacker IdP) | Tampering / Spoofing | Owner-row PK is the arbiter; claim-first and atomic with the row (BEH-EA-317); lock removes the race window |
| Deadlock as denial of service of admin writes | Denial of service | Sorted acquisition + org-level lock; race test asserts `StoreUnavailable` = 0 |
| Orphan claim holding a victim's domain after removal | Denial of service | Claims-first order under the lock (Experiment 3: 0 claims, 0 owners) |
| SCIM orphan row (unknown organization) | Tampering (data hygiene) | Recorded as a FINDING; not exploitable for auth (401) |

## Sources

### Primary (HIGH confidence)
- Repo files read in full or in range this session (before the context reset; re-read before editing): `packages/organization/src/{DomainClaims,OrganizationConnections,ConnectionRecords,OrganizationDeletion,OrganizationDirectory,OrganizationSystem,Organization,OrganizationBundle,records,index}.ts`, `packages/saml/src/{SamlConnections,Saml,SamlAdmin,SamlRecords}.ts`, `packages/scim/src/{ScimConnections,Scim,ScimRecords}.ts`, `packages/sql/src/SqlStore.ts`, `packages/ports/src/SqlTransaction.ts`, `scripts/check-transactions.mjs`, `packages/test/src/{RecordsContract,TestSql}.ts`.
- Spec: `spec/behaviors/{29-saml-sp,28-tenancy}.md`, `spec/decisions/040-plugin-exposes-domain-services.md`, `spec/scripts/check-drift.mjs` (checks 10, 13, 14, 15), `spec/overview.md`.
- `.planning/{REQUIREMENTS,ROADMAP}.md`, `.planning/research/{ARCHITECTURE,PITFALLS,SUMMARY}.md`, `.planning/phases/03-keyset-page-module/03-BASELINE.md`.
- Postgres 16.16 experiments 1-4 on the local container [VERIFIED: executed; results above].

### Secondary / Tertiary
- None. No web research was needed: no new library and no external API is involved.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, no new packages.
- Architecture/lock design: HIGH for deadlock and orphan (reproduced); MEDIUM for the org-level key (superset of the verified connection-level key; the race test must confirm).
- Spec/example fan-out: MEDIUM, grep-level.
- Pitfalls: HIGH.

**Research date:** 2026-11-14
**Valid until:** 30 days (internal refactor against a moving branch; re-record the baseline at the planning HEAD)
