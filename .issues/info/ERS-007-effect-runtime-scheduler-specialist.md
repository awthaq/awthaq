---
ID: "ERS-007"
Title: "No background maintenance workload exists; session expiry is lazy-only"
Level: info
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:117"
Auditor: "effect-runtime-scheduler-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERS-007 — No background maintenance workload exists; session expiry is lazy-only

`INFO` · `architecture` · `core` · reported by **Effect Runtime & Scheduler Specialist** (`effect-runtime-scheduler-specialist`)

Status: **resolved**

## Summary

Expiry is enforced exclusively at verify time (SessionExpired at line 117; SessionConfig absolute 30d / idle 7d at lines 71-75), and a repo-wide search finds no Effect.sleep/interval/periodic fiber in any src package — there is no session-expiry sweep, no key-rotation timer, no eviction pass. Lazy enforcement is correct-by-design for validity (an expired session is never honored), so this is an honest absence rather than a bug, but it means expired rows linger in stores indefinitely until touched, and the 'foreground vs background fiber' split this domain cares about has only one background resident: the forkScoped event subscriptions.

## Evidence

Source: `packages/core/src/Sessions.ts:117`

```
export class SessionExpired extends Data.TaggedError("SessionExpired")({
  readonly message: string,
```

## Recommended fix

Document lazy expiry as the canonical enforcement point (it already is), and add an optional scoped reaper Layer (interval-driven, configured off by default) that memory/SQL backends can provide — this also gives ERS-002's queue drain and ERS-004's eviction a natural home in the same maintenance layer.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: runtime scheduling
- Full dossier: [`effect-runtime-scheduler-specialist`](../../.reports/effect-runtime-scheduler-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `data-retention-sweep`. Duplicate of `CSG-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:786`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `CSG-003-compliance-soc2-gdpr-specialist` — closed by its fix (see that issue's Resolved comment).

**Resolved (2026-09-29):** Duplicate of CSG-003: Sessions/Verification.purgeExpired and Retention.sweep close it.
