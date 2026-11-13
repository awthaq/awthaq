---
plan: 32-scim-resource-engine
ticket: 09
title: "internal/engine.ts: one list path, Users and Groups as two listings"
type: execute
wave: 6
depends_on: [07]
files_modified:
  - packages/scim/src/internal/engine.ts
  - packages/scim/src/Scim.ts
  - packages/scim/test/ScimGroupsListing.test.ts
autonomous: true
requirements: [REQ-EA-1533]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "listUsers and listGroups run the same algorithm: filter to a store lookup, no filter to a store page, resolve each link, build the ListResponse"
    - "Paging and both filters behave the same on memory and SQL for both kinds (L3)"
  artifacts:
    - path: "packages/scim/src/internal/engine.ts"
      provides: "ScimEngine.make with list(listing); the Listing interface"
      exports: ["make", "Listing"]
  key_links:
    - from: "engine.list"
      to: "ScimRecords.list"
      via: "unfiltered paging in the store"
      pattern: "records\\.list\\("
---
Status: ready-for-agent
Blocked by: 07

<objective>
Create the engine module with its list path and express `listUsers` and `listGroups` as two `Listing` values.

Purpose: the list algorithm (and the "no cap" property ticket 04 restored) lives once; a third resource kind, if one ever comes, gets it for free.
Output: `packages/scim/src/internal/engine.ts` (list only), the two listings in `Scim.ts`, L3 on SQL.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§3.3 Listing, the list algorithm, the adapter table)
@packages/scim/src/Scim.ts (listUsers, listGroups after ticket 04)
@packages/scim/src/internal/protocol.ts (parseFilter, paging)
@packages/core/src/SignUp.ts (:115-125: a `make` Effect yielded inside another module's make, the pattern to copy)
@packages/scim/test/ScimGroupsListing.test.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: engine.make with list</name>
  <files>packages/scim/src/internal/engine.ts, packages/scim/src/Scim.ts</files>
  <read_first>packages/scim/src/Scim.ts (listUsers, listGroups), packages/core/src/SignUp.ts (:110-130)</read_first>
  <action>Create `packages/scim/src/internal/engine.ts` exporting the `Listing<A, R>` interface of PLAN.md §3.3 and `make(maxResults)`, which returns an `Effect.gen` that yields `ScimRecords.ScimRecords` once and returns `{ list }` (no annotation on `make`; `maxResults` is an argument because `ScimConfig` lives in `Scim.ts` and importing it here would be a cycle). `list(listing)` returns `(connection, query)`: `parseFilter(query.filter, listing.filters)`, `paging(query, maxResults)`; no filter → `records.list(connection.id, listing.kind, { offset, limit: count })`, `render` each link, drop `None`, `totalResults` the store's total; a filter → `listing.lookup`, `render` each, drop `None`, slice to the page, `totalResults` the rendered count. Build the response with `ScimApi`'s list-response schema constant, once, here. In `Scim.ts` `make`, yield `ScimEngine.make(cfg.maxResults)` once; define `userListing` (filters `["userName", "externalId"]`; lookup by `findByName` / `findByExternalId`; render `users.findById` → `userResource`, `UserNotFound` → `None`) and `groupListing` (filters `["displayName", "externalId"]`; lookup as ticket 04 wrote it, including the connection scoping; render `teams.find` → `groupResource`); `listUsers = engine.list(userListing)`, `listGroups = engine.list(groupListing)`. The literal union from `parseFilter` makes each lookup's branch exhaustive; use a `switch` with no default so the compiler checks it.</action>
  <verify><automated>npx tsc -b tsconfig.json && pnpm circular && npx vitest run packages/scim/test</automated></verify>
  <acceptance_criteria>`test -f packages/scim/src/internal/engine.ts` (baseline absent). `grep -c 'engine.list(' packages/scim/src/Scim.ts` = 2 (baseline 0). `grep -c 'LIST_SCHEMA' packages/scim/src/Scim.ts` = 0 (baseline at HEAD: 2; the response is built once, in the engine).</acceptance_criteria>
  <done>Both list endpoints run one algorithm.</done>
</task>

<task type="auto">
  <name>Task 2: L3, both kinds on SQL</name>
  <files>packages/scim/test/ScimGroupsListing.test.ts</files>
  <read_first>packages/scim/test/ScimGroupsListing.test.ts, packages/scim/test/support.ts (ScimLiveSql)</read_first>
  <action>Add L3 over `ScimLiveSql("scim_listing")`: provision 5 users and 5 groups with distinct externalIds; for each kind, `count: 2` pages at startIndex 1, 3, 5 return 2, 2, 1 resources in creation order with `totalResults` 5; each externalId filter and each userName/displayName filter returns exactly one; a removed team (through `OrganizationTeams.remove` by an application actor) is skipped on its page while `totalResults` still counts its mapping (PLAN.md Q4's default). Use a distinct connection name.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimGroupsListing.test.ts</automated></verify>
  <acceptance_criteria>L3 present and green; L1 and L2 still green.</acceptance_criteria>
  <done>The one list path is proven on SQL for both kinds.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| directory → `GET /scim/v2/{Users,Groups}` | filter and paging parameters |

## STRIDE threat register

| Threat ID | Category | Where | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-32-17 | Information disclosure | `engine.list` | high | mitigate | Every lookup and page is keyed by `connection.id`; L2 and L3 |
| T-32-18 | Denial of service | `count` | low | mitigate | Clamped to `maxResults` by `paging` (unchanged) |
</threat_model>

<verification>
npx vitest run packages/scim/test
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
One list algorithm; two listings; L1–L3 green; no circular import.
</success_criteria>

## Comments
