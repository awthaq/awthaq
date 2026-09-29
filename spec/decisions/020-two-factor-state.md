# ADR-EA-020: Two-Factor State — Encrypted Secrets, a Verification Challenge, One Failure Budget per Account

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-020 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (THS-004, THS-007, BCR-006, THS-005; wayfinder ticket 05) |

---

## Context

`@awthaq/two-factor` (TOTP with recovery codes, wayfinder ticket 05) holds three kinds of state the rest of the library does not: a secret that must be *decryptable* (a TOTP secret is the input to the running code, so hashing it is not an option), a pre-session challenge (a sign-in that passed its first factor and owes a second), and a count of failed attempts that must span every way a second factor can be presented. Each has a design that is easy to get subtly wrong, and ticket 05 left three points open that the build had to settle: where the encryption comes from (it proposed a new `SecretBox` port), how a challenge is bound and superseded, and what stops guessing that spreads across methods and challenges.

## Decision

1. **A TOTP secret is stored only as an `Encryption` port envelope, with AAD bound to its owner.** `two_factor_secret.secret` holds an envelope from `@awthaq/ports`' `Encryption` (AES-256-GCM over `KeyProvider`; multi-key with lazy re-encryption) whose additional authenticated data is `two_factor_secret:<userId>`, so a ciphertext copied to another user's row fails authentication (`DecryptionFailed`). The base32 secret never touches a column, a log, an event or the data export; only `enable` returns it, once. A read under a retired key re-encrypts the secret under the current one (`Decrypted.staleKid`), so a key can eventually be dropped from the key set. Recovery codes are the other half: hashed with the `PasswordHasher` port (one PHC string each), never encrypted, spent by a compare-and-set on `usedAt IS NULL`.
2. **The challenge is a `Verification` row, one live per account.** When `BeforeSessionIssue` diverts, the plugin calls `verification.issue({ identifier: "two-factor-challenge:<userId>", ttl: 10 minutes, payload: { strategy, amr, attempt } })`. Issuing supersedes any earlier live challenge for that identifier (the partial unique index of ADR-EA-016), so an account has at most one; the value is single-use; and every failed or replayed consume publishes `auth.token.replay` (BEH-EA-059). The `challengeId` the client holds is `<identifier>.<value>` — the user id is not a secret here (`TwoFactorRequired` already names the user), and because the identifier is derived from the claimed user, a challenge for user A cannot be spent as user B's. `/two-factor/verify*` consumes the challenge **before** checking the code. A wrong code re-issues a fresh challenge carrying `attempt + 1` (a consumed challenge is never reused) until `maxAttemptsPerChallenge` (3) are spent, after which the client restarts the sign-in. Disabling the factor makes every outstanding challenge fail (there is no confirmed secret left to check). The types carry the state machine: `Challenge.verified` accepts only a spent challenge plus a `FactorProof` minted by `SecondFactor.check*`, and `finalizeSignIn` — the one place the plugin calls `Sessions.issue` — accepts only that `VerifiedChallenge`.
3. **One shared failure budget per account, through the `RateLimiter` port.** Key `two_factor:fail:<userId>`: charged on every *failed* presentation of a TOTP code or a recovery code (any challenge, any purpose — sign-in, reset, disable, regenerate, enrolment confirmation), five failures per fifteen minutes by default. It is checked **before** a code is evaluated (`RateLimiter.check`, the read half added for this) so a locked account gets no free guess, and a locked attempt fails the typed `SecondFactorLocked` (429, `retryAfterMillis`) even for the correct code. **Success does not reset the window**, so interleaving right and wrong codes cannot stretch the budget. The moment the budget is spent publishes `auth.twoFactor.locked` (audited). It sits on top of the per-challenge attempt limit of decision 2 and the per-source `verifyByIp` limit; the three bound different attackers (one sign-in, one account, one origin). The cost of the shared budget is that whoever holds a victim's first factor can lock the victim's second factor for fifteen minutes; that is the accepted trade for bounding the guessing.
4. **A TOTP step is accepted at most once (RFC 6238 §5.2).** `two_factor_secret.lastUsedStep` is advanced by a compare-and-set that succeeds only for a strictly later step; the code that confirms enrolment records its step too. A replayed code, or the losing side of two concurrent verifications of one code, is refused.
5. **The gates are opt-in layers and the plugin refuses to build without them.** Hook points freeze at first use (BEH-EA-024), so the taps ship as `sessionGate` and `credentialResetGate`; `TwoFactor.layer` requires marker services only those layers provide (`noCredentialReset` is the explicit opt-out for a composition with no reset flow). Omitting a gate is a compile error, not a silent bypass.

## Alternatives considered

**A new `SecretBox` port** (ticket 05's proposal). Superseded, not rejected on merit: `Encryption` already provides the AEAD, the key rotation and the AAD binding the ticket asked for, and a second port would duplicate them.

**Plaintext or hashed secrets.** Rejected: plaintext is a database-read away from every account's second factor, and a hash cannot compute the code.

**A signed HttpOnly challenge cookie** (better-auth's design, the spec model's original sketch). Rejected: `Verification` already has the right shape (short-lived, single-consume, replay-observable) and needs no request-scoped cookie state, so it works for native clients and across origins.

**A random public id per challenge.** Considered (it avoids putting a user id in the token, ARF-009's concern for *mailed* tokens). Rejected here because it gives up one-live-challenge-per-account, which is what bounds pending challenges; the id is already disclosed by `TwoFactorRequired`.

**A per-challenge limit alone** (ticket 05's 3 attempts). Insufficient: repeated sign-ins mint fresh challenges, multiplying the budget. Hence decision 3.

## Consequences

**Positive**: no plaintext secret or code at rest; a moved ciphertext is useless; replay is closed atomically; guessing is bounded per sign-in, per account and per source; a forgotten gate fails to compile.

**Negative**: an attacker with a victim's first factor can lock their second factor for the window (a denial of service on the second factor only, never a bypass); the recovery-code check runs one password hash per unused code; and `RateLimiter` gained a required `check` operation (a cost to any custom limiter implementation).
