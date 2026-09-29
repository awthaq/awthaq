---
ID: "PCS-004"
Title: "Decision cache has no TTL or staleness upper bound: FIFO capacity eviction only"
Level: medium
Category: "security"
Status: needs-triage
Package: "qadi"
Source: "packages/qadi/node_modules/@qadi/core/src/DecisionCache.ts:289"
Auditor: "permission-caching-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PCS-004 — Decision cache has no TTL or staleness upper bound: FIFO capacity eviction only

`MEDIUM` · `security` · `qadi` · reported by **Permission Caching Specialist** (`permission-caching-specialist`)

Status: **needs-triage**

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
