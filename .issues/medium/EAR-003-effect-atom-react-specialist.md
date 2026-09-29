---
ID: "EAR-003"
Title: "No 'use client' directive in any packages/react source file"
Level: medium
Category: "dx"
Status: resolved
Package: "react"
Source: "packages/react/src/Providers.tsx:1"
Auditor: "effect-atom-react-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EAR-003 — No 'use client' directive in any packages/react source file

`MEDIUM` · `dx` · `react` · reported by **Effect Atom/React Reactivity Specialist** (`effect-atom-react-specialist`)

Status: **resolved**

## Summary

Providers.tsx, AuthClientAtom.ts, Subject.ts, and index.ts all lack 'use client', even though the package is by construction a client-side runtime: SubjectBridge calls useAtomValue (useSyncExternalStore + useContext), and its imports (@effect/atom-react/RegistryContext, @qadi/react's QadiProvider) are client modules. An App Router Server Component that renders <Providers initialSession={...}> executes Providers on the server and tries to pass the SubjectBridge element — a function defined in a server module — across the client boundary into RegistryProvider, which React rejects ('Functions cannot be passed directly to Client Components'). The failure surfaces as a confusing runtime RSC serialization error instead of a clear build-time signal, and hooks can silently run during server render where the FetchHttpClient queries can never resolve.

## Evidence

Source: `packages/react/src/Providers.tsx:1`

```
// @awthaq/react — Providers
```

## Recommended fix

Add 'use client' to Providers.tsx (and to AuthClientAtom.ts/Subject.ts if they are to be imported directly into client components from RSC-adjacent entry points). This matches the directives already present in the upstream modules the package builds on.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Atom/React reactivity
- Full dossier: [`effect-atom-react-specialist`](../../.reports/effect-atom-react-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-008` — Deliberate zero-component UI stance is undocumented in the packages themselves — migration scoping relies on reading header comments](info/CWM-008-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, info)_`
- [`EAR-001` — QadiProvider's inner registry shadows the outer one, so the subject prop can never update after mount](high/EAR-001-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, high)_`
- [`EAR-005` — Seeded SSR props guarantee a hydration mismatch in the guarded subtree](info/EAR-005-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`EAR-006` — Fetch failure is reported with a render-phase console.error and is otherwise indistinguishable from loading](low/EAR-006-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, low)_`
- [`RSC-002` — Providers.tsx lacks "use client"; canonical RSC usage crashes on first hook call](high/RSC-002-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-006` — Server-decided gate seeding (BEH-EA-186/192) is unimplemented; first paint shows pending for every auth gate](medium/RSC-006-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `react-provider-subject-pipeline`. Duplicate of `RSC-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/react/src/Providers.tsx:1`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `RSC-002-react-server-components-auth-specialist` — closed by its fix (see that issue's Resolved comment).
