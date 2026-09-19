---
ID: "SMS-001"
Title: "Password change revokes no sessions and re-issues none — BEH-EA-053 privilege-change rule unimplemented"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:727"
Auditor: "session-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-001 — Password change revokes no sessions and re-issues none — BEH-EA-053 privilege-change rule unimplemented

`HIGH` · `security` · `password` · reported by **Session Management Specialist** (`session-management-specialist`)

Status: **resolved**

## Summary

spec/behaviors/07-sessions.md BEH-EA-053 requires every privilege-changing operation (password change, email change) to mint a new session and delete the row it supersedes. changePassword verifies the current password, updates the credential hash, and returns — no issue, no revokeOthers, no revokeAll — and the HTTP handler (lines 340-345) does nothing afterwards either. Any session an attacker already holds (or that lingers on a shared device) survives the credential rotation untouched, defeating the main reason users change passwords after a suspected compromise. The codebase proves it knows the requirement: confirmReset calls sessions.revokeAll(userId) (line 664), so the non-reset changePassword path is an asymmetry, not a policy.

## Evidence

Source: `packages/password/src/Password.ts:727`

```
yield* accounts.updateCredentialHash(account.id, Redacted.make(hash)).pipe(Effect.orDie);
      });
```

## Recommended fix

After updateCredentialHash succeeds, either issue a fresh session with supersedes: callerSessionId and set a new cookie, or at minimum call sessions.revokeOthers(userId, callerSessionId). Wire the current session id through the handler (it is available on Api.CurrentPrincipal.sessionId).

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session lifecycle
- Full dossier: [`session-management-specialist`](../../.reports/session-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — Password.ts:727 (`updateCredentialHash`) is `changePassword`'s last statement with no session revocation, and the HTTP handler (Password.ts:323-343) does nothing afterward either; `confirmReset` (line 664) already calls `sessions.revokeAll(userId)` and `Api.CurrentPrincipal` carries `sessionId` (packages/api/src/Api.ts:23), so wiring `changePassword` to `sessions.revokeOthers` is a direct, well-scoped fix mirroring the existing pattern. Status → ready-for-agent.

**Resolved (2026-09-19):** `Password.changePassword` now revokes every other session (`sessions.revokeOthers(userId, currentSessionId)`) then supersedes the caller's own session with a freshly minted one (`sessions.issue({ userId, supersedes: currentSessionId })`), mirroring `confirmReset`'s existing `revokeAll` posture per BEH-EA-053. The HTTP handler and contract (`PasswordApi.ts`) now return the fresh `SessionDto` + `Set-Cookie` (200, not a bare 204) — a breaking response-shape change, accepted. Added domain-level coverage (session-id genuinely rotates; a second, independent session for the same user is confirmed revoked via `sessions.verify` failing `SessionNotFound`) and updated the wire-level test's status assertion. `features/features/02-domain/07-sessions.feature`'s `@REQ-EA-148` Scenario Outline stays `@skip`: its own header comment explains the Outline's sibling row ("email change") names a capability that does not exist anywhere in this codebase, and standard Gherkin has no per-row skip tag — un-wiring just the now-real "password change" row is BDD-wiring work properly scoped to the separately-tracked wiring effort (AH-003/wayfinder ticket 36), not this finding. Full `@awthaq/password` suite (33 tests), monorepo typecheck, and BDD suite all pass. Status → resolved.
