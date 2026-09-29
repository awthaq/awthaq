---
ID: "EAR-002"
Title: "Subject is derived from a second independent fetch, and after sign-out it is an anonymous AuthSubject rather than undefined"
Level: high
Category: "compliance"
Status: resolved
Package: "react"
Source: "packages/react/src/Subject.ts:5"
Auditor: "effect-atom-react-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EAR-002 — Subject is derived from a second independent fetch, and after sign-out it is an anonymous AuthSubject rather than undefined

`HIGH` · `compliance` · `react` · reported by **Effect Atom/React Reactivity Specialist** (`effect-atom-react-specialist`)

Status: **resolved**

## Summary

The spec requirement quoted in this very file mandates deriving subject from sessionAtom and that 'when the session becomes undefined (sign-out), subject MUST become undefined in the same render' — explicitly to avoid 'a window where the session has cleared but a stale subject still grants access'. The code instead derives subject from subjectDtoAtom, a separate HTTP query against SubjectApi. Because that endpoint uses OptionalAuthentication and resolves a well-formed anonymous AuthSubject for every caller (packages/qadi/src/SubjectApi.ts:28-31, :46), toSubject never receives undefined after sign-out — it receives the anonymous dto and returns a real AuthSubject, so gates re-decide against 'anonymous' instead of closing, and only after a second network round trip. Between the two refetches there is a concrete render window where sessionAtom is already null but the pre-sign-out subject is still granting. The header comment's reframing ('not a second, independently-*chosen* source') documents the deviation rather than closing the gap.

## Evidence

Source: `packages/react/src/Subject.ts:5`

```
// spec/behaviors/23-react.md, BEH-EA-179: "the React provider tree MUST
// derive qadi's `subject` prop from `sessionAtom`'s current value, not from
// a second, independently fetched source."
```

## Recommended fix

Derive the subject prop from sessionAtom's three-state value: null session => undefined subject immediately, real session => look up the dto (seeded or fetched). If the separate subject endpoint stays, at minimum gate toSubject on sessionAtom !== null so sign-out collapses subject synchronously, and add a regression test for the sign-out window.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Atom/React reactivity
- Full dossier: [`effect-atom-react-specialist`](../../.reports/effect-atom-react-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/react/src/Subject.ts:3-11` matches the quoted BEH-EA-179 comment verbatim, and `toSubject` derives its result from `subjectDtoAtom`, not `sessionAtom`. `packages/qadi/src/SubjectApi.ts:28-31,66-73` confirms the endpoint uses `OptionalAuthentication` and resolves `CurrentSubject` for every caller including anonymous ones, so `dto` is never `undefined` after sign-out — only after a second round trip, and then as a well-formed anonymous subject rather than `undefined`. Gating `toSubject` on `sessionAtom`'s value is a well-scoped, mechanical fix confined to `packages/react`. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `react-provider-subject-pipeline`. Evidence at HEAD ec065a7: `packages/react/src/Subject.ts:38`. Fix: Gate the subject on sessionAtom: `subjectAtom` is undefined unless sessionAtom is a settled, non-waiting Success with a real session AND subjectDtoAtom is a settled, non-waiting Success. Keeps the separate /subject endpoint (Subject.ts / qadi SubjectApi.ts rationale) but makes sessionAtom the gate, closing the stale-grant window in the same registry batch. (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`.

**Resolved (2026-09-29):** AuthClientAtom.subjectAtom = subjectDtoAtom gated on sessionAtom (settled non-null Success; dto settled, non-waiting). Deviation noted: sessionAtom's own waiting is not part of the gate so window-focus revalidation does not blink gates to pending; sign-out closes the gate in the same registry batch (HistoryProbe test proves no render pairs no-session with a granted subject). Seeded subject without seeded session is not trusted. SubjectAtom.test.ts pure-registry tests + Providers.test.tsx. BEH-EA-179 note added in spec/behaviors/23-react.md; traceability row updated.
