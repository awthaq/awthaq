# @awthaq/admin

> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.

Plugin (M7). Impersonation: off by default, admin-gated, reason required, hard expiry, dual identity, fully audited (NFR-EA-007).

**Planned first module:** not yet specified — see spec/models/15-admin-impersonation.md (non-normative adoption record) and spec/roadmap.md M7

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.

## Impersonation authority and the JWT `act` claim

Impersonation grants the target's full authority; `actingAs` on the principal is a static attribute, not a scoped delegation. Restricting what an impersonating admin may do is a qadi policy over `subject.attributes.actingAs` (BEH-EA-142). A JWT minted from an impersonation session (`@awthaq/jwt`) carries `sub` = the target and an RFC 8693 `act` claim `{ "sub": "<admin id>", "awthaq_actor_type": "<principal type>" }` identifying who is really acting.
