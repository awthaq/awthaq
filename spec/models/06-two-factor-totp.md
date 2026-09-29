# Two-Factor (TOTP)
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-06 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is

A second authentication factor layered on top of Password (or any first
factor): after the first factor succeeds, the plugin diverts sign-in to a
challenge state instead of issuing a session, and only a valid time-based
one-time code (RFC 6238 TOTP) or a hashed, single-use recovery code completes
sign-in. Nothing described here exists yet — awthaq is pre-implementation.

## Who asks for it

`research/07-passwords-2fa.md` Q58 frames this as one of the best-evidenced
methods in the corpus: RFC 6238/4226 fix the algorithm (SHA-1 HMAC, 30 s step,
±1 step verification window, 160-bit secret), and better-auth's shipped
`twoFactor` plugin is cited as the concrete pre-auth state pattern (no session
minted until the second factor succeeds; a signed, HttpOnly 10-minute
challenge cookie binds the challenge to the browser; recovery codes are 10 ×
10 characters, hashed, deleted on use). The plausible adopter is any
application whose users hold account-takeover-sensitive data and expect an
authenticator-app second factor as table stakes.

## Status

| Property | Value |
|---|---|
| Status | Shipped (`@awthaq/two-factor`; normative behaviors in [behaviors/31-two-factor.md](../behaviors/31-two-factor.md), state decisions in [ADR-EA-020](../decisions/020-two-factor-state.md)) |
| Priority | P1 |
| Enabler(s) | E4 — Hook-point step-up/divert wiring |
| Breaking? | Purely additive to Password as planned — `archive/PRD.md` §9.3 already describes "divert" as a hook-point kind "used by two-factor," so the MVP hook-point design anticipates this method; no MVP plugin needs to be reopened. |

## How it would be expressed

`archive/PRD.md` §9.3 already names the mechanism this plugin depends on:
hook points that can "divert" sign-in to "a typed alternative outcome." A
sketch consistent with that and with `archive/design/plugins-as-layers.md`:

```ts
export class TwoFactor extends AuthPlugin.Service<TwoFactor, TwoFactorShape>()("twoFactor", {
  apiVersion: 1,
  contract: TwoFactorApi,
  tables: ["two_factor_secret", "two_factor_recovery_code"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(TwoFactor, {
    dependsOn: [Sessions, Users],
    make: Effect.gen(function*() {
      const beforeSessionIssue = yield* BeforeSessionIssue   // hook point, divert kind
      const config = yield* TwoFactorConfig                  // issuer, step, digits, window
      /* enable/confirm mint a secret + recovery codes;
         beforeSessionIssue taps in and diverts to a TwoFactorRequired outcome
         until /two-factor/verify or /two-factor/verify-recovery succeeds */
      return TwoFactor.of({ enable, confirm, verify, verifyRecovery })
    }),
    handlers: TwoFactorHandlers
  })
  static readonly config = (c: Partial<TwoFactorConfigShape>) => Layer.succeed(TwoFactorConfig, { ...defaults, ...c })
}
```

## Worked example

Adapted from `archive/design/usage-examples-v4.md` §9 ("Two-factor"), fence
changed from the source's `ts` to this document's required `ts` (no change
needed — the source already used a `ts` fence):

```ts
const plugins = [password(), twoFactor({ issuer: "Example" })] as const

// sign-in for a user with 2FA enabled: the password plugin is untouched; two-factor taps the divert point
yield* client.password.signIn({ payload }).pipe(
  Effect.catchTag("TwoFactorRequired", ({ challengeId }) =>
    client.twoFactor.verify({ payload: { challengeId, code: Redacted.make(totp) } }))   // SessionView
)

// enable
const { secret, otpauthUrl, recoveryCodes } = yield* client.twoFactor.enable({ payload: { password } })
yield* client.twoFactor.confirm({ payload: { code: Redacted.make(firstCode) } })
```

Recovery codes are hashed and single-use; `/two-factor/verify` is rate limited
to three attempts per ten seconds by a rule the plugin ships (per the source
cookbook — that rate-limit rule is itself unimplemented, described only in
the sketch).

## What is missing

Everything: no `BeforeSessionIssue` hook point exists to tap into, no
contract, no handler, no persistence for secrets or recovery codes, no test.
Undecided design questions carried over from `research/07-passwords-2fa.md`
Q58 include: TOTP secret encryption at rest, the exact challenge-cookie TTL
(better-auth's 10-minute default is cited, not adopted), whether failed
attempts across TOTP/OTP/recovery-code share one per-account counter, and
whether SMS OTP ships as a separate, explicitly "restricted" plugin per NIST
800-63B-4 guidance. None of this has been decided beyond the row in
`archive/PRD.md` §17.

## Verification

None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
