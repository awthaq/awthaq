# Email OTP
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-33 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release (SOS-001, BCR-005, SOS-004, MLO-002; wayfinder ticket 05 §3), replacing [MOD-EA-005](../models/05-email-otp.md)'s non-normative sketch |
---

> Status: the `EmailOtp` plugin in `@awthaq/magic-link` and the `Verification` numeric-value and attempt-budget support it needs are implemented and tested (`packages/magic-link/test/EmailOtp.test.ts`, `packages/core/test/Verification.test.ts`). SMS is deferred ([ADR-EA-021](../decisions/021-sms-otp-restricted-plugin.md)).

## BEH-EA-271: A short numeric code is minted inside Verification and carries an attempt budget

```ts
verification.issue({
  identifier, ttl,
  format: { _tag: "Numeric", digits: 6 },
  maxAttempts: 3,                 // required by the type for a numeric value
})
```

```text
REQUIREMENT: `Verification.issue` MUST be able to mint a numeric value of 4 to
             10 digits itself, drawn uniformly (rejection sampling over
             `Crypto.randomBytes`), never accepting a caller-chosen string;
             the type MUST require an attempt budget (`maxAttempts`) for such
             a value. A wrong presentation against the live row MUST spend
             one attempt in the same atomic step, and the row MUST be burned
             at the budget so the right value no longer works. A value with
             no budget MUST behave exactly as before.
```

A six-digit code is a million possibilities, so its safety is layered: hashed at rest like every verification value, single-use, a short TTL, one live code per identifier, this attempt budget, and the rate limits of BEH-EA-272/273. `layerMemory` spends the attempt inside its `Ref.modify`; `layerSql` in one `UPDATE ... SET attempts = attempts + 1, consumedAt = CASE WHEN attempts + 1 >= maxAttempts ...` (migration 28).

_Next: [BEH-EA-272](33-email-otp.md#beh-ea-272-requesting-a-code-answers-202-for-every-address-inside-a-resend-window)_

## BEH-EA-272: Requesting a code answers 202 for every address, inside a resend window

```ts
EmailOtp.requestCode({ email, ip }): Effect<void, RateLimited>
```

```text
REQUIREMENT: `request` MUST answer `202` identically for a known address, an
             unknown one, one inside its resend window and one that was never
             mailed, with the lookup, the code and the mail in background
             work. It MUST be rate limited per source and per normalised
             address. An address MUST be mailed at most one code per
             `resendWindow` (default 60 s, `Verification.reserve`); a new code
             after the window MUST supersede the old one. With `allowSignUp`
             off, an unknown address MUST be answered like any other and not
             mailed.
```

The mail is the template `email-otp` with `{ code: Redacted, expiresAt }`. The window is what stops re-requesting from re-rolling the attempt budget or mail-bombing an inbox.

_Previous: [BEH-EA-271](33-email-otp.md#beh-ea-271-a-short-numeric-code-is-minted-inside-verification-and-carries-an-attempt-budget) | Next: [BEH-EA-273](33-email-otp.md#beh-ea-273-a-correct-code-signs-in-once-and-every-failure-is-the-one-invalidemailotp)_

## BEH-EA-273: A correct code signs in once, and every failure is the one InvalidEmailOtp

```ts
EmailOtp.verify({ email, code, ip }, { userAgent }): Effect<IssuedSession, InvalidEmailOtp | RateLimited | HookAborted | TwoFactorRequired | UserSuspended>
```

```text
REQUIREMENT: `verify` MUST be rate limited per source and per normalised
             address, MUST refuse a value that cannot be a code without
             touching the store, and MUST otherwise consume through
             `Verification.consume` under the per-code attempt budget. A
             wrong, expired, spent, burned or never-issued code MUST all be
             the one `InvalidEmailOtp` (401). A correct code MUST go through
             the shared channel step (BEH-EA-269): find or create the user
             (only with `allowSignUp`), mark the mailbox verified, run the
             sign-in gate, veto and MFA divert, and record `amr ["otp",
             "email"]`. A user with a confirmed second factor MUST be
             diverted to `TwoFactorRequired`.
```

The per-address limit (10 per 15 minutes) is the layer above the per-code budget: it bounds guesses at one address across many codes. `["otp", "email"]` is one factor's worth of assurance — both are possession of the mailbox — which `Assurance` (BEH-EA-258) reports as aal1.

_Previous: [BEH-EA-272](33-email-otp.md#beh-ea-272-requesting-a-code-answers-202-for-every-address-inside-a-resend-window) | Next: [BEH-EA-274](33-email-otp.md#beh-ea-274-the-code-is-a-verification-row-with-no-table-of-its-own-and-sms-is-a-later-restricted-plugin-over-it)_

## BEH-EA-274: The code is a Verification row with no table of its own, and SMS is a later restricted plugin over it

```text
REQUIREMENT: The plugin MUST declare no table: the code is a `Verification`
             row under the identifier `email-otp:<normalised address>`. An
             SMS channel MUST NOT be added to this plugin; it MUST be a
             separate, explicitly restricted plugin (ADR-EA-021) recording
             the method as `sms`, never `otp`.
```

`EmailOtp` is the channel-OTP substrate the SMS plugin would build on: the same code minting, budget, resend window and shared sign-in step, with the `Mailer` port replaced by an SMS gateway.

_Previous: [BEH-EA-273](33-email-otp.md#beh-ea-273-a-correct-code-signs-in-once-and-every-failure-is-the-one-invalidemailotp)_
