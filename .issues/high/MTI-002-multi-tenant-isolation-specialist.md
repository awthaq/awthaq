---
ID: "MTI-002"
Title: "listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user"
Level: high
Category: "security"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1857"
Auditor: "multi-tenant-isolation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTI-002 — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user

`HIGH` · `security` · `organization` · reported by **Multi-Tenant Isolation Specialist** (`multi-tenant-isolation-specialist`)

Status: **resolved**

## Summary

listTeamMembers (Organization.ts:1856-1862) and listTeams (1795-1800) take no caller, check no membership, and consult no permission statement — they only verify the organization and team exist and teams are enabled. Any authenticated principal of the deployment can therefore enumerate another tenant's team names, member counts, and per-team user rosters; the HTTP contract confirms this is reachable over the wire with error sets like [OrganizationNotFound, TeamsDisabled, TeamNotFound] containing no permission error (OrganizationApi.ts:637-675). The contract's own header comment (OrganizationApi.ts:4-7) states reads are gated 'where the operation is mutating' — i.e., cross-tenant read openness is documented, but for a multi-tenant product it is a confidentiality leak: team rosters are personal data about another tenant's staff.

## Evidence

Source: `packages/organization/src/Organization.ts:1857`

```
function* (organizationId, teamId) {
          yield* requireOrganization(organizationId);
          yield* requireTeamsEnabled;
          yield* requireTeam(organizationId, teamId);
          return yield* teams.listTeamMembers(teamId);
```

## Recommended fix

Thread the caller into listTeams/listTeamMembers and require at least requireMembership (or a 'team read' permission statement). If some orgs genuinely want public team directories, make it an explicit per-organization config flag defaulting to member-only, not an implicit global default.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Multi-Tenant Isolation
- Full dossier: [`multi-tenant-isolation-specialist`](../../.reports/multi-tenant-isolation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-008` — GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check](medium/MTI-008-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `Organization.ts:1858-1861` (`listTeamMembers`, evidence matches near-exactly at line 1857) and `Organization.ts:1795-1799` (`listTeams`) take only `organizationId`/`teamId`, calling `requireOrganization`/`requireTeamsEnabled`/`requireTeam` but never `requireMembership` or a permission check — unlike sibling reads such as `get` (`Organization.ts:1098-1099`, which does call `requireMembership`). Any authenticated principal can enumerate another tenant's team rosters. Threading the caller through and requiring membership mirrors the existing pattern used elsewhere in the same file, a well-scoped mechanical fix. Status → ready-for-agent.

**Resolved (2026-09-19):** Took the recommended fix's first option (member-only, not a per-organization config flag — no existing config precedent for making a security check optional, and the finding itself frames the default as the confidentiality bug). Both `listTeams` and `listTeamMembers` (`OrganizationShape`, `Organization.ts`) now take `caller: Api.UserPrincipal` as their first parameter and call `requireMembership(Users.UserId(caller.ref.id), organizationId)`, mirroring `getFull`'s own established posture for a member-gated read (and `listUserTeams`'s existing `caller`-first signature, which didn't need this check since it's already self-scoped to the caller's own memberships). Both HTTP handlers now resolve `caller` via `currentUserPrincipal` before calling through. `OrganizationApi.ts`'s `listTeams`/`listTeamMembers` endpoints gained `OrganizationPermissionDenied` to their error unions.

TDD: added "listTeams/listTeamMembers are denied to a non-member" to `packages/organization/test/Organization.test.ts`, mirroring the file's own identical "getFull/listMembers/listInvitationsForOrganization are denied to a non-member" test — an outsider is rejected with `OrganizationPermissionDenied` on both calls, then succeeds once actually added as a member. Verified to genuinely fail with the fix reverted (the outsider's `listTeams` call resolved successfully and returned the org's team data, reproducing the leak exactly). Updated 5 existing call sites (`Organization.test.ts` ×4, `OrganizationHooks.test.ts` ×1) that called the old caller-less signature. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (662 passed, 7 skipped).
