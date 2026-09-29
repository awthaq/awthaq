---
ID: "FAMS-004"
Title: "No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent"
Level: medium
Category: "architecture"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:35"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-004 — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent

`MEDIUM` · `architecture` · `qadi` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **resolved**

## Summary

Firebase projects routinely drive security rules off per-user custom claims such as role: admin. In effect-auth the routing target is right — qadi, exactly as the persona requires, not ad hoc user fields — but the attribute resolver can only ever return the three fields UserRecord carries, there is no per-user claims/attributes table anywhere (grep for customClaims/setCustomUserClaims: zero hits), and the roles plugin's roles/permissions come from static plugin configuration rather than per-user data. Migrated claim-driven authorization therefore has nowhere to land: every user's effective roles would have to be baked into static RolesConfig at deploy time.

## Evidence

Source: `packages/qadi/src/Resolvers.ts:35`

```
 * BEH-EA-161: backed by `Users`, mapping only the attributes a `UserRecord`
 * actually carries (`email`, `emailVerified`, `name` — there is no `plan`
 * field on `UserRecord`, unlike the spec's own illustrative example, so this
```

## Recommended fix

Add a plugin-contributed per-user attribute/claims store (the plugin-field mechanism of BEH-EA-048 is the natural vehicle), extend the qadi AttributeResolver to read it, and document the Firebase customClaims -> qadi attributes / roles mapping as the official import path. JWT definePayload can then source claims from the same store.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-001` — reauth obligation measures session-mint age with no authenticatedAt and no discharge path](high/AAPS-001-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-002` — Multiple AttributeResolver producers compose by silent shadowing, not merge](high/AAPS-002-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-004` — One store round trip per attribute reference, no per-evaluation memoization](medium/AAPS-004-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`ALF-001` — BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only](high/ALF-001-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`EEM-005` — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable](medium/EEM-005-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-002` — The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only](high/ESS-002-effect-stream-specialist.md) `_(effect-stream-specialist, high)_`
- [`TS-001` — Reauth obligation handler silently discharges a malformed obligation](medium/TS-001-torin-sandall.md) `_(torin-sandall, medium)_`
- [`TS-002` — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable](medium/TS-002-torin-sandall.md) `_(torin-sandall, medium)_`
- … 1 more findings touch `packages/qadi/src/Resolvers.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `user-claims-store`. Evidence at HEAD ec065a7: `packages/qadi/src/Resolvers.ts:60`. Fix: Add an opt-in per-user claims store exposed to qadi as a namespaced attribute (pending decision), and document the Firebase import mapping. (effort M). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option 2 per plan; user may revisit. New packages/qadi/src/UserClaims.ts: an opt-in plugin like Roles (id claims, table claims_user with one dialect-branched migration, UserClaims.layer memory / layerSql, no HTTP contract) with get/set/merge/delete per user (merge is shallow, a null value deletes a key; the SQL read-modify-write is one transaction). A real change publishes the new auth.user.claimsUpdated event (keys only, never values; actor recorded; AuditLog actor case added) and announces Hooks.AfterUserAttributesChanged for 'claims' so an app-scoped DecisionCache is flushed via DecisionCacheInvalidation. UserClaimsAttributes is an AttributeResolver answering the single attribute 'claims' (typed name via claimsAttr, UserClaimsAttributeNames for attributeResolverRegistry, so it cannot shadow UserAttributes; a store outage is AttributeResolveError). Placed in @awthaq/qadi (JWT definePayload can copy from UserClaims.get; documented). Firebase mapping documented in packages/qadi/README.md (role claims -> Roles.assign, everything else -> UserClaims). Tests (packages/qadi/test/UserClaims.test.ts, 15 tests, both layers): round-trips, shallow merge and null delete, per-user isolation, events with keys not values, resolver, a real qadi policy hasAttribute(claims, fieldMatch(plan, eq(pro))) flipping allow/deny as the claim changes, plugin composition, registry coexistence, hook announcement. No size cap by design (documented). qadi gains @effect/sql-sqlite-node as a dev dep so pnpm-lock.yaml changed.
