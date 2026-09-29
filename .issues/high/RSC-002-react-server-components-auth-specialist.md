---
ID: "RSC-002"
Title: "Providers.tsx lacks \"use client\"; canonical RSC usage crashes on first hook call"
Level: high
Category: "dx"
Status: resolved
Package: "react"
Source: "packages/react/src/Providers.tsx:58"
Auditor: "react-server-components-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RSC-002 — Providers.tsx lacks "use client"; canonical RSC usage crashes on first hook call

`HIGH` · `dx` · `react` · reported by **React Server Components Auth Specialist** (`react-server-components-auth-specialist`)

Status: **resolved**

## Summary

grep across packages/ finds zero "use client" directives. Providers is designed to receive server-resolved data (initialSession/initialSubject from getSession in a Server Component), so its canonical mount point is app/layout.tsx — a Server Component. A module without the directive imported from server code is server code: RegistryProvider and QadiProvider are fine (their own dist files carry "use client" — verified in @effect/atom-react@rc.116 and @qadi/react@0.7.0), but SubjectBridge is defined in this module and renders as a Server Component, so useAtomValue executes outside a client dispatcher and throws (invalid hook call) during the RSC render. The happy-dom component tests never exercise the RSC runtime, so nothing catches this. Every real consumer must discover on their own that Providers must be wrapped in a client module — and the package README still claims no source has shipped, so there is no documentation of the requirement either.

## Evidence

Source: `packages/react/src/Providers.tsx:58`

```
const subjectResult = useAtomValue(subjectDtoAtom);
```

## Recommended fix

Add "use client" to the top of Providers.tsx (AuthClientAtom.ts and Subject.ts are hook-free and can stay directive-free), and add a test that renders Providers through a server-string renderer (react-dom/server renderToString) to prove the seeded path survives SSR.

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
- [`RSC-006` — Server-decided gate seeding (BEH-EA-186/192) is unimplemented; first paint shows pending for every auth gate](medium/RSC-006-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — a grep across `packages/` finds zero `"use client"` directives, and Providers.tsx:58's `SubjectBridge` component calls `useAtomValue(subjectDtoAtom)` with no client boundary, matching the auditor's evidence exactly. Adding `"use client"` to the file top is a mechanical, well-scoped fix. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `react-provider-subject-pipeline`. Evidence at HEAD ec065a7: `packages/react/src/Providers.tsx:1`. Fix: Mark every hook-bearing/client-only module of @awthaq/react as a client module and pin SSR behavior with a server-render test. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`.

**Resolved (2026-09-29):** use client added to Providers.tsx, Hooks.ts, index.ts (first line, verified preserved in lib/*.js); ClientBoundary.test.ts enumerates src for the directive; scripts/package-smoke.mjs asserts lib/index.js|Providers.js|Hooks.js start with it; Providers.ssr.test.tsx (node env, no window) and Providers.hydrate.test.tsx (hydrateRoot with onRecoverableError) pin SSR/hydration.
