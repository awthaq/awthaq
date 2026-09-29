---
ID: "CWM-005"
Title: "packages/react exposes no organization atoms — an app migrating Clerk's OrganizationSwitcher must hand-build its own reactive layer"
Level: medium
Category: "dx"
Status: resolved
Package: "react"
Source: "packages/react/src/AuthClientAtom.ts:19"
Auditor: "clerk-workos-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CWM-005 — packages/react exposes no organization atoms — an app migrating Clerk's OrganizationSwitcher must hand-build its own reactive layer

`MEDIUM` · `dx` · `react` · reported by **Clerk/WorkOS Migration Specialist** (`clerk-workos-migration-specialist`)

Status: **resolved**

## Summary

Clerk's session carries active organization identity (org_id/org_role claims) directly in the session token and the <OrganizationSwitcher/> reads it from useAuth(). In effect-auth the active organization lives server-side per session (ActiveContextRecords keyed by sessionId) and is served only via dedicated endpoints (/organization/active, /organization/active-member, /organization/active-member/role). The react package deliberately scopes itself to the one universal contract — sessionAtom and subjectDtoAtom built against AuthCore.AuthCoreApi — and pushes everything else (sign-in mutations, and therefore the entire organization surface) onto the application to build as its own AtomHttpApi.Service. The stance is coherent and documented, but from a Clerk migration lens the org switcher, member management screens, and 'pending invites' inbox — the highest-traffic UI in a B2B app — each start from zero reactive plumbing, and the sessionAtom does not change when setActive is called unless the app remembers to tag the mutation with reactivityKeys ["session"].

## Evidence

Source: `packages/react/src/AuthClientAtom.ts:19`

```
// Password's sign-in mutation) builds its own `AtomHttpApi.Service` directly
// against its own composed `api`, the same way it already builds its own
// `Auth`/`AuthPlugin` classes (ADR-EA-005/008) — this module only owns the
```

## Recommended fix

Ship an optional @awthaq/react/organization module (activeOrgAtom + activeMemberAtom built against the plugin's fixed OrganizationApi contract, mirroring how sessionAtom owns the core contract) or publish a recipe file in the package README showing the app-built atom with correct reactivityKeys wiring for setActive/invite/accept — the atoms are ~20 lines each once the contract is imported.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Clerk/WorkOS migration parity
- Full dossier: [`clerk-workos-migration-specialist`](../../.reports/clerk-workos-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-004` — Reactive React client covers only the core session; plugin routes need hand-built clients](medium/BE-004-bereket-engida.md) `_(bereket-engida, medium)_`
- [`PCS-007` — Client-side decision invalidation is a disconnected model: reactivity keys, no server push](info/PCS-007-permission-caching-specialist.md) `_(permission-caching-specialist, info)_`
- [`RSC-004` — BEH-EA-179's derive-subject-from-sessionAtom and same-render sign-out guarantee is not what shipped](medium/RSC-004-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `react-client-atoms-factory`. Duplicate of `BE-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/react/src/AuthClientAtom.ts:19`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.
