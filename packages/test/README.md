# @awthaq/test

Test harness: `TestAuth.layer` runs a composed plugin tuple over an in-memory backend (memory `Users`/`Accounts`/`Sessions`/`Mailer`, a permissive `RateLimiter`, `SqlTransaction.layerNoop`, direct client addresses) so a wire-level test needs no database (BEH-EA-193–200). `examples/memory-server` runs the same machinery as a real listening server.

See [`spec/behaviors/25-testing-harness.md`](../../spec/behaviors/25-testing-harness.md).
