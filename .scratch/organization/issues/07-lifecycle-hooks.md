# 07 — Lifecycle hook points

**Type:** grilling
**Status:** resolved
**Blocked by:** 03, 04, 05, 06

## Question

Declare Organization's own `HookPoint` points
(`packages/core/src/HookPoint.ts` — `veto`/`observe`/`divert`,
BEH-EA-089–096), mirroring better-auth's full `organizationHooks`
before/after set (ticket 00), now that every operation they'd wrap is
itself decided. `Organization` is this project's first real consumer of
this mechanism (map decision) — no prior plugin precedent to lean on.

- Which operations get a hook point, and which kind (`veto` for
  before-hooks that can abort/amend, `observe` for after-hooks)
- Each point's `Input` schema
- Whether better-auth's `databaseHooks.session.create.before` active-org-seeding
  behavior needs its own hook point, or is just plain logic inside
  `set-active` given ticket 08's plugin-owned active-state table (no core
  session hook needed)

## Answer

Resolved directly by `/to-spec`, folded into `.scratch/organization/spec.md`'s
"Implementation Decisions" (§ Lifecycle hooks). Summary: one `HookPoint`
(`veto` before, `observe` after) per mutating operation across organization,
membership, invitation, and team CRUD — `Organization` is the first real
plugin consumer of the core `HookPoint` mechanism. No dedicated hook needed
for active-org seeding, since ticket 08 decided a plugin-owned table (no
core `Session` hook to wire).
