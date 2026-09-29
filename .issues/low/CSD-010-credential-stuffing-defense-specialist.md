---
ID: "CSD-010"
Title: "The only runnable example composes a permissive limiter — out-of-the-box showcase has throttling off"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "examples/memory-server/index.ts:46"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-010 — The only runnable example composes a permissive limiter — out-of-the-box showcase has throttling off

`LOW` · `dx` · `—` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

examples/memory-server builds on TestAuth.layer, which hardwires RateLimiter.layerPermissive (packages/test/src/TestAuth.ts:89 — the BEH-EA-112 never-rejects limiter), and the example's own comment acknowledges the 'permissive rate limiter'. The example also supplies the breach-check transport 'unused since breachCheck defaults false' (index.ts:50). A developer copying the only complete composition example deploys with no rate limiting and no breach checking — both of this audit's primary defenses silently disabled in the reference deployment.

## Evidence

Source: `examples/memory-server/index.ts:46`

```
 *    permissive rate limiter) are deliberately lean — real, but not the
 *    whole set either plugin's own `make` resolves — so Organization's
```

## Recommended fix

Wire the enforcing limiter (RateLimiter.layer over layerStoreMemory) into the example with a comment on swapping the store for production, and enable breachCheck: true (allow posture) so the showcase demonstrates the defense-in-depth path the plugin supports.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: credential stuffing defense
- Full dossier: [`credential-stuffing-defense-specialist`](../../.reports/credential-stuffing-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-008` — Zero subscribers shipped anywhere — a default install records security events nowhere](medium/ALF-008-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`EOTS-006` — packages/server ships no logging/observability surface; example app uses bare console.log](medium/EOTS-006-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`PCS-005` — Zero tests exercise the cached-decision path or any invalidation trigger in this repo](medium/PCS-005-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`
- [`SEA-007` — The one runnable example deliberately avoids any SQL backend, so no end-to-end SQLite composition is demonstrated](info/SEA-007-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `examples-memory-server`. Evidence at HEAD ec065a7: `examples/memory-server/index.ts:46`. Fix: Compose the enforcing `RateLimiter.layer` over `RateLimiter.layerStoreMemory` and `Password.config({ breachCheck: { onUnavailable: "allow" } })` in both runnable compositions (memory example and the README/sql-server example), with a comment on swapping the store for production. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Already true at HEAD when re-verified: the memory example composes the enforcing RateLimiter.layerMemory (layer over layerStoreMemory), Password's breachCheck is on by default, and the root README quickstart uses RateLimiter.layer over the SQL store (there is no examples/sql-server). Added the missing proof: a smoke test where the sixth wrong password in a row answers 429, plus a comment/README note on swapping the store for a shared one in production.
