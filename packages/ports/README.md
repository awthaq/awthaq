# @awthaq/ports

> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.

Ports stratum (2). PasswordHasher, Mailer, WebAuthn — each with layer, layerNoop, layerMemory variants. A plugin depends on a port, never a concrete implementation (capability over implementation).

**Planned first module:** PasswordHasher.ts / Mailer.ts / WebAuthn.ts (spec/overview.md's Ports stratum table; no BEH-EA range allocated yet)

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.
