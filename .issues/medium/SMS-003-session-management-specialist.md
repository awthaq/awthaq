---
ID: "SMS-003"
Title: "No concurrent-session limit exists in config, shape, or either layer"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Sessions.ts:56"
Auditor: "session-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-003 — No concurrent-session limit exists in config, shape, or either layer

`MEDIUM` · `security` · `core` · reported by **Session Management Specialist** (`session-management-specialist`)

Status: **ready-for-agent**

## Summary

SessionConfig carries only absolute/idle/touchEvery; SessionsShape.issue (lines 137-148) accepts no policy input, and neither layer counts a user's live sessions at issuance. A credential-stuffing success or a stolen password can silently accumulate an unbounded number of parallel sessions, each living up to 30 days, with no device-tracking pressure point and no cap a deployment could tune. The persona-relevant 'concurrent session limits / device tracking' policy dimension is simply absent, and list's 200-row page (LIST_PAGE_SIZE, line 418) is a read cap, not a policy.

## Evidence

Source: `packages/core/src/Sessions.ts:56`

```
export interface SessionConfig {
  readonly absolute: Duration.Duration;
  readonly idle: Duration.Duration;
```

## Recommended fix

Add an optional maxSessions (plus eviction policy: deny-new or evict-oldest) to SessionConfig, enforce it in issue (a count query in the SQL layer, a filtered count in memory), and surface evictions via an auth event so clients can react.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session lifecycle
- Full dossier: [`session-management-specialist`](../../.reports/session-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-policy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:58`. Fix: Add an opt-in concurrent-session cap to SessionConfig (default: none, preserving BEH-EA-047) with a typed eviction policy, enforced atomically in issue, publishing an event on eviction. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
