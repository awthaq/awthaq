# @awthaq/jwt

> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.

Plugin (M7). Short-lived, self-contained, cryptographically signed JWTs representing an already-authenticated caller — EdDSA/ES256, JWKS with grace-period key rotation, an explicit mint endpoint and automatic mirroring onto every authenticated response, a standalone lite verifier for downstream services with zero footprint from the rest of this ecosystem, and general-purpose signing primitives.

**Planned first module:** not yet specified — see [`spec/models/08-jwt-bearer.md`](../../spec/models/08-jwt-bearer.md) (non-normative sketch) and `spec/roadmap.md` M7. Full design decisions and implementation tickets live at [`.scratch/jwt/`](../../.scratch/jwt/spec.md).

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.
