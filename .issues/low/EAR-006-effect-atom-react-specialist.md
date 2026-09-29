---
ID: "EAR-006"
Title: "Fetch failure is reported with a render-phase console.error and is otherwise indistinguishable from loading"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "react"
Source: "packages/react/src/Providers.tsx:65"
Auditor: "effect-atom-react-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EAR-006 — Fetch failure is reported with a render-phase console.error and is otherwise indistinguishable from loading

`LOW` · `dx` · `react` · reported by **Effect Atom/React Reactivity Specialist** (`effect-atom-react-specialist`)

Status: **ready-for-agent**

## Summary

When subjectDtoAtom fails, the only signal is a console.error executed during render — which fires on every render of the failing subtree and twice per render under StrictMode — while QadiProvider keeps receiving subject: undefined, so every gate stays pending indefinitely with no user-visible error, no retry, and no error-boundary hook. The comment is candid that the prop contract 'is binary', but a persistent failure then looks exactly like a hung network request to both developers and users.

## Evidence

Source: `packages/react/src/Providers.tsx:65`

```
  if (AsyncResult.isFailure(subjectResult)) {
    console.error(
```

## Recommended fix

Move diagnostics into an effect (or a registered failure reporter), and expose recovery: either surface a typed failure through context for apps to render an error state, or use useAtomRefresh on subjectDtoAtom to offer a retry path instead of waiting for a remount.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Atom/React reactivity
- Full dossier: [`effect-atom-react-specialist`](../../.reports/effect-atom-react-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-008` — Deliberate zero-component UI stance is undocumented in the packages themselves — migration scoping relies on reading header comments](info/CWM-008-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, info)_`
- [`EAR-001` — QadiProvider's inner registry shadows the outer one, so the subject prop can never update after mount](high/EAR-001-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, high)_`
- [`EAR-003` — No 'use client' directive in any packages/react source file](medium/EAR-003-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, medium)_`
- [`EAR-005` — Seeded SSR props guarantee a hydration mismatch in the guarded subtree](info/EAR-005-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`RSC-002` — Providers.tsx lacks "use client"; canonical RSC usage crashes on first hook call](high/RSC-002-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-006` — Server-decided gate seeding (BEH-EA-186/192) is unimplemented; first paint shows pending for every auth gate](medium/RSC-006-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `react-provider-subject-pipeline`. Evidence at HEAD ec065a7: `packages/react/src/Providers.tsx:65`. Fix: Replace the render-phase console.error with an exported auth-status atom/hook plus an optional `onError` prop and a retry handle. (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
