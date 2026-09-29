# @awthaq/ports

Ports stratum (2): the capabilities a plugin _requires_ and an application _provides_ (ADR-EA-010) — a plugin depends on a port, never on a concrete implementation.

**Shipped** (each with a real layer, plus `layerNoop`/`layerMemory`-style variants where they make sense): `PasswordHasher` (argon2id/scrypt), `Mailer`, `SmsSender` (the SMS capability, mirroring `Mailer`: `layerNoop`/`layerMemory`/`layerConsole` and a typed `SmsDeliveryFailed`; no provider ships, an SMS plugin or the application supplies one), `SmsSender` (the SMS capability, mirroring `Mailer`: `layerNoop`/`layerMemory`/`layerConsole` and a typed `SmsDeliveryFailed`; no provider ships, an SMS plugin or the application supplies one), `WebAuthn` (over `@simplewebauthn/server`), `RateLimiter` (`layer` over a store; `layerMemory` is the one-line real limiter for one process, `layerPermissive` is tests-only and warns), `ClientAddress`, `Encryption` and `KeyProvider`, `SqlTransaction` (`layerSql` over the ambient `SqlClient`, `layerNoop` for in-memory compositions), `LegacySessionBridge`, and `WebCrypto` (a `Crypto.Crypto` over `globalThis.crypto` for edge runtimes, where `NodeCrypto` does not exist).

See [`spec/overview.md`](../../spec/overview.md) for the stratum table; no BEH-EA range is allocated to the ports stratum as a whole.
