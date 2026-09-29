# Two-Factor Authentication
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-28 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release (THS-001, AOMS-003, ARF-005, BCR-002, BCR-006, BCR-010, THS-004, THS-005, THS-007; wayfinder ticket 05), replacing [MOD-EA-006](../models/06-two-factor-totp.md)'s non-normative sketch |
---

> Status: the `@awthaq/two-factor` plugin is implemented and tested (`packages/two-factor/test/`). The decisions behind it are [ADR-EA-020](../decisions/020-two-factor-state.md); the credential-reset veto it taps is [BEH-EA-232](15-password.md#beh-ea-232-a-credential-reset-consults-beforecredentialreset-before-anything-is-rewritten). SMS is deliberately not part of it ([ADR-EA-021](../decisions/021-sms-otp-restricted-plugin.md)).

## BEH-EA-233: TOTP is RFC 6238, computed by a pure module checked against the published vectors

```ts
Totp.hotp(crypto, key, counter, digits): Effect<string>
Totp.totp(crypto, key, epochSeconds, { period, digits }): Effect<string>
Totp.verifyTotp(crypto, key, code, epochSeconds, { period, digits, window, lastUsedStep }): Effect<Option<bigint>>
Totp.base32Encode(bytes) / Totp.base32Decode(text): Option<Uint8Array>
Totp.otpauthUri({ issuer, accountName, secret, period, digits }): string
```

```text
REQUIREMENT: The time-based one-time password MUST be RFC 6238 over RFC 4226
             (HMAC-SHA-1, dynamic truncation, 30-second steps, six digits by
             default, one step of drift either side by default) and MUST
             reproduce every value in RFC 4226 Appendix D and RFC 6238
             Appendix B. Verification MUST evaluate every candidate step and
             compare each in constant time, MUST refuse a step at or before
             the last accepted one, and MUST treat a malformed code as no
             match rather than an error. The secret MUST be 160 random bits
             from the ambient `Crypto` service.
```

The module has no plugin, store or clock in it: HMAC-SHA-1 is built from `Crypto.digest` (RFC 2104), like `@awthaq/ports`' HMAC-SHA-256, so it runs wherever the composition's `Crypto` layer does. It is sequenced first because nothing else can be verified without it. base32 (RFC 4648, unpadded) is the alphabet an authenticator's manual-entry field takes; decoding tolerates case, spaces, hyphens and padding. `otpauthUri` is the Key Uri Format link a QR code carries.

_Next: [BEH-EA-234](28-two-factor.md#beh-ea-234-a-sign-in-with-a-confirmed-second-factor-is-diverted-and-no-session-exists-until-it-passes)_

## BEH-EA-234: A sign-in with a confirmed second factor is diverted, and no session exists until it passes

```ts
TwoFactor.sessionGate                // taps Hooks.BeforeSessionIssue
TwoFactor.credentialResetGate        // taps Hooks.BeforeCredentialReset
TwoFactor.noCredentialReset          // explicit "no reset flow here"
TwoFactor.layer                      // requires the markers only the gates provide
```

```text
REQUIREMENT: Every first-factor flow that consults `BeforeSessionIssue`
             (password, OAuth, passkey, magic link, email OTP) MUST, for a
             user with a *confirmed* second factor whose strategy is not in
             `bypassStrategies`, fail with `TwoFactorRequired { userId,
             challengeId }` and mint no session. A pending, unconfirmed
             secret MUST NOT divert. `TwoFactor.layer` MUST require a marker
             service that only `sessionGate` provides and another that only
             `credentialResetGate` (or `noCredentialReset`) provides, so
             composing the plugin without a gate is a compile error.
```

Hook points freeze at first use (BEH-EA-024), so the taps cannot be folded into the plugin's own layer; the markers are what keep a forgotten gate from being a silent MFA bypass (type-system-first plugins, ADR-EA-020 decision 5). The divert passes the first factor's `amr` (`Hooks.BeforeSessionIssue`'s context), so the session finally minted records how *both* factors were proven. `bypassStrategies` (default none) lets an application declare, say, `["passkey"]` — a user-verified passkey is already multi-factor — and is the only way a first factor skips the divert. Infrastructure failures inside the divert die (the divert has no error channel): failing closed, a `500` rather than a session.

_Previous: [BEH-EA-233](28-two-factor.md#beh-ea-233-totp-is-rfc-6238-computed-by-a-pure-module-checked-against-the-published-vectors) | Next: [BEH-EA-235](28-two-factor.md#beh-ea-235-the-challenge-is-a-single-use-verification-row-consumed-before-the-code-is-checked)_

## BEH-EA-235: The challenge is a single-use Verification row, consumed before the code is checked

```ts
POST /two-factor/verify           { challengeId, code }          -> SessionDto | InvalidTwoFactorCode { challengeId? } | SecondFactorLocked
POST /two-factor/verify-recovery  { challengeId, recoveryCode }  -> SessionDto | InvalidTwoFactorCode { challengeId? } | SecondFactorLocked
```

```text
REQUIREMENT: The challenge MUST be a `Verification` row under the identifier
             `two-factor-challenge:<userId>` with a ten-minute default TTL:
             issuing MUST supersede any earlier live challenge for the
             account, it MUST be single-use, and every failed or replayed
             consume MUST publish `auth.token.replay` (BEH-EA-059). The
             endpoints MUST consume the challenge BEFORE checking the code.
             A challenge minted for one user MUST NOT be spendable as
             another's. A wrong code MUST re-issue a fresh challenge carrying
             `attempt + 1` until `maxAttemptsPerChallenge` (default 3) are
             spent, after which the answer carries no challenge and the
             client restarts the sign-in. Every failure — malformed, unknown,
             expired, replayed, foreign, wrong code, factor disabled since —
             MUST be the one `InvalidTwoFactorCode`.
```

The type system carries the state machine (TTE-008): `consumeChallenge` yields a `ConsumedChallenge`, `SecondFactor.check*` a branded `FactorProof`, and `Challenge.verified` joins the two — for the *same* user, else a defect — into the `VerifiedChallenge` that `finalizeSignIn`, the one place the plugin calls `Sessions.issue`, accepts. `finalizeSignIn` re-runs the sign-in gate (`Users.assertCanSignIn`: a user suspended in the minutes since the first factor gets no session), records `amr = [...first factor, "otp", "mfa"]` (AOMS-003), publishes `auth.user.signedIn` for the first factor's strategy and runs `AfterSignIn`. `/verify` is rate limited per source (`verifyByIp`).

_Previous: [BEH-EA-234](28-two-factor.md#beh-ea-234-a-sign-in-with-a-confirmed-second-factor-is-diverted-and-no-session-exists-until-it-passes) | Next: [BEH-EA-236](28-two-factor.md#beh-ea-236-enrolling-disabling-and-regenerating-need-a-fresh-session-and-the-secret-is-encrypted-at-rest)_

## BEH-EA-236: Enrolling, disabling and regenerating need a fresh session, and the secret is encrypted at rest

```ts
POST /two-factor/enable                      -> { secret, otpauthUri }          // once
POST /two-factor/confirm       { code }      -> { recoveryCodes }               // once
POST /two-factor/disable       { code }      -> 204
POST /two-factor/recovery-codes/regenerate { code } -> { recoveryCodes }
GET  /two-factor/status                      -> { enabled, remainingRecoveryCodes }
```

```text
REQUIREMENT: `enable`, `disable` and `regenerate` MUST require a session
             whose `authenticatedAt` is within `reauthMaxAge` (default ten
             minutes), else `TwoFactorReauthRequired`. `enable` MUST store a
             pending secret that is not an active factor until `confirm`
             proves it with a valid code; enabling an already-confirmed
             account MUST fail `TwoFactorAlreadyEnabled`. The secret MUST be
             stored only as an `Encryption` port envelope with AAD
             `two_factor_secret:<userId>` — an envelope moved to another
             user's row MUST fail authentication — and MUST NOT appear in
             any column, log, event or export in the clear. `disable` and
             `regenerate` MUST require a valid TOTP or recovery code.
```

The base32 secret is returned exactly once, by `enable`; the plaintext lives only in that response. A read under a retired encryption key re-encrypts the secret under the current one (lazy re-encryption), so a key can eventually be dropped. All five endpoints sit behind `Api.Authentication` and `CsrfProtection`; the management endpoints are rate limited per account (`manageByUser`).

_Previous: [BEH-EA-235](28-two-factor.md#beh-ea-235-the-challenge-is-a-single-use-verification-row-consumed-before-the-code-is-checked) | Next: [BEH-EA-237](28-two-factor.md#beh-ea-237-recovery-codes-are-hashed-single-use-shown-once-and-replaced-atomically)_

## BEH-EA-237: Recovery codes are hashed, single-use, shown once and replaced atomically

```ts
interface TwoFactorRecoveryCodesShape {
  replaceAll(userId, hashes): Effect<void>
  listUnused(userId): Effect<ReadonlyArray<{ id, codeHash }>>
  markUsed(userId, id): Effect<boolean>      // compare-and-set on usedAt IS NULL
  countUnused(userId): Effect<number>
  deleteAllByUser(userId): Effect<void>
}
```

```text
REQUIREMENT: `confirm` MUST mint ten recovery codes of ten characters from a
             32-symbol unambiguous alphabet (50 bits each), return them once,
             and persist only a `PasswordHasher` hash of each. Presenting a
             code MUST check every unused hash (no early exit), MUST spend
             the matching one with a single compare-and-set so it succeeds
             exactly once even under concurrent presentation, and MUST
             publish `auth.twoFactor.recoveryCodeUsed { remaining }`.
             Regenerating MUST replace the whole set in one transaction — a
             failure part-way MUST leave the old set intact — and the old
             set MUST stop working. The remaining count MUST be readable.
```

Codes are shown grouped (`ABCDE-FGHJK`) and normalised (upper-cased, separators stripped) before hashing or comparing; a string that cannot be a code is refused without running a password hash. A code is accepted wherever a TOTP is (sign-in, credential reset, disable, regenerate), and never both a success and a silent replay: a spent code fails the ordinary way.

_Previous: [BEH-EA-236](28-two-factor.md#beh-ea-236-enrolling-disabling-and-regenerating-need-a-fresh-session-and-the-secret-is-encrypted-at-rest) | Next: [BEH-EA-238](28-two-factor.md#beh-ea-238-a-totp-step-is-accepted-at-most-once-even-concurrently)_

## BEH-EA-238: A TOTP step is accepted at most once, even concurrently

```ts
interface TwoFactorSecretsShape {
  advanceLastUsedStep(userId, step): Effect<boolean>   // UPDATE ... WHERE lastUsedStep IS NULL OR lastUsedStep < step
  confirm(userId, step): Effect<boolean>
  upsertPending(userId, envelope): Effect<boolean>     // false once confirmed
  ...
}
```

```text
REQUIREMENT: A verified TOTP MUST advance `two_factor_secret.lastUsedStep`
             with a compare-and-set that succeeds only for a strictly later
             step; a replay of the same step, and the losing side of two
             concurrent verifications of one code, MUST be refused (RFC 6238
             §5.2). The code that confirms enrolment MUST record its step so
             it cannot be replayed at sign-in. `upsertPending` MUST NOT
             overwrite a confirmed secret.
```

Both stores (`layerMemory` in one `Ref.modify`, `layerSql` in one conditional `UPDATE ... RETURNING`) behave identically, against SQLite and Postgres. `lastUsedStep` is an `INTEGER` — a step is `floor(epochSeconds / 30)`, under 2³¹ for two thousand years — so it decodes as a plain number on both dialects.

_Previous: [BEH-EA-237](28-two-factor.md#beh-ea-237-recovery-codes-are-hashed-single-use-shown-once-and-replaced-atomically) | Next: [BEH-EA-239](28-two-factor.md#beh-ea-239-one-failure-budget-per-account-locks-the-second-factor-and-every-outcome-is-audited)_

## BEH-EA-239: One failure budget per account locks the second factor, and every outcome is audited

```ts
RateLimiter.check(input): Effect<void, RateLimitExceeded>   // read half: never counts
SecondFactorLocked { retryAfterMillis }                     // 429
// events: auth.twoFactor.{enabled, disabled, verified, challengeFailed, recoveryCodeUsed, recoveryCodesRegenerated, locked}
```

```text
REQUIREMENT: Failed presentations of a TOTP code or a recovery code — for any
             purpose, on any challenge — MUST be charged to one per-account
             budget (`two_factor:fail:<userId>`, five per fifteen minutes by
             default) through the `RateLimiter` port. The budget MUST be
             checked before a code is evaluated, so a locked attempt fails
             `SecondFactorLocked` even for the correct code; MUST be spent
             only by failures; and MUST NOT be reset by success. The moment
             it is spent MUST publish `auth.twoFactor.locked`. Enrolment,
             disabling, use of a factor and every failure MUST publish their
             `auth.twoFactor.*` event, identifiers only.
```

`RateLimiter.check` is the read half of a limit that only failures spend: it fails with the same `RateLimitExceeded` `consume` would once the bucket holds `limit` or more, without counting the call. Together with the per-challenge attempts of BEH-EA-235 and the per-source limit it bounds guessing per sign-in, per account and per origin (ADR-EA-020 decision 3). Account erasure removes the secret and every recovery code; the data-subject export reports whether a factor exists and how many codes remain, never a secret or a hash.

_Previous: [BEH-EA-238](28-two-factor.md#beh-ea-238-a-totp-step-is-accepted-at-most-once-even-concurrently)_
