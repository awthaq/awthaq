---
ID: "EAR-001"
Title: "QadiProvider's inner registry shadows the outer one, so the subject prop can never update after mount"
Level: high
Category: "correctness"
Status: ready-for-agent
Package: "react"
Source: "packages/react/src/Providers.tsx:105"
Auditor: "effect-atom-react-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EAR-001 — QadiProvider's inner registry shadows the outer one, so the subject prop can never update after mount

`HIGH` · `correctness` · `react` · reported by **Effect Atom/React Reactivity Specialist** (`effect-atom-react-specialist`)

Status: **ready-for-agent**

## Summary

SubjectBridge reads subjectDtoAtom via useAtomValue in the outer RegistryProvider's registry (it renders above QadiProvider), then passes the derived AuthSubject down as a prop. QadiProvider, however, creates its own AtomRegistry and becomes the ambient RegistryContext for everything under it (QadiProvider.tsx:166 and :221 — 'Each provider owns its own registry'). Every session-changing mutation an app runs under Providers executes in that inner registry, and reactivity-key invalidation is per-registry (AtomRegistry doc: 'Each registry is independent'). The outer registry's subjectDtoAtom therefore never refetches, the subject prop never changes, and QadiProvider's own resync effect (registry.get(atoms.subject) !== subject) never fires. Net effect: after sign-in, sign-out, or a role change, sessionAtom in the inner registry updates but every useCan/useSubject decision keeps deciding against the mount-time subject — exactly the 'component silently stopped reacting' registry-shadowing bug this architecture is meant to prevent, and a direct violation of BEH-EA-178/179 ('the session atom refetches; subject changes; every Can re-decides'). router.refresh() does not rescue it either: RegistryProvider documents that 'Option changes after the first render do not rebuild the registry', so re-served initialSubject seeds are ignored.

## Evidence

Source: `packages/react/src/Providers.tsx:105`

```
    <RegistryProvider initialValues={initialValues}>
      <SubjectBridge atoms={atoms} instrument={instrument} initialValues={initialValues}>
        {children}
```

## Recommended fix

Move the session/subject atoms into the registry that mutations actually invalidate: render SubjectBridge inside QadiProvider (deriving the subject from the inner registry via a derived atom over subjectDtoAtom, written to atoms.subject), or have Providers expose the outer registry and run app mutations against it. Then add a regression test: sign-in mutation with reactivityKeys ['session'] must flip useSubject from user:1 to user:2 without remount.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Atom/React reactivity
- Full dossier: [`effect-atom-react-specialist`](../../.reports/effect-atom-react-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-008` — Deliberate zero-component UI stance is undocumented in the packages themselves — migration scoping relies on reading header comments](info/CWM-008-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, info)_`
- [`EAR-003` — No 'use client' directive in any packages/react source file](medium/EAR-003-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, medium)_`
- [`EAR-005` — Seeded SSR props guarantee a hydration mismatch in the guarded subtree](info/EAR-005-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`EAR-006` — Fetch failure is reported with a render-phase console.error and is otherwise indistinguishable from loading](low/EAR-006-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, low)_`
- [`RSC-002` — Providers.tsx lacks "use client"; canonical RSC usage crashes on first hook call](high/RSC-002-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-006` — Server-decided gate seeding (BEH-EA-186/192) is unimplemented; first paint shows pending for every auth gate](medium/RSC-006-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/react/src/Providers.tsx:104-106` matches the quoted JSX verbatim: `SubjectBridge` (which calls `useAtomValue(subjectDtoAtom)`) is rendered as a child of the outer `RegistryProvider`, *around* `QadiProvider`, not inside it. `node_modules/.../@qadi/react/lib/QadiProvider.js:78-88` confirms `QadiProvider` constructs its own `AtomRegistry.make(...)` and provides it via `RegistryContext.Provider` only to `children` — so `SubjectBridge`'s read resolves against the outer registry while app mutations under `children` invalidate the inner one. `effect/src/unstable/reactivity/AtomRegistry.ts:6` confirms "Each registry is independent" verbatim. The fix is confined to `packages/react/src/Providers.tsx` and doesn't require touching the external `@qadi/react` library. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `react-provider-subject-pipeline`. Evidence at HEAD ec065a7: `packages/react/src/Providers.tsx:103`. Fix: Collapse to ONE registry: drop the outer RegistryProvider, seed everything through QadiProvider's initialValues, and derive/sync the qadi subject inside QadiProvider's registry from a new derived `subjectAtom` (implemented jointly with EAR-002). (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`.
