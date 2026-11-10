# ADR-EA-057: A Compact JWS Is Verified by One Module of `@awthaq/ports`, Under RFC 7515/7517 Key Selection

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-057 |
> | Revision | 1.0 |
> | Effective Date | 2026-11-10 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-11-10): Initial release (architecture plan 38 tickets 04–06) |

---

## Context

Two copies of JWS verification (the OIDC `id_token` in `@awthaq/oauth`; the jwt codec behind the plugin and the edge-safe lite verifier in `@awthaq/jwt`) drifted. One died on malformed segments, one refused `alg`-less JWKS keys, one used `key_ops`-restricted keys, and neither refused `crit`.

## Decision

1. `Jws` in `@awthaq/ports` owns compact-JWS decoding (strict base64url, never a defect), `crit` refusal, the five-algorithm table (RS256, PS256, ES256, ES384, EdDSA; `none` and HS* unrepresentable), key selection, signature verification over WebCrypto with public members only, one refetch on an unknown `kid` through a caller-supplied `KeySource`, and exp/nbf/iat judgement with a caller-supplied leeway.
2. Key selection: candidates are structurally valid RSA/EC/OKP keys with `use` absent or `sig` and `key_ops` absent or including `verify`. When the token names a `kid`, only exact matches. A usable key has `alg` absent or equal to the header `alg`, and a `kty`/`crv` that fits it. The header `alg` must be in the caller's allowlist. A known `kid` with no usable key is refused without a refetch.
3. Callers own claim policy and key sources. The jwt codec requires `kid` and the expected `typ`, and keeps integer NumericDates (GC-002). OIDC keeps `kid` optional and checks `iss`, `aud`/`azp`, `nonce`, `sub` and `maxIdTokenAge`. Each caller fetches and caches its keys and classifies fetch failures itself. No JWKS-fetch port is introduced.
4. `@awthaq/jwt/verify` remains free of `@awthaq/core`/`server`/`sql`/`api`. `Jws` imports only `effect` and `node:crypto` types.
5. No wire error tag changes. `Jws/Rejected` is internal, and each caller maps it to its existing error.

## Alternatives considered

- **A subpath of `@awthaq/jwt`.** Rejected: `@awthaq/oauth` would depend on the jwt plugin package for a primitive.
- **A new package.** Rejected: a package for one module of pure functions over WebCrypto; `@awthaq/ports` already holds the edge-safe shared helpers (`RefreshingCache`).
- **A JWKS-fetch port.** Rejected: the two callers differ in caching, failure classification and trust (a configured issuer URL versus a discovery document), so a shared fetcher would carry both policies.

## Consequences

One file holds every RFC 7515/7517 verification rule. ADR-EA-017 decision 6 is unchanged for ring keys, which always declare `alg`. A foreign key without `alg` is limited by the allowlist and its key type. A token with a `crit` header, or a key restricted away from `verify`, is refused everywhere.

## Implementation

- `packages/ports/src/Jws.ts`, exported from the `@awthaq/ports` root as `Jws`.
- Callers: `IdToken.ts` in `@awthaq/oauth`, `JwtCodec.ts` (and through it the plugin's `Jwt.ts`) and the lite verifier `verify.ts` in `@awthaq/jwt`.
- Tests: the vector table `packages/ports/test/jwsVectors.ts`, `packages/ports/test/Jws.test.ts`, and the differential runners `packages/jwt/test/JwsDifferential.test.ts` and `packages/oauth/test/JwsDifferential.test.ts`.

## Open points (defaults taken)

- Q1: an RSA key with no `alg` may verify any allowlisted RSA algorithm (the allowlist is the pin).
- Q2: a `kid`-less token (OIDC only) uses the first usable candidate.
- Q3: `Jws` is exported from the `@awthaq/ports` root, not a subpath.
