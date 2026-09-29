---
ID: "EP-010"
Title: "Invitations accepted from unverified emails by default"
Level: low
Category: "security"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:83"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-010 — Invitations accepted from unverified emails by default

`LOW` · `security` · `organization` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **resolved**

## Summary

`requireEmailVerificationOnInvitation` defaults to false, so an invitation sent to an address the target user does not control (a typo, a stale address, or a hostile pre-registration) can be accepted by whoever holds that account. In a B2B product where invitations are the tenant's front door and membership confers data access, failing open here is the wrong default; the invite-by-email flow should require the address to be verified unless the tenant explicitly opts out.

## Evidence

Source: `packages/organization/src/Organization.ts:83`

```
  cancelPendingInvitationsOnReInvite: false,
  requireEmailVerificationOnInvitation: false,
```

## Recommended fix

Flip the default to true (verification is already plumbed through @awthaq/core's Verification service) and let host applications opt out explicitly; pair it with the invitation events already published so org admins can audit acceptances.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-008` — GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check](medium/MTI-008-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `org-config-and-tenancy`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:83`. Fix: Flip requireEmailVerificationOnInvitation to true (pending decision) so membership is conferred only on a verified address. (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option (flip the default) per plan; user may revisit. requireEmailVerificationOnInvitation now defaults to true; fixtures that accept invitations verify the invitee first (test helper verifiedUser). Tests: default refuses an unverified invitee with EmailVerificationRequired, verifying unlocks acceptance, config({ requireEmailVerificationOnInvitation: false }) restores the old behaviour.
