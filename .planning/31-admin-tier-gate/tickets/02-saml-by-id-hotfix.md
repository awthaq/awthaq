---
plan: 31-admin-tier-gate
ticket: 02
title: "SAML by-id operations read the connection first and ask with its organization (hotfix)"
type: tdd
wave: 1
depends_on: [01]
files_modified:
  - packages/saml/src/SamlAdmin.ts
  - packages/saml/test/SamlAdmin.test.ts
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1521]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Untenanted, an administrator whose predicate admits A and 'the action in general' gets SamlConnectionNotFound for every by-id operation on B's connection, and B's connection is unchanged"
    - "An administrator whose predicate admits only A (strictly) can get, update, rotate, refresh, list keys of and delete A's connection by id"
    - "An administrator with no grant gets SamlActionDenied for every by-id call, real id or not"
    - "Every refused by-id call publishes exactly one auth.admin.actionDenied, naming the connection's organizationId when the connection was read"
    - "Calls that end in SamlConnectionNotFound for an administrator who holds the action spend the saml.admin rule"
  artifacts:
    - path: "packages/saml/src/SamlAdmin.ts"
      provides: "authorizeFound: read, ask with the organization, uniform answer"
  key_links:
    - from: "packages/saml/src/SamlAdmin.ts (getConnection … listSigningKeys)"
      to: "settings.canManageSaml"
      via: "organizationId: found.organizationId"
      pattern: "organizationId: found\\.organizationId|organizationId: record\\.organizationId"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Close F1 in `@awthaq/saml` alone, without any core change, so it can ship as a hotfix before the deepening.

Purpose: a host predicate that delegates organizations must see the organization of the connection a by-id call acts on.
Output: `SamlAdmin.ts` with a by-id gate that reads first, asks with the organization, and answers per PLAN §3.3; ticket 01's matrix green and committed; the two tests it replaces deleted.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§2.4, §3.3, §5.3)
@.planning/31-admin-tier-gate/tickets/01-saml-by-id-red-tests.md (the matrix and its Comments)
@packages/saml/src/SamlAdmin.ts
@packages/saml/src/SamlApi.ts (SamlConnectionNotFound :29, SamlActionDenied :179)
@packages/core/src/AuthEventSchemas.ts (lines 389-415, AdminActionDeniedEvent: organizationId is an optional key)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: A by-id gate in SamlAdmin.ts</name>
  <files>packages/saml/src/SamlAdmin.ts</files>
  <read_first>packages/saml/src/SamlAdmin.ts</read_first>
  <behavior>
    - The six rows of PLAN §3.3 with `find` = the connection lookup (absent and out of the ambient tenant's reach both read as none), target = the connection's `organizationId`, general = `organizationId: undefined`, notFound = `SamlConnectionNotFound`, denied = `SamlActionDenied`, throttle = the existing `throttle` closure.
    - Exactly one `auth.admin.actionDenied` per refused call; the event for a read connection carries `organizationId`.
  </behavior>
  <action>Split today's `authorize` (lines 134-153) into three local steps inside `makeAdmin`: `allows(caller, action, organizationId: string | undefined)` returning the predicate's boolean; `refuse(caller, action, organizationId: string | undefined)` publishing `auth.admin.actionDenied` with `action: "saml." + action` and, when the organization is defined, `organizationId`, then failing `SamlActionDenied`; and keep `authorize(caller, action, organizationId)` (= allows → refuse or throttle) for `createConnection` and `listConnections`, now passing `organizationId` into the event as well. Turn `existing` (lines 221-233) into `lookup(connectionId)` that answers `Option` of the record: `store.get` with `SamlConnections/NotFound` mapped to none, and a found record outside `inScope` also none. Add `authorizeFound(caller, action, connectionId)` implementing the six rows of PLAN §3.3 in that order (read; if found ask with its organization; on a refusal or absence ask the general question; throttle before any not-found answer and before a pass; refuse at most once) and returning the record. Rewrite the six by-id operations (getConnection :298, updateConnection :305, deleteConnection :342, refreshMetadata :358, rotateSigningKey :391, listSigningKeys :417) to call `authorizeFound` once and use the returned record instead of a second `existing` call. Keep every later store error mapping (`fromMissing` etc.) as it is: a row deleted between the read and the write still answers `SamlConnectionNotFound`. Update the header comment (lines 3-8): by-id operations read the connection first and ask with its organization; a refused connection is answered like an absent one when the administrator holds the action in general. No `as`, no return-type annotations.</action>
  <verify><automated>npx vitest run packages/saml/test/SamlAdmin.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c 'authorize(caller, "[a-zA-Z]*", undefined)' packages/saml/src/SamlAdmin.ts` → 0 (baseline at HEAD: 6).
    - `grep -c 'authorizeFound(' packages/saml/src/SamlAdmin.ts` → 7 (one definition + six calls; baseline 0).
    - Ticket 01's matrix is green.
  </acceptance_criteria>
  <done>All by-id operations go through `authorizeFound`; the matrix passes.</done>
</task>

<task type="auto">
  <name>Task 2: Replace the tests the matrix supersedes</name>
  <files>packages/saml/test/SamlAdmin.test.ts</files>
  <read_first>packages/saml/test/SamlAdmin.test.ts</read_first>
  <action>Delete "the gate sees the action and the organization, so a host can let one administrator manage one tenant" (lines 126-157, its comment pins F1) and "a caller who fails the gate learns nothing about which ids exist; one who passes gets 404 for an unknown id" (lines 159-171); the matrix's rows replace both. Move the create/list half of the deleted delegated test into the matrix block as one case: under the delegated predicate, `createConnection` for B and `listConnections(B)` are `SamlActionDenied`, and the denial events name B's `organizationId`. Keep "with no gate configured every operation is denied…" unchanged (REQ-EA-1238's oracle). Keep "past the gate each administrator is limited per window" (ticket 08 deletes it). Add one throttle case to the matrix block: delegated predicate, `adminRate: { limit: 2, window: Duration.minutes(1) }` with the file's `MemoryLimiter`, two by-id calls on B (both absent) then a third is `RateLimited`.</action>
  <verify><automated>npx vitest run packages/saml/test/SamlAdmin.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "learns nothing about which ids exist" packages/saml/test/SamlAdmin.test.ts` → 0 (baseline 1).
    - `grep -c "by-id operations are gated on the action alone" packages/saml/test/SamlAdmin.test.ts` → 0 (baseline 1).
  </acceptance_criteria>
  <done>No test re-tests what the matrix covers; the file is green.</done>
</task>

<task type="auto">
  <name>Task 3: Package gate</name>
  <files>packages/saml/src/SamlAdmin.ts, packages/saml/test/SamlAdmin.test.ts</files>
  <read_first>.planning/IMPLEMENTING.md</read_first>
  <action>Run the ticket gate. Format the two files with `npx oxfmt packages/saml/src/SamlAdmin.ts packages/saml/test/SamlAdmin.test.ts`. Commit both files together (the red tests from ticket 01 land here, green) with the plan's commit style; the commit body records ticket 01's red list. Spec, changeset and BDD follow in tickets 03 and 04, in the same PR.</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/saml && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - All five commands exit 0 (knip: only `.reports/` files may be reported, per IMPLEMENTING.md).
  </acceptance_criteria>
  <done>Green and committed.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| administrator → `saml.admin` by-id operations | the request names a connection id; the host predicate is asked about its organization |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-31-01 | Elevation of privilege | `SamlAdmin` six by-id operations | critical | mitigate | `authorizeFound` asks `canManageSaml` with the read connection's `organizationId`; matrix rows delegated × B |
| T-31-02 | Information disclosure | 403-vs-404 on by-id calls | medium | mitigate | Uniform answer: refusal and absence answer alike for a given caller (§3.3); matrix rows per predicate |
| T-31-03 | Repudiation | `auth.admin.actionDenied` from SAML | low | mitigate | The event names `organizationId` for every refused read connection and for create/list |
| T-31-04 | Tampering | read-then-write window on update/delete | low | accept | A connection's organization cannot change through `update` (`UpdateConnectionPayload` has no `organizationId`); a deleted row answers `SamlConnectionNotFound` from the store mapping |
| T-31-05 | Denial of service | id probing by a delegated administrator | low | mitigate | Not-found answers to an administrator who holds the action spend the `saml.admin` rule (throttle case) |
| T-31-06 | Information disclosure | store outage before the gate | low | accept | A denied caller now sees 503 during an outage on by-id calls; the answer still does not reveal which ids exist |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- Ticket 01's red set is green; 0 calls ask with `undefined` for a by-id operation.
- The SAML suite passes; the two superseded tests are gone.
</success_criteria>

## Comments

BEH id taken as BEH-EA-347, not 348: the catalog highest was 346 and spec:verify:strict rejects gaps. Red at HEAD: 5 tests failed; green after the fix (SAML suite 352 passed).
