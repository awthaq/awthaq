---
ID: "AAPS-005"
Title: "DecisionCache has no TTL: cached verdicts can outlive an attribute change"
Level: medium
Category: "security"
Status: resolved
Package: "—"
Source: "node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/DecisionCache.ts:289"
Auditor: "abac-attribute-policy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AAPS-005 — DecisionCache has no TTL: cached verdicts can outlive an attribute change

`MEDIUM` · `security` · `—` · reported by **ABAC Attribute-Based Policy Specialist** (`abac-attribute-policy-specialist`)

Status: **resolved**

## Summary

The cache key covers the embedded subject, policy, resource, action and maxDepth — but not resolver-resolved attribute values, which are fetched at evaluation time and never re-fetched on a hit. A decision that turned on `emailVerified` (or organizationCount) stays servable after `users.verifyEmail` flips the flag: there is no TTL, eviction is optional FIFO by insertion order, and the only invalidation is a manual flush. The repo's own composition example (archive/design/usage-qadi.md:295) recommends `decisionCacheLayer({ capacity: 512 })`, which bounds memory but not staleness — a user who verifies their email keeps getting denied (or, for demoted attributes, allowed) for the cache's whole lifetime. The subject-bearing key shows qadi treats staleness as a security boundary elsewhere; attribute volatility is the gap.

## Evidence

Source: `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/DecisionCache.ts:289`

```
* **Unbounded by default** — `entries` is never evicted unless `capacity` is
* given.
```

## Recommended fix

Add a per-entry TTL option to decisionCacheLayer, or document loudly that attribute-dependent policies are cache-unsafe and give the application a flush hook fired by Users.verifyEmail/updateProfile (AuthEvents subscription is the natural carrier).

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: ABAC attributes & policy
- Full dossier: [`abac-attribute-policy-specialist`](../../.reports/abac-attribute-policy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`YL-007` — Per-request role-DAG walk with the engine's decision cache unwired](low/YL-007-yang-luo.md) `_(yang-luo, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `qadi-decision-cache-invalidation`. Evidence at HEAD ec065a7: `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/DecisionCache.ts:289`. Fix: No TTL (ADR-QD-031 / ticket 12). Close the part ticket 12 misses: awthaq-owned user attributes must also invalidate an application-scoped cache — add a user-attribute-change signal and tap it in DecisionCacheInvalidationLive. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New core observe hook Hooks.AfterUserAttributesChanged {userId, attributes} (in HooksLive), fired by Users.updateProfile (name) and Users.verifyEmail (emailVerified, only when it actually flips) on both layers; Users reads it through Effect.serviceOption so neither layer's RIn changes (a composition without it announces nothing). DecisionCacheInvalidationLive taps it (BEH prose/appendix note the coverage). No TTL added to qadi. Tests: qadi DecisionCacheInvalidation.test.ts 'a cached Deny on hasAttribute(emailVerified) becomes Allow after Users.verifyEmail' (with the app-scoped cache + bridge), core UserAttributesHookMemory.test.ts and UserAttributesHookSql.test.ts (announced once, none when already verified; one file per backend because HookPoint tap registries freeze). Touches packages/core Hooks.ts and Users.ts (P14 territory) minimally. Gates: tsc -b (only the pre-existing packages/react errors), tsconfig.test clean, pnpm test 929 pass, test:bdd green, spec:verify:strict PASS, oxlint (organization/qadi/roles) clean.
