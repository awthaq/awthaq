---
ID: "OHS-006"
Title: "Re-inviting an existing member and accepting creates duplicate/overwritten org membership"
Level: medium
Category: "correctness"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1522"
Auditor: "organization-hierarchy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OHS-006 — Re-inviting an existing member and accepting creates duplicate/overwritten org membership

`MEDIUM` · `correctness` · `organization` · reported by **Organization Hierarchy Specialist** (`organization-hierarchy-specialist`)

Status: **resolved**

## Summary

invite only cancels a pending invitation for an already-member when one is actually pending (lines 1409-1411); when no pending invitation exists it falls through and creates a fresh invitation for the existing member (line 1441). acceptInvitation has no already-member guard — it validates email match and org capacity, then calls members.create unconditionally. In the memory layer this silently overwrites the membership via HashMap.set on `${organizationId}:${userId}` (MembershipRecords.ts:123-125), replacing the member's roles with the invitation's role with no permission check; in the SQL layer it inserts a second row because organization_membership is id-PK only with no UNIQUE(userId, organizationId) (MembershipRecords.test.ts:23-30), after which findOneOption-based findByUserAndOrg (line 256-261) is ambiguous.

## Evidence

Source: `packages/organization/src/Organization.ts:1522`

```
const membership = yield* members.create({
            userId: callerId,
            organizationId: record.organizationId,
```

## Recommended fix

Make acceptInvitation a typed no-op or error when the accepting user already holds a membership (or merge roles explicitly, gated by canGrant), and add UNIQUE(userId, organizationId) to organization_membership.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Org hierarchy modeling
- Full dossier: [`organization-hierarchy-specialist`](../../.reports/organization-hierarchy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-write-atomicity-and-uniqueness`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1772`. Fix: Refuse to invite or admit someone who is already a member, so an invitation can never overwrite or duplicate a membership. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** invite: an existing member gets AlreadyMember (their pending invitation is canceled, none created); acceptInvitation: already-member -> invitation canceled + AlreadyMember, never members.create; MembershipRecordAlreadyExists race mapped. AlreadyMember added to the invite/acceptInvitation endpoint error arrays. Existing test 'inviting an existing member cancels...' updated to the new contract. Tests: Organization.test.ts 'inviting an existing member fails AlreadyMember...' and 'accepting an invitation while already a member ... roles unchanged'. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 853 pass, test:bdd green, spec:verify:strict PASS, oxlint clean.
