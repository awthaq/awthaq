---
"@awthaq/ports": minor
"@awthaq/jwt": minor
"@awthaq/oauth": patch
---

`@awthaq/ports` adds `Jws`, the one compact-JWS verifier (ADR-EA-057): strict base64url decoding, a `crit` header refused, the five-algorithm table, RFC 7517 key selection and one refetch on an unknown `kid`.

`@awthaq/jwt` verifies through it (BEH-EA-293/298). `JwtCodec.verify` accepts an optional `refetch`, and `VerificationKey.alg` is optional. The lite verifier accepts JWKS keys without `alg` (RFC 7517 §4.4) and ignores keys with `use: "enc"` or a `key_ops` that excludes `verify`. Every verifier refuses a `crit` header (RFC 7515 §4.1.11).

`@awthaq/oauth`: `id_token` verification honours `key_ops` and refuses `crit` (BEH-EA-127); the internal `Jwt` module is removed (it was never exported).

Migration: no code changes. An issuer that sets `crit` on its tokens, or serves its signing key with `key_ops` that exclude `verify`, is now refused; fix the issuer's tokens or JWKS.
