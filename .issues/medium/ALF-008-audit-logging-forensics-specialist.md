---
ID: "ALF-008"
Title: "Zero subscribers shipped anywhere — a default install records security events nowhere"
Level: medium
Category: "architecture"
Status: resolved
Package: "—"
Source: "examples/memory-server/index.ts:70"
Auditor: "audit-logging-forensics-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ALF-008 — Zero subscribers shipped anywhere — a default install records security events nowhere

`MEDIUM` · `architecture` · `—` · reported by **Audit Logging & Forensics Specialist** (`audit-logging-forensics-specialist`)

Status: **resolved**

## Summary

A search of every packages/*/src finds no AuthEvents.on call and no production consumer of events.stream — only test suites read the stream. Even the flagship example composes AuthEvents.layer and then subscribes to nothing, so the reference deployment's complete audit trail is the void: events are published and immediately dropped, not even retained in memory. Combined with ALF-001 (no durable table), a first-run application has no security record of any kind, and nothing in the docs or examples shows an operator what a correct audit wiring would look like.

## Evidence

Source: `examples/memory-server/index.ts:70`

```
).pipe(Layer.provideMerge(AuthEvents.layer));
```

## Recommended fix

Ship a reference durable sink in examples/memory-server (e.g. AuthEvents.on("auth.token.replay", ...) writing to the AuditLog from ALF-001) and document the compose-your-own-auditor recipe alongside it, so the bus stops being exercised only by its own tests.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 35/100), domain: Audit trail & forensics
- Full dossier: [`audit-logging-forensics-specialist`](../../.reports/audit-logging-forensics-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSD-010` — The only runnable example composes a permissive limiter — out-of-the-box showcase has throttling off](low/CSD-010-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, low)_`
- [`EOTS-006` — packages/server ships no logging/observability surface; example app uses bare console.log](medium/EOTS-006-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`PCS-005` — Zero tests exercise the cached-decision path or any invalidation trigger in this repo](medium/PCS-005-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`
- [`SEA-007` — The one runnable example deliberately avoids any SQL backend, so no end-to-end SQLite composition is demonstrated](info/SEA-007-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 6bd3f1d. Evidence at HEAD ec065a7: `packages/core/src/AuthEvents.ts:341`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
