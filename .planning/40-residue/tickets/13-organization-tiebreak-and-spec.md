---
plan: 40-residue
ticket: 13
title: "Organization memory adapter: code-unit tiebreak; BEH-EA-036 limit note"
type: execute
wave: 0
depends_on: [12]
files_modified:
  - packages/organization/src/OrganizationRecords.ts
  - spec/behaviors/05-persistence-stratum.md
  - .changeset/organization-keyset-tiebreak.md
autonomous: true
requirements: [REQ-EA-1614]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "The organization memory adapter sorts and filters by the same code-unit id compare"
    - "BEH-EA-036 states the limit rule every keyset listing follows"
  artifacts:
    - path: spec/behaviors/05-persistence-stratum.md
      provides: "BEH-EA-036 As shipped note + revision bump"
  key_links:
    - from: packages/organization/src/OrganizationRecords.ts
      to: packages/organization/test/contract/OrganizationRecords.ts
      via: "ticket 11's exact-order case keeps it honest"
      pattern: "every page size traverses"
---
Status: ready-for-agent
Blocked by: 12 (the spec note describes 12's rule)

<objective>
Close B-F3 and write down the limit rule.
Purpose: `OrganizationRecords.ts:218` sorts with `localeCompare` while `:227` filters with `>` (PLAN §2.B.3): locale-dependent, and not what SQL does. Unreachable with UUIDv7 ids, so this is a one-line consistency fix, not a bug fix.
Output: code-unit compare; BEH-EA-036 note; changeset.
</objective>

<context>
@packages/organization/src/OrganizationRecords.ts (:211-232)
@spec/behaviors/05-persistence-stratum.md (:1-15 document control, :97-115 BEH-EA-036)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: code-unit tiebreak</name>
    <files>packages/organization/src/OrganizationRecords.ts, .changeset/organization-keyset-tiebreak.md</files>
    <read_first>packages/organization/src/OrganizationRecords.ts:205-235</read_first>
    <action>Replace `a.id.localeCompare(b.id)` with `(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)` (the form `UserStore.byCreation` uses, `ports/src/UserStore.ts:184-186`). Changeset: `"@awthaq/organization": patch`, "the memory adapter orders organizations with the same id comparison it pages with", `Migration: none.`</action>
    <verify><automated>npx vitest run packages/organization/test/Contract.test.ts</automated></verify>
    <acceptance_criteria>`rg -c 'localeCompare' packages/organization/src/OrganizationRecords.ts` prints nothing (baseline 1).</acceptance_criteria>
    <done>Organization contract green.</done>
  </task>
  <task type="auto">
    <name>Task 2: BEH-EA-036 note</name>
    <files>spec/behaviors/05-persistence-stratum.md</files>
    <read_first>spec/behaviors/05-persistence-stratum.md:1-15, :97-115</read_first>
    <action>Bump the Document Control revision and add a change-history entry "(architecture plan 40)". Under BEH-EA-036 add an *As shipped* paragraph: every keyset listing (users, organizations, impersonation episodes) normalises an in-process `limit` like `Users.list`: truncated, clamped to 1..200, 50 when absent or non-finite; the wire refuses anything outside 1..200 first; memory adapters compare ids by code unit. Do not change the REQUIREMENT block.</action>
    <verify><automated>pnpm spec:verify:strict</automated></verify>
    <done>Spec states the rule.</done>
  </task>
</tasks>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:pg</verification>

<success_criteria>`localeCompare` 1 → 0; BEH-EA-036 revised; spec verify green.</success_criteria>

## Comments
