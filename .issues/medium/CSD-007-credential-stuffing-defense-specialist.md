---
ID: "CSD-007"
Title: "Only in-process rate-limit store ships — multi-replica deployments multiply every limit by node count"
Level: medium
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:28"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-007 — Only in-process rate-limit store ships — multi-replica deployments multiply every limit by node count

`MEDIUM` · `security` · `ports` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

layerStoreMemory (lines 111-129) is a single-process Ref: counters are not shared across replicas, so a 5/15min email limit becomes 5/15min per node — horizontally scaled deployments dilute account throttling proportionally to their own resilience, and a botnet rotates buckets for free. The port (RateLimiterStoreShape.increment, one atomic read-and-advance) is correctly designed for a Redis/SQL implementation, and the BDD suite even names `layerStoreRedisConfig(...)` (features/04-cross-cutting/14-rate-limiting.feature:154), but no such layer exists in any package. The fixed-window algorithm also admits up to 2x limit across a window boundary — acceptable and documented (BEH-EA-105), but worth stating in a stuffing context.

## Evidence

Source: `packages/ports/src/RateLimiter.ts:28`

```
// against today. A store that legitimately can go unreachable (Redis, a SQL
// pool) is a documented future `RateLimiterStore` implementation — its
// `increment` would carry a real error channel for `layer` to catch and
```

## Recommended fix

Implement a Redis (INCR+EXPIRE or Lua) or Postgres (upsert-and-return) store against the existing RateLimiterStore port; the consume logic, retryAfterMillis computation, and Layer shadowing semantics need no changes.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: credential stuffing defense
- Full dossier: [`credential-stuffing-defense-specialist`](../../.reports/credential-stuffing-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-005` — Rate limiting is per-process and identity-keyed only; the quickstart ships it disabled](medium/AR-005-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`EOTS-007` — Rate-limit breaches emit no event, log, or metric](medium/EOTS-007-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ERS-004` — Memory rate-limiter store never evicts buckets: unbounded growth in a long-lived process](medium/ERS-004-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, medium)_`
- [`NHS-005` — Canonical quickstart wires a no-op rate limiter while the contract advertises 429s](medium/NHS-005-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, medium)_`
- [`RBS-003` — Memory store never evicts buckets whose keys are attacker-controlled — unauthenticated memory-DoS](high/RBS-003-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, high)_`
- [`RBS-004` — Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists](medium/RBS-004-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`RBS-009` — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows](low/RBS-009-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- [`RBS-010` — Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads](low/RBS-010-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- … 1 more findings touch `packages/ports/src/RateLimiter.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `ratelimit-distributed-store`. Duplicate of `RBS-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/RateLimiter.ts:26`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.
