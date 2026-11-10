---
"@awthaq/jwt": patch
---

A token whose header, payload or signature segment is not base64url is now refused like every other bad token (BEH-EA-293). `JwtCodec.verify` decodes segments with a strict `Base64Url.decode` that returns a `Result`, so malformed input is a typed `JwtInvalidError`, never a defect.

- `POST /jwt/introspect` answers `{"active":false}` instead of 500.
- An opted-in bearer request answers 401 instead of 500.
- `verifySessionJwt` (`@awthaq/next/edge`) resolves `undefined` instead of rejecting.

Migration: none.
