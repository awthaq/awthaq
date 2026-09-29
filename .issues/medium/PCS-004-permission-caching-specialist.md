---
ID: "PCS-004"
Title: "Decision cache has no TTL or staleness upper bound: FIFO capacity eviction only"
Level: medium
Category: "security"
Status: wontfix
Package: "qadi"
Source: "packages/qadi/node_modules/@qadi/core/src/DecisionCache.ts:289"
Auditor: "permission-caching-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PCS-004 — Decision cache has no TTL or staleness upper bound: FIFO capacity eviction only

`MEDIUM` · `security` · `qadi` · reported by **Permission Caching Specialist** (`permission-caching-specialist`)

Status: **wontfix**

## Summary

The cache's only disposal mechanisms are capacity-driven FIFO eviction (insertion order, not age-based) and a manual clear; there is no time-based expiry anywhere in the module, so an entry's staleness is bounded only by how long the process runs and how much traffic evicts it. This contradicts the repo's own caching discipline: ADR-EA-014 (spec/decisions/014-session-storage-backend-neutrality.md:27) requires any non-authoritative read-side session cache to carry a documented upper-bound TTL (~5-minute reference figure) precisely because better-auth's cookieCache shipped a revocation-lag caveat. A permission-decision cache accepted with no time bound at all is a weaker posture than the one the same project mandates for session reads.

## Evidence

Source: `packages/qadi/node_modules/@qadi/core/src/DecisionCache.ts:289`

```
 * **Unbounded by default** — `entries` is never evicted unless `capacity` is
 * given.
```

## Recommended fix

Add an optional per-entry or global TTL to decisionCacheLayer (time-checked on hit), and state in awthaq's docs that if the dependency ships no TTL, application-scope deployments must compensate with event-driven clear (PCS-002) — never capacity alone.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: decision caching
- Full dossier: [`permission-caching-specialist`](../../.reports/permission-caching-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `qadi-decision-cache-invalidation`. Evidence at HEAD ec065a7: `../qadi/packages/core/src/DecisionCache.ts:291`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`.

**Wontfix (2026-09-29):** Not implemented, deliberately. qadi's ADR-QD-031 rejects a TTL on the decision cache (a time-bounded cache needs a clock and therefore a determinism story against INV-QD-008, and 'stale for at most N seconds' is a claim about the caller's tolerance qadi cannot make); the scope is the caller's rather than the duration. awthaq closes the staleness hole a different way: the default wiring is a per-request cache (`RequestDecisionCacheLive`, PCS-001) which has no staleness window at all, and the opt-in app-scope cache is cleared by `DecisionCacheInvalidationLive` on every membership/role/hook event (PCS-002). Overriding an upstream ADR from this repo for a knob no awthaq wiring uses (a TTL is meaningless on a per-request cache) would be speculative. What a user who insists on an app-scope cache with a hard staleness bound does instead: keep the cache and run `DecisionCache.clear` on a schedule (`Effect.repeat(cache.clear, Schedule.spaced(Duration.seconds(5)))` in a scoped layer), or open the upstream ADR in ../qadi.
