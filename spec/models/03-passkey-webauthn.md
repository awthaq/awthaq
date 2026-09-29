# Passkey and WebAuthn

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-03 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Status vocabulary aligned with the adoption matrix; corrected the challenge storage and TTL misquote (a dedicated `passkey_challenge` table, five minutes, BEH-EA-132) (HSK-009, CCR-EA-006) |
---

## What it is
Passkey is WebAuthn-based, phishing-resistant sign-in: the browser mints a public-key credential via the platform authenticator, awthaq stores the public key and verifies signed challenges, with no shared secret ever transmitted. It ships as `@awthaq/passkey`, listed alongside `Password`, `OAuth` and `Roles` in `archive/PRD.md` §9.4's example tuple.

## Who asks for it
`research/06-webauthn-passkeys.md`'s TL;DR frames 2026 as the point where this stopped being a niche ask: "WebAuthn Level 3 is a W3C Recommendation (2026-08-25) — the 'passkey release'," and cites a Corbado 2026 benchmark that conditional-UI-only deployments plateau around 20% passkey adoption, "+manual prompts → ~40%, full best practice → 60–80%" — meaning any consumer application aiming for passwordless adoption at scale is the concrete class asking for this, and the win depends on doing autofill/conditional-create correctly, not just exposing the two ceremony endpoints.

## Status
| Property | Value |
|---|---|
| Status | Shipped-Unpublished (`packages/passkey`) |
| Priority | P1 |
| Enabler(s) | E2 — External provider/port abstraction |
| Breaking? | Additive on top of core `Sessions`/`Users` and the `Accounts` invariant that the last credential cannot be unlinked (`archive/PRD.md` §13) — a passkey is simply another credential kind under that same rule, nothing earlier needs to change. |

## How it is expressed
No plugin-class sketch for Passkey is drafted in `archive/PRD.md` beyond naming it in the plugin tuple; the plausible shape, consistent with the `AuthPlugin.Service` pattern in `archive/design/plugins-as-layers.md` and the `Password` class in `archive/PRD.md` §9.1, is a plugin depending on `Sessions`/`Users` and a required `WebAuthn` port (named explicitly in `archive/PRD.md` §11, default `layerSimpleWebAuthn`):
```ts
export class Passkey extends AuthPlugin.Service<Passkey, PasskeyShape>()("passkey", {
  apiVersion: 1,
  contract: PasskeyApi,
  tables: ["passkey_credential"],
  migrations
}) {
  static readonly layer = AuthPlugin.layer(Passkey, {
    dependsOn: [Sessions, Users],
    make: Effect.gen(function*() {
      const webauthn = yield* WebAuthn          // port: required, never provided; default layerSimpleWebAuthn
      const challenges = yield* ChallengeStore  // single-use, short-TTL ceremony state
      /* … */
      return Passkey.of({ registerOptions, registerVerify, authenticateOptions, authenticateVerify, list, remove })
    }),
    handlers: PasskeyHandlers
  })
}
```
This sketch is speculative — it is not quoted from `archive/PRD.md` — but it is consistent with `research/06-webauthn-passkeys.md`'s recommendation that "server-side ceremony state should be an injected awthaq capability (`ChallengeStore`)" and its endorsement of `@simplewebauthn/server` "behind an Effect service," which is what the `WebAuthn` port in `archive/PRD.md` §11 already names.

## Worked example
```ts
// browser
const options = yield* client.passkey.registerOptions()                       // WebAuthn PublicKeyCredentialCreationOptions
const credential = await navigator.credentials.create({ publicKey: options })
yield* client.passkey.registerVerify({ payload: { credential } })

const request = yield* client.passkey.authenticateOptions()
const assertion = await navigator.credentials.get({ publicKey: request })
const view = yield* client.passkey.authenticateVerify({ payload: { assertion } })   // SessionView

yield* client.passkey.list()
yield* client.passkey.remove({ params: { id } })      // refuses to remove the last credential when no other method exists
```
Reproduced from `archive/design/usage-examples-v4.md` §8, fence changed to `ts`. The archive cookbook's sentence about challenge storage and lifetime is superseded: as built, challenges are single-use rows in a dedicated `passkey_challenge` table (`ChallengeStore.ts`), not verification rows, with a fixed five-minute TTL that BEH-EA-132 fixes and nothing configures; attestation defaults to `none` (BEH-EA-135), matching `research/06-webauthn-passkeys.md`'s recommendation.

## What is missing
The plugin (`Passkey`, `PasskeyApi`, `ChallengeStore`, `PasskeyCredentials`, `PasskeyUserHandles`), the `WebAuthn` port with `layerSimpleWebAuthn`, the `passkey_credential`/`passkey_challenge`/`passkey_user_handle` migrations, challenge single-use/replay handling and the origin-validation pitfalls `research/06-webauthn-passkeys.md` names (CVE-2026-30964, YSA-2026-02) are implemented. What remains, and is documented in `packages/passkey/README.md` under "Limits":

- FIDO Metadata Service (MDS3) attestation validation — `attestationPolicy` is an AAGUID allow-list, not MDS (BEH-EA-135).
- Passkey-first sign-up: a passkey is only ever added to an existing, freshly-authenticated account.
- Self-service recovery when a passkey is a user's only credential: pair passkeys with a second credential type (see the README's "Recovery").
- Credentials registered before the stable user handle shipped carry a random stored handle that no authenticator holds, so their discoverable assertions fail the `userHandle` cross-check; those users re-register.

## Verification
`packages/passkey/test/*` (ceremony policy, counter anomaly, enumeration safety, attestation policy, user handle, and `PasskeyRealPort.test.ts` over the real `layerSimpleWebAuthn`), `packages/ports/test/WebAuthn.test.ts`, `packages/client/test/PasskeyClient.test.ts`, and the `17-passkey.feature` scenarios (`features/`); see `spec/traceability.md` for the per-file map.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
