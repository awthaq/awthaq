# JWT and Bearer
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-08 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

## What it is
A plan for two related plugins: `Jwt`, which mints and verifies short-lived, self-contained tokens for handing an authenticated caller's identity to a downstream service that cannot consult the session store; and `Bearer`, which lets `Authorization: Bearer <token>` reach the same `Authentication` middleware and the same resolved principal that a session cookie would, for clients that cannot hold cookies. Neither is a replacement for the opaque, revocable session that `Sessions` (core) already owns — both are additive transports and token kinds layered on top of it.

## Who asks for it
Native mobile/desktop clients and machine-to-machine callers that cannot rely on cookie storage, and services downstream of the API that need to verify a caller's identity without a round trip to the session store. `research/04-sessions-tokens.md` Q60 frames the JWT plugin exactly this way, citing better-auth's own JWT plugin docs insisting the plugin "is not meant as a replacement for the session," and Q61 documents that both major TypeScript precedents (better-auth's bearer plugin, Lucia's transport model) route bearer credentials through the same resolution surface as cookies rather than a parallel one. Q61 also notes bearer tokens are a "documented downgrade from cookie sessions" per RFC 9700's attacker model, which is why this is planned as an explicit opt-in rather than a default.

## Status
| Property | Value |
|---|---|
| Status | Planned-Phase2 |
| Priority | P1 |
| Enabler(s) | E3 — Principal-type extension |
| Breaking? | Purely additive: `Authentication` (`archive/PRD.md` §10) already tries schemes in declaration order and returns the first success, so adding `bearer` to that record, or adding a `Jwt` plugin alongside it, extends the strategy chain without changing any type a Planned-MVP application would already depend on. |

## How it would be expressed
```ts
export class JwtConfig extends Context.Reference<{
  readonly alg: "EdDSA" | "ES256"
  readonly ttl: Duration.Duration
}>()("awthaq/jwt/Config", {
  defaultValue: () => ({ alg: "EdDSA", ttl: Duration.minutes(15) })
}) {}

export class Jwt extends AuthPlugin.Service<Jwt, {
  sign(principal: Principal): Effect.Effect<Redacted.Redacted<string>, JwtError>
  verify(token: Redacted.Redacted<string>): Effect.Effect<Principal, JwtError>
  jwks: Effect.Effect<JwksDocument>
}>()("jwt", {
  apiVersion: 1,
  contract: JwtApi,          // GET /auth/jwt/jwks
  tables: [],
  migrations: []
}) {
  static readonly config = (c: Partial<typeof JwtConfig.Service>) =>
    Layer.succeed(JwtConfig, { ...JwtConfig.defaultValue(), ...c })

  static readonly layer = AuthPlugin.layer(Jwt, {
    dependsOn: [Sessions],
    make: Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const config = yield* JwtConfig
      /* sign with kid, verify against an allowlisted alg + typ, expose /jwks */
      return Jwt.of({ sign, verify, jwks })
    }),
    handlers: JwtHandlers
  })
}

// a resource server that only needs bearer resolution, no full plugin:
export class Bearer extends AuthPlugin.Service<Bearer, {}>()("bearer", {
  apiVersion: 1, contract: BearerApi, tables: [], migrations: []
}) {
  static readonly layer = AuthPlugin.layer(Bearer, {
    dependsOn: [Sessions],
    make: Effect.succeed(Bearer.of({})),
    handlers: BearerHandlers
    // installs `bearer` into the Authentication strategy chain, after `cookie`
  })
}
```

## Worked example
No worked example drafted yet. `archive/design/usage-examples-v4.md` does not carry a section dedicated to the JWT or Bearer plugins as of this revision (its worked examples cover sessions, password, OAuth, passkeys, two-factor, authorization, client/React, and API keys, but not JWT/Bearer specifically); §11.3 sketches "Bearer mode for native clients" from the client side (`Auth.api(…, { csrf: false })` and `HttpClientRequest.bearerToken`) but that is client-side plumbing, not a `Jwt`/`Bearer` plugin worked example.

## What is missing
Everything: no `Jwt` or `Bearer` plugin class exists, no `JwtApi`/`BearerApi` contract, no signer, no JWKS endpoint, no key-rotation implementation, no test. `research/04-sessions-tokens.md` Q60 lays out a fairly detailed recommendation (EdDSA default, `kid`-tagged JWKS, strict `alg`/`typ`/`iss`/`aud` verification per RFC 8725, `sid` claim for optional live revocation checks, `jose` as the underlying library) and Q61 lays out the strategy-chain composition rules (first-match-wins, no silent fallthrough on a present-but-invalid credential, per-request memoization rather than cross-request caching) — but none of that has been turned into a contract, a service shape beyond this sketch, or code. A future `behaviors/` file will need to specify the claims mapping and revocation-check semantics normatively; none exists yet.

## Verification
None yet — no test exists.

_Related: [00 — Adoption Matrix](00-adoption-matrix.md)_
