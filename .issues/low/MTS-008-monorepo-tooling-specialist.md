---
ID: "MTS-008"
Title: "Prose comments still cite effect rc.115 after the catalog moved to rc.116"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "client"
Source: "packages/client/src/AuthClient.ts:17"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-008 — Prose comments still cite effect rc.115 after the catalog moved to rc.116

`LOW` · `docs` · `client` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **ready-for-agent**

## Summary

The catalog pins effect 4.0.0-rc.116 (pnpm-workspace.yaml:17) and the lockfile contains zero rc.115 resolutions, yet hand-written rationale comments in packages/client/src/AuthClient.ts:17 and packages/react/src/AuthClientAtom.ts:9 still say `effect@4.0.0-rc.115`. Harmless at runtime, but it demonstrates that the coordinated rc bump process updates manifests and lockfile while prose version references drift — and this repo leans heavily on long evidentiary comments, so drifting version claims erode their trustworthiness. Future bumps will accumulate more of these unless the bump checklist includes a version-string sweep.

## Evidence

Source: `packages/client/src/AuthClient.ts:17`

```
// against this project's `effect@4.0.0-rc.115` — that reasoning no longer
```

## Recommended fix

Fix the two stale comments now, and add `grep -rn 'rc\.[0-9]' packages --include='*.ts'` (excluding pnpm-lock.yaml) to the rc-bump checklist, or reference the catalog rather than a literal version in prose.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`APS-001` — CsrfProtection middleware is implemented but attached to zero contract groups](high/APS-001-auth-pentest-specialist.md) `_(auth-pentest-specialist, high)_`
- [`CDS-001` — CsrfProtection middleware is fully implemented but attached to zero served groups](high/CDS-001-csrf-defense-specialist.md) `_(csrf-defense-specialist, high)_`
- [`CDS-007` — CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s](low/CDS-007-csrf-defense-specialist.md) `_(csrf-defense-specialist, low)_`
- [`DESS-003` — toPromiseFacade silently discards the typed error channel](medium/DESS-003-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`DESS-009` — CsrfClientLive's empty-string header fallback will produce opaque 403s when activated](info/DESS-009-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, info)_`
- [`EHA-003` — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code](medium/EHA-003-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`EHA-005` — toPromiseFacade types away the shared error taxonomy at the Promise boundary](medium/EHA-005-effect-http-api-specialist.md) `_(effect-http-api-specialist, medium)_`
- [`FAMS-008` — Client SDK session model has no Firebase-style token surface or proactive refresh](low/FAMS-008-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- … 5 more findings touch `packages/client/src/AuthClient.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `frontend-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/client/src/AuthClient.ts:17`. Fix: Remove literal versions from prose and guard against recurrence. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
