---
plan: 32-scim-resource-engine
ticket: 04
title: "Group listing through the store: no cap, no scan, still scoped to the connection"
type: tdd
wave: 3
depends_on: [01, 03]
files_modified:
  - packages/scim/src/Scim.ts
  - packages/scim/test/ScimGroupsListing.test.ts
autonomous: true
requirements: [REQ-EA-1533]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "displayName eq, externalId eq and paging reach a group however many groups the connection has (L1 green)"
    - "displayName eq never lists a team this connection did not provision (L2 stays green, memory and SQL)"
    - "An unfiltered page costs one store page read plus at most count team reads"
  artifacts:
    - path: "packages/scim/src/Scim.ts"
      provides: "listGroups over records.findByExternalId, a connection-scoped name lookup, and records.list paging"
  key_links:
    - from: "listGroups displayName branch"
      to: "records.find(connection.id, \"Group\", team.id)"
      via: "each same-named team kept only when this connection maps it"
      pattern: "records\\.find\\(connection\\.id, \"Group\""
---
Status: done (uncommitted)
Blocked by: 01, 03

<objective>
Replace `listGroups`' scan (`Scim.ts:1153-1181`: at most ten thousand mappings, one `teams.find` each, then filter and page in memory) with the shape `listUsers` already has: the filter goes to a store lookup, the unfiltered case pages in the store.

Purpose: fixes F4. Group 10,001 onwards becomes visible to both filters and to paging; the per-request cost drops from up to ten thousand reads to one page.
Output: the new `listGroups`; L1 flipped to `it.effect`.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§2.3, §3.3 group lookup, §3.6 (c)-(e), Q1, Q4)
@packages/scim/src/Scim.ts (:752-781 listUsers, :1041-1088 ownedGroup/groupResource, :1153-1181 listGroups)
@packages/scim/src/ScimRecords.ts (:115-135 find/findByExternalId/list)
@packages/organization/src/OrganizationTeams.ts (:52-54 list, :343-346 find/list)
@packages/scim/test/ScimGroupsListing.test.ts
</context>

<tasks>

<task type="tdd">
  <name>Task 1: listGroups without the cap</name>
  <files>packages/scim/src/Scim.ts</files>
  <read_first>packages/scim/src/Scim.ts (:752-781, :1153-1181)</read_first>
  <action>Rewrite `listGroups` to mirror `listUsers`. Parse the filter and paging as now. Unfiltered: `records.list(connection.id, "Group", { offset, limit: count })`; resolve each link on the page with `teams.find(connection.organizationId, link.resourceId)`; skip a link whose team is gone (do not unlink: Q4's default; `getGroup` already drops a stale mapping); `totalResults` is the page's `total`. Filter `externalId`: `records.findByExternalId(connection.id, "Group", value)`, resolved the same way. Filter `displayName`: `teams.list(connection.organizationId)`, keep teams whose `name` equals the value exactly (case-sensitive, as today), then keep only those for which `records.find(connection.id, "Group", team.id)` is `Some` (this is the connection scoping L2 pins: a same-named team of an administrator or of another connection must never appear). For both filters, slice the matches to the page in memory and set `totalResults` to the number of matches. Then `groupResource` per row, as now. Remove the hard-coded ten-thousand page and the per-link scan entirely. No new store operation (Q1's default).</action>
  <verify><automated>npx vitest run packages/scim/test/ScimGroups.test.ts packages/scim/test/ScimFilter.property.test.ts</automated></verify>
  <acceptance_criteria>`grep -c '10_000' packages/scim/src/Scim.ts` = 0 (baseline at HEAD: 1). `ScimGroups.test.ts` "list filters by displayName and externalId" green.</acceptance_criteria>
  <done>Group listing has no cap and no scan.</done>
</task>

<task type="tdd">
  <name>Task 2: flip L1</name>
  <files>packages/scim/test/ScimGroupsListing.test.ts</files>
  <read_first>packages/scim/test/ScimGroupsListing.test.ts</read_first>
  <action>Change L1 from `it.effect.fails` to `it.effect` (keep its timeout). L2 must stay green on both modes. Record L1's run time in Comments.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimGroupsListing.test.ts</automated></verify>
  <acceptance_criteria>`grep -c 'it.effect.fails' packages/scim/test/ScimGroupsListing.test.ts` = 0 (baseline after ticket 01: 1).</acceptance_criteria>
  <done>F4 is fixed and proven; connection scoping still holds.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| directory → `GET /scim/v2/Groups?filter=…` | The filter value is attacker-controlled when a token leaks |

## STRIDE threat register

| Threat ID | Category | Where | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-32-12 | Information disclosure | `displayName eq` over `teams.list(organizationId)` | high | mitigate | Every candidate passes `records.find(connection.id, "Group", id)`; L2 on memory and SQL |
| T-32-13 | Denial of service | `displayName eq` reads every team of the organization | low | accept | One query bounded by the organization's own teams (no per-team read); Q1 is the follow-up |
| T-32-14 | Tampering | filter parsing | low | mitigate | Parser unchanged; the "never a defect" property (`ScimFilter.property.test.ts:38`) still runs |
</threat_model>

<verification>
npx vitest run packages/scim/test
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
No ten-thousand literal in `Scim.ts`; L1 and L2 green; no new store operation; every pre-existing SCIM test green.
</success_criteria>

## Comments
