# P11 — Compliance: erasure, export, retention, redaction

Phase 2 · 7 open issues to fix (2 high, 4 medium, 1 low) · 11 closed by validation · ~57h summed per-issue estimate (upper bound) · 3 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `gdpr-erasure-export` — GDPR erasure completeness + data-subject export

Slices: [06-server-api](../slices/06-server-api.md) · ~25h · depends on workstreams: `hook-registry-scoping (ELC-001, slice 02)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CSG-001](../slices/06-server-api.md) | high | compliance | PARTIAL ⚖️ decision | L | ELC-001, DRS-008 | Finish the erasure cascade per decision 30: move it into a core domain service, populate the remaining plugin taps, make the taps part of every default composition, and settle audit-record retention. |
| [CSG-005](../slices/06-server-api.md) | medium | compliance | CONFIRMED ⚖️ decision | L | CSG-001 | Add a GDPR Art. 15/20 self-service export: GET /auth/user/export under Authentication, aggregating core data plus plugin-contributed sections. |
| [SEA-001](../slices/06-server-api.md) | medium | correctness | PARTIAL | S | CSG-001 | The untransactional cascade is fixed (e940a12). What remains is making the FK-less design an explicit, tested invariant, not adding FKs, since spec/behaviors/12-hooks.md:133 deliberately prefers hook-driven erasure to DB-level cascades. |

Closed by validation in this workstream: DRS-002 (DUPLICATE → CSG-001), SSMS-002 (DUPLICATE → SEA-001), TS-004-tim-smart (ALREADY-FIXED), CSG-007 (ALREADY-FIXED), TRBS-008 (ALREADY-FIXED)

## `data-retention-sweep` — Retention sweep (ticket 30)

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~12h · depends on workstreams: `session-supersede-atomicity`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CSG-003](../slices/01-core-sessions-users.md) | high | compliance | CONFIRMED | L | — | Implement ticket 30's Retention service: cutoff-based purge primitives on both Sessions and Verification (both layers), a RetentionConfig reference, Retention.sweep, and an opt-in Retention.layerScheduled. |

Closed by validation in this workstream: DRS-003 (ALREADY-FIXED), ERS-007 (DUPLICATE → CSG-003), TRBS-006 (DUPLICATE → CSG-003), ESR-006 (DUPLICATE → CSG-003), ECF-008 (DUPLICATE → CSG-003)

## `auth-event-pii-posture` — PII posture for events and the durable audit log

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~4h · depends on workstreams: `auth-event-schema`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ESA-005](../slices/02-core-events-hooks.md) | medium | compliance | PARTIAL ⚖️ decision | M | ESA-007 | Adopt a PII posture for events + audit rows (see decision D1), then implement: identifiers-only payloads, redacted observer-error logs, audit-row pseudonymization on erasure, and documented stream privilege. |

Closed by validation in this workstream: ALF-009 (DUPLICATE → ESA-005)

## `redaction-guarantee-check` — BEH-EA-199 canary-based redaction probe in @awthaq/test

Slices: [12-spec](../slices/12-spec.md) · ~12h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [SMS-003-secrets-management-specialist](../slices/12-spec.md) | medium | testing | CONFIRMED | L | — | Build the BEH-EA-199 interceptor in @awthaq/test using canary secrets: run the plugin's flows with known canary passwords/tokens under a recording Tracer, Logger and AuthEvents/AuditLog subscriber, and fail if any canary string (or an unwrapped Redacted payload) appears in span attributes/events, log messages/annotations, or published events. |

## `retention-sweeps` — Retention for audit data (extends CSG-003's Retention)

Slices: [05-sql](../slices/05-sql.md) · ~4h · depends on workstreams: `retention (CSG-003, cross-slice)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ALF-010](../slices/05-sql.md) | low | compliance | PARTIAL | M | CSG-003 | Extend ticket 30's `Retention` service (CSG-003) with per-event-class audit retention. The default is retain-forever (forensics-safe), and operators opt in to purge windows. Add the missing occurredAt index. |

