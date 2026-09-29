---
ID: "PCS-007"
Title: "Client-side decision invalidation is a disconnected model: reactivity keys, no server push"
Level: info
Category: "dx"
Status: needs-triage
Package: "react"
Source: "packages/react/src/AuthClientAtom.ts:97"
Auditor: "permission-caching-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PCS-007 — Client-side decision invalidation is a disconnected model: reactivity keys, no server push

`INFO` · `dx` · `react` · reported by **Permission Caching Specialist** (`permission-caching-specialist`)

Status: **needs-triage**

## Summary

Mounted policy gates re-decide only when a mutation shares the 'session' reactivity key or the application remembers to call useInvalidate (BEH-EA-181 makes that the application's MUST). A grant changed out-of-band — an admin revokes a role or removes a membership while a user's tab is open — pushes nothing: the served SubjectDto, and every Can gate derived from it, stays at the old verdict until the next tagged mutation or refetch. This is documented, intentional design (BEH-EA-180's 'a stale decision is not a decision' mitigates the render window), but it means the system has two invalidation models that never meet: server-side AuthEvents nobody consumes, and client-side reactivity keys nobody can trigger from the server. Noting the seam so a future SSE/push subject channel can unify them.

## Evidence

Source: `packages/react/src/AuthClientAtom.ts:97`

```
export const subjectDtoAtom = ReactSubjectClient.query("subject", "current", {
  reactivityKeys: ["session"],
```

## Recommended fix

When server push arrives (SSE/WebSocket), publish AuthEvents authorization-fact events to the owning user's channel and have the client refetch subjectDtoAtom — one event stream driving both the server cache flush (PCS-002) and the client gates.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: decision caching
- Full dossier: [`permission-caching-specialist`](../../.reports/permission-caching-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-004` — Reactive React client covers only the core session; plugin routes need hand-built clients](medium/BE-004-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CWM-005` — packages/react exposes no organization atoms — an app migrating Clerk's OrganizationSwitcher must hand-build its own reactive layer](medium/CWM-005-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`RSC-004` — BEH-EA-179's derive-subject-from-sessionAtom and same-render sign-out guarantee is not what shipped](medium/RSC-004-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `react-client-atoms-factory`. Evidence at HEAD ec065a7: `packages/react/src/AuthClientAtom.ts:97`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/11-frontend-next-react-client.md`.
