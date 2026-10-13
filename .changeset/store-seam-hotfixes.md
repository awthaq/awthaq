---
"@awthaq/core": patch
"@awthaq/sql": patch
---

Atomic session revoke, reauthenticate, reuse detection and supersede ownership; Postgres-safe unlink; reservation boundary; a verification miss is charged to the token it was judged against; `verifyEmail` announces once.

- `Sessions` (both layers): two concurrent revokes of one session publish exactly one `auth.session.revoked` (one `DELETE ... RETURNING`); concurrent `reauthenticate` calls both land in `amr` (compare-and-swap in `layerSql`); reuse detection publishes `auth.session.reuse` and the family revoke exactly once; `supersedes` naming another user's (or a tombstoned) session tombstones nothing, founds a fresh family and publishes no `auth.session.superseded`, and that event's `userId` is the superseded row's.
- `Accounts.unlink` locks the user's account rows on Postgres before counting siblings (BEH-EA-045), so two concurrent unlinks cannot leave zero accounts.
- `Verification.reserve`: a reservation is expired iff `now >= expiresAt` in both layers (SQL used `>`). A failed attempt is charged to the row the miss was judged against, so a reissue never charges the new token (SOS-004).
- `Users.verifyEmail` (`layerSql`) announces `emailVerified` once under concurrency (AAPS-005).
- `@awthaq/sql` repositories: `SessionsRepository.deleteOwned` is replaced by `deleteReturning`, `markReused` by `markReusedOnce`, `tombstone` takes `userId`, `reauthenticate` takes an expected `amr`; `AccountsRepository.lockByUser`; `VerificationRepository.recordFailedAttempt` takes the token `id`; `UsersRepository.verifyEmail` answers `Option<User>`.

Migration: none for application code. A host that calls `Repositories.SessionsRepository.deleteOwned`/`markReused`, `VerificationRepository.recordFailedAttempt` or `UsersRepository.verifyEmail` directly adopts the new signatures. BEH-EA-045, 053, 063.
