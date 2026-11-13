---
plan: 32-scim-resource-engine
ticket: 07
title: "internal/protocol.ts: the RFC 7644 filter, paging and PATCH rules in one pure module"
type: tdd
wave: 5
depends_on: [05, 06]
files_modified:
  - packages/scim/src/internal/protocol.ts
  - packages/scim/src/Scim.ts
  - packages/scim/test/ScimProtocol.test.ts
autonomous: true
requirements: [REQ-EA-1530, REQ-EA-1532]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "The filter, paging and PATCH rules for users and groups are defined once, in internal/protocol.ts, and Scim.ts imports them"
    - "Those rules are tested directly, without building a composition"
    - "parseFilter returns the attribute as a literal union, so a caller's branch on it is checked by the compiler"
  artifacts:
    - path: "packages/scim/src/internal/protocol.ts"
      provides: "parseFilter, paging, interpretUserPatch, interpretGroupPatch, groupReplacement, namedMembers, settleRoster, the input helpers"
      exports: ["parseFilter", "paging", "interpretUserPatch", "interpretGroupPatch", "groupReplacement", "namedMembers", "settleRoster"]
    - path: "packages/scim/test/ScimProtocol.test.ts"
      provides: "pure cases and properties"
  key_links:
    - from: "packages/scim/src/Scim.ts"
      to: "packages/scim/src/internal/protocol.ts"
      via: "named imports"
      pattern: "from \"./internal/protocol.ts\""
---
Status: ready-for-agent
Blocked by: 05, 06

<objective>
Move the pure protocol code out of `Scim.ts` into a package-private module and test it at that interface.

Purpose: locality (the RFC rules in one place; today the unknown-op refusal is written in two interpreters) and fast tests (the filter properties currently build a composition per run).
Output: `packages/scim/src/internal/protocol.ts`, `packages/scim/test/ScimProtocol.test.ts`; `Scim.ts` imports instead of defining.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§3.2, §3.5, §5.1)
@packages/scim/src/Scim.ts (:196-367 pure helpers and the user interpreter; the group interpreter ticket 03 added)
@packages/scim/test/ScimFilter.property.test.ts (the properties to port in Task 3)
@packages/organization/src/internal/ (the package-private module convention)
@packages/scim/package.json (exports only ".", so src/internal is not public)
</context>

<tasks>

<task type="tdd">
  <name>Task 1: create internal/protocol.ts by moving code</name>
  <files>packages/scim/src/internal/protocol.ts, packages/scim/src/Scim.ts</files>
  <read_first>packages/scim/src/Scim.ts (:196-367 and ticket 03's group interpreter)</read_first>
  <action>Create `packages/scim/src/internal/protocol.ts` with a header comment (RFC 7644 §3.4.2 filter and paging, §3.5.2 PATCH; pure: it requires nothing from the context). Move, without behaviour change: `coerceBoolean`, `isRecord`, `stringOf`, the eq-filter parser (rename it `parseFilter` and make it generic over the attribute list with a `const` type parameter so the returned `attribute` is the literal union of the attributes passed, per PLAN.md §3.2), `paging` (return a `Page`), `splitName`, `joinName`, `nameFromInput`, `emailFromInput`, `UserChanges`, `noChanges`, `assign`, `interpretUserPatch`, and ticket 03's `RosterStep`, `GroupChanges`, `interpretGroupPatch`, `groupReplacement`, `namedMembers`, `settleRoster`, the member-id extraction and the 255 constant. Export only what `Scim.ts` or the tests use (knip fails on an unused export). Import them in `Scim.ts` by name from `./internal/protocol.ts`. Where `Scim.ts` compared the parsed attribute against a string, the literal union now type-checks the comparison; keep the logic identical. `protocol.ts` imports only `effect/*` and `../ScimApi.ts` (no `Scim.ts`, no `ScimRecords.ts`): `pnpm circular` must stay green.</action>
  <verify><automated>npx tsc -b tsconfig.json && pnpm circular && npx vitest run packages/scim/test</automated></verify>
  <acceptance_criteria>`test -f packages/scim/src/internal/protocol.ts` (baseline: absent). `grep -c 'Unknown patch op' packages/scim/src/Scim.ts` = 0 (baseline after ticket 03: 2). `grep -c 'Unknown patch op' packages/scim/src/internal/protocol.ts` = 1. `grep -c 'from "./internal/protocol.ts"' packages/scim/src/Scim.ts` = 1. Every existing SCIM test green unchanged.</acceptance_criteria>
  <done>The protocol rules exist once; `Scim.ts` only uses them.</done>
</task>

<task type="tdd">
  <name>Task 2: one unknown-op refusal for both interpreters</name>
  <files>packages/scim/src/internal/protocol.ts</files>
  <read_first>packages/scim/src/internal/protocol.ts</read_first>
  <action>Both interpreters normalise the op the same way (trim, lower-case) and refuse anything outside add/replace/remove with the same `400 invalidSyntax`. Factor that into one private `opOf(operation)` that returns the literal union `"add" | "replace" | "remove"` or fails, and use it in both interpreters, so the refusal message exists once. No behaviour change.</action>
  <verify><automated>npx tsc -b tsconfig.json && npx vitest run packages/scim/test/ScimUsers.test.ts packages/scim/test/ScimAtomicity.test.ts</automated></verify>
  <acceptance_criteria>The refusal message appears once in `packages/scim/src` (`grep -rc 'Unknown patch op' packages/scim/src` sums to 1; baseline at HEAD: 2).</acceptance_criteria>
  <done>The op rule lives once.</done>
</task>

<task type="tdd">
  <name>Task 3: ScimProtocol.test.ts</name>
  <files>packages/scim/test/ScimProtocol.test.ts</files>
  <read_first>packages/scim/test/ScimFilter.property.test.ts, packages/scim/src/internal/protocol.ts</read_first>
  <behavior>
    - parseFilter properties (ported from ScimFilter.property.test.ts:50 and :112, now pure): any operator other than eq on a supported attribute fails invalidFilter; an attribute not in the list fails invalidFilter; any quoted, escaped value round-trips exactly; any text yields Some, None or a typed ScimBadRequest, never a defect
    - paging: startIndex below 1 is 1; count is clamped to 0..maxResults; offset = startIndex - 1
    - interpretGroupPatch: one case per row of PLAN.md §3.2's table, including path-less { displayName, externalId, members } and the 256-character refusal
    - settleRoster properties over random steps and a random current set: add and remove are disjoint; remove is a subset of current; applying add and remove to current equals folding the steps one by one; an id never in current and never in an Add or Replace is in neither list
    - interpretUserPatch: Okta path-less object, Entra capitalized op and "True"/"False", unmanaged attributes ignored, remove externalId clears, unknown op invalidSyntax
  </behavior>
  <action>Write the file with `@effect/vitest` (`it.effect` for Effect-returning functions, `it.effect.prop` with `Schema` arbitraries as `ScimFilter.property.test.ts` does, plain `it` for `paging` and `settleRoster`). Header: BEH-EA-248/251/252/350, plan 32 ticket 07. No composition, no layer: these functions require nothing.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimProtocol.test.ts</automated></verify>
  <acceptance_criteria>The file runs without providing any layer (`grep -c 'Effect.provide' packages/scim/test/ScimProtocol.test.ts` = 0). It contains at least the four parseFilter properties and the four settleRoster properties.</acceptance_criteria>
  <done>The RFC rules are tested at their own interface.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| directory → `/scim/v2` | Every filter and PATCH body passes through this module |

## STRIDE threat register

| Threat ID | Category | Where | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-32-15 | Tampering | `parseFilter` | medium | mitigate | Pure "never a defect" and round-trip properties |
| T-32-16 | Elevation of privilege | `settleRoster` | high | mitigate | "remove ⊆ current" property: a directory can never remove a member it did not provision |
</threat_model>

<verification>
npx vitest run packages/scim/test
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
`internal/protocol.ts` exists; the op refusal appears once in `packages/scim/src`; `ScimProtocol.test.ts` green without a composition; every other SCIM test unchanged and green.
</success_criteria>

## Comments
