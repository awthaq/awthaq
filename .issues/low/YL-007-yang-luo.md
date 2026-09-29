---
ID: "YL-007"
Title: "Per-request role-DAG walk with the engine's decision cache unwired"
Level: low
Category: "performance"
Status: resolved
Package: "—"
Source: "node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/DecisionCache.ts:2"
Auditor: "yang-luo"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# YL-007 — Per-request role-DAG walk with the engine's decision cache unwired

`LOW` · `performance` · `—` · reported by **Yang Luo — Creator of Casbin** (`yang-luo`)

Status: **resolved**

## Summary

Roles.resolve calls fromRoles on every UserPrincipal resolution, and flattenAll walks the whole inherited DAG per request; the spec mandates exactly this (flatten once per resolution, checks are O(1) membership — BEH-EA-139, verified in code), but the engine's DecisionCache — with hit/coalesced/miss single-flight paths built precisely to amortize repeated evaluations — is optional and referenced nowhere in packages/ or examples/, so every deny-heavy request pays full resolution plus evaluation from scratch. Correct today; a known, already-built lever left unpulled as catalogs and policies grow.

## Evidence

Source: `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/DecisionCache.ts:2`

```
 * An optional, caller-scoped cache for repeated identical questions.
```

## Recommended fix

Wire decisionCacheLayer into the example server's QadiLive composition and document its invalidation boundary (caller-scoped, per the engine's own contract); for the resolver itself, consider memoizing flattenAll per (userId, assignments-version) inside the roles plugin when catalogs are static.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Authorization modeling
- Full dossier: [`yang-luo`](../../.reports/yang-luo/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-005` — DecisionCache has no TTL: cached verdicts can outlive an attribute change](medium/AAPS-005-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `qadi-decision-cache-invalidation`. Duplicate of `PCS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/roles/src/Roles.ts:198`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
