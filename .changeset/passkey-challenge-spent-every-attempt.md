---
"@awthaq/passkey": patch
---

`register/verify` and `reauthenticate/verify` now spend the ceremony's challenge before checking the origin, and every ceremony (sign-in included) spends it when the browser's `clientDataJSON` cannot be read, so no refused verification attempt leaves its challenge usable (BEH-EA-132). A missing or spent challenge now outranks an origin refusal at registration and step-up (`PasskeyChallengeInvalid`, as sign-in already answered).

Migration: a client that presented the same challenge again after `PasskeyOriginMismatch` or `PasskeyRpIdMismatch` must request fresh options first (`@awthaq/client`'s `passkeyClient` never retries). Requests refused before verification (rate-limited, stale session, bad token-delivery header) are unaffected: their challenge stays usable.
