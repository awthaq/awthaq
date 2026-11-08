---
"@awthaq/client": minor
---

`bearerTransformClient` follows the session through response headers (ADR-EA-045): it stores `set-auth-token` from every response (every bearer sign-in, sign-up, password change, second factor, OAuth native exchange and device grant now sends it) and clears the store on `x-awthaq-session-ended` (sign-out, revoke-all, account deletion), which wins over a `set-auth-token` on the same response. `captureSessionToken` is removed.

Migration: unwrap `AuthClient.captureSessionToken(call)` to `call`. BEH-EA-175.
