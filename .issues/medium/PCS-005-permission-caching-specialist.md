---
ID: "PCS-005"
Title: "Zero tests exercise the cached-decision path or any invalidation trigger in this repo"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "examples/memory-server/index.ts:40"
Auditor: "permission-caching-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PCS-005 — Zero tests exercise the cached-decision path or any invalidation trigger in this repo

`MEDIUM` · `testing` · `—` · reported by **Permission Caching Specialist** (`permission-caching-specialist`)

Status: **ready-for-agent**

## Summary

Neither the example app nor any package test composes a DecisionCache: the qadi test suite covers resolvers/bridges (uncached), Roles.test.ts pins revocation only on the live-resolution path (Roles.test.ts:60), and no test provides decisionCacheLayer, asserts a hit, or — the security-critical one — asserts that a membership removal or role revoke is visible on the next decision under a scoped cache. The appendix wiring that every reader will copy is therefore untested in the exact dimension where a bug silently grants privileges (a stale allow survives memberRemoved). The vendored dependency has its own unit tests, but the awthaq-side composition contract (facts store + events + cache + bridge) has none.

## Evidence

Source: `examples/memory-server/index.ts:40`

```
const built = Auth.make([Password.Password, Organization.Organization]);
```

## Recommended fix

Add one integration test that wires decisionCacheLayer at request scope plus the AuthEvents bridge, and pins: (1) second identical decision is a hit; (2) after organization memberRemoved, the next decision denies; (3) after roles.revoke, the next decision denies. These three assertions are the regression net for every future caching change.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: decision caching
- Full dossier: [`permission-caching-specialist`](../../.reports/permission-caching-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-008` — Zero subscribers shipped anywhere — a default install records security events nowhere](medium/ALF-008-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`CSD-010` — The only runnable example composes a permissive limiter — out-of-the-box showcase has throttling off](low/CSD-010-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, low)_`
- [`EOTS-006` — packages/server ships no logging/observability surface; example app uses bare console.log](medium/EOTS-006-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`SEA-007` — The one runnable example deliberately avoids any SQL backend, so no end-to-end SQLite composition is demonstrated](info/SEA-007-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-decision-cache-invalidation`. Evidence at HEAD ec065a7: `spec/appendices/02-qadi-path-a-end-to-end.md:59`. Fix: Write the regression net that wayfinder ticket 12's decision (PCS-001/RZS-002) needs: tests for per-request cache scope and for DecisionCacheInvalidationLive clearing on organization membership/role hooks. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
