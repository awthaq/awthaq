---
ID: "EOTS-007"
Title: "Rate-limit breaches emit no event, log, or metric"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:45"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-007 — Rate-limit breaches emit no event, log, or metric

`MEDIUM` · `security` · `ports` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **ready-for-agent**

## Summary

Exceeding a limit fails the request with the typed `RateLimited` error (carrying `retryAfterMillis`) and nothing else. The 25-tag `AuthEvent` union has no rate-limit tag, neither port nor core's rule registry logs or counts breaches, and no metric tracks bucket saturation — so a distributed brute-force attempt that stays under per-email thresholds, or an attacker rotating identifiers, leaves zero server-side signal. For an auth runtime whose sign-in paths are the primary target of exactly this traffic, breach visibility is a first-class observability requirement (persona: 'login failure rate' metrics).

## Evidence

Source: `packages/ports/src/RateLimiter.ts:45`

```
export class RateLimited extends Data.TaggedError("RateLimited")<{
```

## Recommended fix

Publish a `auth.ratelimit.exceeded` event (rule id + key bucket class, never the raw key which can be attacker-controlled per BEH-EA-108) or at minimum document that breach visibility is wholly the host's responsibility.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: observability & tracing
- Full dossier: [`effect-observability-tracing-specialist`](../../.reports/effect-observability-tracing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-005` — Rate limiting is per-process and identity-keyed only; the quickstart ships it disabled](medium/AR-005-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CSD-007` — Only in-process rate-limit store ships — multi-replica deployments multiply every limit by node count](medium/CSD-007-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
- [`ERS-004` — Memory rate-limiter store never evicts buckets: unbounded growth in a long-lived process](medium/ERS-004-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, medium)_`
- [`NHS-005` — Canonical quickstart wires a no-op rate limiter while the contract advertises 429s](medium/NHS-005-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, medium)_`
- [`RBS-003` — Memory store never evicts buckets whose keys are attacker-controlled — unauthenticated memory-DoS](high/RBS-003-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, high)_`
- [`RBS-004` — Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists](medium/RBS-004-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`RBS-009` — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows](low/RBS-009-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- [`RBS-010` — Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads](low/RBS-010-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- … 1 more findings touch `packages/ports/src/RateLimiter.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `ratelimit-signal-and-escalation`. Evidence at HEAD ec065a7: `packages/ports/src/RateLimiter.ts:45`. Fix: Emit an auth.rateLimit.exceeded event, a warning log and a counter on every breach, via one shared helper. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
