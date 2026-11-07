---
"@awthaq/admin": minor
"@awthaq/api": minor
"@awthaq/api-key": minor
"@awthaq/cli": minor
"@awthaq/client": minor
"@awthaq/core": minor
"@awthaq/device-authorization": minor
"@awthaq/jwt": minor
"@awthaq/magic-link": minor
"@awthaq/migrate-auth0": minor
"@awthaq/migrate-better-auth": minor
"@awthaq/migrate-firebase": minor
"@awthaq/next": minor
"@awthaq/oauth": minor
"@awthaq/organization": minor
"@awthaq/passkey": minor
"@awthaq/password": minor
"@awthaq/ports": minor
"@awthaq/qadi": minor
"@awthaq/react": minor
"@awthaq/roles": minor
"@awthaq/saml": minor
"@awthaq/scim": minor
"@awthaq/server": minor
"@awthaq/sql": minor
"@awthaq/test": minor
"@awthaq/two-factor": minor
"@awthaq/web": minor
"@awthaq/webhooks": minor
---

awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.

- **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
- **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
- **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
- **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
