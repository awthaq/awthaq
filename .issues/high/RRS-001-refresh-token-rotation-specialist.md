---
ID: "RRS-001"
Title: "changePassword issues no new session and revokes nothing — BEH-EA-053 privilege-change rotation unimplemented"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:727"
Auditor: "refresh-token-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRS-001 — changePassword issues no new session and revokes nothing — BEH-EA-053 privilege-change rotation unimplemented

`HIGH` · `security` · `password` · reported by **Refresh Token Rotation Specialist** (`refresh-token-rotation-specialist`)

Status: **resolved**

## Summary

changePassword verifies the current password, writes the new hash, and returns — no sessions.issue({supersedes}), no revokeOthers, no revokeAll (the HTTP handler at Password.ts:340-344 adds nothing). BEH-EA-053 (spec/behaviors/07-sessions.md:78-85) explicitly requires every privilege-changing operation to mint a new session and delete the row it supersedes, and the BDD scenario that would hold this honest (REQ-EA-148) is @skip'd (features/features/02-domain/07-sessions.feature:167). Consequence: an attacker holding a hijacked session retains full account access after the victim rotates their password — the exact scenario privilege-change session rotation exists to close — and the user's other devices are never forced to re-prove the credential. The reset path (confirmReset, Password.ts:664) already calls revokeAll, proving the intended posture; the authenticated change path lacks it entirely.

## Evidence

Source: `packages/password/src/Password.ts:727`

```
const hash = yield* hasher.hash(input.newPassword);
        yield* accounts.updateCredentialHash(account.id, Redacted.make(hash)).pipe(Effect.orDie);
```

## Recommended fix

In changePassword (and the future changeEmail), issue a fresh session with supersedes set to the caller's current session, deliver the new token in the response, and revoke all other sessions per BEH-EA-053; then un-skip REQ-EA-148 with a wire-level scenario for the password-change row.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Refresh & Token Rotation
- Full dossier: [`refresh-token-rotation-specialist`](../../.reports/refresh-token-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — duplicate lens on the same gap as PIL-002; `packages/password/src/Password.ts:726-727` matches the evidence exactly, the HTTP handler (lines 323-345) never sets a cookie, `revokeAll` is only called from `confirmReset` (line 664), and `features/features/02-domain/07-sessions.feature:167`'s `@REQ-EA-148` scenario is confirmed `@skip`'d. Fix mirrors `confirmReset`'s existing `revokeAll` pattern. Status → ready-for-agent.

**Resolved (2026-09-19):** `Password.changePassword` now revokes every other session (`sessions.revokeOthers(userId, currentSessionId)`) then supersedes the caller's own session with a freshly minted one (`sessions.issue({ userId, supersedes: currentSessionId })`), mirroring `confirmReset`'s existing `revokeAll` posture per BEH-EA-053. The HTTP handler and contract (`PasswordApi.ts`) now return the fresh `SessionDto` + `Set-Cookie` (200, not a bare 204) — a breaking response-shape change, accepted. Added domain-level coverage (session-id genuinely rotates; a second, independent session for the same user is confirmed revoked via `sessions.verify` failing `SessionNotFound`) and updated the wire-level test's status assertion. `features/features/02-domain/07-sessions.feature`'s `@REQ-EA-148` Scenario Outline stays `@skip`: its own header comment explains the Outline's sibling row ("email change") names a capability that does not exist anywhere in this codebase, and standard Gherkin has no per-row skip tag — un-wiring just the now-real "password change" row is BDD-wiring work properly scoped to the separately-tracked wiring effort (AH-003/wayfinder ticket 36), not this finding. Full `@awthaq/password` suite (33 tests), monorepo typecheck, and BDD suite all pass. Status → resolved.
