---
"@awthaq/core": minor
"@awthaq/sql": minor
"@awthaq/password": patch
"@awthaq/passkey": patch
---

`Sessions.reauthenticate` advances only a live session the caller owns.

- `@awthaq/core`: `reauthenticate(id, amr?)` becomes `reauthenticate(userId, id, amr?)`. A tombstoned (superseded), expired, foreign or absent session fails `SessionNotFound` and is left unchanged, in both layers (BEH-EA-319).
- `@awthaq/sql`: `SessionsRepository.reauthenticate(id, userId, now, amr?)` guards owner, tombstone and both expiries in the one `UPDATE`'s `WHERE`.
- `@awthaq/password`, `@awthaq/passkey`: `POST /password/reauthenticate` and `POST /passkey/reauthenticate/verify` answer 401 `Unauthenticated` when the session ended during the request (it used to be a 500 defect). `PasswordShape["reauthenticate"]` and `PasskeyShape["reauthenticateVerify"]` gain `Api.Unauthenticated` in their error channel.

Migration: call `sessions.reauthenticate(userId, sessionId, amr)`; a host with its own `SessionsRepository` implementation adds the `userId` and `now` parameters and the three predicates. A caller that relied on stepping up a dead or foreign session id now gets `SessionNotFound`.
