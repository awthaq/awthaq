---
ID: "RBS-009"
Title: "Fixed-window algorithm plus zero escalation: attacker cost never rises across windows"
Level: low
Category: "security"
Status: resolved
Package: "ports"
Source: "packages/ports/src/RateLimiter.ts:121"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-009 — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows

`LOW` · `security` · `ports` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **resolved**

## Summary

The store implements a plain fixed window (spec-accepted, including its documented 2x-limit burst across a boundary), and nothing in the codebase layers exponential backoff, progressive delay, lockout, or CAPTCHA escalation on top: every 15-minute window an attacker gets a fresh full 5-attempt budget at the same cost, and the same fixed cadence lets them hold a victim's bucket permanently full with 5 requests per window. retryAfterMillis (clamped at RateLimiter.ts:95-98, TestClock-tested in RateLimiter.test.ts:38-47) at least lets legitimate clients back off cleanly. This is a deliberate simplicity choice worth recording, not a bug — but it defines the ceiling of the brute-force resistance.

## Evidence

Source: `packages/ports/src/RateLimiter.ts:121`

```
Option.isSome(existing) && DateTime.isLessThan(now, existing.value.resetAt)
              ? { count: existing.value.count + 1, resetAt: existing.value.resetAt }
```

## Recommended fix

Track consecutive-limited windows per key in the plugin (not the store) and grow retryAfterMillis geometrically, or require a CAPTCHA step after N consecutive limited windows; keep it as an opt-in config so the default stays simple.

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
- [`RBS-010` — Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads](low/RBS-010-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, low)_`
- … 1 more findings touch `packages/ports/src/RateLimiter.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `ratelimit-signal-and-escalation`. Evidence at HEAD ec065a7: `packages/ports/src/RateLimiter.ts:121`. Fix: Opt-in per-rule exponential escalation. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Opt-in escalation. ports RateLimiter.ts: Escalation {factor, maxPenalty} on ConsumeInput; RateLimiterStore gains read-only peek(key) (memory + SQL implementations); layer's consumeEscalating: blocked callers refused without touching the plain bucket, one strike per window (request crossing limit+1), penalty = window*factor^(strikes-1) capped at maxPenalty held as a block bucket, retryAfterMillis = max(remaining window, penalty); strike/block keys namespaced under 'ratelimit-escalation:' so caller-chosen keys cannot name another key's block row. core RateLimits RuleInput.escalation and EnforceInput.escalation pass-through. Tests: ports RateLimiter.test.ts (doubling, cap, unchanged default; red first: 10000 != 20000), sql RateLimiterStoreSql.test.ts (peek, end-to-end escalation). BEH-EA-105 spec addendum. Deferred: no plugin-shipped rule enables it (Password RATE_LIMITS unchanged; an app opts in per rule) and no PasswordConfig knob yet. Gates: typecheck (pre-existing react TS2883 only), test 843, bdd 104, spec:verify 19/19.
