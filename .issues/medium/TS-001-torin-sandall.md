---
ID: "TS-001"
Title: "Reauth obligation handler silently discharges a malformed obligation"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:126"
Auditor: "torin-sandall"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-001 — Reauth obligation handler silently discharges a malformed obligation

`MEDIUM` · `correctness` · `qadi` · reported by **Torin Sandall — Co-creator of Open Policy Agent (OPA)** (`torin-sandall`)

Status: **ready-for-agent**

## Summary

The handler dies loudly on an unknown obligation id (fail-closed against wiring mistakes) but silently returns — i.e. discharges the step-up requirement — when a reauth obligation carries a missing or non-numeric maxAgeSeconds attribute. A policy authoring error (the classic PDP/PEP contract drift) converts a mandatory re-authentication gate into an unconditional pass. In policy-engine terms the PEP must fail closed on any obligation it cannot interpret; an uninterpretable obligation is a deny, not an allow.

## Evidence

Source: `packages/qadi/src/Resolvers.ts:126`

```
const maxAgeSeconds = obligations
  .map((duty) => duty.attributes["maxAgeSeconds"])
  .find((value): value is number => typeof value === "number");
if (maxAgeSeconds === undefined) return;
```

## Recommended fix

When the obligation id matches but no numeric maxAgeSeconds is found, fail with ReauthRequired (or die like the unknown-id branch) instead of returning; add a regression test for a reauth duty with attributes: {}.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Authorization architecture
- Full dossier: [`torin-sandall`](../../.reports/torin-sandall/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-001` — reauth obligation measures session-mint age with no authenticatedAt and no discharge path](high/AAPS-001-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-002` — Multiple AttributeResolver producers compose by silent shadowing, not merge](high/AAPS-002-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-004` — One store round trip per attribute reference, no per-evaluation memoization](medium/AAPS-004-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`ALF-001` — BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only](high/ALF-001-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`EEM-005` — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable](medium/EEM-005-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-002` — The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only](high/ESS-002-effect-stream-specialist.md) `_(effect-stream-specialist, high)_`
- [`FAMS-004` — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent](medium/FAMS-004-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`TS-002` — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable](medium/TS-002-torin-sandall.md) `_(torin-sandall, medium)_`
- … 1 more findings touch `packages/qadi/src/Resolvers.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-bridge-hardening`. Evidence at HEAD ec065a7: `packages/qadi/src/Resolvers.ts:135`. Fix: Fail closed on an uninterpretable reauth obligation, like the unknown-id branch already does. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
