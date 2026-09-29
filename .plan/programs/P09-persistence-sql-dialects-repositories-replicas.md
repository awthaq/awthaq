# P09 — Persistence: SQL dialects, repositories, replicas

Phase 2 · 19 open issues to fix (2 high, 7 medium, 8 low, 2 info) · 12 closed by validation · ~79h summed per-issue estimate (upper bound) · 1 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `sql-dialect-neutral-models` — Dialect-neutral SQL models (make Postgres reads work)

Slices: [05-sql](../slices/05-sql.md) · ~14h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [TS-001-tim-smart](../slices/05-sql.md) | high | correctness | CONFIRMED | L | — | Follow ticket 29's decision: `Models.ts` becomes a `makeModels(dialect)` factory that selects Effect's own per-dialect Model field variants for the dialect-sensitive columns (boolean and DateTime). `Repositories.ts` resolves `sql.dialect` once at layer construction. The pg client's codecs are never overridden globally. |
| [ESR-009](../slices/05-sql.md) | low | testing | CONFIRMED | S | TS-001-tim-smart | Mirror the security-relevant SQLite cases into the Postgres suite once TS-001 makes pg row decode possible. |
| [PPS-007](../slices/05-sql.md) | low | performance | CONFIRMED | S | TS-001-tim-smart | Collapse verifyEmail into one `UPDATE ... RETURNING *` decoded through the dialect model. Bind the boolean through the model's own encoding so the per-dialect literal branch disappears. |

Closed by validation in this workstream: ESR-007 (ALREADY-FIXED), SSMS-007 (ALREADY-FIXED)

## `read-replica-routing` — Opt-in read-replica routing with causal tokens / Read-replica consistency (cross-slice canonical RRC-001)

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md), [05-sql](../slices/05-sql.md) · ~36h · depends on workstreams: `session-list-liveness-and-pagination`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [RRC-001](../slices/05-sql.md) | high | architecture | CONFIRMED | XL | TIR-003 | Implement ticket 28's decision: an opt-in, default-off `ReadRouting` module (a `ReplicaSqlClient` Context.Reference plus a fiber-scoped `CurrentCausalToken`), and a per-method staleness classification in which only display/history listings are replica-eligible. |
| [RRC-008](../slices/05-sql.md) | low | testing | CONFIRMED | M | RRC-001 | Land a lag-injecting replica test double together with ReadRouting, and cover the four causal handoffs. |

Closed by validation in this workstream: RRC-004 (DUPLICATE → RRC-001), DRS-004 (WONTFIX-CANDIDATE), RRC-006 (INVALID), RRC-005 (DUPLICATE → RRC-001), RRC-007 (WONTFIX-CANDIDATE)

## `sql-docs-operations` — Persistence-stratum README and operations docs

Slices: [05-sql](../slices/05-sql.md) · ~16h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CSG-006](../slices/05-sql.md) | medium | compliance | CONFIRMED ⚖️ decision | M | SMS-002-secrets-management-specialist | Document the encryption boundary now. Depending on the decision, add opt-in application-level encryption for the non-lookup PII columns (ipAddress, userAgent, users.metadata) through the existing Encryption port, with row AAD. |
| [ESR-008](../slices/05-sql.md) | medium | docs | CONFIRMED | M | — | Rewrite the package README as the operations home for the persistence stratum. The docs-only findings in this slice (ERAS-006, PPS-004, PPS-009, SSMS-006, NAM-007, CSG-006, CSG-009, SAM-006) land as sections of it. Refresh or delete the stale metrics JSON. |
| [NAM-007](../slices/05-sql.md) | medium | dx | PARTIAL | S | — | Publish an Auth.js migration runbook built on the now-existing ports. No new package unless demand appears. |
| [PPS-004](../slices/05-sql.md) | medium | dx | CONFIRMED | S | — | Ship a documented, ops-ready PgClient recipe and update the spec example. Distinguishable pool-exhaustion errors are an upstream @effect/sql-pg concern and are out of scope. |
| [SSMS-006](../slices/05-sql.md) | low | architecture | CONFIRMED | S | — | Document an expand-phase runbook and adopt `IF NOT EXISTS` for every new index migration, so an operator can pre-build with CONCURRENTLY out of band and the recorded migration becomes a no-op. |
| [ERAS-006](../slices/05-sql.md) | info | architecture | CONFIRMED | M | — | Document the edge/origin split and the driver matrix, and prove one HTTP-capable sqlite-dialect driver against the contract suite so the documentation isn't aspirational. |
| [PPS-009](../slices/05-sql.md) | info | architecture | CONFIRMED | S | — | Record 'opaque JSON is TEXT on every dialect' as a deliberate decision. Plan no jsonb migration until a server-side query need exists. |

Closed by validation in this workstream: NAM-011 (DUPLICATE → ERAS-006), PPS-006 (INVALID)

## `sql-repository-hygiene` — Repository hygiene: email fold, brand unification, named spans

Slices: [05-sql](../slices/05-sql.md) · ~3h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EOTS-008](../slices/05-sql.md) | medium | performance | PARTIAL | S | — | Give every hand-written repository method a named span, matching SqlModel's `<spanPrefix>.<method>` convention, so a flame graph shows `Users.findByEmail > sql.execute` rather than an anonymous `sql.execute`. |
| [ESR-003](../slices/05-sql.md) | medium | correctness | CONFIRMED | S | — | Make JS `toLowerCase()` the only fold. Normalize the bound parameter in the repository and keep `lower(email)` on the column side so the existing `users_email_unique` expression index still serves the lookup. Stored values are already JS-lowercased, so column-side `lower()` is a no-op for them on every dialect. |
| [MA-008](../slices/05-sql.md) | low | architecture | CONFIRMED | S | — | Declare each id type once, in @awthaq/sql, the lower stratum core already imports. Core re-exports the type and keeps a nominal constructor over it, so a key rename on either side breaks every bridge at compile time. |

Closed by validation in this workstream: ESS-011 (DUPLICATE → MA-008), PPS-008 (WONTFIX-CANDIDATE)

## `accounts-targeted-writes` — Column-targeted Accounts secret writes

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [RRS-006](../slices/01-core-sessions-users.md) | medium | api | PARTIAL | M | — | Replace read-pass-through writes with column-targeted UPDATE statements (no read needed) so writers of one secret never rewrite another. |

## `sql-contract-test-coverage` — SQLite contract coverage: file-backed WAL and timestamp invariants

Slices: [05-sql](../slices/05-sql.md) · ~5h · depends on workstreams: `sql-dialect-neutral-models (ESR-009's shared contract cases)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [SEA-004](../slices/05-sql.md) | low | testing | CONFIRMED | M | ESR-009 | Run the SQLite contract cases against a temp-file database as well, and add a two-connection contention test for the CAS primitives. |
| [SEA-005](../slices/05-sql.md) | low | correctness | CONFIRMED | S | — | Pin the encoding invariant with contract tests. STRICT tables are rejected: they enforce only the TEXT type, not the format, and need table rebuilds. |

## `sqlite-ops-docs` — Embedded SQLite operations guide

Slices: [12-spec](../slices/12-spec.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [SEA-003](../slices/12-spec.md) | low | dx | CONFIRMED | S | — | Add an embedded-SQLite operations section: WAL default and -wal/-shm sidecars, live backup via the client's `backup(destination)`, checkpointing, busy timeout, single-writer/single-instance constraint. |

