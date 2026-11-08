---
"@awthaq/passkey": minor
---

The passkey signature-counter verdict is decided at the record-store write (plan 25 ticket 18, ADR-EA-041 decision 9):

- Two concurrent assertions carrying the same counter can no longer both advance it unnoticed. Before, each compared its counter with the value the ceremony had read earlier, so both passed the CB-004 check. Now `PasskeyCredentials.recordUsage` decides: exactly one advances, and the others are regressions. Under `counterAnomalyPolicy: "flag"` a regression is published as `auth.passkey.counterAnomaly` and flagged. Under `"reject"` it fails with `PasskeyCounterAnomaly`, and the counter does not advance.
- A regressed assertion stores nothing but the anomaly flag: not the counter, the backup state or the last-used time (before, under `"flag"`, it stamped the last-used time and backup state).
- A credential deleted between the ceremony's lookup and its usage write fails the sign-in or step-up like an unknown credential. Before, the request died with a defect.
- `ChallengeStore`, `PasskeyCredentials` and `PasskeyUserHandles` have RecordsContract suites. `ChallengeStore`'s also runs on `layerCookie`.

Migration: a custom adapter through `@awthaq/passkey`'s `PasskeyCredentials` must implement `recordUsage(id, counter, backedUp)` as one conditional write that answers `"advanced"` or `"regressed"` (before, it answered `void`). It advances when `counter` is above the stored counter or both are 0, storing the counter, backup state and last-used time in that same step. Otherwise it writes nothing and answers `"regressed"`. It fails `PasskeyCredentials/NotFound` when the credential is gone. Memory: one `Ref.modify`. SQL: `UPDATE … WHERE id = $id AND (counter < $n OR (counter = 0 AND counter = $n)) RETURNING id`. BEH-EA-131, CB-004.
