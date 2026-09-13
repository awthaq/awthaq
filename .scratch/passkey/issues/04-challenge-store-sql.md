# 04 — ChallengeStore.layerSql

**What to build:** a SQLite-backed `ChallengeStore` implementation, passing
the exact same contract suite ticket 03 established against `layerMemory`,
so the two are behaviorally indistinguishable from a caller's perspective.

**Blocked by:** 03 — ChallengeStore interface and layerMemory

**Status:** done

- [ ] `layerSql` claims a challenge atomically — one statement, no
      separate delete-then-insert or check-then-act race — using the same
      technique ADR-EA-016 established for `Verification`'s `reserve`
      (`INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`, or an
      equivalent single-statement claim expressing "unconsumed and
      unexpired" directly in the `WHERE` clause)
- [ ] Ticket 03's full contract suite (single-use, deleted on every
      attempt regardless of outcome, five-minute TTL via `TestClock`,
      scope isolation) passes identically against `layerSql`
- [ ] Two concurrent `issue` calls for the same scope don't leave two live
      challenge rows behind (the concurrency bug ADR-EA-016's revision
      history records finding and fixing for `Verification.issue`)

## Result

Done. `layerSql` uses ADR-EA-016's atomic-single-statement technique: `issue` is one `INSERT ... ON CONFLICT(scope) DO UPDATE ... RETURNING`; `consume` is one `DELETE ... RETURNING` (simpler than `Verification`'s `UPDATE` — a consumed challenge has no history worth keeping). Same contract suite as `layerMemory` passes identically. The concurrency test checks row count directly via SQL rather than trying both concurrently-issued values through `consume` — see the test's own comment: since a *wrong*-value consume also deletes the row (BEH-EA-132), trying the losing value first would destroy the winner's row too, which isn't a bug, just means `Verification.test.ts`'s exact assertion shape doesn't transfer here.
