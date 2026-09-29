---
ID: "KRS-008"
Title: "No rotation runbook in spec/decisions and the model doc contradicts the shipped implementation"
Level: medium
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/models/08-jwt-bearer.md:80"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-008 — No rotation runbook in spec/decisions and the model doc contradicts the shipped implementation

`MEDIUM` · `docs` · `—` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **ready-for-agent**

## Summary

spec/decisions contains sixteen decision records, none covering signing-key rotation; the actual design (publish new key, old key keeps verifying until rotatedAt + gracePeriod, then disappears from JWKS) is documented only in .scratch/jwt/issues/11-key-rotation.md, a scratch location an operator would never consult. Worse, the spec model page still asserts the implementation does not exist at all — an auditor or operator reading spec/ alongside the code receives opposite claims. Emergency-versus-routine rotation procedures, grace-window sizing rationale, and KeyProvider rotation guidance all have no spec-level home.

## Evidence

Source: `spec/models/08-jwt-bearer.md:80`

```
Everything: no `Jwt` or `Bearer` plugin class exists, no `JwtApi`/`BearerApi` contract, no signer, no JWKS endpoint, no key-rotation implementation, no test.
```

## Recommended fix

Add a spec/decisions record for signing-key rotation (sequence, window sizing vs max token TTL, emergency rotateNow procedure and what it sacrifices) and update 08-jwt-bearer.md's 'What is missing' to reflect the shipped KeyRing.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MAPS-009` — spec/models/08-jwt-bearer.md describes the shipped Jwt plugin as nonexistent](medium/MAPS-009-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`VB-007` — JWT bearer spec claims the plugin does not exist; docs lag the code](low/VB-007-vittorio-bertocci.md) `_(vittorio-bertocci, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-key-rotation-runbook`. Evidence at HEAD ec065a7: `spec/models/08-jwt-bearer.md:80`. Fix: Add ADR-EA-017 'JWT signing-key rotation' (routine vs emergency, grace sizing vs max token TTL, multi-process visibility), give emergency rotation a real retire-immediately knob in code, and rewrite spec/models/08-jwt-bearer.md to the shipped Jwt plugin (absorbing MAPS-009's dependsOn:[] divergence and VB-007's remaining typ/audience deltas). (effort M). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
