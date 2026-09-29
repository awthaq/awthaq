---
ID: "CWM-008"
Title: "Deliberate zero-component UI stance is undocumented in the packages themselves — migration scoping relies on reading header comments"
Level: info
Category: "docs"
Status: resolved
Package: "react"
Source: "packages/react/src/Providers.tsx:88"
Auditor: "clerk-workos-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CWM-008 — Deliberate zero-component UI stance is undocumented in the packages themselves — migration scoping relies on reading header comments

`INFO` · `docs` · `react` · reported by **Clerk/WorkOS Migration Specialist** (`clerk-workos-migration-specialist`)

Status: **resolved**

## Summary

The single exported React component in packages/react is provider glue (Providers, 110 lines); there are no sign-in, sign-up, user-button, or organization components anywhere in the repo — the persona brief confirms this is deliberate ('effect-auth deliberately ships no pre-built sign-in components'). That stance is the single largest line item in any Clerk migration estimate (every hosted component and the user-management dashboard must be rebuilt), yet no package README or spec page states it as a positioning decision or bounds what the project intends to ship here; a migrator discovers it by reading header comments and counting exports. The research corpus understands the tradeoff precisely (research/03-auth-landscape.md:124: Clerk's 'components↔API duality' is the UX bar, 'avoid replicating the lock-in shape'), but that analysis is buried in research files.

## Evidence

Source: `packages/react/src/Providers.tsx:88`

```
export const Providers = ({
  initialSession,
  initialSubject,
```

## Recommended fix

State the headless positioning once normatively — in spec/overview.md's client row or the react/next package READMEs — with an explicit list of what will never ship (drop-in components) and what applications are expected to build (sign-in forms against typed contract errors per BEH-EA-183, org management screens against OrganizationApi), so migration scoping is a documented contract rather than an inference.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Clerk/WorkOS migration parity
- Full dossier: [`clerk-workos-migration-specialist`](../../.reports/clerk-workos-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EAR-001` — QadiProvider's inner registry shadows the outer one, so the subject prop can never update after mount](high/EAR-001-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, high)_`
- [`EAR-003` — No 'use client' directive in any packages/react source file](medium/EAR-003-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, medium)_`
- [`EAR-005` — Seeded SSR props guarantee a hydration mismatch in the guarded subtree](info/EAR-005-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`EAR-006` — Fetch failure is reported with a render-phase console.error and is otherwise indistinguishable from loading](low/EAR-006-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, low)_`
- [`RSC-002` — Providers.tsx lacks "use client"; canonical RSC usage crashes on first hook call](high/RSC-002-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-006` — Server-decided gate seeding (BEH-EA-186/192) is unimplemented; first paint shows pending for every auth gate](medium/RSC-006-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `frontend-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/react/README.md:5`. Fix: State the headless positioning normatively. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Headless stance stated normatively in packages/react/README.md ('What this package does not ship') and in the client row of spec/overview.md.
