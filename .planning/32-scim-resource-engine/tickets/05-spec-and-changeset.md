---
plan: 32-scim-resource-engine
ticket: 05
title: "Spec, traceability, README and changeset for Phase 0"
type: execute
wave: 4
depends_on: [02, 03, 04]
files_modified:
  - spec/behaviors/30-scim.md
  - spec/traceability.md
  - packages/scim/README.md
  - .changeset/scim-group-writes-atomic.md
autonomous: true
requirements: [REQ-EA-1530, REQ-EA-1531, REQ-EA-1532, REQ-EA-1533]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "BEH-EA-350 and BEH-EA-351 exist and say what tickets 02-04 made true, including the memory caveat"
    - "BEH-EA-248, 251 and 252 no longer contradict the new behaviour"
    - "A host reading the changeset learns the event-cardinality change and the 255-character PATCH limit"
  artifacts:
    - path: "spec/behaviors/30-scim.md"
      provides: "BEH-EA-350, BEH-EA-351; revision 1.7"
      contains: "BEH-EA-350"
    - path: ".changeset/scim-group-writes-atomic.md"
      provides: "patch changeset with a Migration: line"
      contains: "Migration:"
  key_links:
    - from: "spec/traceability.md"
      to: "packages/scim/test/ScimAtomicity.test.ts, ScimGroupsListing.test.ts"
      via: "the packages/scim/test/* row names them against BEH-EA-350/351"
      pattern: "ScimAtomicity"
---
Status: done (uncommitted)
Blocked by: 02, 03, 04

<objective>
Record Phase 0's behaviour changes where the repo requires them: the behaviour entries (Document Control revision and history), traceability, the package README, and a changeset with a `Migration:` line.

Purpose: every behaviour change updates its spec entry (shared conventions); `pnpm spec:verify:strict` checks the links.
Output: `30-scim.md` 1.7, traceability rows, README lines, `.changeset/scim-group-writes-atomic.md`.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§3.4, §3.7, §6.2-§6.6)
@spec/behaviors/30-scim.md (Document Control :1-14; BEH-EA-248 :65-80; BEH-EA-251 :125-150; BEH-EA-252 :154-173)
@spec/traceability.md (Document Control :13; §1 row :56; scim rows :387-388; §6 row :436)
@packages/scim/README.md (:27-28, :42)
@.changeset/api-key-owner-standing.md (changeset format)
</context>

<tasks>

<task type="auto">
  <name>Task 1: behaviours and traceability</name>
  <files>spec/behaviors/30-scim.md, spec/traceability.md</files>
  <read_first>spec/behaviors/30-scim.md, spec/traceability.md (:1-60, :380-440)</read_first>
  <action>In `30-scim.md`: add BEH-EA-350 and BEH-EA-351 after BEH-EA-253 with the REQUIREMENT text of PLAN.md §6.2, each followed by its rationale paragraph and the `_Previous | Next_` navigation line the file uses (fix BEH-EA-253's Next link). BEH-EA-350 carries the memory note of §6.2 and the RFC 7644 §3.5.2 sentence; before quoting it, check the exact wording at https://www.rfc-editor.org/rfc/rfc7644#section-3.5.2 and quote what is there (plan 04 Q11 asked for this). Reword BEH-EA-248 (one clause pointing at BEH-EA-350), BEH-EA-251 (a path-less object applies every managed attribute it names; a `PATCH` changes the roster once by its net effect, so team events and observers follow per user actually changed; point at BEH-EA-350), BEH-EA-252 (paging and both filters reach every provisioned resource; point at BEH-EA-351). Document Control: Revision 1.7, Effective Date the landing date, a change-history entry "1.7 (date): BEH-EA-350 and BEH-EA-351; BEH-EA-248/251/252 point at them; a group PATCH changes the roster by its net effect and a path-less object applies every managed attribute (architecture plan 32)". In `traceability.md`: the §1 row for file 30 becomes `246-253, 350-351`; the `packages/scim/test/*` row (:388) adds `ScimAtomicity.test.ts` (BEH-EA-350: refused PUT/PATCH and deactivation leave nothing, memory and SQL) and `ScimGroupsListing.test.ts` (BEH-EA-351: past the ten-thousandth group, connection scoping); add a Document Control revision line naming plan 32 ticket 05.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>`grep -c '^## BEH-EA-35[01]' spec/behaviors/30-scim.md` = 2 (baseline 0). `grep -c 'ScimAtomicity' spec/traceability.md` ≥ 1 (baseline 0). `grep -c '| Revision | 1.7 |' spec/behaviors/30-scim.md` = 1 (baseline 0).</acceptance_criteria>
  <done>The spec states Phase 0's behaviour and traces it to the tests.</done>
</task>

<task type="auto">
  <name>Task 2: README and changeset</name>
  <files>packages/scim/README.md, .changeset/scim-group-writes-atomic.md</files>
  <read_first>packages/scim/README.md, .changeset/api-key-owner-standing.md</read_first>
  <action>README: in the `PUT`/`PATCH` rows (:28 and the Groups row) add that a request is applied whole or not at all (on the in-memory backend, a rename veto after a roster change keeps the roster change: development only); in the Groups paragraph (:42) add that filters and paging reach every group the connection provisioned. Changeset: front matter `"@awthaq/scim": patch`; one paragraph per row of PLAN.md §3.7; then `Migration:` as PLAN.md §6.6 words it (event counts per net change; partial PATCHes no longer happen; PATCH `displayName` over 255 is `400`). Name BEH-EA-350/351.</action>
  <verify><automated>pnpm check:readmes && pnpm format:check</automated></verify>
  <acceptance_criteria>`grep -c '^Migration:' .changeset/scim-group-writes-atomic.md` = 1 (baseline: no file). `grep -c '"@awthaq/scim": patch' .changeset/scim-group-writes-atomic.md` = 1.</acceptance_criteria>
  <done>Hosts can read the change and its migration note.</done>
</task>

</tasks>

<verification>
pnpm spec:verify:strict && pnpm check:readmes && pnpm format:check
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Two new behaviour entries, three reworded, revision 1.7, traceability rows, README, changeset; spec verification strict green.
</success_criteria>

## Comments
