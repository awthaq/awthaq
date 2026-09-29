---
ID: "RBS-004"
Title: "Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:72"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-004 — Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists

`MEDIUM` · `architecture` · `ports` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **ready-for-agent**

## Summary

spec/behaviors/14-rate-limiting.md (rev 1.1) mandates that RateLimiter.layer fail OPEN when the backing store is unreachable, and BEH-EA-109 names Redis/SQL stores as the production default for multi-instance deployments — but RateLimiterStoreShape.increment is typed as never-failing, so a Redis store literally cannot report an outage: it must either widen the port (breaking every provider) or orDie (fail closed, crashing requests). The module header admits the error channel is future work, yet consume's own error type is already fixed to RateLimited. Concretely, no store other than the in-process Ref exists anywhere in the repo, so the multi-instance story is: per-process counters whose effective limit multiplies by instance count, or nothing.

## Evidence

Source: `packages/ports/src/RateLimiter.ts:72`

```
readonly increment: (key: string, window: Duration.Input) => Effect.Effect<Bucket>;
```

## Recommended fix

Widen increment to Effect<Bucket, StoreError> now while there is exactly one store implementation to migrate, add the fail-open catch (with an opt-out) in layer per BEH-EA-105, and ship at least a SQL-backed store next to the sql package's repositories so the distributed claim is testable.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: brute-force defense
- Full dossier: [`rate-limiting-brute-force-specialist`](../../.reports/rate-limiting-brute-force-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-005` — Rate limiting is per-process and identity-keyed only; the quickstart ships it disabled](medium/AR-005-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CSD-007` — Only in-process rate-limit store ships — multi-replica deployments multiply every limit by node count](medium/CSD-007-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`EOTS-007` — Rate-limit breaches emit no event, log, or metric](medium/EOTS-007-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ERS-004` — Memory rate-limiter store never evicts buckets: unbounded growth in a long-lived process](medium/ERS-004-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, medium)_`
- [`NHS-005` — Canonical quickstart wires a no-op rate limiter while the contract advertises 429s](medium/NHS-005-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, medium)_`
- [`RBS-003` — Memory store never evicts buckets whose keys are attacker-controlled — unauthenticated memory-DoS](high/RBS-003-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, high)_`
- [`RBS-009` — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows](low/RBS-009-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- [`RBS-010` — Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads](low/RBS-010-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- … 1 more findings touch `packages/ports/src/RateLimiter.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `ratelimit-distributed-store`. Evidence at HEAD ec065a7: `packages/ports/src/RateLimiter.ts:72`. Fix: Give the store an error channel, implement BEH-EA-105's fail-open default, and ship a SQL-backed store. (effort L). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
