---
ID: "VB-007"
Title: "JWT bearer spec claims the plugin does not exist; docs lag the code"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/models/08-jwt-bearer.md:80"
Auditor: "vittorio-bertocci"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# VB-007 — JWT bearer spec claims the plugin does not exist; docs lag the code

`LOW` · `docs` · `—` · reported by **Vittorio Bertocci — Token-Based Identity Protocol Expert** (`vittorio-bertocci`)

Status: **resolved**

## Summary

The spec's What is missing section contradicts the implemented packages/jwt (full plugin, JWKS endpoint, rotation, tests), and the spec's design intent is in fact largely realized: JWT as an additive transport, bearer routed through the same resolution surface as cookies (Q61), sid claims for live checks. The stale text matters because it is the only place documenting the intended consumption story for minted tokens, and the one verifiable spec requirement not yet implemented (typ validation) is invisible as a gap when the doc claims everything is missing.

## Evidence

Source: `spec/models/08-jwt-bearer.md:80`

```
Everything: no `Jwt` or `Bearer` plugin class exists, no `JwtApi`/`BearerApi` contract, no signer, no JWKS endpoint, no key-rotation implementation, no test.
```

## Recommended fix

Update spec/models/08-jwt-bearer.md to describe the shipped Jwt plugin, the bearer-is-session-secret decision, and the remaining typ/audience deltas as open items.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: token architecture
- Full dossier: [`vittorio-bertocci`](../../.reports/vittorio-bertocci/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`KRS-008` — No rotation runbook in spec/decisions and the model doc contradicts the shipped implementation](medium/KRS-008-key-rotation-specialist.md) `_(key-rotation-specialist, medium)_`
- [`MAPS-009` — spec/models/08-jwt-bearer.md describes the shipped Jwt plugin as nonexistent](medium/MAPS-009-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `jwt-key-rotation-runbook`. Duplicate of `KRS-008` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/models/08-jwt-bearer.md:80`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.
