---
ID: "IDS-008"
Title: "Chain-depth and self-act-as invariants live only in the Admin plugin, not in Sessions.issue"
Level: low
Category: "architecture"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Sessions.ts:142"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-008 — Chain-depth and self-act-as invariants live only in the Admin plugin, not in Sessions.issue

`LOW` · `architecture` · `core` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **ready-for-agent**

## Summary

BEH-EA-209 makes actingAs a generic, any-plugin-reusable issuance parameter, yet Sessions.issue performs no validation on it: core will happily mint an actingAs session whose actingAs.id equals its own userId, or an actingAs session for a caller that already carries one. The only depth-1 and self-refusal guards are in Admin.impersonate (Admin.ts:207-212). Any future plugin (or host code calling Sessions directly, as the feature steps themselves do) that reuses the parameter inherits none of the anti-laundering invariants - the generic field outlives the single consumer that polices it.

## Evidence

Source: `packages/core/src/Sessions.ts:142`

```
readonly actingAs?: ActingAs;
```

## Recommended fix

Push the two cheap invariants into Sessions.issue (reject actingAs.id === userId; optionally reject nested actingAs at issuance) or document explicitly that every future producer must re-implement them.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 71/100), domain: Impersonation & Delegation
- Full dossier: [`impersonation-delegation-specialist`](../../.reports/impersonation-delegation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-verify-hardening`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:173`. Fix: Enforce the self-act-as invariant inside Sessions.issue (both layers) as a typed defect, and document that the nesting check needs the caller's session and stays with the producer. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
