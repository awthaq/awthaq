---
ID: "EOTS-004"
Title: "Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Sessions.ts:274"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-004 — Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs

`MEDIUM` · `security` · `core` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **ready-for-agent**

## Summary

SessionNotFound and SessionExpired messages embed the session id (`: no such session: ${id}` at :274 and :295, `session expired: ${id}` at :280, `idle-expired` at :285; SessionExpired also carries `id` as a typed field). The middleware maps these away from HTTP responses (good), but the only two logging sites in the library serialize whole error causes (EOTS-005), and any host that logs defects or unexpected errors will persist session ids. The spec classifies the id as 'the public half' (Sessions.ts:27, BEH-EA-049), so this is not secret leakage — but it is the only identifier-bearing content the library itself puts on the log channel, and no policy note distinguishes it from the never-log discipline the research corpus mandates (research/12-library-strategy.md:227, OWASP never-log list).

## Evidence

Source: `packages/core/src/Sessions.ts:274`

```
new SessionNotFound({ message: `awthaq: no such session: ${id}` }),
```

## Recommended fix

Either drop the id from messages (keep it in a typed field for correlation) or document explicitly that the session id half is approved for logs — ideally as part of the redaction policy table BEH-EA-199's interceptor will enforce.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: observability & tracing
- Full dossier: [`effect-observability-tracing-specialist`](../../.reports/effect-observability-tracing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `core-error-taxonomy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:428`. Fix: Stop interpolating identifiers into core error messages; carry them only as typed fields, and state the logging policy. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
