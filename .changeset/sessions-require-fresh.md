---
"@awthaq/core": minor
"@awthaq/passkey": patch
"@awthaq/two-factor": patch
"@awthaq/qadi": patch
"@awthaq/password": minor
---

One fresh-session gate, `Sessions.requireFresh`, replaces the copies in passkey, two-factor and qadi; `POST /change-email` now uses it.

- `@awthaq/core`: new `Sessions.requireFresh(userId, id, maxAge)` and the `SessionStale` error (`Sessions/Stale`, with `maxAgeSeconds` and a `reason` of `notLive` or `stale`). Both layers share one implementation built on `findOwned` (BEH-EA-320).
- `@awthaq/passkey`, `@awthaq/two-factor`, `@awthaq/qadi`: enrolment, enable/disable/regenerate and the `reauth` obligation call `requireFresh` and map `SessionStale` to their existing wire errors (`PasskeyReauthRequired`, `TwoFactorReauthRequired`, `Api.ReauthRequired`); the wire contracts do not change.
- `@awthaq/password`: `POST /change-email` needs a session that proved a credential within the new `PasswordConfig.reauthMaxAge` (default 5 minutes), else `403 PasswordReauthRequired { maxAgeSeconds }`. `PasswordShape["requestEmailChange"]` takes `currentSessionId`.

Migration: a hand-written `Sessions` test double adds a `requireFresh` member. A client of `POST /change-email` handles `PasswordReauthRequired` by running `POST /password/reauthenticate` (or a passkey step-up) and retrying, or the host sets `reauthMaxAge: Duration.infinity` to keep the old behaviour. Callers of `Password.requestEmailChange` pass `currentSessionId`.
