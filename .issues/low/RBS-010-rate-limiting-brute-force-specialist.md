---
ID: "RBS-010"
Title: "Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads"
Level: low
Category: "api"
Status: resolved
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:45"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-010 — Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads

`LOW` · `api` · `ports` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **resolved**

## Summary

The port error carries {key, retryAfterMillis} while the wire error Api.RateLimited (packages/api/src/Api.ts:91-95, httpApiStatus 429) carries {retryAfterMillis} only, and both use the tag "RateLimited". Effect.catchTag is tag-keyed, so any effect scope whose error channel contains both (plausible once plugins compose plugins or a handler maps the port error while a nested service fails with it) cannot disambiguate the two, and today every mapping site (Password.ts:464-466, OAuth.ts:514-516) relies on the port error being the only RateLimited in scope. The port's `key` field also leaks the raw bucket key (which embeds user emails) to any internal consumer that logs it.

## Evidence

Source: `packages/ports/src/RateLimiter.ts:45`

```
export class RateLimited extends Data.TaggedError("RateLimited")<{
```

## Recommended fix

Rename the port's tag (e.g. RateLimitExceeded) or namespace wire tags per group; drop `key` from the port error or reduce it to a non-identifying hash so internal logging cannot capture emails.

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
- [`RBS-004` — Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists](medium/RBS-004-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`RBS-009` — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows](low/RBS-009-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- … 1 more findings touch `packages/ports/src/RateLimiter.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `ratelimit-signal-and-escalation`. Evidence at HEAD ec065a7: `packages/ports/src/RateLimiter.ts:45`. Fix: Rename the port error and drop its raw key. (effort S). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Renamed the port error to RateLimitExceeded (tag 'RateLimitExceeded', only retryAfterMillis; key dropped) in packages/ports/src/RateLimiter.ts; updated catchTag sites in packages/password/src/Password.ts and packages/oauth/src/OAuth.ts (1-line each) and comments in api/core; BEH-EA-106 prose clarifies wire vs port error. Test: packages/ports/test/RateLimiter.test.ts (red: tag was 'RateLimited'). Gates: typecheck (only pre-existing react TS2883), test 827, bdd 104, spec:verify 19/19.
