# ADR-EA-037: A Unit of Work Releases State-Change Events on Commit and Attempt Events Either Way

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-037 |
> | Revision | 1.0 |
> | Effective Date | 2026-10-13 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-10-13): Initial release (plan 10 item 5) |

---

## Context

`AuthEvents.publish` did two things inline, in the caller's fiber: it wrote the durable audit row through the ambient `SqlClient`, and it handed the event to every live subscriber (`AuthEvents.on`, `stream`, `subscribe`). Inside a transaction the first is part of the transaction and rolls back with it, which is right for a state change and is what makes the [ADR-EA-030](030-event-delivery-outbox-relay.md) relay safe (it tails only committed rows). The second cannot be undone.

So any publish inside a transaction that later failed told live subscribers about something that never happened: account erasure (`auth.session.revoked`, `auth.roles.revoked`, `auth.user.claimsUpdated` published before a later step fails), `Password.confirmReset` (the second-factor check publishes, then the reset aborts), and every request of a tenanted Postgres deployment, whose whole handler runs inside `TenantScope.withTenant`'s transaction. Observe hooks (`HookPoint.observe`, the `After*` points) leaked the same way: a host tap was told about a sign-up that then rolled back.

The same placement also erased the wrong thing. An event that records an *attempt* (a wrong second-factor code, a replayed token, a failed sign-in, a denial) is a forensic fact about something that happened whether or not the surrounding operation went on to succeed. Its audit row, written inside a transaction that then rolled back, vanished: a brute force of the second factor through the password-reset form left no audit row at all, and the bus copy was the only trace. Password's `deferMiss`/`settleMiss` was a hand-rolled version of the fix for one such event.

## Decision

**1. Every real transaction is opened through `SqlTransaction`, and that installs a unit of work.** `@awthaq/ports` exports `SqlTransaction.UnitOfWork` (an ambient `Context.Reference`), the `onCommit` and `afterUnit` helpers, and `SqlTransaction.transactional(sql)`, which is `sql.withTransaction` plus a buffer for two lanes. `SqlTransaction.layerSql` is `transactional`; library source never calls `sql.withTransaction` directly (decision 6).

- `onCommit(effect)`: runs `effect` once the enclosing unit has committed, and never if it rolls back.
- `afterUnit(effect)`: runs `effect` once the *outermost* unit has ended, committed or not, outside any transaction (so a write made there lands on its own connection and commits by itself).

**2. Events pick a lane by what they record.** A *state-change* event (the default) writes its audit row inline, inside the transaction, so the row is atomic with the change (the outbox property [ADR-EA-030](030-event-delivery-outbox-relay.md) depends on), and releases its bus copy `onCommit`. An *attempt* event records both its audit row and its bus copy `afterUnit`, so a rollback cannot erase the forensic record. The classification belongs to the event's own definition (`defineEvent`'s `attempt: true`, [ADR-EA-029](029-event-pii-posture.md)'s declaration site): the attempt events are `auth.user.signInFailed`, `auth.token.replay`, `auth.twoFactor.challengeFailed`, `auth.twoFactor.locked`, `auth.rateLimit.exceeded`, `auth.admin.actionDenied`, `auth.admin.impersonationDenied`, `auth.authz.denied`, `auth.organization.permissionDenied` and `auth.deviceAuthorization.denied`. Every other event is a state change.

**3. Observe hooks run their taps `onCommit`.** `HookPoint.observe`'s `run` defers the tap chain to the commit lane (capturing the per-request tenant and request context the taps would have seen). Observe taps are already fail-isolated ([BEH-EA-092](../behaviors/12-hooks.md)) and return `void`, so no caller's types change. Veto and divert taps stay inline, because they decide the outcome.

**4. Nesting.** A nested `transactional` call (a savepoint) hands its commit lane to its parent on success and drops it when the savepoint rolls back; its `afterUnit` lane always goes to the parent. Only the outermost unit runs the lanes: `onCommit` work after a successful COMMIT, then `afterUnit` work after the transaction has ended. A COMMIT that fails is a failure of the unit, so its commit lane is dropped.

**5. With no transaction, both lanes run immediately.** `UnitOfWork` defaults to a no-unit that runs the work now. That is the answer for `SqlTransaction.layerNoop` and the memory stores too: their writes are not rolled back either (DRS-006), and withholding the event would hide a write that did happen.

**6. Raw `sql.withTransaction` in library source fails `pnpm check`.** `SqlClient` is effect's own type, so the compiler cannot ban the call; `scripts/check-transactions.mjs` (`pnpm check:transactions`) fails on any `sql.withTransaction(` in `packages/*/src` outside `packages/ports/src/SqlTransaction.ts`.

**7. The in-transaction audit insert runs in a savepoint.** On Postgres a failed statement aborts the whole transaction, so without one the `"bestEffort"` audit-write policy ([ADR-EA-028](028-infrastructure-error-policy.md)) did not hold inside a transaction: a failed audit `INSERT` took the operation down with it. `AuditLogRepository.insert` opens a savepoint when (and only when) a transaction is open.

## Consequences

**Positive**: live subscribers, observe taps, the audit log and the relay agree on what happened; forensic events survive rollbacks; `confirmReset` now audits a wrong second-factor code ([BEH-EA-266](../behaviors/31-two-factor.md)); the ad-hoc `deferMiss`/`settleMiss` is gone (`Verification.consume` records a miss through the `afterUnit` lane itself); a failed audit write degrades the trail instead of the transaction.

**Negative**: inside a transaction a live subscriber learns of a state change after the commit, not mid-transaction. [BEH-EA-098](../behaviors/13-events.md) "never suspends" still holds, since buffering is a push; the lanes run on the committing fiber at the end of the unit. An attempt event's audit row takes its own connection (outside the tenant transaction, so Postgres row-level security sees no tenant setting for it; the audit policy admits an unset tenant, and the row is stamped with the tenant the event carries). A host's own raw `sql.withTransaction` around awthaq calls is not covered: the docs tell hosts to use `SqlTransaction.transactional(sql)`. Tests that assert an event inside a still-open `transactional` unit no longer see it until the unit ends.

## Alternatives considered

- **(a) Feed in-process subscribers only from the relay.** Rejected: adds the relay's `settleDelay` and poll latency to every in-process reaction, contrary to [BEH-EA-097](../behaviors/13-events.md) and [BEH-EA-098](../behaviors/13-events.md).
- **(b) Move each publish after its transaction by hand.** Rejected: no locality, already done inconsistently, and impossible inside a request wrapped by the tenant transaction.
- **(c) One lane only (commit).** Rejected: it would also drop the bus copy of attempt events and keep erasing their audit rows.

## Related

[ADR-EA-030](030-event-delivery-outbox-relay.md) (the relay reads committed rows, unchanged), [ADR-EA-031](031-erasure-registry-and-retention.md) (erasure in one transaction), [ADR-EA-028](028-infrastructure-error-policy.md) (audit-write policy; the Postgres aborted-transaction hazard), [ADR-EA-029](029-event-pii-posture.md) (event definitions carry their metadata).
