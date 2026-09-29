---
ID: "EP-009"
Title: "No operational artifact of effective configuration — an ADR-acknowledged multi-tenant blind spot"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "spec/decisions/006-runtime-config-separate-from-installation.md:33"
Auditor: "eugenio-pace"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# EP-009 — No operational artifact of effective configuration — an ADR-acknowledged multi-tenant blind spot

`LOW` · `dx` · `—` · reported by **Co-founder/former CEO of Auth0** (`eugenio-pace`)

Status: **resolved**

## Summary

The ADR itself concedes that answering 'what is Password's minLength in production, and did someone override Sessions' idle timeout for this tenant' requires reading the composition code (same line continues to exactly that example). In a one-app deployment that is a nit; the moment configuration varies per tenant, 'read the composition code' stops being an answer — an operator must be able to dump effective config per tenant for support and incident response. Auth0's own tenant settings UI/API exists precisely because this question is asked daily in support escalations.

## Evidence

Source: `spec/decisions/006-runtime-config-separate-from-installation.md:33`

```
**Negative**: There is no single artifact that lists "every configuration value this application has set,"
```

## Recommended fix

Have `Auth.make` return a machine-readable effective-config manifest (every Context.Reference's resolved value, redacting Redacted fields) alongside the existing `manifest`, and expose it on a guarded operator endpoint.

## Context

- Auditor verdict on this domain: **needs-work** (score 48/100), domain: multi-tenant SaaS readiness
- Full dossier: [`eugenio-pace`](../../.reports/eugenio-pace/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ECS-008` — doctor's config-validation mandate conflicts with ADR-006 and the no-Layer boundary](medium/ECS-008-effect-cli-specialist.md) `_(effect-cli-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `cli-doctor-hardening`. Duplicate of `ECS-008` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/decisions/006-runtime-config-separate-from-installation.md:33`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.
