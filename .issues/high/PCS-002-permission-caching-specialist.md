---
ID: "PCS-002"
Title: "No event-driven invalidation path exists: AuthEvents are published but nothing connects them to a cache flush"
Level: high
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1213"
Auditor: "permission-caching-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PCS-002 — No event-driven invalidation path exists: AuthEvents are published but nothing connects them to a cache flush

`HIGH` · `architecture` · `organization` · reported by **Permission Caching Specialist** (`permission-caching-specialist`)

Status: **resolved**

## Summary

Organization publishes 23 granular mutation events (memberAdded, memberRemoved, memberRoleUpdated, roleCreated, roleUpdated, team/invitation events) into core's AuthEvents PubSub — exactly the invalidation triggers this domain needs. But no code in any awthaq package (or example) subscribes to those events, and the DecisionCache surface offers only a manual clear (DecisionCache.ts:188) with no subscription API. The invalidation half of a permission cache is therefore absent end to end: the only correct deployments today are 'no cache' (the accidental status quo) or a per-request cache nobody has wired. The moment an application follows the appendix's app-scope example, revocation stops propagating.

## Evidence

Source: `packages/organization/src/Organization.ts:1213`

```
yield* events.publish({
  _tag: "auth.organization.memberRemoved",
  organizationId,
```

## Recommended fix

Ship a small optional layer (e.g. in @awthaq/qadi or a recipe) that runs AuthEvents.on for every authorization-fact tag (auth.organization.memberRemoved, memberRoleUpdated, roleUpdated, and future role events) and calls DecisionCache.clear — coarse flush-first, key-scoped invalidation later. Document it as the required companion of any longer-than-request cache scope.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: decision caching
- Full dossier: [`permission-caching-specialist`](../../.reports/permission-caching-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/organization/src/Organization.ts:1213` matches the evidence exactly (the `memberRemoved` publish), and a repo-wide grep for `DecisionCache`/`AuthEvents.on(` outside `node_modules` finds zero subscribers or invalidation wiring anywhere in `packages/` or `examples/`. Recommended fix (an optional layer bridging `AuthEvents.on` to `DecisionCache.clear`) is a well-scoped, additive piece of code with an existing hook/event surface to build on. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-decision-cache-invalidation`. Evidence at HEAD ec065a7: `packages/organization/src/Organization.ts:1571`. Fix: Ship ticket 12's opt-in invalidation bridge (DecisionCacheInvalidationLive) for application-scoped DecisionCache deployments, and close the leave() hook gap it depends on. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`.

**Resolved (2026-09-29):** leave() now runs beforeRemove (veto) and afterRemove hooks (Organization.ts, HookAborted added to the leave error union and endpoint); DecisionCacheInvalidationLive (see PCS-001) taps all organization observe points incl. AfterAcceptInvitation and role CRUD. Test: packages/qadi/test/DecisionCacheInvalidation.test.ts 'leave clears the cache' (red before, green after) plus removeMember/updateMemberRole/delete/removeTeamMember cases.
