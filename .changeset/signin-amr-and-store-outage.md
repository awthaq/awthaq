---
"@awthaq/saml": patch
"@awthaq/password": patch
"@awthaq/passkey": patch
"@awthaq/oauth": patch
---

A SAML sign-in completed by a second factor now records `fed` in its `amr`, and a store outage during sign-in answers 503 `StoreUnavailable` instead of a 500 defect.

- `@awthaq/saml`: the `BeforeSessionIssue` divert context carries `amr: ["fed"]`, the same methods the session is issued with, so the two-factor plugin's final session records `["fed", "otp", "mfa"]` instead of `["otp", "mfa"]`. An outage reading the user or minting the session is the typed `StoreUnavailable`.
- `@awthaq/password`, `@awthaq/passkey`, `@awthaq/oauth`: the sign-in completions no longer `Effect.orDie` `Sessions.issue`, `Users.findById` or the credential-hash reads (ADR-EA-028); a `UserNotFound` / `AccountNotFound` impossible by construction still dies, on that tag only. No Shape or contract changes; the wire answer for an outage becomes 503.

Migration: sessions minted before the fix keep `["otp", "mfa"]` until they end, so a policy gating on `fed` should not assume old two-factor SAML sessions carry it. Clients that retried sign-in only on 500 should also retry 503, and alerting keyed on 500s for sign-in outages should add 503. BEH-EA-245, BEH-EA-261, BEH-EA-088.
