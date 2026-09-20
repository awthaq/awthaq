---
ID: "AR-001"
Title: "Documented MFA step-up flow has no attachment point: nothing hooks session issuance"
Level: high
Category: "architecture"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:559"
Auditor: "aeneas-rekkas"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AR-001 — Documented MFA step-up flow has no attachment point: nothing hooks session issuance

`HIGH` · `architecture` · `password` · reported by **Aeneas Rekkas — Founder/CEO of Ory** (`aeneas-rekkas`)

Status: **resolved**

## Summary

The spec claims a two-factor step-up flow can be added 'by installing a plugin, with no change to the password plugin' via a divert tap turning sign-in into a TwoFactorRequired outcome (spec/behaviors/12-hooks.md). The HookPoint machinery itself is real and tested (packages/core/src/HookPoint.ts), but grep over every package's src finds zero declared hook points — sign-in calls sessions.issue directly, with no declared BeforeSessionIssue-style divert point to intercept. The only declared points live in test files (packages/core/test/HookPoint.test.ts:112). The two-factor plugin is an empty placeholder (packages/two-factor/src/index.ts:8: 'Empty placeholder'). Net: the flagship platform flow (MFA) is unreachable, and adding it today requires editing the password plugin — the exact coupling the design claims to avoid.

## Evidence

Source: `packages/password/src/Password.ts:559`

```
const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
```

## Recommended fix

Declare a real session-issuance divert hook point in core (id 'auth.session.beforeIssue'), wrap sessions.issue calls in password (and oauth/passkey link/upgrade paths) with its run(), and ship the two-factor plugin against it. The divert result type already forces callers to handle both outcomes, so the API design is done — only the declaration and call-site wiring are missing.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Platform & API posture
- Full dossier: [`aeneas-rekkas`](../../.reports/aeneas-rekkas/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/password/src/Password.ts:559` (`sessions.issue({ userId: user.id })`) is called directly with no hook wrap; a repo-wide grep for `HookPoint.divert<` finds it declared only in `packages/core/test/HookPoint.test.ts:112/125`, never in any package's `src/`. `packages/organization/src/OrganizationHooks.ts` shows the established declaration pattern (veto/observe) this can mirror for a divert point, and `packages/two-factor/src/index.ts:8-10` is confirmed still an `export {}` placeholder. The core wiring gap (declare `auth.session.beforeIssue`, wrap the `sessions.issue` call sites in password/oauth/passkey) is mechanical against an existing, precedented mechanism — shipping the full two-factor plugin is separately tracked (ARF-005, BAM-007). Status → ready-for-agent.

**Resolved (2026-09-20):** Duplicate of [`AOMS-006`](AOMS-006-auth0-okta-migration-specialist.md), which carries the full resolution — this finding's own specific ask is met exactly, down to the id string it names: `Hooks.BeforeSessionIssue`, a real `HookPoint.divert` declared in new `packages/core/src/Hooks.ts` with id `"auth.session.beforeIssue"` (verbatim match to this finding's own recommended fix), wraps `sessions.issue` at each of `Password.signIn`, `OAuth.callback`, and `Passkey.authenticateVerify` — the plugin/link-path callers this finding names — diverting to a typed `Hooks.TwoFactorRequired` outcome. `OAuth`'s `flow.link` path is correctly left unwrapped: it never calls `sessions.issue` (linking an already-authenticated session's account, not minting a new one), so there is no "upgrade path" session-issuance call site distinct from `callback`'s own. Verified by dedicated mutation-tested `packages/password/test/PasswordHooksSignIn.test.ts`, `packages/oauth/test/OAuthHooksSignIn.test.ts`, and `packages/passkey/test/PasskeyHooksSignIn.test.ts`. Shipping the full two-factor plugin against this point remains separately tracked (`ARF-005`/`BAM-007`, part of the still-deferred wayfinder ticket 05 MFA cluster).
