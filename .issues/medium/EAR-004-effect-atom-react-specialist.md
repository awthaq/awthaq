---
ID: "EAR-004"
Title: "Tests cover only the seeded path; the live fetch, invalidation, and failure paths are untested"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "react"
Source: "packages/react/test/Providers.test.tsx:8"
Auditor: "effect-atom-react-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EAR-004 — Tests cover only the seeded path; the live fetch, invalidation, and failure paths are untested

`MEDIUM` · `testing` · `react` · reported by **Effect Atom/React Reactivity Specialist** (`effect-atom-react-specialist`)

Status: **ready-for-agent**

## Summary

All three tests render Providers with seeds and assert first-paint values. The behaviors that give this package its reason to exist — rawSessionAtom's Unauthenticated-to-null translation (AuthClientAtom.ts:71-80), a mutation invalidating the 'session' key and refetching sessionAtom/subjectDtoAtom, the failure branch surfacing as AsyncResult.Failure, and cross-registry behavior — have zero coverage. The test header is admirably honest about this, but BEH-EA-178's guarantee ('sessionAtom MUST NOT require an explicit manual refetch') is precisely the kind of invariant that silently regresses, and EAR-001 shows it already has: a seeded-only suite cannot see it because the two registries behave identically until an invalidation happens.

## Evidence

Source: `packages/react/test/Providers.test.tsx:8`

```
// (`initialSession`/`initialSubject`), never the live query path (which
```

## Recommended fix

Add tests that intercept fetch (or point the AtomHttpApi clients at a local stub): (1) anonymous initial load renders 'no-session' via the null translation, (2) a mocked mutation with reactivityKeys ['session'] flips a subject probe without remount — this test would have caught EAR-001, (3) a 500 response surfaces as Failure, not success(null).

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Atom/React reactivity
- Full dossier: [`effect-atom-react-specialist`](../../.reports/effect-atom-react-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `react-provider-subject-pipeline`. Evidence at HEAD ec065a7: `packages/react/test/Providers.test.tsx:7`. Fix: Add a fetch-stubbed live-path suite; these tests are the TDD drivers for EAR-001/EAR-002/EAR-006 and the CSRF new finding. (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
