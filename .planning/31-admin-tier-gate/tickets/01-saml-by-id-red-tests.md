---
plan: 31-admin-tier-gate
ticket: 01
title: "SAML by-id red tests: a delegated predicate reaches another organization"
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/saml/test/SamlAdmin.test.ts
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1521]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "A test shows that, untenanted, a predicate admitting `organizationId === undefined || organizationId === A` lets an administrator rename, rotate and delete B's connection"
    - "A test shows that a strict predicate (`organizationId === A`) refuses the administrator's own A connection by id"
    - "A test shows that SAML's actionDenied carries no organizationId"
    - "The red results are recorded in this ticket's Comments; no red test is committed"
  artifacts:
    - path: "packages/saml/test/SamlAdmin.test.ts"
      provides: "describe block \"by-id operations ask the gate with the connection's organization (BEH-EA-348)\""
      contains: "BEH-EA-348"
  key_links:
    - from: "packages/saml/test/SamlAdmin.test.ts"
      to: "packages/saml/src/SamlAdmin.ts"
      via: "ops.getConnection / updateConnection / deleteConnection / refreshMetadata / rotateSigningKey / listSigningKeys"
      pattern: "ops\\.(getConnection|updateConnection|deleteConnection|refreshMetadata|rotateSigningKey|listSigningKeys)"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Reproduce live bug F1 (plan 31 §2.4) as failing tests, before any fix.

Purpose: prove by execution what §2.4 found by reading: SAML's six by-id operations ask `canManageSaml` with `organizationId: undefined`, so a delegated predicate reaches every organization's connections on an untenanted request. The matrix written here is also the oracle ticket 02 turns green and ticket 08 keeps green.
Output: one new `describe` block in `packages/saml/test/SamlAdmin.test.ts`, run red, with the red cases recorded in `## Comments`. Do not commit the red tests: ticket 02 commits them with the fix (plan 30 ticket 01's convention).
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§2.4, §3.3)
@packages/saml/src/SamlAdmin.ts (lines 134-162 the gate and inScope, 221-233 existing, 298-423 the by-id operations)
@packages/saml/src/SamlConfig.ts (lines 61-70 canManageSaml)
@packages/saml/test/SamlAdmin.test.ts (lines 1-200: helpers `admin`, `org`, `handBuilt`, `auditTags`, `grant`, and the existing gate tests)
@packages/saml/test/support.ts (SamlLive at :73, seedConnection at :113)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: Write the by-id matrix</name>
  <files>packages/saml/test/SamlAdmin.test.ts</files>
  <read_first>packages/saml/test/SamlAdmin.test.ts, packages/saml/test/support.ts, packages/saml/src/SamlAdmin.ts</read_first>
  <behavior>
    - Four predicates, each its own SamlLive: deny-all (no canManageSaml), allow-all (`() => Effect.succeed(true)`), delegated (`organizationId === undefined || organizationId === permitted`), strict (`organizationId === permitted`). `permitted` is set to organization A's id after it is created, the closure pattern of the existing test at lines 126-157.
    - Every case runs under `TestAuth.withoutRequest` (no ambient tenant).
    - Setup per case: organization A with one connection and organization B with one connection, each through `seedConnection` with distinct `slug` and `emailDomains` ("acme"/"acme.example", "globex"/"globex.example"), plus an unknown id "nope".
    - Six operations per target: getConnection, listSigningKeys, updateConnection with `{ name: "renamed" }`, rotateSigningKey with `{}`, refreshMetadata, deleteConnection (delete last, so the other five see the row).
    - An outcome is classified as "denied" (`SamlActionDenied`), "absent" (`SamlConnectionNotFound`) or "reached" (anything else, including success and `SamlNoMetadataUrl` from refreshMetadata on a hand-built connection).
    - Expected (the fixed behaviour, plan 31 §3.3): deny-all → A denied, B denied, nope denied. allow-all → A reached, B reached, nope absent. delegated → A reached, B absent, nope absent. strict → A reached, B denied, nope denied.
    - Expected events (read `auth.admin.actionDenied` rows through `AuditLog` as the existing test at lines 98-113 does): exactly one per refused call; for a refused call on A or B the payload has `organizationId` equal to that connection's organization; for "nope" no `organizationId`; for delegated × B each of the six calls publishes one event naming B even though the answer is absent.
    - Expected state: after delegated × B, B's connection keeps name "Acme Okta"/its seeded name, its SP keys are unchanged in count, and it still exists (`SamlRecords.findById(grant, id)` is Some).
  </behavior>
  <action>Add a describe block named "by-id operations ask the gate with the connection's organization (BEH-EA-348)" after the existing "the gate is fail-closed" block. Build the matrix as data (an array of predicate rows with their expected outcome per target) and loop with `it.effect` per predicate row, so a failure names the predicate, operation and target. Use a small local helper that runs one operation and returns its classification by `_tag` via `Effect.flip`/`Effect.match`, never by message text. Reuse the file's existing `admin` principal, `org`, `grant` and `auditTags` helpers; seed connections with `seedConnection`, not `ops.createConnection`, so the deny-all row needs no gate to set up. Do not edit or delete existing tests in this ticket (ticket 02 deletes the two it replaces). Do not touch `src`.</action>
  <verify><automated>npx vitest run packages/saml/test/SamlAdmin.test.ts</automated></verify>
  <acceptance_criteria>
    - The new block exists: `grep -c "BEH-EA-348" packages/saml/test/SamlAdmin.test.ts` is at least 1 (baseline at HEAD: 0).
    - The run is red at HEAD exactly in: delegated × B (reached instead of absent), strict × A (denied instead of reached), strict × nope (unchanged: denied, so green), and every event row that expects `organizationId` (absent today). Deny-all and allow-all rows are green at HEAD.
  </acceptance_criteria>
  <done>The matrix runs, its red rows are exactly the F1 rows, the strict-own rows and the event-names rows, and the 16 pre-existing tests still pass.</done>
</task>

<task type="auto">
  <name>Task 2: Record the red results and hand the tests to ticket 02</name>
  <files>packages/saml/test/SamlAdmin.test.ts</files>
  <read_first>.planning/31-admin-tier-gate/tickets/02-saml-by-id-hotfix.md</read_first>
  <action>Run the file once more and paste into this ticket's `## Comments` the list of failing test names and, for delegated × B, the observed classification per operation (expect "reached" for all six). Then leave the new block uncommitted in the working tree for ticket 02, or stash it with `git stash push packages/saml/test/SamlAdmin.test.ts` and name the stash "plan31-01-red". Never commit a red test to the main line.</action>
  <verify><automated>npx vitest run packages/saml/test/SamlAdmin.test.ts 2>&1 | grep -E "Tests +[0-9]+ failed"</automated></verify>
  <acceptance_criteria>
    - `## Comments` lists every red case by name.
    - `git log -1 --stat` does not contain `packages/saml/test/SamlAdmin.test.ts` from this ticket.
  </acceptance_criteria>
  <done>Red evidence recorded; tests available to ticket 02.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| administrator → `saml.admin` group | an authenticated administrator names a connection id; the host predicate decides scope |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-31-01 | Elevation of privilege | `SamlAdmin` by-id operations | critical | mitigate | This ticket proves it; ticket 02 asks the predicate with the read connection's organization |
| T-31-02 | Information disclosure | 403-vs-404 answers on by-id calls | medium | mitigate | The matrix pins the uniform answer (§3.3) for every predicate shape |
</threat_model>

<verification>
npx vitest run packages/saml/test/SamlAdmin.test.ts (expected red in the listed rows only). No source change, so no package gate.
</verification>

<success_criteria>
- The red set equals {delegated × B × 6 ops, strict × A × 6 ops, every organizationId event assertion}.
- No other test in the file changes outcome.
</success_criteria>

## Comments
