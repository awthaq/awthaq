---
plan: 31-admin-tier-gate
ticket: 05
title: "ADR-EA-050 (Proposed) and the glossary entry"
type: execute
wave: 0
depends_on: []
files_modified:
  - spec/decisions/050-admin-tier-gate.md
  - spec/decisions/index.yaml
  - spec/glossary.md
autonomous: false
requirements: [REQ-EA-1520, REQ-EA-1521, REQ-EA-1522, REQ-EA-1523]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "ADR-EA-050 records the core admin-tier gate as Proposed, and says it reverses plan 13 Q5 and amends ADR-EA-018 D8"
    - "The glossary defines Admin-tier gate in the project's vocabulary"
  artifacts:
    - path: "spec/decisions/050-admin-tier-gate.md"
      contains: "ADR-EA-050"
    - path: "spec/decisions/index.yaml"
      contains: "ADR-EA-050"
  key_links:
    - from: "spec/decisions/050-admin-tier-gate.md"
      to: "spec/decisions/018-tenancy-is-an-organization.md"
      via: "Consequences: amends decision 8"
      pattern: "ADR-EA-018"
---
Status: ready-for-human (Q7: does the user reverse plan 13 Q5? The ADR records that reversal)
Blocked by: none

<objective>
Write the decision before the code, as plan 29 ticket 03 did.

Purpose: Track R reverses a recorded plan decision (13 Q5) and amends ADR-EA-018 D8; the ADR is where a reader finds why.
Output: `spec/decisions/050-admin-tier-gate.md` (revision 1.0, Proposed), its `index.yaml` entry, a glossary entry.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§1.4, §3, §6.2, §6.3, §10 Q7)
@.planning/13-admin-gate/PLAN.md (§3.5, §10 Q5, Decisions taken)
@spec/decisions/049-plugins-own-event-definitions.md (shape: Document Control, Context, Decision, Alternatives considered, Consequences, Implementation)
@spec/decisions/018-tenancy-is-an-organization.md (decision 8)
@spec/decisions/009-authorization-delegated-to-qadi.md
@spec/glossary.md (entries "Tier", "Clearance", "Erasure clearance")
</context>

<tasks>
<task type="auto">
  <name>Task 1: The ADR and its index entry</name>
  <files>spec/decisions/050-admin-tier-gate.md, spec/decisions/index.yaml</files>
  <read_first>spec/decisions/049-plugins-own-event-definitions.md, spec/decisions/index.yaml</read_first>
  <action>Create the ADR from PLAN §6.2's draft, in ADR-EA-049's layout: Document ID EFAUTH-ADR-050, Revision 1.0, Effective Date the day you write it, Status "Proposed", Change History "1.0: Initial release, Proposed (architecture plan 31 ticket 05)". Title "Admin-Tier Operations Pass One Core Gate That Sees the Target". Context cites plan 31 §2.2–§2.4 (the three copies, the drifts, F1) and plan 13 Q5. Decision has the six numbered items of the draft; item 3 includes the §3.3 table. Alternatives considered lists PLAN §3.7. Consequences names: ADR-EA-018 decision 8 amended (revision assigned on landing, see ticket 14), plan 13 Q5 reversed, ADR-EA-009 unchanged, plans 36 and 40 interactions. Leave "Implementation" as a heading with "Pending (architecture plan 31 tickets 06–12)". Add the index entry after ADR-EA-049 with status "Proposed".</action>
  <verify><automated>grep -c 'ADR-EA-050' spec/decisions/index.yaml && pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c 'id: "ADR-EA-050"' spec/decisions/index.yaml` → 1 (baseline 0).
    - The ADR's Status cell reads "Proposed".
  </acceptance_criteria>
  <done>ADR-EA-050 Proposed exists and is indexed.</done>
</task>

<task type="auto">
  <name>Task 2: Glossary</name>
  <files>spec/glossary.md</files>
  <read_first>spec/glossary.md</read_first>
  <action>Add an entry "### Admin-tier gate" near "Tier"/"Clearance": the one core module (`AdminTierGate`) every admin-tier operation passes; it reads the plugin's configuration in force, asks the host's predicate (with the target when the operation has one, read first when only the read row can answer), publishes `auth.admin.actionDenied` on a refusal, spends the administrator's rate rule on a pass and mints a clearance carrying the configuration that authorized it. A plugin only declares its actions, predicate adapter, denial names, typed refusal and throttle. See ADR-EA-050 (ticket 13 adds the BEH-EA-347 link once it exists). Bump the glossary's Document Control revision with a plan-31 line.</action>
  <verify><automated>grep -c "^### Admin-tier gate" spec/glossary.md</automated></verify>
  <acceptance_criteria>
    - The grep prints 1 (baseline 0).
  </acceptance_criteria>
  <done>Glossary entry present.</done>
</task>
</tasks>

<verification>
pnpm spec:verify:strict && pnpm format:check
</verification>

<success_criteria>
- ADR-EA-050 Proposed and indexed; glossary entry present; spec verification green.
</success_criteria>

## Comments
