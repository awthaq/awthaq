# P05 — Admin & impersonation

Phase 1 · 12 open issues to fix (3 high, 7 medium, 1 low, 1 info) · 7 closed by validation · ~91h summed per-issue estimate (upper bound) · 3 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `admin-impersonation-gate-target` — Target-aware, tenant-scoped impersonation gate

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~9h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [IDS-001](../slices/10-passkey-admin.md) | high | security | CONFIRMED | M | — | Make the impersonation gate target-aware: `canImpersonate({ admin, target })` for impersonate, and episode-aware predicates for forceStop/list, all fail-closed. |
| [IDS-002](../slices/10-passkey-admin.md) | medium | security | CONFIRMED | M | IDS-001, DRS-001 | Stamp the ambient tenant (ticket 18's TenantContext) on every episode and scope list/forceStop to it; cross-tenant access only through the superadmin predicate from ticket 19. |
| [IDS-003](../slices/10-passkey-admin.md) | medium | correctness | CONFIRMED | S | IDS-001 | Refuse impersonation of a nonexistent target with a typed 404, after the gate, and tighten the path-param schemas. |

Closed by validation in this workstream: MTI-006 (DUPLICATE → IDS-001), APS-009 (DUPLICATE → IDS-003)

## `admin-surface-expansion` — Admin API surface expansion (ticket 19)

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~44h · depends on workstreams: `admin-impersonation-gate-target`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BAM-005](../slices/10-passkey-admin.md) | high | api | CONFIRMED | XL | — | Implement ticket 19 §1: fail-closed per-capability predicates, user/session admin endpoints, and a core-level ban gate at every sign-in call site. |
| [EP-003](../slices/10-passkey-admin.md) | high | api | CONFIRMED | L | BAM-005, DRS-001 | Implement ticket 19 §3: an optional superadmin tenant-administration sub-surface on top of BAM-005's user/session admin. |

## `admin-audit-integrity` — Tamper-evident impersonation audit (decision needed)

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~12h · depends on workstreams: `admin-impersonation-lifecycle`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ALF-005](../slices/10-passkey-admin.md) | medium | security | CONFIRMED ⚖️ decision | L | — | Ship DB-level immutability triggers plus a shared HMAC hash-chain for durable audit tables (admin_impersonation, audit_log). |

## `admin-impersonation-lifecycle` — Impersonation episode lifecycle: expiry, stop robustness, paginated history

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~9h · depends on workstreams: `admin-impersonation-gate-target`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ESS-006-effect-stream-specialist](../slices/10-passkey-admin.md) | medium | performance | CONFIRMED | M | — | Keyset-paginate the impersonation history on (startedAt, id), newest-first, in both layers and on the wire. |
| [IDS-004](../slices/10-passkey-admin.md) | medium | compliance | CONFIRMED | M | — | Record each episode's hard expiry and close expired episodes as endedBy="expired" — lazily on every read and via an exported sweep — publishing the stopped event from the same path. |
| [IDS-007](../slices/10-passkey-admin.md) | low | correctness | CONFIRMED | S | IDS-001 | Make revocation the primary, idempotent act on both stop paths and record the episode end best-effort, without letting forceStop revoke sessions that are not provably impersonation sessions. |

Closed by validation in this workstream: JR-011 (DUPLICATE → IDS-004), ESA-008 (DUPLICATE → IDS-004)

## `admin-impersonation-cookie-contract` — Browser cookie contract for impersonation (decision needed)

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~5h · depends on workstreams: `session-delivery`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [APS-006](../slices/10-passkey-admin.md) | medium | correctness | CONFIRMED ⚖️ decision | M | WPS-004 | Deliver impersonation sessions under a dedicated `__Host-impersonation` cookie that shadows (not replaces) `__Host-session`, and clear it on stop (Option A — pending decision). |
| [BAM-012](../slices/10-passkey-admin.md) | info | api | CONFIRMED | S | APS-006, DTWS-002 | Document the impersonation client contract (and its delta from better-auth) once APS-006's cookie contract is decided. |

Closed by validation in this workstream: IDS-005 (DUPLICATE → APS-006), JR-006 (DUPLICATE → APS-006), CSS-003 (DUPLICATE → APS-006)

## `admin-api-tier` — Separable admin API tier (decision needed)

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~12h · depends on workstreams: `admin-surface-expansion`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AR-003](../slices/10-passkey-admin.md) | medium | architecture | CONFIRMED ⚖️ decision | L | — | Give admin groups a separable tier (own HttpApi + optional dedicated auth middleware), defaulting to today's co-hosted behavior. |

