---
ID: "JH-010"
Title: "divert kind has zero production usage — the spec's step-up flow cannot be built today"
Level: low
Category: "api"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:50"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-010 — divert kind has zero production usage — the spec's step-up flow cannot be built today

`LOW` · `api` · `core` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **resolved**

## Summary

BEH-EA-093's worked example — password.signIn diverted into a typed TwoFactorRequired outcome the client catches — is the flagship composability story: step-up auth added purely by installing a plugin. It is unrealizable: no divert point exists in any production flow (divert appears only in HookPoint.test.ts), core signUp/signIn run no hook points at all, and the two-factor package is an export-{} placeholder. The mechanism is tested in isolation while the integration that justifies it does not exist; the same is true for veto on core flows, meaning the strategy extension surface most comparable to Passport's authenticate() dispatch is currently aspirational.

## Evidence

Source: `packages/core/src/HookPoint.ts:50`

```
// Also scoped smaller in not yet wiring any concrete hook point into
// `Users.ts`/`Sessions.ts`'s real `signUp`/`signIn` flows (BEH-EA-090's
// `BeforeSignUp`, BEH-EA-092's `AfterSignIn`) — `AuthCore`, the fixed
```

## Recommended fix

Land AuthCore (the fixed core tuple Auth.ts:8-11 already anticipates) with beforeSignUp/beforeSessionIssue points wired into Users.ts/Sessions.ts, and make the two-factor milestone's step-up flow consume a divert point end-to-end — that integration is the acceptance test for the whole hook design.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: plugin strategy architecture
- Full dossier: [`jared-hanson`](../../.reports/jared-hanson/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 3e298c8. Evidence at HEAD ec065a7: `packages/core/src/Hooks.ts:69`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
