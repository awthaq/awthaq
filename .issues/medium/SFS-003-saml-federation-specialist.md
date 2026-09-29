---
ID: "SFS-003"
Title: "No XML-signature port exists despite the spec sketch depending on one"
Level: medium
Category: "architecture"
Status: ready-for-agent
Package: "—"
Source: "spec/models/10-saml.md:43"
Auditor: "saml-federation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SFS-003 — No XML-signature port exists despite the spec sketch depending on one

`MEDIUM` · `architecture` · `—` · reported by **SAML Federation Specialist** (`saml-federation-specialist`)

Status: **ready-for-agent**

## Summary

packages/ports ships eight capability ports (PasswordHasher, Mailer, RateLimiter, Encryption, KeyProvider, SqlTransaction, WebAuthn, and friends) and none covers asymmetric signature verification or X.509 trust chains; the closest, KeyProvider, is a symmetric AES-256 env-backed single-kid seam for encryption at rest. SAML needs metadata-or-explicit certificate ingestion, canonicalization, XML-DSig verification of the assertion against the IdP cert set, and rotation-aware key selection — none of it designed, per the spec row's own admission.

## Evidence

Source: `spec/models/10-saml.md:43`

```
const signer = yield* SamlSigner        // port: XML signature verification/signing, not yet designed
```

## Recommended fix

Design the port before any plugin code: fused parse+verify (no well-formed-but-unverified intermediate state), external-entity resolution disabled inside the port, canonicalization invisible to callers, cert set keyed for overlap-window rotation, following the existing ports convention (plugin depends on the port, never an implementation).

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: SAML Federation
- Full dossier: [`saml-federation-specialist`](../../.reports/saml-federation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`SFS-001` — SAML support is entirely absent; OAuth2/OIDC is the only federation surface](info/SFS-001-saml-federation-specialist.md) `_(saml-federation-specialist, info)_`
- [`SFS-007` — Spec row lists its gaps but omits canonicalization and signature-wrapping](info/SFS-007-saml-federation-specialist.md) `_(saml-federation-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `enterprise-federation-saml-scim`. Evidence at HEAD ec065a7: `spec/models/10-saml.md:43`. Fix: Design the `SamlSigner` port in spec before any plugin code, with fused parse+verify semantics, then implement it in packages/saml (port lives in @awthaq/ports per ADR-EA-010). (effort M). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Plan note (2026-09-29, P18):** the spec half is done and is what the acceptance criteria name: spec/models/10-saml.md now specifies the SamlSigner port contract (fused parse+verify returning only the signed assertion data, DTD/external entities disabled inside, exclusive C14N internal, algorithm allow-list refusing SHA-1, IdpTrustSet of certificates with notBefore/notAfter for rotation overlap, trustFromMetadata, optional sign), and ADR-EA-023 adopts it. Left open because the dossier code half (packages/ports/src/SamlSigner.ts service tag, packages/saml/src/SamlSignerLive.ts over a maintained XML-DSig library) is not built: it belongs with the @awthaq/saml package, needs a dependency to be vetted first, and adding an unused port tag now would be speculative infrastructure. First failing tests when it lands: XSW corpus, DOCTYPE/XXE rejection, previous-certificate overlap window.
