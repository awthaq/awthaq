# @awthaq/jwt

Short-lived, self-contained, signed JWTs for an already-authenticated caller: EdDSA/ES256 signing, a JWKS endpoint (`GET /jwt/jwks`) with grace-period key rotation (`KeyRing`, `SigningKeyRecords`), an explicit mint endpoint (`GET /jwt/token`), `POST /jwt/introspect`, a revocation store, and a standalone lite verifier for downstream services.

**Claims authenticate; they do not authorize.** A JWT proves who the caller is (and what the session looked like when it was minted). Authorization decisions come from qadi (`@awthaq/qadi`): role and permission claims are not the source of truth, so policy logic that used to read token claims (`auth.jwt()`-style RLS, Firebase custom claims) belongs in qadi policies over `AuthSubject`, resolved from the live session — not in the token.

See [`spec/models/08-jwt-bearer.md`](../../spec/models/08-jwt-bearer.md) and [`.scratch/jwt/spec.md`](../../.scratch/jwt/spec.md) for the full design.
