# Password

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-01 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is
Password is the credential-based sign-up/sign-in method: an email (or username) plus a secret the user chose, hashed at rest, with reset and email-verification flows layered on top of the shared verification-token infrastructure. It is planned as the first plugin in the MVP tuple and the one every other MVP plugin (`OAuth`, `Passkey`, `Roles`) is written against as a peer.

## Who asks for it
Every application class that isn't exclusively social- or passwordless-first still asks for password sign-in as a fallback, and it is the credential-recovery path for other methods (an account with only a passkey still needs a way back in if the authenticator is lost). `research/07-passwords-2fa.md` Q52 treats NIST SP 800-63B-4 and the OWASP Password Storage Cheat Sheet as the normative baseline this plugin would be judged against — no composition rules, no forced periodic rotation, mandatory breach blocklist checking, argon2id at rest.

## Status
| Property | Value |
|---|---|
| Status | Planned-MVP |
| Priority | P0 |
| Enabler(s) | E1 — Verification-token infrastructure |
| Breaking? | Purely additive — as the first plugin in the MVP tuple there is nothing earlier for it to break; it is the plugin later MVP/Phase-2 plugins (two-factor, magic link, email OTP) are themselves written not to break. |

## How it would be expressed
```ts
export class Password extends AuthPlugin.Service<Password, PasswordShape>()("password", {
  apiVersion: 1,
  contract: PasswordApi,                 // HttpApi<"auth", groups named "password" | "password.*">
  tables: ["password_account"],          // must start with "password_"
  migrations
}) {
  static readonly layer = AuthPlugin.layer(Password, {
    dependsOn: [Sessions, Users],        // typed requirement and migration order, one declaration
    make: Effect.gen(function*() {
      const hasher = yield* PasswordHasher     // port: required, never provided
      const config = yield* PasswordConfig     // Context.Reference with defaults
      const before = yield* BeforeSignUp       // hook point, as a service
      /* … */
      return Password.of({ signUp, signIn, requestReset, confirmReset })
    }),
    handlers: PasswordHandlers           // HttpApiBuilder.group(PasswordContract, "password", …)
  })
  static readonly config = (c: Partial<PasswordConfigShape>) => Layer.succeed(PasswordConfig, { ...defaults, ...c })
}
```
This is the plugin class reproduced from `archive/PRD.md` §9.1 verbatim, fence changed to `ts`. Its `PasswordHasher` port is where `research/07-passwords-2fa.md` Q52's recommendation would land: a `Layer` per algorithm (`Argon2IdHasher` default, `ScryptHasher`, `BcryptHasher`, `Pbkdf2Hasher`), all consuming and emitting PHC strings, with a `needsRehash(phc)` capability the plugin would call after every successful sign-in.

## Worked example
```ts
yield* client.password.requestReset({ payload: { email } })     // always 202, even for unknown emails
// mail arrives with token
yield* client.password.confirmReset({ payload: { token: Redacted.make(tokenFromMail), password: Redacted.make(newPassword) } })
// → other sessions revoked, token consumed in the same transaction
```
```ts
yield* client.password.signUp({ payload: { email, password } })          // sends verification mail
yield* client.verification.confirm({ params: { token: Redacted.make(t) } })
// replaying the same token: 410 TokenConsumed, and event "auth.token.replay" is published
```
```ts
password({ breachCheck: true, minLength: 12 })
// signUp with a pwned password → 422 WeakPassword { hints: ["appears in known breaches"] }
// HIBP unreachable → fail-open by default; password({ breachCheck: { onUnavailable: "reject" } }) to fail closed
```
Reproduced from `archive/design/usage-examples-v4.md` §6.1–6.3, fences changed to `ts`.

## What is missing
Everything: no `Password` class exists, no `PasswordHasher` port has an implementation, no `password_account` table or migration has been written, no `PasswordApi` contract exists, and no handler has ever run. The one-sentence gap for an MVP method is that literally nothing beyond this document's sketch has been built — the sketch itself is drawn faithfully from `archive/PRD.md` and `archive/design/usage-examples-v4.md`, but neither of those is code.

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
