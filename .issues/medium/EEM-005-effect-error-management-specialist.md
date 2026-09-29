---
ID: "EEM-005"
Title: "ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable"
Level: medium
Category: "api"
Status: ready-for-agent
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:93"
Auditor: "effect-error-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EEM-005 — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable

`MEDIUM` · `api` · `qadi` · reported by **Effect Typed Error Management Specialist** (`effect-error-management-specialist`)

Status: **ready-for-agent**

## Summary

ReauthRequired is a qadi-internal Data.TaggedError; no Schema.TaggedError, HttpApi contract error, or HTTP mapping for it exists anywhere in the packages (verified by grep). On Path B the wire outcome is qadi's own mapping — UndischargedObligation answers 403 with an empty body, the identical status/body as AccessDenied — so maxAgeSeconds and even the fact that this is a reauth (rather than a permission) denial are destroyed at the boundary. A browser client literally cannot implement the comment's promised prompt from the observable surface. (awthaq must not override qadi's Path-B mapping per BEH-EA-160, so the fix belongs in awthaq's own contract/Path-A layer.)

## Evidence

Source: `packages/qadi/src/Resolvers.ts:93`

```
export class ReauthRequired extends Data.TaggedError("ReauthRequired")<{
  readonly maxAgeSeconds: number;
}> {}
```

## Recommended fix

Give obligation outcomes a typed wire representation — e.g. a ReauthRequired Schema.TaggedError (403, { maxAgeSeconds }) on the contracts where handlers run obligations, or at minimum a distinct status — so the client-side prompt BEH-EA-165 promises is decodable.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 77/100), domain: typed error discipline
- Full dossier: [`effect-error-management-specialist`](../../.reports/effect-error-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 35 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-001` — reauth obligation measures session-mint age with no authenticatedAt and no discharge path](high/AAPS-001-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-002` — Multiple AttributeResolver producers compose by silent shadowing, not merge](high/AAPS-002-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-004` — One store round trip per attribute reference, no per-evaluation memoization](medium/AAPS-004-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`ALF-001` — BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only](high/ALF-001-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`ESS-002` — The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only](high/ESS-002-effect-stream-specialist.md) `_(effect-stream-specialist, high)_`
- [`FAMS-004` — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent](medium/FAMS-004-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`TS-001` — Reauth obligation handler silently discharges a malformed obligation](medium/TS-001-torin-sandall.md) `_(torin-sandall, medium)_`
- [`TS-002` — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable](medium/TS-002-torin-sandall.md) `_(torin-sandall, medium)_`
- … 1 more findings touch `packages/qadi/src/Resolvers.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-bridge-hardening`. Evidence at HEAD ec065a7: `packages/qadi/src/Resolvers.ts:100`. Fix: Give the reauth obligation a shared, wire-decodable error in @awthaq/api and use it from qadi's handler (Path A); document Path B's qadi-owned mapping. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
