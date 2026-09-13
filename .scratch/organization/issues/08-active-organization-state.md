# 08 — Active organization/team state

**Type:** grilling
**Status:** resolved
**Blocked by:** 03, 04

## Question

Design the plugin-owned table (map decision: not a core `Session` column)
that tracks a session's active organization/team, mirroring better-auth's
`activeOrganizationId`/`activeTeamId` session fields without reopening
core's `Session` model a second time this cycle (`Admin` already added a
core-touching column, `actingAs`):

- Table shape (keyed by `sessionId`), lifecycle (created on first
  `set-active` call? seeded at session-issue time?)
- What happens to this row when the underlying session is revoked (cascade
  delete, or orphaned-but-harmless?)
- `set-active`/`get-active`/`get-active-member`/`get-active-member-role`
  read/write semantics

## Answer

Resolved directly by `/to-spec`, folded into `.scratch/organization/spec.md`'s
"Implementation Decisions" (§ Active organization/team state). Summary:
`organization_active_context` keyed by `sessionId` (unique), with
`activeOrganizationId`/`activeTeamId` (both optional) and `updatedAt` — a
plugin-owned table, not a new core `Session` column. `set-active`/
`set-active-team` upsert this row; reads join through it. Deliberately not
cascade-deleted on session revocation (orphaned-but-harmless), mirroring
`Admin`'s own documented `endedBy: "expired"` gap rather than building new
session-lifecycle plumbing this ticket didn't ask for.
