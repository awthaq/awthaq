# JWT
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-32 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-29): Initial release (implementing [MOD-EA-008](../models/08-jwt-bearer.md) as `@awthaq/jwt`; BDD-005) |
---

> `@awthaq/jwt` composes as `Auth.make([Jwt])` and serves two groups: `jwt` (`GET /jwt/jwks`, public) and `jwt.token` (`POST /jwt/token`, `POST /jwt/introspect`, behind `Api.Authentication`). It issues short-lived, self-contained tokens for an already-authenticated caller so other services can verify them without a session store ([MOD-EA-008](../models/08-jwt-bearer.md), [ADR-EA-017](../decisions/017-jwt-signing-key-rotation.md)). It is never a login: the session remains the source of truth, and the token is a delegation credential whose lifetime bounds how stale it can be.

## BEH-EA-266: A principal token is minted only for the authenticated caller, from nothing the caller supplies

```text
REQUIREMENT: `POST /jwt/token` MUST require an authenticated caller (`401`
             otherwise) and MUST accept no request body: the token's claims
             derive from the caller alone. The token MUST carry header
             `typ: "at+jwt"` and the current key's `kid` and `alg` (default
             `EdDSA`), and claims `iss` and `aud` from `JwtConfig`, `sub` (the
             user id), `sid` (the session id), `iat`, `exp = iat + ttl`
             (default 15 minutes) and a unique `jti`. Minting is an action, so
             only `POST` reaches it. No JWT MUST be attached to responses
             unless `mirrorResponses` opts in.
```

A caller-supplied claim would let a user mint whatever identity they like; taking none makes the endpoint incapable of that. Response mirroring is off by default because a response header is a log, proxy and APM capture surface.

_Previous: [BEH-EA-265](31-organization.md#beh-ea-265-organization-changes-are-published-as-events-and-a-hook-can-veto-them) | Next: [BEH-EA-267](32-jwt.md#beh-ea-267-the-jwks-is-public-holds-public-keys-only-and-tells-verifiers-how-long-to-cache-it)_

## BEH-EA-267: The JWKS is public, holds public keys only, and tells verifiers how long to cache it

```text
REQUIREMENT: `GET /jwt/jwks` MUST answer without authentication with a
             standard JWKS document whose keys each carry a `kid`, an `alg` and
             the public members of the key, and MUST NOT contain any private
             member (for example `d`) or any stored private-key field. It MUST
             carry `Cache-Control: public, max-age=<jwksMaxAge>` (default 10
             minutes) so a verifier knows how long it may reuse the set.
```

A JWKS is public by definition; the risk it carries is disclosure of the private half through the same serializer, which is why the absence of private members is a stated requirement rather than an implementation detail.

_Previous: [BEH-EA-266](32-jwt.md#beh-ea-266-a-principal-token-is-minted-only-for-the-authenticated-caller-from-nothing-the-caller-supplies) | Next: [BEH-EA-268](32-jwt.md#beh-ea-268-verification-is-strict-and-every-way-of-failing-it-looks-the-same)_

## BEH-EA-268: Verification is strict, and every way of failing it looks the same

```text
REQUIREMENT: A token MUST be accepted only if its signature verifies under
             the key its `kid` names, its header `alg` is in the verifier's
             allowlist and equals that key's own algorithm (never trusted from
             the token alone; `none` and a symmetric `HS*` MUST be refused), its
             `iss` and `aud` match the configuration, its `typ` is the expected
             class, it has not expired, and `nbf` and `iat` are not in the
             future. Every failure (a tampered payload or signature, an
             unknown `kid`, a wrong issuer or audience, an expired token) MUST
             collapse into one undifferentiated result that names no reason to
             the caller.
```

RFC 8725 (JWT best current practice) in one rule: the classic algorithm-confusion and `alg: none` attacks work only when a verifier believes the header, so the header is treated as a claim to be checked against the key, not as an instruction.

_Previous: [BEH-EA-267](32-jwt.md#beh-ea-267-the-jwks-is-public-holds-public-keys-only-and-tells-verifiers-how-long-to-cache-it) | Next: [BEH-EA-269](32-jwt.md#beh-ea-269-principal-tokens-and-general-purpose-tokens-are-different-classes-that-cannot-pass-for-one-another)_

## BEH-EA-269: Principal tokens and general-purpose tokens are different classes that cannot pass for one another

```text
REQUIREMENT: Tokens from `sign`, `POST /jwt/token` and response mirroring
             (`typ: "at+jwt"`, a mandatory `sub`) MUST be the only tokens
             `verify`, `verifyLive` and bearer acceptance (BEH-EA-272) take as a
             principal. A token from `signJWT` (`typ: "JWT"` unless overridden,
             may choose its audience per call, may lack a `sub`) MUST be accepted
             only by `verifyJWT`, and `verifyJWT` MUST refuse a principal token.
             A `signJWT` payload that carries a forged `sid` or `sub` MUST NOT
             thereby become a principal token. Introspection
             ([BEH-EA-270](32-jwt.md#beh-ea-270-introspection-answers-in-the-rfc-7662-shape-for-callers-who-are-themselves-authenticated))
             is the one exception: it reports on either class, because it
             answers whether the issuer still stands behind a token, not who a
             principal is.
```

Both classes are signed by the same key, so the class distinction lives entirely in the header `typ` the verifier insists on. Without it, a service that can mint a general-purpose token for itself could mint a token that another service reads as a user.

_Previous: [BEH-EA-268](32-jwt.md#beh-ea-268-verification-is-strict-and-every-way-of-failing-it-looks-the-same) | Next: [BEH-EA-270](32-jwt.md#beh-ea-270-introspection-answers-in-the-rfc-7662-shape-for-callers-who-are-themselves-authenticated)_

## BEH-EA-270: Introspection answers in the RFC 7662 shape, for callers who are themselves authenticated

```text
REQUIREMENT: `POST /jwt/introspect` MUST require an authenticated caller
             (`401` otherwise) and MUST answer `{ "active": true, "claims": ... }`
             for a token this issuer signed that verifies, has not been denylisted
             by its `jti`, and, when it names a session (`sid`), whose session is
             still live, and `{ "active": false }` with no other member for
             everything else: a malformed or foreign token, a bad signature, an
             expired token, a denylisted `jti` and a revoked or expired session
             MUST be indistinguishable.
```

Introspection exists so a downstream service can ask "is this still good, right now" where the token's own expiry is too coarse. A single `active: false` shape means the endpoint cannot be used to learn why a token stopped working, or to probe another issuer's tokens.

_Previous: [BEH-EA-269](32-jwt.md#beh-ea-269-principal-tokens-and-general-purpose-tokens-are-different-classes-that-cannot-pass-for-one-another) | Next: [BEH-EA-271](32-jwt.md#beh-ea-271-signing-keys-rotate-without-invalidating-live-tokens-and-an-emergency-rotation-invalidates-them-at-once)_

## BEH-EA-271: Signing keys rotate without invalidating live tokens, and an emergency rotation invalidates them at once

```text
REQUIREMENT: Keys MUST rotate every `keyRotationInterval` (default 90 days)
             or when `JwtConfig.algorithm` changes. A key rotated out MUST stay
             in the JWKS and keep verifying for `keyGracePeriod` (default 30
             days, and never shorter than `ttl`, a configuration that would let
             rotation invalidate unexpired tokens MUST fail to build), while new
             tokens MUST be signed with the new current key. An emergency
             rotation (`KeyRing.rotateNow({ gracePeriod: Duration.zero })`, or
             `KeyRing.revoke(kid)`) MUST retire the key at once: it MUST leave the
             JWKS and tokens it signed MUST stop verifying.
```

The grace period is what makes routine rotation invisible to callers; the emergency path is what makes a leaked key recoverable. They are the same mechanism with a different grace period, which is why one is a default and the other an explicit argument ([ADR-EA-017](../decisions/017-jwt-signing-key-rotation.md) is the operator runbook).

_Previous: [BEH-EA-270](32-jwt.md#beh-ea-270-introspection-answers-in-the-rfc-7662-shape-for-callers-who-are-themselves-authenticated) | Next: [BEH-EA-272](32-jwt.md#beh-ea-272-a-minted-token-is-not-an-origin-credential-unless-the-deployment-opts-in-and-a-downstream-only-token-never-is)_

## BEH-EA-272: A minted token is not an origin credential unless the deployment opts in, and a downstream-only token never is

```text
REQUIREMENT: By default (`acceptAsBearer: false`) a principal token
             presented as `Authorization: Bearer` to the API that issued it MUST
             be refused `401`, and only an opaque session token MUST authenticate
             there. With `acceptAsBearer: true` a principal token MUST
             authenticate statelessly (signature, `iss`, `aud`, `exp`, `typ`; no
             session-store lookup), so a revoked session's token keeps working
             until its own `exp`. A token whose `aud` names another service
             (`signJWT(payload, { audience })`) MUST NOT authenticate at the
             origin in either mode.
```

Installing the plugin mints a delegation token meant for other services; quietly making the same token a valid credential here would widen what a leaked or propagated token can do, so re-entry is a deliberate choice with a stated revocation lag (at most `ttl`).

_Previous: [BEH-EA-271](32-jwt.md#beh-ea-271-signing-keys-rotate-without-invalidating-live-tokens-and-an-emergency-rotation-invalidates-them-at-once) | Next: [BEH-EA-273](32-jwt.md#beh-ea-273-a-downstream-service-can-verify-tokens-from-the-jwks-alone-and-cannot-check-revocation)_

## BEH-EA-273: A downstream service can verify tokens from the JWKS alone, and cannot check revocation

```text
REQUIREMENT: `Verify.makeVerifier({ jwksUrl, issuer, audience, algorithms })`
             MUST verify a principal token using only the published JWKS and
             the same strict rules as [BEH-EA-268](32-jwt.md#beh-ea-268-verification-is-strict-and-every-way-of-failing-it-looks-the-same),
             without any other awthaq footprint. It MUST fetch the JWKS lazily,
             reuse it for `cacheTtl`, and refetch at most once per
             `minRefetchInterval` when a token names an unknown `kid`, so garbage
             kids cannot become a fetch per request. It MUST NOT claim to know
             about revocation.
```

The lite path trades freshness for independence: a service with no session store can still trust the token, for as long as the token itself is valid. Anything needing freshness calls introspection.

_Previous: [BEH-EA-272](32-jwt.md#beh-ea-272-a-minted-token-is-not-an-origin-credential-unless-the-deployment-opts-in-and-a-downstream-only-token-never-is)_
