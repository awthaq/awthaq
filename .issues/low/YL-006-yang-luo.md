---
ID: "YL-006"
Title: "No wildcard or pattern matching on permission keys"
Level: low
Category: "api"
Status: resolved
Package: "—"
Source: "node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Evaluate.ts:823"
Auditor: "yang-luo"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# YL-006 — No wildcard or pattern matching on permission keys

`LOW` · `api` · `—` · reported by **Yang Luo — Creator of Casbin** (`yang-luo`)

Status: **resolved**

## Summary

HasPermission is exact set membership; PermissionKey segments merely forbid ':' so '*' in a key is an inert literal, meaning 'docs:*' grants nothing. Casbin-style resource-path patterns (keyMatch2 '/api/*') and action families must be emulated by enumerating every concrete key into each role — workable for small catalogs, painful for hierarchical resources. Tellingly, the engine added wildcard semantics where it needed them for field-visibility specs (FieldPath.ts: 'dot-paths and wildcards over fields', including '**'), so the omission in permission matching is a choice, not an oversight.

## Evidence

Source: `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Evaluate.ts:823`

```
        subject.permissions.has(key)
```

## Recommended fix

Either add an explicit matchesPermission(node) with documented '*'/'**' segment semantics evaluated at check time, or keep exact matching and ship a catalog helper that expands patterns into concrete keys at role-definition time so intent is visible in the policy, not implicit in a matcher.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Authorization modeling
- Full dossier: [`yang-luo`](../../.reports/yang-luo/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`RRM-008` — No wildcard or namespace permission support anywhere in the model](info/RRM-008-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `roles-permission-modeling`. Evidence at HEAD ec065a7: `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Evaluate.ts:823`. Fix: Keep qadi's exact O(1) membership (deliberate engine design; no matcher change in ../qadi). Document the modeling boundary in @awthaq/roles and show definition-time expansion via qadi's `createPermissionGroup`, plus attribute policies for the 'wildcard instinct'. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Documented, no matcher change (qadi's exact O(1) membership stays): packages/roles/README.md states permission keys match exactly (no wildcards), shows definition-time expansion via @qadi/core's createPermissionGroup, and points the 'any action on this resource' instinct at attribute policies. Docs-only.
