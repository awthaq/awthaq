# Magic Link

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-04 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is
Magic Link is passwordless sign-in by email possession: the user submits their email, receives a single-use link, and clicking it authenticates and redirects them straight into a session — no password, no code to type. `archive/PRD.md` §17 lists it as a Phase-2 official plugin.

## Who asks for it
`research/04-sessions-tokens.md`'s domain owner treats magic link as sharing the same purpose-scoped verification-token table as password reset and email verification (see its note that rotation/lineage concerns are a separate topic from "this table," implying the shared table is already assumed for one-shot tokens). `research/07-passwords-2fa.md` Q57 is the more direct source: NIST 63B-4 explicitly carves out an exception that keeps magic-link legitimate ("Confirmation codes that are sent to validate email addresses… are not authentication processes") even though it separately says "email SHALL NOT be used for out-of-band authentication" — and cites better-auth's magic-link plugin as the reference implementation this design would be checked against.

## Status
| Property | Value |
|---|---|
| Status | Planned-Phase2 |
| Priority | P2 |
| Enabler(s) | E1 — Verification-token infrastructure |
| Breaking? | Purely additive — it is a second consumer of the same verification-token table `Password`'s reset/verify flows already require, so nothing about `Password` or core `Verification` needs to change shape to add it. |

## How it would be expressed
No plugin-class sketch for Magic Link exists in `archive/PRD.md` beyond its one-line mention in the §17 phase table. A plausible shape, modeled on the `Password` class in `archive/PRD.md` §9.1 and consistent with the shared-table design `research/07-passwords-2fa.md` Q57 recommends:
```ts
export class MagicLink extends AuthPlugin.Service<MagicLink, MagicLinkShape>()("magicLink", {
  apiVersion: 1,
  contract: MagicLinkApi,
  tables: [],                          // reuses core Verification's table, contributes none of its own
  migrations
}) {
  static readonly layer = AuthPlugin.layer(MagicLink, {
    dependsOn: [Sessions, Users, Verification],
    make: Effect.gen(function*() {
      const mailer = yield* Mailer                // port: required, never provided
      const config = yield* MagicLinkConfig        // ttl, disableSignUp, linkPolicy
      /* … */
      return MagicLink.of({ requestLink, consumeLink })
    }),
    handlers: MagicLinkHandlers
  })
  static readonly config = (c: Partial<MagicLinkConfigShape>) => Layer.succeed(MagicLinkConfig, { ...defaults, ...c })
}
```
`research/07-passwords-2fa.md` Q57's recommended defaults for this config — a 10-minute TTL, atomic single-attempt consume, and a uniform 200-response regardless of whether the address exists — are the concrete parameters this sketch's `MagicLinkConfig` would carry, along with an explicit `linkPolicy` option so consuming a link against a pre-existing unconfirmed account does not silently clear an existing password (the same research file flags better-auth's default behavior of doing exactly that as "surprising... make it an explicit option").

## Worked example
No worked example drafted yet.

## What is missing
No implementation exists yet, and unlike the three MVP methods, no cookbook worked example exists in `archive/design/usage-examples-v4.md` or `archive/design/usage-qadi.md` to anchor "how it would be expressed" against — the sketch above is inferred from the `Password` plugin's shape and `research/07-passwords-2fa.md`'s recommendations, not drawn from a PRD or cookbook source for Magic Link specifically. A future `behaviors/*.md` file would need to specify the enumeration-safety and atomic-consume requirements normatively before this is buildable.

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
