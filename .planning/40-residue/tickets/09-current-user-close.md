---
plan: 40-residue
ticket: 09
title: "CurrentUser.current returns Caller only; ADR-EA-042 rev 1.2, glossary, plugin-authoring, changeset"
type: execute
wave: 4
depends_on: [02, 03, 04, 06, 07, 08]
files_modified:
  - packages/core/src/CurrentUser.ts
  - docs/plugin-authoring.md
  - spec/glossary.md
  - spec/decisions/042-credential-resolution-module.md
  - .changeset/current-user-caller.md
autonomous: true
requirements: [REQ-EA-1612]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "CurrentUser.current's success type is exactly CurrentUser.Caller (no `principal`)"
    - "Outside CurrentUser.ts no src file re-brands a principal or reads `caller.ref.id` in passkey, password, two-factor, admin, saml, webhooks, organization"
    - "ADR-EA-042 decision 9 names CurrentUser.Caller and records that it is not OrganizationActor.Actor (plan 04 Q7)"
  artifacts:
    - path: spec/decisions/042-credential-resolution-module.md
      provides: "revision 1.2"
      contains: "CurrentUser.Caller"
  key_links:
    - from: docs/plugin-authoring.md
      to: packages/core/src/CurrentUser.ts
      via: "documents `const { userId, sessionId, actingAs } = yield* CurrentUser.current`"
      pattern: "userId, sessionId, actingAs"
---
Status: ready-for-agent
Blocked by: 02, 03, 04, 06, 07, 08 (if Q3 = no, 08 is dropped and this ticket keeps `principal`; see task 1)

<objective>
Close Part A: the transitional `principal` leaves `current`, and the rule is written down.
Purpose: PLAN §1.A.3 goal 4; GC-003 holds by construction.
Output: `current` returns `Caller`; ADR-EA-042 rev 1.2; glossary 1.16; plugin-authoring; core changeset.
</objective>

<context>
@packages/core/src/CurrentUser.ts
@docs/plugin-authoring.md (:205-215)
@spec/glossary.md (:13 change history, :67 CurrentPrincipal)
@spec/decisions/042-credential-resolution-module.md (:1-15 document control, :41 decision 9)
@.planning/40-residue/PLAN.md §6.A (text to write), §10 Q2 (exceptions to record)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: drop `principal` from current</name>
    <files>packages/core/src/CurrentUser.ts</files>
    <read_first>packages/core/src/CurrentUser.ts</read_first>
    <precondition>`rg -n '\{ principal(: caller)? \} = yield\* CurrentUser\.current|CurrentUser\.current\)\.principal|\(\{ principal \}' packages/*/src` prints nothing. If Q3 = no and only OrganizationHandlers.ts:32 remains, keep `principal` and write in Comments that ticket 08 was skipped.</precondition>
    <action>`current` returns `of(principal)` (drop the spread and its transitional comment). Run `pnpm typecheck`; any remaining reader of `.principal` is a missed site: convert it the way tickets 02–08 did and list it in Comments.</action>
    <verify><automated>pnpm typecheck && npx vitest run packages/core/test/CurrentUser.test.ts</automated></verify>
    <acceptance_criteria>A1: `rg -c 'Users\.UserId\(principal\.ref\.id\)' packages/passkey/src packages/password/src packages/two-factor/src packages/core/src` prints only `packages/core/src/CurrentUser.ts:1` (baseline 18 across 4 files). A2: `rg -c 'caller\.ref\.id' packages/admin/src packages/saml/src packages/webhooks/src packages/organization/src` prints nothing (baseline 43). A3: `rg -c 'caller: Api\.UserPrincipal' …same dirs` prints nothing (baseline 110). A5: the three patterns of the precondition print nothing (baseline 56).</acceptance_criteria>
    <done>`current`'s type is `Effect<Caller, never, Api.CurrentPrincipal>` by inference.</done>
  </task>
  <task type="auto">
    <name>Task 2: ADR, glossary, plugin-authoring, changeset</name>
    <files>spec/decisions/042-credential-resolution-module.md, spec/glossary.md, docs/plugin-authoring.md, .changeset/current-user-caller.md</files>
    <read_first>the lines in context; .changeset/adr-041-decision-9.md (format)</read_first>
    <action>ADR-EA-042: Revision 1.2; Change History `1.2 (<today>): decision 9: CurrentUser.Caller is the domain caller; admin-tier modules take it (architecture plan 40)`; append to decision 9 the paragraph in PLAN §6.A (Caller, `of` as the one re-brand, domain modules never take `Api.UserPrincipal`, not `OrganizationActor.Actor` per plan 04 Q7) plus one sentence naming the principal-any readers left as they are (`device-authorization`, qadi `Resolvers`, roles' subject resolver, qadi `SubjectResolver`, jwt) per Q2. Do not change any other decision (Accepted ADR: amend only). Glossary: Revision 1.16 and change-history entry; in `CurrentPrincipal` say the user-tier read returns a `CurrentUser.Caller`. plugin-authoring.md:210: show `const { userId, sessionId, actingAs } = yield* CurrentUser.current` and add: a domain method that needs its caller takes `CurrentUser.Caller` (or the branded ids), never `Api.UserPrincipal`. Changeset `.changeset/current-user-caller.md`: `"@awthaq/core": minor`, body: `CurrentUser.Caller`, `CurrentUser.of`; `Migration: CurrentUser.current no longer returns principal; read userId, sessionId, actingAs, or Api.CurrentPrincipal if the wire principal is needed.`</action>
    <verify><automated>pnpm spec:verify:strict && pnpm check:readmes && grep -c 'CurrentUser.Caller' spec/decisions/042-credential-resolution-module.md</automated></verify>
    <done>Spec and docs say what the code does.</done>
  </task>
</tasks>

<verification>pnpm check   (plan-level gate for Part A)</verification>

<success_criteria>A1 = 1 (CurrentUser.ts), A2 = 0, A3 = 0, A4 = 0, A5 = 0; `pnpm check` green.</success_criteria>

## Comments

Status: done (uncommitted)
Result: `CurrentUser.current` returns `of(principal)` (Caller only). Precondition grep and tsc (build + test) clean. The only remaining `.principal` reader was `examples/plugin-template` (`Notes` took `Api.UserPrincipal`): converted to `CurrentUser.Caller` (src + test via `CurrentUser.of`). Principal-any readers (device-authorization, qadi Resolvers, roles) did not use `current`'s principal; left per Q2. GC-003 guard test now asserts `current` deep-equals `of(principal)` with keys exactly userId/sessionId/actingAs. ADR-EA-042 rev 1.2, glossary 1.16, plugin-authoring, `.changeset/current-user-caller.md` written. No traceability/README/overview change needed (spec:verify:strict 32/0, check:readmes pass). `pnpm check` not run (not allowed).
