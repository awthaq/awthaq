# P06 — Rate limiting & abuse resistance

Phase 1 · 10 open issues to fix (1 high, 7 medium, 2 low) · 3 closed by validation · ~39h summed per-issue estimate (upper bound) · 0 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `ratelimit-memory-eviction` — Bound the in-memory stores (rate limiter + core memory twins)

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~8h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [RBS-003](../slices/09-ports-apikey-cli.md) | high | security | CONFIRMED | M | — | Bound layerStoreMemory: periodic expiry sweep + hard cap, with an observable size. |
| [TMS-004](../slices/09-ports-apikey-cli.md) | medium | security | CONFIRMED | M | RBS-003 | Prune expired rows in the core memory layers (Sessions, Verification). |

Closed by validation in this workstream: ERS-004 (DUPLICATE → RBS-003)

## `ratelimit-signal-and-escalation` — Rate-limit breach signal, error naming and opt-in escalation

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~9h · depends on workstreams: `ratelimit-distributed-store`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EOTS-007](../slices/09-ports-apikey-cli.md) | medium | security | CONFIRMED | M | RBS-010 | Emit an auth.rateLimit.exceeded event, a warning log and a counter on every breach, via one shared helper. |
| [RBS-009](../slices/09-ports-apikey-cli.md) | low | security | CONFIRMED | M | RBS-004, EOTS-007 | Opt-in per-rule exponential escalation. |
| [RBS-010](../slices/09-ports-apikey-cli.md) | low | api | CONFIRMED | S | — | Rename the port error and drop its raw key. |

## `server-request-limits` — Default request-body cap with 413 on the serving path

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [NHS-004](../slices/13-repo-features-tooling.md) | medium | security | CONFIRMED | M | — | Ship a default request-body cap in @awthaq/server: a global HttpRouter middleware layer that provides `HttpIncomingMessage.MaxBodySize` (configurable, default ~256 KiB) and maps the resulting parse failure to a typed 413, and wire it into the canonical composition. |

## `ratelimit-distributed-store` — Store error channel, fail-open, SQL store, enforcing quickstart

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~14h · depends on workstreams: `ratelimit-memory-eviction`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AR-005](../slices/09-ports-apikey-cli.md) | medium | architecture | PARTIAL | S | RBS-004, NHS-005 | Close when RBS-004 and NHS-005 land; no additional code. |
| [NHS-005](../slices/09-ports-apikey-cli.md) | medium | dx | CONFIRMED | S | RBS-003, RBS-004 | Make the quickstart enforce limits and flag the permissive layer. |
| [RBS-004](../slices/09-ports-apikey-cli.md) | medium | architecture | CONFIRMED | L | RBS-003 | Give the store an error channel, implement BEH-EA-105's fail-open default, and ship a SQL-backed store. |

Closed by validation in this workstream: CSD-007 (DUPLICATE → RBS-004)

## `cors-posture` — Documented default-deny CORS + blessed preset sharing CSRF origins

Slices: [06-server-api](../slices/06-server-api.md) · ~4h · depends on workstreams: `csrf-hardening`, `wire-constant-single-source`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AGA-002](../slices/06-server-api.md) | medium | architecture | CONFIRMED | M | CSS-007, MNA-008 | Document the default-deny CORS posture, and ship a blessed CORS preset whose origin allowlist is the same value as CsrfConfig.allowedOrigins. |

Closed by validation in this workstream: CDS-008 (DUPLICATE → AGA-002)

