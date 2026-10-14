# ADR-EA-039: `Verification.redeem` Owns the Consume-in-Transaction Protocol

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-039 |
> | Revision | 1.0 |
> | Effective Date | 2026-10-13 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-10-13): Initial release (plan 07) |

---

## Context

`Verification` handed callers the pieces of a protocol, not the protocol. [BEH-EA-058](../behaviors/08-verification-tokens.md) says a token's consumption and the state change it authorises commit in one transaction, and [ADR-EA-016](016-verification-sql-claiming.md) concluded that this "needs no change to `VerificationShape` at all": `SqlClient.withTransaction` threads transparently, so the calling plugin wraps `consume` with its own change. That was true and it was not enough.

- Only `@awthaq/password` assembled the protocol, by hand, three times (`confirmReset`, `verifyEmail`, `confirmEmailChange`). Each wrapped `consume` in `sqlTransaction.withTransaction` and mapped the transaction's `SqlError` to a defect, against [ADR-EA-028](028-infrastructure-error-policy.md).
- `@awthaq/magic-link` consumed **outside any transaction** and then ran the whole sign-in. Any failure after the consume burned the link or code, including a database outage while issuing the session, so the person had to request a new mail.
- The memory adapter has no rollback. Over `layerMemory` plus `SqlTransaction.layerNoop` a refused password reset burned the token, while over `layerSql` the same refusal restored it. [BEH-EA-259](../behaviors/15-password.md) baked the drift into the spec ("rolls the consume back (on SQL)") and a test comment worked around it.
- [ADR-EA-037](037-unit-of-work-releases-events-on-commit.md) had already removed the PV-220 deferred-miss pieces (`deferMiss`, `recordMiss`): a miss is recorded through the unit of work's `afterUnit` lane. What was left was the transaction itself.

## Decision

**1. `Verification` gains `redeem({ identifier, value, use, onFailure? })`.** It claims the token and runs `use` with it in one transaction. A miss never runs `use`, records itself (the attempt a budgeted token is owed, `auth.token.replay`, its audit row) and fails `TokenConsumed`. A failure of `use` is settled by `onFailure`.

**2. Settlement.** `Settlement = "rollback" | "commit"`. `"rollback"` (the default): nothing `use` wrote stands and the token is live again. `"commit"`: the token is spent, what `use` wrote stands, and the failure still reaches the caller. It is for a refusal that is itself the outcome the token paid for: a second-factor divert, or a veto after a valid presentation. A defect or an interruption always rolls back. `Verification.commitUnlessUnavailable` is the settlement three callers share: an outage (`StoreUnavailable`) gives the token back, any other refusal spends it.

**3. The give-back holds in both adapters.** `layerSql` opens one transaction through `SqlTransaction.transactional(sql)` (a savepoint inside an outer one, such as the RLS tenant transaction), so the rollback restores the row. `layerMemory` holds the claimed row in a `held` map and gives it back on a failed `use`, unless a newer `issue` for the identifier replaced it or `deleteAllByUser` swept it meanwhile; both maps change in one `Ref`, so a release never races them. `purgeExpired` never touches an in-flight hold.

**4. One implementation.** `consume` and `redeem` are written once (`makeTokenFlows`) over a module-private `ClaimStore` (`claim`, `transaction`, `release`) that each adapter supplies. It is the shape the planned store seam (ADR-EA-041) promotes.

**5. `layerSql` requires `SqlClient`.** A core SQL adapter owns its transactions through the client directly (as `Accounts` and `Sessions` do), not through the `SqlTransaction` port, so a composition that pairs `Verification.layerSql` with `SqlTransaction.layerNoop` cannot silently lose atomicity. A `SqlError` from `BEGIN` or `COMMIT` is `StoreUnavailable("Verification.redeem")`, never a defect; `Effect.catchIf(isSqlError)` is used because the body's own error type is generic.

**6. `consume` stays, as the burn-first operation.** OAuth flow state, the native exchange code, SAML request and logout state are spent on purpose before any follow-up, and the OAuth callback does network I/O after the spend, which must never run inside a write transaction. Each such call site carries a comment naming this ADR. `consume` must not be used for a token that authorises a state change.

**7. Callers.** `Password.confirmReset`, `verifyEmail` and `confirmEmailChange` redeem with the default settlement. `MagicLink.verify` and `EmailOtp.verify` redeem with `commitUnlessUnavailable`: the second-factor divert must commit (the challenge the tap issued inside `use` would otherwise roll back and the client would hold a dead `challengeId`), a veto, a suspension or an invalid proof spend the link as before, and an outage or a defect gives it back. `SecondFactor.redeemChallenge` does the same for the second-factor challenge ([ADR-EA-020](020-two-factor-state.md) decision 2).

**8. A rule inside `use`.** Never recover from a constraint violation by catching it: on Postgres a failed statement aborts the transaction, and a `"commit"` settlement would turn into a silent rollback. Use `ON CONFLICT` forms (`Users.createOrGet`, `SignUp`). Enforce rate limits before `redeem`, not inside `use`, because a limiter charge on the ambient client is refunded by a rollback.

## Consequences

**Positive**: one place writes the protocol; a failed completion gives the token back identically over memory and SQL (the shared contract suite proves it for both); magic links and email codes survive an outage; Password loses three hand-written transaction blocks and three `SqlError -> die` sites; the interface cannot regress because `consume` takes no options and has no `recordMiss` (a type gate in `CompileTimeGates.ts`).

**Negative**: the magic-link and email-OTP sign-in, including its `Before*` hooks, now runs inside the write transaction, so a tap that writes through a different database client may wait on the lock. In memory a *concurrent* redeem of a held token misses at once (and publishes a replay), where SQL makes the second claim wait on the row lock and then win if the first rolled back. [BEH-EA-062](../behaviors/08-verification-tokens.md) ("at most one succeeds") holds in both; only the loser's timing differs (TRBS-005, test-grade memory).

## Alternatives considered

- **(a) Keep the pieces and document them.** Rejected: each caller re-implements the protocol, and did so differently.
- **(b) A `redeem` module function over `Verification | SqlTransaction`.** Rejected: memory cannot give a token back without a store primitive.
- **(c) A `"burn"` settlement (spend the token, roll back `use`'s writes) via a savepoint.** Deferred: no caller needs it. For magic link and email OTP the refusals that spend the link follow writes that should stand (a user created before a veto), so `"commit"` is the match.
- **(d) A runtime guard that dies when `consume` runs inside a transaction.** Rejected: the RLS tenant middleware wraps every tenanted request in one.
- **(e) Retrying the redeem transaction on a transient `SqlError`.** Rejected: it re-runs `use` and its hooks; the caller gets `StoreUnavailable` and the token is given back.

## Related

[ADR-EA-016](016-verification-sql-claiming.md) (its "no interface change" paragraph is superseded), [ADR-EA-037](037-unit-of-work-releases-events-on-commit.md) (misses ride the `afterUnit` lane), [ADR-EA-038](038-sign-in-and-sign-up-are-core-modules.md) (the completion `use` runs), [ADR-EA-028](028-infrastructure-error-policy.md), [ADR-EA-020](020-two-factor-state.md).
