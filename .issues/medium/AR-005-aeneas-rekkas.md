---
ID: "AR-005"
Title: "Rate limiting is per-process and identity-keyed only; the quickstart ships it disabled"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:111"
Auditor: "aeneas-rekkas"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AR-005 — Rate limiting is per-process and identity-keyed only; the quickstart ships it disabled

`MEDIUM` · `architecture` · `ports` · reported by **Aeneas Rekkas — Founder/CEO of Ory** (`aeneas-rekkas`)

Status: **ready-for-agent**

## Summary

layerStoreMemory is a plain in-process Ref (header comment: 'a plain in-process Ref'), so behind N replicas each instance gets its own budget — effective limits scale by node count. All shipped rules key on email alone ('this codebase has no client-IP-extraction mechanism anywhere yet', packages/password/src/Password.ts:146-147), so distributed credential stuffing across IPs is unthrottled, and session/userAgent records capture no IP for audit either. Worse, the README's Postgres quickstart wires 'RateLimiter | layerPermissive (no real limiting)' (README.md:216) — the canonical deployment path ships brute-force protection off.

## Evidence

Source: `packages/ports/src/RateLimiter.ts:111`

```
export const layerStoreMemory: Layer.Layer<RateLimiterStore> = Layer.effect(
```

## Recommended fix

Ship a RateLimiterStore over the existing SQL port (the atomic increment contract is already specified), thread remote address into the request context the way the OAuth callback already does (packages/oauth/src/OAuth.ts:332), and change the quickstart default to the real fixed-window layer over the same Postgres client the example already creates.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Platform & API posture
- Full dossier: [`aeneas-rekkas`](../../.reports/aeneas-rekkas/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSD-007` — Only in-process rate-limit store ships — multi-replica deployments multiply every limit by node count](medium/CSD-007-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, medium)_`
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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `ratelimit-distributed-store`. Already fixed by commit 349e220. Evidence at HEAD ec065a7: `README.md:216`. Fix: Close when RBS-004 and NHS-005 land; no additional code. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.
