---
ID: "RSC-008"
Title: "Spec and READMEs still claim pre-implementation while the RSC layer ships"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/behaviors/23-react.md:15"
Auditor: "react-server-components-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RSC-008 — Spec and READMEs still claim pre-implementation while the RSC layer ships

`LOW` · `docs` · `—` · reported by **React Server Components Auth Specialist** (`react-server-components-auth-specialist`)

Status: **resolved**

## Summary

The behavior specs' banner (repeated in 24-nextjs-ssr.md:15) and packages/react/README.md:3 ("no line of source in this package has shipped yet") are stale: Providers.tsx, AuthClientAtom.ts, Subject.ts, GetSession.ts, HasSessionCookie.ts and WithNextCookies.ts are implemented with passing component tests, and packages/react/src/index.ts:5-8 explicitly lists what is implemented. The contract rule that docs state intentions and code is ground truth holds here, but the contradiction is actively misleading for the RSC seam specifically: a Next.js integrator reading the README will conclude Providers does not exist, skip the (necessary) client-wrapper knowledge, and discover the "use client" crash at runtime. Notably the implementations diverge from their specs in documented ways (BEH-EA-179's two-atom design, Providers' initialSubject prop with no decisions prop), which a reader comparing spec to reality would want flagged.

## Evidence

Source: `spec/behaviors/23-react.md:15`

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

## Recommended fix

Update the banner in 23-react.md/24-nextjs-ssr.md and the react/next READMEs to mark implemented behaviors (BEH-EA-177-179, 185, 188, 189) with pointers to the divergences, or auto-generate an implementation-status table from the index.ts header comments.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: RSC auth boundary
- Full dossier: [`react-server-components-auth-specialist`](../../.reports/react-server-components-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-behavior-code-reconcile`. Evidence at HEAD ec065a7: `spec/behaviors/23-react.md:15`. Fix: Replace 23-react.md's banner with implementation pointers and document the two shipped divergences (two-atom session/subject design; Providers' initialSubject seed prop) against BEH-EA-177/179; fix the react README. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** spec/behaviors/23-react.md rev 1.1: banner given implementation pointers (BEH-EA-177/178/179 are the package's own, 180-184 are @qadi/react re-exports); the BEH-EA-177 example uses Providers' real props (initialSession, initialSubject, decisions, atoms) and an Implementation note documents the two-atom design and the encoded-seed decoding; BEH-EA-179 already documented the sessionAtom/subjectDtoAtom split. packages/react/README.md already carried no banner. The 23-react.feature header is gone with the suite-wide header sweep.
