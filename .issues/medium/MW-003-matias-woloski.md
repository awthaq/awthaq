---
ID: "MW-003"
Title: "Hook points are mechanism-only: zero taps reachable from real signUp/signIn flows"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:51"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-003 — Hook points are mechanism-only: zero taps reachable from real signUp/signIn flows

`MEDIUM` · `architecture` · `core` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **resolved**

## Summary

The Auth0 'Rules at login' lever — arbitrary, customer-authored logic invoked during authentication — is the single biggest extensibility hook in this market. The veto/observe/divert machinery is real and tested in isolation, but no hook point is declared in any production flow, so a plugin or application cannot yet intercept registration or sign-in at all. TestAuth.ts:25-28 confirms the testkit has 'nothing plugin-facing to assemble for this one'. Extensibility economics are therefore unproven where they matter most.

## Evidence

Source: `packages/core/src/HookPoint.ts:51`

```
Also scoped smaller in not yet wiring any concrete hook point into
// `Users.ts`/`Sessions.ts`'s real `signUp`/`signIn` flows (BEH-EA-090's
// `BeforeSignUp`, BEH-EA-092's `AfterSignIn`)
```

## Recommended fix

Declare BeforeSignUp/AfterSignIn/BeforePasswordVerify hook points in Users.ts/Sessions.ts and run them in the real flows, with at least the password plugin consuming one (e.g. breach-check as an observe tap) to validate the ordering and failure semantics end to end.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-006` — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists](high/AOMS-006-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-004` — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs](high/BCR-004-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BE-005` — Core lifecycle hook points are declared but never fired by signUp/signIn](medium/BE-005-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CSG-002` — BeforeUserDelete hook point relied on by spec and BDD does not exist in code](high/CSG-002-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-006` — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only](low/ECF-006-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ELC-001` — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention](medium/ELC-001-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`ERS-005` — Hook-point taps run with unbounded concurrency, making tap order cosmetic](low/ERS-005-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 3e298c8. Evidence at HEAD ec065a7: `packages/core/src/Hooks.ts:36`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
