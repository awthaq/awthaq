---
ID: "PV-220"
Title: "`auth.token.replay` audit rows are rolled back with the failing transaction of the endpoint that replayed the token"
Level: medium
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Verification.ts:398"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-220 — `auth.token.replay` audit rows are rolled back with the failing transaction of the endpoint that replayed the token

`MEDIUM` · `correctness` · `core` · found while wiring `08-verification-tokens.feature` (P20a, AH-003 tier 1); not in the original audit

Status: **resolved**

## Summary

`Verification.consume` publishes `auth.token.replay` on every failed consumption, and `AuthEvents.publish` writes the durable `auth_audit_log` row inline (BEH-EA-100). `Password.verifyEmail`/`confirmReset` call `consume` *inside* `sqlTransaction.withTransaction`; the replayed (unknown/consumed/expired) token fails that transaction with `TokenConsumed`, so the inline audit insert rolls back with it. Over SQL the bus subscriber still sees the event, but the durable record of the replay attempt is never persisted, which defeats the ALF-001/INV-EA-010 intent (a token-replay probing campaign leaves durable evidence).

## Evidence

- `packages/core/src/Verification.ts:398`: `Effect.tapError(() => events.publish({ _tag: "auth.token.replay", identifier }))` inside `consume`.
- `packages/password/src/Password.ts` (`confirmReset`, `verifyEmail`): `verification.consume` runs inside `sqlTransaction.withTransaction`, and the typed `TokenConsumed` failure aborts it.
- Reproduced by `features/features/02-domain/08-verification-tokens.feature`, the `@skip` scenario "A replay through a transactional endpoint leaves a durable audit row": POST `/verify-email` twice with the same mailed token over the SQLite composition (`DomainWorld`); the second call returns `410 TokenConsumed` and the bus event is seen, but `auth_audit_log` holds no `auth.token.replay` row.

## Recommended fix

Publish the replay event after the transaction has rolled back (catch `TokenConsumed` outside `withTransaction` in every plugin that consumes a token transactionally, or give `Verification.consume` a way to defer its failure publication to the caller), then un-skip the scenario.

## Comments

_Triage notes and discussion append here._

**Plan note (2026-09-29, P20a):** Left open: every plugin that consumes a token transactionally (password verifyEmail/confirmReset, and now magic-link, email-otp and two-factor challenges) would need the publish moved outside its transaction, or Verification.consume needs a deferred-publication contract; that is an events/transaction design call (P10), not a cheap fix. The skipped scenario keeps this id.

**Resolved (2026-09-29):** packages/core/src/Verification.ts: consume takes { deferMiss } (a miss then records nothing) and the new Verification.recordMiss(identifier) writes the auth.token.replay event and durable audit row and, over SQL, spends the budgeted attempt. packages/password/src/Password.ts: confirmReset, verifyEmail and confirmEmailChange consume with deferMiss inside their transaction, map a miss to an internal TokenMissed marker and call recordMiss after the transaction has rolled back (then fail TokenConsumed as before). Red first: the skipped BDD scenario REQ-EA-688 was un-skipped and failed (no durable row); plus packages/core/test/Verification.test.ts deferred-miss tests (SQLite real transaction: nothing recorded until recordMiss, attempts spent after rollback still burn a budgeted token, memory twin). Also fixes a same-cause defect: over SQL the failed-attempt count of a budgeted token spent inside a rolled-back transaction was lost. features DomainWorld VerificationProbe now forwards consume options. BEH-EA-059 amended. Gates: typecheck, core/password/magic-link/oauth suites, features 02-domain, spec:verify:strict.
