---
ID: "ERS-004"
Title: "Memory rate-limiter store never evicts buckets: unbounded growth in a long-lived process"
Level: medium
Category: "performance"
Status: resolved
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:124"
Auditor: "effect-runtime-scheduler-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERS-004 — Memory rate-limiter store never evicts buckets: unbounded growth in a long-lived process

`MEDIUM` · `performance` · `ports` · reported by **Effect Runtime & Scheduler Specialist** (`effect-runtime-scheduler-specialist`)

Status: **resolved**

## Summary

layerStoreMemory inserts one HashMap entry per distinct key (line 114's Ref grows monotonically; expired buckets are only overwritten if the same key is seen again). Plugin keys embed attacker-controlled input — `password:signin:${input.email}` and `password:signup:${input.email}` (Password.ts:471, 517) — so a script spraying arbitrary addresses grows the map without bound in the long-lived server process this persona owns. There is no eviction pass, no size cap, and (per ERS-007) no background fiber that could host one. A memory exhaustion vector on a pre-auth path.

## Evidence

Source: `packages/ports/src/RateLimiter.ts:124`

```
return [next, HashMap.set(state, key, next)];
```

## Recommended fix

Make the store bounded: either prune lazily inside increment (when the map exceeds a configured cap, drop entries whose resetAt has passed; refuse or LRU-evict if still full), or run a scoped maintenance fiber (Effect.forever + Effect.sleep over a configurable interval inside Layer.effect) that sweeps expired buckets. Route the choice through a Config knob so the SQL/Redis stores described in spec/behaviors/14 inherit the same contract.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: runtime scheduling
- Full dossier: [`effect-runtime-scheduler-specialist`](../../.reports/effect-runtime-scheduler-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-005` — Rate limiting is per-process and identity-keyed only; the quickstart ships it disabled](medium/AR-005-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CSD-007` — Only in-process rate-limit store ships — multi-replica deployments multiply every limit by node count](medium/CSD-007-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`EOTS-007` — Rate-limit breaches emit no event, log, or metric](medium/EOTS-007-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`NHS-005` — Canonical quickstart wires a no-op rate limiter while the contract advertises 429s](medium/NHS-005-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, medium)_`
- [`RBS-003` — Memory store never evicts buckets whose keys are attacker-controlled — unauthenticated memory-DoS](high/RBS-003-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, high)_`
- [`RBS-004` — Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists](medium/RBS-004-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`RBS-009` — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows](low/RBS-009-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- [`RBS-010` — Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads](low/RBS-010-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- … 1 more findings touch `packages/ports/src/RateLimiter.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `ratelimit-memory-eviction`. Duplicate of `RBS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/ports/src/RateLimiter.ts:114`. Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `RBS-003-rate-limiting-brute-force-specialist` — closed by its fix (see that issue's Resolved comment).
