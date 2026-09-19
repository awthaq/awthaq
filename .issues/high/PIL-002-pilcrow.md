---
ID: "PIL-002"
Title: "changePassword violates BEH-EA-053: no re-issue, no revocation"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:727"
Auditor: "pilcrow"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PIL-002 — changePassword violates BEH-EA-053: no re-issue, no revocation

`HIGH` · `security` · `password` · reported by **pilcrow (pilcrowOnPaper) — Creator of Lucia Auth** (`pilcrow`)

Status: **resolved**

## Summary

The repo's own spec says every privilege-changing operation '(password change, email change) MUST issue a newly minted session and delete the row it supersedes' (spec/behaviors/07-sessions.md, BEH-EA-053), and the device-list section says revokeOthers is 'designed to trigger automatically' after a password change. The authenticated changePassword implementation verifies the current password, updates the credential hash, and ends — no sessions.issue, no supersedes, no revokeOthers, no revokeAll. An attacker holding the victim's session cookie (the classic reason to change a password) keeps a fully valid session after the change; the defense the user believes they performed never happens. The HTTP handler (Password.ts:323-345) returns without touching the cookie either.

## Evidence

Source: `packages/password/src/Password.ts:727`

```
const hash = yield* hasher.hash(input.newPassword);
yield* accounts.updateCredentialHash(account.id, Redacted.make(hash)).pipe(Effect.orDie);
```

## Recommended fix

End changePassword with sessions.revokeOthers(userId, currentSessionId) followed by sessions.issue({ userId, supersedes: currentSessionId }), and have the HTTP handler Set-Cookie the fresh token with SESSION_COOKIE_ATTRIBUTES — the exact primitive pair the spec (BEH-EA-053) and the Sessions API (supersedes) were designed for and that confirmReset already approximates with revokeAll.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session fundamentals
- Full dossier: [`pilcrow`](../../.reports/pilcrow/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Validation (2026-09-19):** CONFIRMED — `packages/password/src/Password.ts:726-727` matches the evidence exactly; `changePassword` ends at `updateCredentialHash` with no `sessions.issue`/`revokeOthers`/`revokeAll` call, the HTTP handler at lines 323-345 adds no cookie write, and a grep of the file shows `revokeAll` is only called from `confirmReset` (line 664). `spec/behaviors/07-sessions.md` BEH-EA-053 requires rotation on privilege change, and `features/features/02-domain/07-sessions.feature:167`'s matching scenario (REQ-EA-148) is tagged `@skip`. Fix mirrors `confirmReset`'s existing `revokeAll` pattern — mechanical. Status → ready-for-agent.

**Resolved (2026-09-19):** `Password.changePassword` now revokes every other session (`sessions.revokeOthers(userId, currentSessionId)`) then supersedes the caller's own session with a freshly minted one (`sessions.issue({ userId, supersedes: currentSessionId })`), mirroring `confirmReset`'s existing `revokeAll` posture per BEH-EA-053. The HTTP handler and contract (`PasswordApi.ts`) now return the fresh `SessionDto` + `Set-Cookie` (200, not a bare 204) — a breaking response-shape change, accepted. Added domain-level coverage (session-id genuinely rotates; a second, independent session for the same user is confirmed revoked via `sessions.verify` failing `SessionNotFound`) and updated the wire-level test's status assertion. `features/features/02-domain/07-sessions.feature`'s `@REQ-EA-148` Scenario Outline stays `@skip`: its own header comment explains the Outline's sibling row ("email change") names a capability that does not exist anywhere in this codebase, and standard Gherkin has no per-row skip tag — un-wiring just the now-real "password change" row is BDD-wiring work properly scoped to the separately-tracked wiring effort (AH-003/wayfinder ticket 36), not this finding. Full `@awthaq/password` suite (33 tests), monorepo typecheck, and BDD suite all pass. Status → resolved.
