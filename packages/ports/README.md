# @awthaq/ports

Ports stratum (2): the capabilities a plugin *requires* and an application *provides* (ADR-EA-010) — a plugin depends on a port, never on a concrete implementation.

**Shipped** (each with a real layer, plus `layerNoop`/`layerMemory`-style variants where they make sense): `PasswordHasher` (argon2id/scrypt), `Mailer`, `WebAuthn` (over `@simplewebauthn/server`), `RateLimiter`, `ClientAddress`, `Encryption` and `KeyProvider`, `SqlTransaction` (`layerSql` over the ambient `SqlClient`, `layerNoop` for in-memory compositions), and `LegacySessionBridge`.

See [`spec/overview.md`](../../spec/overview.md) for the stratum table; no BEH-EA range is allocated to the ports stratum as a whole.
