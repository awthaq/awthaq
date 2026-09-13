# 13 — Active organization context

**What to build:** `organization_active_context`, and `setActive`/
`getActive` for a member's active organization (team columns/behavior
added inert here, wired for real by ticket 16).

**Blocked by:** 12.

**Status:** done

- [x] `organization_active_context` table/persistence module: keyed by
      `sessionId` (unique), `activeOrganizationId?`, `activeTeamId?`,
      `updatedAt`; both layers — a plugin-owned table, not a core `Session`
      column
- [x] `setActive(organizationId | null)` upserts this row for the caller's
      current session; rejects if the caller isn't a member of the named
      organization
- [x] `getActive` reads it back; ticket 12's `getActiveMember`/
      `getActiveMemberRole` now resolve against this row instead of
      returning "no active organization"
- [x] Explicitly documented (in this ticket's own `## Result`, mirroring
      `Admin`'s own `endedBy: "expired"` precedent): this row is not
      actively cascade-deleted when its session is revoked — an orphaned
      row is harmless
- [x] Domain + wire-level tests: set active, read it back, unset with
      `null`, reject setting an org the caller doesn't belong to

## Result

Done. `ActiveContextRecords.ts` persists `organization_active_context`
(`sessionId` PK/unique, `activeOrganizationId?`, `activeTeamId?`,
`updatedAt`), both layers — `setOrganization`/`setTeam` are independent
partial upserts, each touching only its own column. `Organization.ts` gains
`setActive`/`getActive` (contract endpoints `POST`/`GET /organization/active`)
and `getActiveMember`/`getActiveMemberRole` now genuinely resolve against
this table via the caller's own `Api.UserPrincipal.sessionId` (no separate
`Sessions` lookup needed — the principal already carries it). `setActive`
rejects with `MembershipNotFound` (reusing ticket 12's existing error,
not a new one) when the caller isn't a member of the named organization.
Not cascade-deleted on session revocation — an orphaned row is harmless,
exactly mirroring `Admin`'s own documented `endedBy: "expired"` gap.
Covered by `ActiveContextRecords.test.ts` (both layers), `Organization.test.ts`
(domain-level: set/read/unset/reject-non-member), and `AuthHttp.test.ts`
(wire-level round trip). `pnpm --filter @effect-auth/organization typecheck`
clean; `pnpm --filter @effect-auth/organization test` — 7 files, 75 tests,
all passing.
