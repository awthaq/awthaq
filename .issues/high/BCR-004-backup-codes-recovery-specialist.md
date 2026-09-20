---
ID: "BCR-004"
Title: "Password sign-in declares no divert hook point — the exact enabler the challenge flow needs"
Level: high
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:276"
Auditor: "backup-codes-recovery-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BCR-004 — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs

`HIGH` · `architecture` · `core` · reported by **Backup Codes & Account Recovery Specialist** (`backup-codes-recovery-specialist`)

Status: **resolved**

## Summary

The divert mechanism is real and tested — packages/core/test/HookPoint.test.ts:110-138 exercises a literal BeforeSessionIssue point diverting to 'two-factor-required' — but the only plugin declaring real hook points is organization, all veto/observe. packages/password declares none, so a two-factor plugin cannot intercept session issuance after first-factor success; spec/models/06 confirms this ('no BeforeSessionIssue hook point exists to tap into') and names it enabler E4. Without it, backup codes have no flow to complete: there is no challenge state between password success and session issue.

## Evidence

Source: `packages/core/src/HookPoint.ts:276`

```
 * BEH-EA-089/093: a hook point whose taps may redirect the operation to a
 * typed alternative outcome — the first tap to divert wins; if none do,
 * the operation continues with the original input.
```

## Recommended fix

Implement E4: declare a BeforeSessionIssue divert point (HookPoint.divert, typed Diverted outcome like TwoFactorRequired) in the password sign-in path, with the challenge carried in a purpose-scoped verification row (the oauth.flow payload precedent) rather than a bare cookie.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: Backup Codes & Recovery
- Full dossier: [`backup-codes-recovery-specialist`](../../.reports/backup-codes-recovery-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-006` — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists](high/AOMS-006-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BE-005` — Core lifecycle hook points are declared but never fired by signUp/signIn](medium/BE-005-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CSG-002` — BeforeUserDelete hook point relied on by spec and BDD does not exist in code](high/CSG-002-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-006` — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only](low/ECF-006-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ELC-001` — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention](medium/ELC-001-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`ERS-005` — Hook-point taps run with unbounded concurrency, making tap order cosmetic](low/ERS-005-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- [`GC-009` — Hook point input schemas are phantom witnesses, never decoded](info/GC-009-giulio-canti.md) `_(giulio-canti, info)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Hook point wiring completeness across auth flows](../../.scratch/resolve-ready-for-human-findings/issues/03-hook-point-wiring-completeness.md) — `Hooks.BeforeSessionIssue` (a real `HookPoint.divert` in new `packages/core/src/Hooks.ts`) is consulted at `Password.signIn` immediately before `sessions.issue`, diverting to a typed `TwoFactorRequired` outcome; the challenge-state storage question is left to ticket 05. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/HookPoint.ts:50-56`'s own header states no concrete hook point is wired into real `signUp`/`signIn` flows yet; a repo-wide grep for `HookPoint.divert<`/`HookPoint.observe<`/`HookPoint.veto<` shows only `packages/organization/src/OrganizationHooks.ts` declares real points (all veto/observe), and `BeforeSessionIssue` exists only as a locally-scoped class inside `packages/core/test/HookPoint.test.ts:112-138`, never in `packages/password/src`. Deciding where the divert-carrying challenge state lives (purpose-scoped verification row vs. cookie) and the new `Diverted` outcome shape is an architecture call, not a mechanical wiring change. Status → ready-for-human.

**Resolved (2026-09-20):** Duplicate of [`AOMS-006`](AOMS-006-auth0-okta-migration-specialist.md), which carries the full resolution — this finding's own specific ask is fully covered: `Hooks.BeforeSessionIssue` (a real `HookPoint.divert` in new `packages/core/src/Hooks.ts`) is consulted at `Password.signIn` immediately before `sessions.issue`, diverting to a typed `Hooks.TwoFactorRequired` outcome, verified by a dedicated mutation-tested `packages/password/test/PasswordHooksSignIn.test.ts`. The challenge-state storage question this finding's own recommended fix raises (a purpose-scoped `Verification` row vs. a cookie) is explicitly left to wayfinder ticket 05 (the still-`ready-for-agent` `AOMS-003`/`THS-001` MFA-subsystem cluster) — this ticket only had to seed the attachment point, not the challenge flow behind it.
