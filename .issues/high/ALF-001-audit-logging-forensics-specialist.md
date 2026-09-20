---
ID: "ALF-001"
Title: "BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only"
Level: high
Category: "compliance"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:11"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-001 — BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only

`HIGH` · `compliance` · `qadi` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **resolved**

## Summary

The spec is unambiguous: the audit trail of security-relevant operations MUST be written durably as part of the operation itself and MUST NOT depend on any AuthEvents subscriber (spec/behaviors/13-events.md:62-71). The implementation is a Layer-scoped in-memory PubSub (AuthEvents.ts:260-268): auth.token.replay, auth.passkey.counterAnomaly, and both impersonationDenied paths evaporate at process exit and leave no forensic trace. The sql package's entire migration set (users, accounts, sessions, verification_tokens, verification_reservations) contains no audit table. A suspected-compromise investigation — this persona's core scenario — has no ground truth to consult even minutes after the fact, and a token-replay probing campaign leaves zero durable evidence.

## Evidence

Source: `packages/qadi/src/Resolvers.ts:11`

```
BEH-EA-164 (`DecisionHistory` backed by audit events) needs a durable
//   audit-event table this repository does not have — no `AuditLog`
//   service exists anywhere in `@awthaq/core` yet.
```

## Recommended fix

Add an audit_events table plus AuditLog service in @awthaq/sql (the ImpersonationRecords pattern: memory + SQL layers under one Shapes contract), and have publishers write the durable row inside the operation before publishing, minimally for: signedIn/signedInFailed, session issued/revoked, credential changed/reset, token replay, counter anomaly, impersonation denied.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-001` — reauth obligation measures session-mint age with no authenticatedAt and no discharge path](high/AAPS-001-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-002` — Multiple AttributeResolver producers compose by silent shadowing, not merge](high/AAPS-002-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-004` — One store round trip per attribute reference, no per-evaluation memoization](medium/AAPS-004-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`EEM-005` — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable](medium/EEM-005-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-002` — The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only](high/ESS-002-effect-stream-specialist.md) `_(effect-stream-specialist, high)_`
- [`FAMS-004` — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent](medium/FAMS-004-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`TS-001` — Reauth obligation handler silently discharges a malformed obligation](medium/TS-001-torin-sandall.md) `_(torin-sandall, medium)_`
- [`TS-002` — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable](medium/TS-002-torin-sandall.md) `_(torin-sandall, medium)_`
- … 1 more findings touch `packages/qadi/src/Resolvers.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Durable audit/event trail sink architecture](../../.scratch/resolve-ready-for-human-findings/issues/01-durable-audit-event-sink.md) — new `AuditLog` core service, backed by a new `auth_audit_log` SQL table, written inline by `AuthEvents.publish` itself (not a subscriber) for all 25 registry event tags. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/qadi/src/Resolvers.ts:11-14` carries exactly the quoted comment admitting no `AuditLog` service exists; `packages/sql/src/CoreMigrations.ts` creates only `users`, `accounts`, `sessions`, `verification_tokens`, `verification_reservations` — no audit table — and `AuthEvents.ts`'s bus is confirmed in-memory-only (see ALF-002). Building a durable audit subsystem (new `AuditLog` port/service, schema, retention, which publishers write which rows) is an architecture decision, not a mechanical patch. Status → ready-for-human.

**Resolved (2026-09-20):** Implemented the wayfinder decision exactly — a new `AuditLog` core service, written inline by `AuthEvents.publish` itself, never by a subscriber:

- New `packages/core/src/AuditLog.ts`: `AuditLogShape` (`record`/`list`), `AuditLog` `Context.Service`, `layerMemory` (dev/test convenience, explicitly documented as not durable), `layerSql`. An exhaustive `actorOf` pattern-match over all 27 current `AuthEvent` variants derives `actorUserId` — TypeScript forces it to be updated whenever the union grows, so audit-actor coverage can't silently lag the registry.
- `packages/core/src/AuthEvents.ts`: `layer`'s `R` channel now includes `AuditLog` (a hard dependency); `publish` calls `auditLog.record(event)` *before* `PubSub.publish` — the durability write is structurally inside `publish` itself, not an optional subscriber, which is what actually satisfies "MUST NOT depend on any `AuthEvents` subscriber." `AuditLogShape.record` stays `Effect<void>` (no typed error) — `layerSql` `.orDie`s a SQL failure internally, a deliberate fail-closed choice (an audit-store outage now takes down the triggering operation, not just audit visibility), since a "successful" security-relevant operation with no durable row is exactly what BEH-EA-100 exists to make impossible.
- `packages/sql/src/CoreMigrations.ts`: migration 13 `create_auth_audit_log` — one `auth_audit_log` table (`id`, `"eventTag"`, `"actorUserId"`, `"occurredAt"`, `"correlationId"`, `payload`), indexed on `"eventTag"`/`"actorUserId"`. `payload` is an opaque JSON envelope (`Schema.fromJsonString(Schema.Unknown)`), the same `verification_tokens.payload` precedent — a new `AuthEvent` tag needs no migration to be durably recorded, and all 27 registry tags are recorded (not a curated subset), per this effort's "ship the richer option" directive.
- `packages/sql/src/Repositories.ts`: new `AuditLogRepository`/`AuditLogRepositoryLive`, hand-written against `SqlSchema.findOne`/`SqlSchema.findAll` (not `SqlModel.makeRepository`, for the same opaque-payload reason as `VerificationRepository`); `list`'s dynamic `eventTag`/`actorUserId`/`occurredAfter`/`occurredBefore` filters combine via `sql.and(...)`.
- Breaking change (accepted per this effort's standing directive): every existing `AuthEvents.layer` composition now also needs `AuditLog.layerMemory` or `.layerSql` — updated all ~40 call sites across `packages/*/test`, `features/step-definitions/*World.ts`, `packages/test/src/TestAuth.ts` (the shared test harness), and `examples/memory-server`.

TDD: new `packages/core/test/AuditLog.test.ts` (7 tests, both `layerMemory` and `layerSql` against a real in-memory SQLite table) plus a new test in `packages/core/test/AuthEvents.test.ts` proving `publish` durably records with **zero subscribers** (BEH-EA-100's own point). Verified genuinely load-bearing via two separate mutations, each reverted: (1) skipped the `auditLog.record(event)` call in `AuthEvents.publish` — the new "zero subscribers" test failed exactly as expected (empty audit log); (2) disabled the `eventTag` SQL filter in `AuditLogRepositoryLive.list` — the "list narrows by eventTag" test failed exactly as expected (2 rows instead of 1). Both confirmed via a full `pnpm run typecheck` rebuild between mutation and test run (this monorepo's cross-package imports resolve through each package's built `lib/` output, not `src/` directly — a mutation only takes effect once `tsc -b`'s composite build re-emits it). Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (702 passed, 7 skipped, up from 694); `pnpm run test:bdd` green for every suite this change touches (Admin/OAuth/Password/Session/Passkey), with the 2 pre-existing, unrelated `15-password.steps.test.ts` failures left untouched (confirmed via `git log`/`git diff` unrelated to this session).

Also closes [`ESA-001`](ESA-001-event-sourcing-audit-trail-specialist.md), [`ESS-002`](ESS-002-effect-stream-specialist.md), [`CSG-004`](CSG-004-compliance-soc2-gdpr-specialist.md), and [`EP-002`](EP-002-eugenio-pace.md) — the same 5-finding cluster the wayfinder ticket names, cross-referenced.

Deliberately out of scope here (per the wayfinder decision's own scope note): `AuthAuditTrail`/`AuditTrailPort` for qadi's own authorization-decision auditing (BEH-EA-164), retention/erasure policy (`CSG-004`'s GDPR concern, owned by a separate ticket), and `correlationId` population (`ALF-006`, reserved but unpopulated by this change).
