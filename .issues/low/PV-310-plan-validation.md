---
ID: "PV-310"
Title: "PermissionEngine.canGrant/hasPermission/mergeStatements throw (500) for a resource named like an Object.prototype member"
Level: low
Category: "correctness"
Status: resolved
Package: "organization"
Source: "packages/organization/src/PermissionEngine.ts:114"
Auditor: "property-testing"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-310 — PermissionEngine.canGrant/hasPermission/mergeStatements throw (500) for a resource named like an Object.prototype member

`LOW` · `correctness` · `organization` · found by the ETVS-002 property tests (P20a), not in the original audit

Status: **resolved**

## Summary

`Statements` is a `Record<string, ReadonlyArray<string>>` whose keys come from a dynamic role's `permission` payload (`createRole`/`updateRole`, `Organization.ts` -> `canGrant`). The engine looked a resource up with a plain index (`granterPermissions[resource] ?? []`), so a resource named `constructor`, `toString`, `hasOwnProperty`, `valueOf` or `__proto__` returned the inherited function/prototype instead of "nothing held", and `.includes` / the array spread then threw a `TypeError`. The request became a defect (HTTP 500) instead of a typed `RolePermissionEscalation` (or a grant, when the caller genuinely holds that resource).

It fails closed (nothing is granted by the throw), so this is a robustness defect, not an escalation. `mergeStatements` had the same shape and also assigned through `merged[resource]`, which for `__proto__` would set the prototype rather than a key.

## Evidence

`PermissionEngine.canGrant({ constructor: ["x"] }, {})` threw `TypeError: held.includes is not a function`; `hasPermission({}, "toString", "x")` threw; `mergeStatements({}, { constructor: ["x"] })` threw `existing is not iterable` (all reproduced before the fix, for the five names above).

## Comments

**Resolved (2026-09-29, P20a):** `PermissionEngine.ts` reads a resource's actions through an own-property helper (`actionsOn`, `Object.hasOwn`) in `canGrant`, `hasPermission` and `mergeStatements`, and `mergeStatements` writes with `Object.defineProperty` so `__proto__` is an ordinary key. Regression: `packages/organization/test/PermissionEngine.property.test.ts` ("PV-310: ... never throw for any resource name ..."), which fails against the previous code.
