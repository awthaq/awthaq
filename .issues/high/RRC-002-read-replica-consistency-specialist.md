---
ID: "RRC-002"
Title: "BEH-EA-058/117's mandated one-transaction consume+apply is unimplemented in Password.confirmReset and verifyEmail"
Level: high
Category: "correctness"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:630"
Auditor: "read-replica-consistency-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRC-002 — BEH-EA-058/117's mandated one-transaction consume+apply is unimplemented in Password.confirmReset and verifyEmail

`HIGH` · `correctness` · `password` · reported by **Read Replica Consistency Specialist** (`read-replica-consistency-specialist`)

Status: **resolved**

## Summary

spec/behaviors/08-verification-tokens.md requires that marking a token consumed and applying the change it authorizes "MUST commit under one SQL transaction, so that no window exists in which the token is marked consumed but the change has not applied", and spec/behaviors/05-persistence-stratum.md names Password.confirmReset itself as the canonical example of a domain service holding that boundary. The code instead runs verification.consume (line 630), accounts.findByProviderSubject (a read, line 641), accounts.updateCredentialHash (line 657), and sessions.revokeAll (line 664) as four independent statements. The SqlTransaction port built for exactly this composition is imported and used by the OAuth plugin but not by the password plugin. A crash between statements burns a single-use reset token with the password unchanged, and this consume->read->write->revoke chain is precisely the sequence that breaks first under any future read/write split — consume lands on the primary while the follow-up read can see nothing that pins it to that write.

## Evidence

Source: `packages/password/src/Password.ts:630`

```
yield* verification.consume(identifier, value).pipe(
          Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
          Effect.catchTag("PlatformError", Effect.die),
```

## Recommended fix

Wrap the post-consume bodies of confirmReset and verifyEmail (and signUp per BEH-EA-115's one-transaction user+session requirement) in SqlTransaction.withTransaction exactly as OAuth.ts does for create+link; add a contract test asserting the token row and credential hash commit or roll back together.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: replica consistency
- Full dossier: [`read-replica-consistency-specialist`](../../.reports/read-replica-consistency-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/password/src/Password.ts:630` matches the evidence exactly; `confirmReset` runs `verification.consume` (630), a read (641), `updateCredentialHash` (657), and `sessions.revokeAll` (664) as independent statements, and a grep confirms `packages/password/src/Password.ts` never imports `SqlTransaction`, unlike `packages/oauth/src/OAuth.ts` which wraps its create+link in `SqlTransaction.withTransaction`. Fix has a direct precedent to mirror. Status → ready-for-agent.

**Resolved (2026-09-19):** Implemented the full recommended fix, not just `confirmReset`: `verifyEmail` now wraps its own `verification.consume` + `users.verifyEmail` in `SqlTransaction.withTransaction` (same atomicity gap as `confirmReset`, closed the same way), and `signUp` wraps `users.create` + `accounts.link` + `sessions.issue` per BEH-EA-113's literal "MUST create the user and session in one transaction" requirement (the auditor's own citation of "BEH-EA-115" for this appears to be a mis-citation — BEH-EA-115 is actually about `PasswordHasher` being a port; the real requirement is BEH-EA-113, verified directly against `spec/behaviors/15-password.md`). `hasher.hash` stays outside the transaction (pure CPU work, no persistence side effect); the mail dispatch stays on its existing `Effect.forkDetach` posture (BEH-EA-113's own non-blocking-mail requirement is unrelated to this atomicity fix). See `ARF-001`'s own comment for the `confirmReset` half and the same layerNoop-is-a-no-op caveat, which applies identically here. Full monorepo typecheck and test suite (606 tests) pass.

**Cross-reference (2026-09-19):** [`MA-001`](MA-001-michael-arnaldi.md) (same file, same `signUp` atomicity defect) was resolved as a duplicate of this fix — no separate change needed.
