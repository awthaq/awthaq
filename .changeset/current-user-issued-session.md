---
"@awthaq/core": minor
"@awthaq/ports": minor
"@awthaq/server": minor
"@awthaq/admin": minor
"@awthaq/passkey": minor
"@awthaq/password": minor
"@awthaq/two-factor": minor
"@awthaq/magic-link": minor
"@awthaq/device-authorization": minor
"@awthaq/organization": minor
"@awthaq/webhooks": minor
"@awthaq/saml": minor
"@awthaq/oauth": minor
"@awthaq/api-key": minor
---

`CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.

Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` -> `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.
