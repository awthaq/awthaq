---
ID: "RSC-004"
Title: "BEH-EA-179's derive-subject-from-sessionAtom and same-render sign-out guarantee is not what shipped"
Level: medium
Category: "correctness"
Status: resolved
Package: "react"
Source: "packages/react/src/AuthClientAtom.ts:97"
Auditor: "react-server-components-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RSC-004 — BEH-EA-179's derive-subject-from-sessionAtom and same-render sign-out guarantee is not what shipped

`MEDIUM` · `correctness` · `react` · reported by **React Server Components Auth Specialist** (`react-server-components-auth-specialist`)

Status: **resolved**

## Summary

The spec's requirement text (spec/behaviors/23-react.md:63-66) is explicit: subject MUST be derived from sessionAtom's current value, not a second, independently fetched source, and when the session becomes undefined on sign-out, subject MUST become undefined in the same render. The implementation feeds QadiProvider from a second HTTP endpoint (subjectDtoAtom -> GET /subject) that shares only the reactivityKeys tag with sessionAtom. Invalidation is simultaneous but settlement is not: between sign-out and the /subject refetch landing, the old subject is still held and gates keep granting; and because qadi's OptionalAuthentication resolves anonymous callers to a real anonymous AuthSubject (packages/qadi/src/SubjectApi.ts:28-31), subject never becomes undefined at all post-sign-out — it becomes the anonymous subject after a round trip. The deviation is candidly documented in Subject.ts's header, but the spec's stale-grant-window guarantee is nonetheless unimplemented. Server-side authority is unaffected; this is a client-UX security window.

## Evidence

Source: `packages/react/src/AuthClientAtom.ts:97`

```
export const subjectDtoAtom = ReactSubjectClient.query("subject", "current", {
  reactivityKeys: ["session"],
});
```

## Recommended fix

Either update BEH-EA-179 to codify the two-endpoint design (and require SubjectBridge to gate on sessionAtom's value, e.g. render subject only when sessionAtom is Success and non-null), or derive subject client-side by composing sessionAtom with a per-session subject cache keyed by session id so sign-out nulls it in the same render.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: RSC auth boundary
- Full dossier: [`react-server-components-auth-specialist`](../../.reports/react-server-components-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-004` — Reactive React client covers only the core session; plugin routes need hand-built clients](medium/BE-004-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CWM-005` — packages/react exposes no organization atoms — an app migrating Clerk's OrganizationSwitcher must hand-build its own reactive layer](medium/CWM-005-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`PCS-007` — Client-side decision invalidation is a disconnected model: reactivity keys, no server push](info/PCS-007-permission-caching-specialist.md) `_(permission-caching-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `react-provider-subject-pipeline`. Duplicate of `EAR-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/react/src/AuthClientAtom.ts:97`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `EAR-002-effect-atom-react-specialist` — closed by its fix (see that issue's Resolved comment).
