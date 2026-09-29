---
ID: "TMS-004"
Title: "Memory stores never evict expired state — attacker-keyed unbounded growth in rate limiter, sessions, and verification reservations"
Level: medium
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:124"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-004 — Memory stores never evict expired state — attacker-keyed unbounded growth in rate limiter, sessions, and verification reservations

`MEDIUM` · `security` · `ports` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

layerStoreMemory inserts a bucket per unique key and only overwrites a key when it is hit again after expiry — there is no sweep, size cap, or TTL eviction anywhere in the layer. Bucket keys are attacker-chosen (password:signin:<email>, password:signup:<email>, oauth:callback:<ip>), so an unauthenticated client rotating email values grows the Ref's HashMap without bound for the life of the process: a cheap remote memory-exhaustion DoS. The same no-expiry pattern holds in the memory Sessions layer (expired rows are failed on verify but never removed, Sessions.ts:278-287) and Verification reservations (Verification.ts:143/231-243). Memory↔SQL is the one boundary where the memory twin silently diverges from the SQL story, which bounds all of this via storage limits.

## Evidence

Source: `packages/ports/src/RateLimiter.ts:124`

```
              : { count: 1, resetAt: DateTime.addDuration(now, window) };
          return [next, HashMap.set(state, key, next)];
```

## Recommended fix

Evict on write (periodic sweep of expired buckets/rows, or cap the map and reject/overwrite oldest), or explicitly document the memory layers as test-only and require a bounded external store in production compositions.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: STRIDE threat model
- Full dossier: [`threat-modeling-specialist`](../../.reports/threat-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-005` — Rate limiting is per-process and identity-keyed only; the quickstart ships it disabled](medium/AR-005-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CSD-007` — Only in-process rate-limit store ships — multi-replica deployments multiply every limit by node count](medium/CSD-007-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`EOTS-007` — Rate-limit breaches emit no event, log, or metric](medium/EOTS-007-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ERS-004` — Memory rate-limiter store never evicts buckets: unbounded growth in a long-lived process](medium/ERS-004-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, medium)_`
- [`NHS-005` — Canonical quickstart wires a no-op rate limiter while the contract advertises 429s](medium/NHS-005-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, medium)_`
- [`RBS-003` — Memory store never evicts buckets whose keys are attacker-controlled — unauthenticated memory-DoS](high/RBS-003-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, high)_`
- [`RBS-004` — Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists](medium/RBS-004-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`RBS-009` — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows](low/RBS-009-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- … 1 more findings touch `packages/ports/src/RateLimiter.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `ratelimit-memory-eviction`. Evidence at HEAD ec065a7: `packages/ports/src/RateLimiter.ts:114`. Fix: Prune expired rows in the core memory layers (Sessions, Verification). (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Added packages/core/src/internal/pruneExpired.ts (pruneExpired, pruneExpiredAbove, threshold 10_000) and applied it inside Verification.layerMemory (issue's Ref.update, reserve's Ref.modify) and Sessions.layerMemory.issue (absoluteExpiresAt). Tests: packages/core/test/pruneExpired.test.ts (red first: module absent) + Verification.test.ts reserve-after-prune regression. Rate-limiter half closed by RBS-003. Gates as RBS-003.
