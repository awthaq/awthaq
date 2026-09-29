---
ID: "EP-008"
Title: "Session cookie identity is a fixed, non-configurable __Host- constant"
Level: low
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:123"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-008 — Session cookie identity is a fixed, non-configurable __Host- constant

`LOW` · `architecture` · `core` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **resolved**

## Summary

The `__Host-` prefix is the right security call (no Domain attribute, secure-only, host-locked), and the code is explicit that it is non-configurable. The tenancy consequence: sessions are welded to one exact hostname per composition, so multi-brand or custom-domain serving (tenant A on acme.auth.example.com, tenant B on id.acme.com) cannot share a process's cookie identity and would need distinct hosts or a token-boundary redesign. Fine for the current single-app story; a hard constraint to surface before anyone attempts domain-based tenancy.

## Evidence

Source: `packages/core/src/Sessions.ts:123`

```
/** BEH-EA-055: the one session cookie's fixed, non-configurable attribute set. */
export const SESSION_COOKIE_NAME = "__Host-session";
```

## Recommended fix

Keep `__Host-` as the default but document the constraint in the overview, and if custom domains ever land, plan per-domain cookie scopes (name derived from tenant) rather than weakening the prefix.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-cookie-policy`. Duplicate of `IC-007` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:151`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `IC-007-iain-collins` — closed by its fix (see that issue's Resolved comment).
