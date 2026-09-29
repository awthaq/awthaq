---
ID: "EAR-005"
Title: "Seeded SSR props guarantee a hydration mismatch in the guarded subtree"
Level: info
Category: "correctness"
Status: needs-triage
Package: "react"
Source: "packages/react/src/Providers.tsx:31"
Auditor: "effect-atom-react-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EAR-005 — Seeded SSR props guarantee a hydration mismatch in the guarded subtree

`INFO` · `correctness` · `react` · reported by **Effect Atom/React Reactivity Specialist** (`effect-atom-react-specialist`)

Status: **needs-triage**

## Summary

During server render, SubjectBridge's useAtomValue reads via getServerSnapshot (Hooks.ts:46-48), which returns the unseeded pending AsyncResult — subject is undefined and every QadiProvider gate renders pending. On the client, RegistryProvider creates its registry with initialValues at construction (RegistryContext.ts:88-94), so the first client render sees the seeded, resolved subject and gates render decided verdicts. The HTML and the first client render therefore disagree for the flagship initialSession/initialSubject flow; React 19 will log hydration mismatches and re-render the divergent subtree. qadi ships hydrateDecisions (BEH-EA-192) with subject-bound, drop-unverifiable seeding for exactly this class of problem, but Providers has no equivalent guidance or suppression strategy for its own seeds.

## Evidence

Source: `packages/react/src/Providers.tsx:31`

```
   * BEH-EA-177: seeds `sessionAtom` so the first client render already
   * knows what the server knew — no loading flash for a session the server
   * already resolved.
```

## Recommended fix

Document (or handle) the mismatch: either render gates' pending state only until hydration completes (qadi's HydrationCounts pattern), or document suppressHydrationWarning boundaries for seeded trees, and add an SSR/hydration test with react-dom/server to pin the intended behavior.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Atom/React reactivity
- Full dossier: [`effect-atom-react-specialist`](../../.reports/effect-atom-react-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-008` — Deliberate zero-component UI stance is undocumented in the packages themselves — migration scoping relies on reading header comments](info/CWM-008-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, info)_`
- [`EAR-001` — QadiProvider's inner registry shadows the outer one, so the subject prop can never update after mount](high/EAR-001-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, high)_`
- [`EAR-003` — No 'use client' directive in any packages/react source file](medium/EAR-003-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, medium)_`
- [`EAR-006` — Fetch failure is reported with a render-phase console.error and is otherwise indistinguishable from loading](low/EAR-006-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, low)_`
- [`RSC-002` — Providers.tsx lacks "use client"; canonical RSC usage crashes on first hook call](high/RSC-002-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-006` — Server-decided gate seeding (BEH-EA-186/192) is unimplemented; first paint shows pending for every auth gate](medium/RSC-006-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** INVALID (confidence medium); workstream `react-provider-subject-pipeline`. Evidence at HEAD ec065a7: `node_modules/.pnpm/@effect+atom-react@4.0.0-rc.116_effect@4.0.0-rc.116_react@19.3.0_scheduler@0.27.0/node_modules/@effect/atom-react/src/Hooks.ts:46`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/11-frontend-next-react-client.md`.
