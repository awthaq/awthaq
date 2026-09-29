---
ID: "SCP-008"
Title: "HookPoint machinery shipped but no concrete point is wired into real user flows for SCIM integration"
Level: low
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:50"
Auditor: "scim-provisioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SCP-008 — HookPoint machinery shipped but no concrete point is wired into real user flows for SCIM integration

`LOW` · `architecture` · `core` · reported by **SCIM Provisioning Specialist** (`scim-provisioning-specialist`)

Status: **resolved**

## Summary

The veto/observe/divert mechanism is implemented and tested, but per its own header no concrete hook point is installed in real signUp/signIn flows yet. A SCIM plugin will need exactly such points — e.g. a veto tap on sign-up/sign-in to reject a deactivated tombstone, or an observe tap to keep a directory link in sync — and today has nothing to tap; every integration would have to poll or wrap services directly. This is a substrate readiness gap, not a defect in the hook design.

## Evidence

Source: `packages/core/src/HookPoint.ts:50`

```
// Also scoped smaller in not yet wiring any concrete hook point into
// `Users.ts`/`Sessions.ts`'s real `signUp`/`signIn` flows (BEH-EA-090's
// `BeforeSignUp`, BEH-EA-092's `AfterSignIn`) — `AuthCore`, the fixed tuple
```

## Recommended fix

When AuthCore lands with BeforeSignUp/AfterSignIn, add the provisioning-relevant points to the same pass (BeforeUserCreate with veto for tombstoned directory users, AfterUserDeactivated observe) so the SCIM plugin integrates via taps rather than service wrapping.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: SCIM provisioning
- Full dossier: [`scim-provisioning-specialist`](../../.reports/scim-provisioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `core-hook-point-coverage`. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:50`. Fix: Close the non-SCIM part now via NAM-002's plan (BeforeSignUp on every creation path); add deactivation hook/event points in the same change that implements ticket 09's deactivation state. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Non-SCIM part closed by NAM-002 (BeforeSignUp now guards the OAuth first-login creation path too, with strategy on the input, and AfterSignUp exists). The deactivation hook points (BeforeUserDeactivate/AfterUserDeactivated) and the auth.user.deactivated event are deliberately not built: they belong to ticket 09's deactivation state (P14, UserRecord model) and land in the same change.
