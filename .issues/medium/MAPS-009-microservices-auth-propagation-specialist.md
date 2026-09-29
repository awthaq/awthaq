---
ID: "MAPS-009"
Title: "spec/models/08-jwt-bearer.md describes the shipped Jwt plugin as nonexistent"
Level: medium
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/models/08-jwt-bearer.md:80"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-009 — spec/models/08-jwt-bearer.md describes the shipped Jwt plugin as nonexistent

`MEDIUM` · `docs` · `—` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **resolved**

## Summary

The spec's ground truth is stale: packages/jwt ships a full implementation (sign/verify/verifyLive/signJWT/JWKS/mint, KeyRing rotation with 90-day interval and 30-day grace, a standalone lite verifier, and tests under packages/jwt/test). The doc also sketches Jwt with dependsOn: [Sessions] while the implementation deliberately inverts that (dependsOn: [], Jwt.ts:27-28) - a meaningful architectural divergence an integrator would misread. For a specialist deciding how services should verify tokens, trusting this doc means concluding the propagation story does not exist at all.

## Evidence

Source: `spec/models/08-jwt-bearer.md:80`

```
Everything: no `Jwt` or `Bearer` plugin class exists, no `JwtApi`/`BearerApi` contract, no signer, no JWKS endpoint, no key-rotation implementation, no test.
```

## Recommended fix

Update model 08 to Effective with the shipped surface, including the deliberate dependsOn: [] decision and the lite-verifier revocation limitation; the 'Bearer plugin' half remains genuinely unbuilt and should stay marked as such.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`KRS-008` — No rotation runbook in spec/decisions and the model doc contradicts the shipped implementation](medium/KRS-008-key-rotation-specialist.md) `_(key-rotation-specialist, medium)_`
- [`VB-007` — JWT bearer spec claims the plugin does not exist; docs lag the code](low/VB-007-vittorio-bertocci.md) `_(vittorio-bertocci, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `jwt-key-rotation-runbook`. Duplicate of `KRS-008` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/models/08-jwt-bearer.md:80`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.
