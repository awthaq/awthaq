---
ID: "EP-007"
Title: "Per-tenant configuration mechanism designed but unimplemented"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "—"
Source: "spec/decisions/005-static-composition.md:39"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-007 — Per-tenant configuration mechanism designed but unimplemented

`MEDIUM` · `architecture` · `—` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **ready-for-agent**

## Summary

ADRs 005/006/011 consistently name the tenancy mechanism: `LayerMap.Service` composing per-tenant `Password.config(...)`/`Sessions.config(...)` Layers over the same `Context.Reference` (spec/decisions/006-runtime-config-separate-from-installation.md:31: 'multi-tenant configuration is `LayerMap` composed over the same `Context.Reference`'). A grep confirms `LayerMap` exists nowhere in packages/ — it lives only in spec text and the v4 substrate rationale. The design is the right one (no contract change needed), but today there is exactly one configuration reality per process, which caps the platform at one tenant.

## Evidence

Source: `spec/decisions/005-static-composition.md:39`

```
Not yet implemented — see spec/roadmap.md for milestone.
```

## Recommended fix

Promote the LayerMap per-tenant path from roadmap to a tracked milestone with an integration test proving two tenants with different `Password.config({ minLength })` in one composition — it is the cheapest credible demonstration that the tenancy claim is more than prose.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EP-001` — No tenant model exists; one static composition per process is the only deployment shape](high/EP-001-eugenio-pace.md) `_(eugenio-pace, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `multi-tenant-composition`. Evidence at HEAD ec065a7: `spec/decisions/005-static-composition.md:39`. Fix: Make per-tenant configuration real: plugins read their config Reference per operation (not once at Layer build), and a `TenantConfig` LayerMap.Service keyed by tenant id supplies each tenant's config Layers, provided per request by the tenant middleware — ADR-005/006's own prescription. (effort L). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
