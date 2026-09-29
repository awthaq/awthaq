---
ID: "PIL-006"
Title: "Secret rotation mislabeled 'the standard session-fixation defense'"
Level: low
Category: "docs"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:157"
Auditor: "pilcrow"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# PIL-006 — Secret rotation mislabeled 'the standard session-fixation defense'

`LOW` · `docs` · `core` · reported by **pilcrow (pilcrowOnPaper) — Creator of Lucia Auth** (`pilcrow`)

Status: **resolved**

## Summary

Session fixation is an attack on the session *identifier*: the defense is minting a fresh id at privilege escalation, which this codebase correctly does by always issuing a brand-new row (and thus a new UUIDv7 id) at every sign-in. Rotating only the secret half while the id stays constant defends against a different threat — replay of the stored hash by someone with read access to the sessions table at an earlier time. The doc comment teaches the wrong threat model to every plugin author reading SessionsShape, in a codebase whose explicit mission is teaching auth primitives from first principles.

## Evidence

Source: `packages/core/src/Sessions.ts:157`

```
* rotates the session's secret (the standard session-fixation defense) —
* `rotated` carries the freshly-minted full token exactly when this call
```

## Recommended fix

Reword the comment: fixation is prevented by fresh issuance at sign-in (BEH-EA-053); the throttled secret rotation narrows the value of a leaked/stale secret-hash snapshot. If rotation is ever meant to be a fixation control, it must rotate the id too (new token, delete old row).

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-docs-accuracy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:187`. Fix: Reword the verify doc comment: fixation is prevented by fresh issuance/supersede (BEH-EA-053); throttled secret rotation limits the useful life of a leaked secret / stale hash snapshot. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Sessions.ts verify doc comment reworded: rotation is not the session-fixation defense (fresh issuance/supersede, BEH-EA-053, is); it limits the useful life of a leaked secret or stale hash snapshot. grep for the phrase in packages/*/src, spec, docs, README, examples finds no other copy (packages/next has none).
