# Email OTP
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-05 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is

A passwordless sign-in method that emails a short numeric code instead of a
clickable link: the caller submits an email address, receives a code, and
types it back into the application to complete sign-in. It is the same
email-possession proof as Magic Link, delivered as a code a user can type on a
second device rather than a link they must click on the device that received
it. Nothing described here exists yet — awthaq is pre-implementation.

## Who asks for it

`archive/PRD.md` §17 names `EmailOtp` as a Phase 2 official plugin alongside
Magic Link, but gives no worked example or dedicated design section — it is
speculative at this stage, included because it is the natural companion to
Magic Link for applications whose users are more likely to retype a code than
follow a link (for example, cases where the email client opens on a different
device than the one signing in). `research/07-passwords-2fa.md` Q57 treats
email OTP as a variant of the same click-to-session pattern and recommends it
share infrastructure with Magic Link rather than be designed independently.

## Status

| Property | Value |
|---|---|
| Status | Planned-Phase2 |
| Priority | P2 |
| Enabler(s) | E1 — Verification-token infrastructure |
| Breaking? | Purely additive — it would reuse the same shared verification-token table as Magic Link and Password reset/verify; no existing MVP plugin needs to change. |

## How it would be expressed

A plausible sketch, consistent with the `AuthPlugin.Service` pattern and
sharing the `Verification` service with Magic Link:

```ts
export class EmailOtp extends AuthPlugin.Service<EmailOtp, EmailOtpShape>()("emailOtp", {
  apiVersion: 1,
  contract: EmailOtpApi,
  tables: ["email_otp_request"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(EmailOtp, {
    dependsOn: [Sessions, Users, Verification],
    make: Effect.gen(function*() {
      const verification = yield* Verification
      const mailer = yield* Mailer
      const config = yield* EmailOtpConfig   // digits, ttl, max attempts
      /* requestCode(email) -> uniform response; verify(email, code) -> session */
      return EmailOtp.of({ requestCode, verify })
    }),
    handlers: EmailOtpHandlers
  })
  static readonly config = (c: Partial<EmailOtpConfigShape>) => Layer.succeed(EmailOtpConfig, { ...defaults, ...c })
}
```

## Worked example

No worked example drafted yet. `archive/design/usage-examples-v4.md`'s table
of contents has no OTP-specific section (§6 password, §7 OAuth, §8 passkeys,
§9 two-factor, §20 API keys are the closest neighbors), and `archive/PRD.md`
§17 lists Email OTP only as a row in the Phase 2 plugin table with no
accompanying sketch.

## What is missing

No design beyond the §17 row and the shared E1 enabler exists yet. There is no
contract, no decision on digit count or TTL (`research/07-passwords-2fa.md`
recommends 6 digits, 5 minutes, and a maximum of 3 failed verifications per
token, matching NIST 800-63B-4's OOB constraints, but awthaq has not
adopted any of that as a committed default), and no decision on whether Email
OTP and Magic Link ship as one plugin with two verification modes or as two
separate plugins sharing one enabler. That question is itself unresolved and
would need to be settled before implementation begins.

## Verification

None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
