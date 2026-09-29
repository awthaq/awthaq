---
ID: "RRM-008"
Title: "No wildcard or namespace permission support anywhere in the model"
Level: info
Category: "architecture"
Status: resolved
Package: "—"
Source: "node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Evaluate.ts:823"
Auditor: "rbac-role-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRM-008 — No wildcard or namespace permission support anywhere in the model

`INFO` · `architecture` · `—` · reported by **RBAC Role Modeling Specialist** (`rbac-role-modeling-specialist`)

Status: **resolved**

## Summary

PermissionKey is an exact resource:action string (Permission.ts:18-21, SEGMENT_PATTERN forbids colons in segments) and HasPermission is plain set membership, so there is no project:* or resource:* convention. For a growing multi-tenant product this is the canonical path to role explosion — every new resource and action must be enumerated into every role that touches it, the exact failure mode this persona exists to prevent. The intended escape hatch (attribute policies via qadi's matcher DSL) exists but nothing in the awthaq roles plugin or its docs points modeling decisions at that boundary.

## Evidence

Source: `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Evaluate.ts:823`

```
        subject.permissions.has(key)
          ? allow("HasPermission", policy.fields)
          : deny("HasPermission", `subject lacks permission '${key}'`),
```

## Recommended fix

State the boundary explicitly in the roles README (enumerate exact keys in roles; reach for qadi attribute policies when a wildcard instinct appears), and if scale demands it, add a documented wildcard convention at flatten time rather than at check time so the O(1) membership property survives.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: RBAC role modeling
- Full dossier: [`rbac-role-modeling-specialist`](../../.reports/rbac-role-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`YL-006` — No wildcard or pattern matching on permission keys](low/YL-006-yang-luo.md) `_(yang-luo, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `roles-permission-modeling`. Duplicate of `YL-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Evaluate.ts:823`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
