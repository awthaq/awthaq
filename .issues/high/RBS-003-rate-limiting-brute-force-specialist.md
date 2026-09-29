---
ID: "RBS-003"
Title: "Memory store never evicts buckets whose keys are attacker-controlled — unauthenticated memory-DoS"
Level: high
Category: "security"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:124"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-003 — Memory store never evicts buckets whose keys are attacker-controlled — unauthenticated memory-DoS

`HIGH` · `security` · `ports` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **ready-for-agent**

## Summary

layerStoreMemory's Ref starts empty and entries are only ever overwritten, never deleted: an expired bucket is reclaimed only if that exact key is seen again. Every enforced key embeds unauthenticated request data — `password:signin:${email}` (Password.ts:517), `password:reset-confirm:${identifier}` where identifier is decoded from an attacker-supplied token (Password.ts:629), `oauth:callback:${ip ?? "unknown"}` (OAuth.ts:509) — so a for-loop spraying arbitrary emails/identifiers grows the map one entry per request for the lifetime of the long-lived server process. On the single-instance memory deployment this codebase actually ships (layerStoreMemory is the only store that exists), this is an unauthenticated remote memory-exhaustion vector reachable through the very endpoints the limiter protects.

## Evidence

Source: `packages/ports/src/RateLimiter.ts:124`

```
return [next, HashMap.set(state, key, next)];
```

## Recommended fix

Sweep expired buckets opportunistically (e.g. on insert when map size crosses a threshold, or a scheduled pass), or bound the map with an LRU cap sized to expected key cardinality; the sweep logic belongs in layerStoreMemory, not in consume, so a future Redis/SQL store inherits nothing.

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
- [`RBS-004` — Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists](medium/RBS-004-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`RBS-009` — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows](low/RBS-009-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- [`RBS-010` — Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads](low/RBS-010-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- … 1 more findings touch `packages/ports/src/RateLimiter.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/ports/src/RateLimiter.ts:124` matches the evidence exactly; `layerStoreMemory`'s `Ref.modify` only ever overwrites `HashMap.set(state, key, next)`, with no eviction/sweep logic anywhere in the file, and every enforced key does embed attacker-controlled input (`Password.ts:517`, `Password.ts:629`, `OAuth.ts` IP key). This is the only rate-limiter store shipped in the repo. Fix (opportunistic sweep or LRU cap) is well-scoped. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `ratelimit-memory-eviction`. Evidence at HEAD ec065a7: `packages/ports/src/RateLimiter.ts:114`. Fix: Bound layerStoreMemory: periodic expiry sweep + hard cap, with an observable size. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`.
