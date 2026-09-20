---
ID: "ALF-004"
Title: "Credential changes and ordinary session lifecycle emit no events at all"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:727"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-004 — Credential changes and ordinary session lifecycle emit no events at all

`HIGH` · `security` · `password` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **resolved**

## Summary

changePassword updates the credential hash and returns — no publish, and the closed union (AuthEvents.ts:213-238) has no password-changed or reset-completed tag for confirmReset either. Likewise there is no auth.session.issued/revoked: ordinary session issuance (:559), revoke, and revoke-others happen silently, so a forensics timeline cannot show when a hijacker's session died or when a victim rotated a credential after suspecting theft. Of the minimum event set an auth audit trail must capture — login success/failure, session create/end, credential change — only login success and two impersonation bookends exist.

## Evidence

Source: `packages/password/src/Password.ts:727`

```
        yield* accounts.updateCredentialHash(account.id, Redacted.make(hash)).pipe(Effect.orDie);
      });
```

## Recommended fix

Add auth.password.changed / auth.password.resetCompleted and auth.session.issued / auth.session.revoked tags and publish them within the same operations; follow the admin plugin's precedent of pairing each bus event with a durable row so the record of record grows with the union.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/password/src/Password.ts:726-727` (`changePassword`) matches the quoted evidence and returns with no publish; a full grep of the file confirms only `auth.user.created`/`auth.user.signedIn` are ever published, and `AuthEvents.ts`'s closed `AuthEvent` union (lines 213-238) has no password-changed/reset-completed/session-issued/revoked tags. Adding those tags and publish calls at existing operation sites is mechanical. Status → ready-for-agent.

**Resolved (2026-09-20):** Implemented the recommended fix exactly, scoped to `@awthaq/password`'s own operations (the finding's own `Package: password` and evidence file):

- `packages/core/src/AuthEvents.ts`: added 4 new closed-union tags — `SessionIssuedEvent` (`auth.session.issued`, `sessionId`/`userId`), `SessionRevokedEvent` (`auth.session.revoked`, `userId`/`reason: "passwordChanged" | "passwordReset"` — no per-row `sessionId`, since `Sessions.revokeAll`/`revokeOthers` are bulk operations with no per-row identity to report), `PasswordChangedEvent` (`auth.password.changed`), `PasswordResetCompletedEvent` (`auth.password.resetCompleted`). `packages/core/src/AuditLog.ts`'s exhaustive `actorOf` switch was updated for all 4 — TypeScript forced this, exactly the "audit-actor coverage can't silently lag the registry" design point.
- `packages/password/src/Password.ts`: `signUp` and `signIn` now each publish `auth.session.issued` right after `sessions.issue(...)` (alongside their existing `auth.user.created`/`auth.user.signedIn`); `confirmReset` publishes `auth.password.resetCompleted` + `auth.session.revoked(reason: "passwordReset")` — but only *after* the `sqlTransaction.withTransaction(...)` call that does the actual consume/rehash/revoke work has committed, mirroring `signUp`'s own established placement (never inside the transaction, so a rollback can never leave a "completed" event published for an operation that didn't happen); `changePassword` publishes `auth.password.changed` right after the hash update, `auth.session.revoked(reason: "passwordChanged")` right after `revokeOthers`, and `auth.session.issued` for the rotated session right after the final `sessions.issue(...)`.
- Session issuance/revocation events are scoped to Password's own call sites only (not centralized into `Sessions.ts` itself) — deliberately, to keep this fix's blast radius matched to the finding's own boundaries; other plugins' session issue/revoke call sites (passkey, oauth, admin) are out of scope here and would be their own findings if audited.

TDD: 3 new tests in `packages/password/test/Password.test.ts` (36 total, up from 33) — signUp/signIn both publish `auth.session.issued` with the correct `sessionId`/`userId`; confirmReset publishes both new tags with `reason: "passwordReset"`; changePassword publishes all three (`auth.password.changed`, `auth.session.revoked` with `reason: "passwordChanged"`, `auth.session.issued` for the rotated session). Verified genuinely load-bearing via two mutations, each reverted: (1) dropped the `auth.password.changed` publish — the changePassword test hung waiting for a 3rd event that never arrived, failing on timeout exactly as expected; (2) swapped `confirmReset`'s `reason: "passwordReset"` to `"passwordChanged"` — the confirmReset test failed with a clean assertion mismatch. Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (705 passed, 7 skipped, up from 702); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures noted in prior resolutions).
