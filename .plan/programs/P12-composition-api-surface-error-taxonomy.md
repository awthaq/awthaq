# P12 — Composition, API surface & error taxonomy

Phase 2 · 16 open issues to fix (1 high, 10 medium, 5 low) · 10 closed by validation · ~73h summed per-issue estimate (upper bound) · 1 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `httpapi-surface-consolidation` — (cross-slice) Fold core groups into Auth.make — canonical MW-002, slice 01 / One served HttpApi: core groups in Auth.make (ticket 26)

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md), [06-server-api](../slices/06-server-api.md) · ~12h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MW-002](../slices/01-core-sessions-users.md) | high | api | CONFIRMED | L | — | Implement ticket 26: composed api always carries core session/account groups, optional extraGroups for qadi's subject group, AuthHttp.coreHandlers convenience, and update every composition site. |

Closed by validation in this workstream: AVS-002 (DUPLICATE → MW-002), BE-006 (DUPLICATE → MW-002), EHA-004 (DUPLICATE → MW-002)

## `core-error-taxonomy` — Core error channels and tags

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~38h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EOTS-004](../slices/01-core-sessions-users.md) | medium | security | CONFIRMED | S | — | Stop interpolating identifiers into core error messages; carry them only as typed fields, and state the logging policy. |
| [ESS-008-effect-schema-specialist](../slices/01-core-sessions-users.md) | medium | correctness | CONFIRMED | M | — | Make internal (Data) and wire (Schema) error tags disjoint by construction and guard it with a test. |
| [GC-004](../slices/01-core-sessions-users.md) | medium | correctness | CONFIRMED | S | — | Give UsersRepository a targeted, Option-returning profile update and map a missing row to UserNotFound so layerSql honors the Shape's declared E like layerMemory. |
| [MA-004](../slices/01-core-sessions-users.md) | medium | architecture | CONFIRMED ⚖️ decision | XL | — | Adopt one infrastructure-error policy across core Shapes (recommended: typed StoreUnavailable), recorded as an ADR, and make every Shape's E channel authoritative for both layers. |

Closed by validation in this workstream: EEM-008 (DUPLICATE → ESS-008-effect-schema-specialist), EEM-006 (DUPLICATE → MA-004)

## `plugin-composition-soundness` — Auth.make static/runtime agreement and always-on slot conflicts

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~9h · depends on workstreams: `httpapi-surface-consolidation`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [JH-006](../slices/01-core-sessions-users.md) | medium | correctness | CONFIRMED | M | — | Make the static fold provably equal to the runtime fold by refusing out-of-order tuples in Validate<P> (dependency must be listed before its dependent). |
| [MA-005](../slices/01-core-sessions-users.md) | medium | architecture | CONFIRMED | M | — | Make slot-conflict checking always-on: Auth.make provides one SlotsRegistry per composition, and Slots.override requires the registry instead of looking it up optionally. |
| [ELC-006](../slices/01-core-sessions-users.md) | low | correctness | CONFIRMED | S | — | Refuse a second AuthPlugin.layer registration for the same class whose dependsOn ids differ from the first (a definition-time invariant violation). |

Closed by validation in this workstream: MA-007 (DUPLICATE → JH-006), TTE-006 (WONTFIX-CANDIDATE), TS-004-torin-sandall (DUPLICATE → MA-005), ELC-002 (DUPLICATE → MA-005), JH-005 (DUPLICATE → MA-005)

## `api-contract-tests` — Direct tests + precise schemas for the contract stratum

Slices: [06-server-api](../slices/06-server-api.md) · ~5h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ETVS-003](../slices/06-server-api.md) | medium | testing | CONFIRMED | M | — | Give @awthaq/api a direct test suite for its security-relevant contract. The placeholder-package half goes to the tooling slice. |
| [MW-008](../slices/06-server-api.md) | low | api | CONFIRMED | S | ETVS-003 | Make SessionDto's timestamps a real contract: Schema.DateTimeUtcFromString on the wire (an ISO string) that decodes to DateTime.Utc. |

## `canonical-starter-defaults` — Production-safe defaults in README/examples (rate limiter, edge crypto)

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ERAS-002](../slices/02-core-events-hooks.md) | medium | dx | CONFIRMED | S | — | Ship a tiny, dependency-free WebCrypto-backed Crypto layer in @awthaq/ports and document it for edge runtimes. |
| [RBS-007](../slices/02-core-events-hooks.md) | medium | dx | CONFIRMED | S | — | Ship a real in-memory limiter composite as the documented default, reserve permissive for tests, and warn when rules are registered under a permissive limiter. |

## `plugin-api-surface-conventions` — Consistent HTTP contract conventions

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AVS-005](../slices/04-oauth-provider-jwt.md) | medium | api | CONFIRMED | S | — | Make password follow the stated convention: move its two authenticated endpoints into a dotted `password.account` sub-group with group-level Authentication; keep paths. |
| [AVS-007](../slices/04-oauth-provider-jwt.md) | low | api | CONFIRMED | S | — | Make token minting `POST /jwt/token`. |

## `plugin-contract-docs` — dependsOn semantics

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [JH-007](../slices/10-passkey-admin.md) | low | api | CONFIRMED | S | — | Align BEH-EA-008 with the shipped convention and make the plugin-to-plugin data dependency explicit where it matters. |

## `plugin-port-boundary-enforcement` — Compile-time enforcement of 'plugins never provide ports'

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [JH-008](../slices/04-oauth-provider-jwt.md) | low | architecture | CONFIRMED | M | — | Enforce BEH-EA-020 at the type level: `Auth.make`'s `Validate<P>` rejects any plugin whose layer's ROut contains a port tag. |

