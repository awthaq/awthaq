---
ID: "NHS-005"
Title: "Canonical quickstart wires a no-op rate limiter while the contract advertises 429s"
Level: medium
Category: "dx"
Status: resolved
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:136"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-005 — Canonical quickstart wires a no-op rate limiter while the contract advertises 429s

`MEDIUM` · `dx` · `ports` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

README.md line 216 lists layerPermissive ('no real limiting') as the real default layer the quickstart uses for the RateLimiter port. The served OpenAPI still declares RateLimited 429 on /password/sign-in, /password/request-reset, etc., and the RATE_LIMITS registry (Password.ts:156-166) registers 5-per-15-min rules — none of which the documented deployment enforces. An operator following the quickstart ships brute-force protection that silently does nothing, with the wire contract and the introspectable registry both claiming otherwise.

## Evidence

Source: `packages/ports/src/RateLimiter.ts:136`

```
export const layerPermissive: Layer.Layer<RateLimiter> = Layer.succeed(
  RateLimiter,
  RateLimiter.of({ consume: () => Effect.void }),
```

## Recommended fix

Make the quickstart default a real store-backed limiter (the README's own layerStoreMemory path), or have Auth.make/composition refuse or warn when RateLimits rules are registered while the installed RateLimiter is the permissive one.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: HTTP server integration
- Full dossier: [`node-http-server-integration-specialist`](../../.reports/node-http-server-integration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-005` — Rate limiting is per-process and identity-keyed only; the quickstart ships it disabled](medium/AR-005-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CSD-007` — Only in-process rate-limit store ships — multi-replica deployments multiply every limit by node count](medium/CSD-007-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`EOTS-007` — Rate-limit breaches emit no event, log, or metric](medium/EOTS-007-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ERS-004` — Memory rate-limiter store never evicts buckets: unbounded growth in a long-lived process](medium/ERS-004-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, medium)_`
- [`RBS-003` — Memory store never evicts buckets whose keys are attacker-controlled — unauthenticated memory-DoS](high/RBS-003-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, high)_`
- [`RBS-004` — Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists](medium/RBS-004-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`RBS-009` — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows](low/RBS-009-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- [`RBS-010` — Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads](low/RBS-010-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- … 1 more findings touch `packages/ports/src/RateLimiter.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `ratelimit-distributed-store`. Evidence at HEAD ec065a7: `README.md:216`. Fix: Make the quickstart enforce limits and flag the permissive layer. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** README quickstart now wires RateLimiter.layer over RateLimiterStoreSql.layerStoreSql (with its migration) instead of layerPermissive; Configuration table row updated; layerPermissive JSDoc says tests only. Deferred: the BE-003 doctor check that flags layerPermissive in production config (CLI program P17). Doc-only change; no smoke test covers the README snippet.
