---
ID: "RSC-006"
Title: "Server-decided gate seeding (BEH-EA-186/192) is unimplemented; first paint shows pending for every auth gate"
Level: medium
Category: "architecture"
Status: resolved
Package: "react"
Source: "packages/react/src/Providers.tsx:95"
Auditor: "react-server-components-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RSC-006 — Server-decided gate seeding (BEH-EA-186/192) is unimplemented; first paint shows pending for every auth gate

`MEDIUM` · `architecture` · `react` · reported by **React Server Components Auth Specialist** (`react-server-components-auth-specialist`)

Status: **resolved**

## Summary

Providers seeds exactly two atoms (sessionAtom, subjectDtoAtom); there is no decisions prop, and no module in packages/ exports dehydrateDecisions or hydrateDecisions (grep across packages: zero matches), and Suspense/useTransition appear nowhere in packages, examples, or spec code. BEH-EA-186 requires that a page decide every policy server-side and pass the result via dehydrateDecisions so "the very first client paint show correct gate states instead of a pending spinner for every gate", and BEH-EA-192 requires gates not render pending on first paint. Since decision dehydration is the only mechanism in this architecture that prevents that flash (the spec forbids client-side evaluation shortcuts per BEH-EA-184), every Can gate in a Next.js app built on today's Packages flashes pending on load. The session/subject half of first-paint correctness is done; the authorization half is absent.

## Evidence

Source: `packages/react/src/Providers.tsx:95`

```
  const initialValues = [
    ...(initialSession === undefined
      ? []
```

## Recommended fix

Implement dehydrateDecisions/hydrateDecisions (qadi-owned, per the spec's usage-qadi.md §12.1/§13 wiring), add a decisions prop to Providers that feeds them into QadiProvider's initialValues the same way initialSession already does, and cover it with a no-pending-first-paint test.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: RSC auth boundary
- Full dossier: [`react-server-components-auth-specialist`](../../.reports/react-server-components-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-008` — Deliberate zero-component UI stance is undocumented in the packages themselves — migration scoping relies on reading header comments](info/CWM-008-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, info)_`
- [`EAR-001` — QadiProvider's inner registry shadows the outer one, so the subject prop can never update after mount](high/EAR-001-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, high)_`
- [`EAR-003` — No 'use client' directive in any packages/react source file](medium/EAR-003-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, medium)_`
- [`EAR-005` — Seeded SSR props guarantee a hydration mismatch in the guarded subtree](info/EAR-005-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`EAR-006` — Fetch failure is reported with a render-phase console.error and is otherwise indistinguishable from loading](low/EAR-006-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, low)_`
- [`RSC-002` — Providers.tsx lacks "use client"; canonical RSC usage crashes on first hook call](high/RSC-002-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `next-react-ssr-bridge`. Evidence at HEAD ec065a7: `packages/react/src/index.ts:19`. Fix: Let Providers accept the server's dehydrated decisions (and arbitrary extra seeds), hydrate them against the seeded subject, and document the server half. (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Providers gains decisions (DehydratedDecisions) and initialValues props; decisions are hydrated with @qadi/react hydrateDecisions against the trusted seeded subject (needs seeded session+subject), extra initialValues merged last. Tests (ProvidersSeeds.test.tsx): server-decided Can renders granted on first paint (control renders pending), other-subject payload dropped, no hydration without trusted seeds. README section 'Server-decided gates on first paint' (app-level wiring, no new next export, per the next-package decision). traceability row added.
