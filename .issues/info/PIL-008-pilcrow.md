---
ID: "PIL-008"
Title: "Admin impersonation semantics encoded in core's session model"
Level: info
Category: "architecture"
Status: needs-triage
Package: "core"
Source: "packages/core/src/Sessions.ts:81"
Auditor: "pilcrow"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PIL-008 — Admin impersonation semantics encoded in core's session model

`INFO` · `architecture` · `core` · reported by **pilcrow (pilcrowOnPaper) — Creator of Lucia Auth** (`pilcrow`)

Status: **needs-triage**

## Summary

Core's SessionRow/SessionView carry actingAsType/actingAsId columns and verify branches on them ('a session carrying actingAs never idle-refreshes'), and issue accepts absoluteDuration explicitly so @awthaq/admin's maxDuration can cap it. The comment frames this as a generic, Admin-agnostic field, but the consumer is exactly one plugin today and its interpretation (never touch, hard expiry) is baked into core's verify. This is mild sprawl against the stated minimal-core thesis — the session service now understands a privilege-delegation policy. It is documented, deliberate, and cheap (two nullable columns, one early return), so I note it, not condemn it.

## Evidence

Source: `packages/core/src/Sessions.ts:81`

```
* BEH-EA-209: the caller's own identity, immutably attached to a session
* minted on someone else's behalf (e.g. `@awthaq/admin`'s `impersonate`)
```

## Recommended fix

Acceptable as-is; if a second consumer never materializes, consider pushing the semantics up: issue({ idleRefresh: false }) would express 'hard expiry' without core knowing what impersonation is.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: session fundamentals
- Full dossier: [`pilcrow`](../../.reports/pilcrow/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `session-policy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:81`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/01-core-sessions-users.md`.
