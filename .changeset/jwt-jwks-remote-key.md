---
"@awthaq/jwt": patch
---

`GET /jwt/jwks` now names `kid` and `alg` for a key registered with `KeyRing.registerRemoteKey` from a bare public JWK (BEH-EA-292). A KMS or HSM public JWK carries neither, so the served entry used to have no `kid` and no `alg`. Downstream verifiers, including `@awthaq/jwt/verify` and `@awthaq/next/edge`, can now verify tokens signed by a remote key. Only what is served changes; what `registerRemoteKey` stores is untouched.

Migration: none; a downstream verifier picks the corrected set up within its JWKS cache lifetime (`cacheTtl`, default 10 minutes).
