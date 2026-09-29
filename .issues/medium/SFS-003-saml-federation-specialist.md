---
ID: "SFS-003"
Title: "No XML-signature port exists despite the spec sketch depending on one"
Level: medium
Category: "architecture"
Status: resolved
Package: "—"
Source: "spec/models/10-saml.md:43"
Auditor: "saml-federation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SFS-003 — No XML-signature port exists despite the spec sketch depending on one

`MEDIUM` · `architecture` · `—` · reported by **SAML Federation Specialist** (`saml-federation-specialist`)

Status: **resolved**

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

**Resolved (2026-09-29):** Built the XmlSignature port and the SP-only SAML plugin. Port: packages/ports/src/XmlSignature.ts (verify({xml,trust,policy}) returns only the canonical bytes of the element a verified signature covers; VerifyPolicy: signedElements/exactlyOne/forbidden/maxBytes; TrustSet: certificates by SHA-256 fingerprint with notBefore/notAfter for rotation overlap; typed XmlSignatureError reasons; layerUnavailable placeholder). Adapter: packages/saml/src/XmlSignatureNode.ts over xml-crypto 6.3.2 (pinned) + SafeXml.ts (size cap, no DOCTYPE/ENTITY/comments/PIs, strict parse, depth cap). Library evaluation recorded in ADR-EA-023 rev 1.1 Decision 3: xml-crypto adopted (5.3M/wk, three CRITICAL advisories all fixed by 6.0.1, none open, depends on patched xmldom 0.8.15); node-saml and samlify rejected (would put their validation chain on the trust boundary; recent CRITICAL/HIGH advisories). Hardening around the library: unique IDs, one Reference #ID only, Signature must be the signed element's child, transforms limited to enveloped+exc-c14n (XSLT/XPath refused by name), RSA-SHA256/512 + SHA-256/512 only (no SHA-1/HMAC), getCertFromKeyInfo disabled, every KeyInfo certificate must be pinned, pinning by fingerprint within validity window, every signature must verify, library registries pruned. Plugin (packages/saml): SP metadata, AuthnRequest (redirect binding), ACS with the full BEH-EA-238..245 chain, browser-bound request state cookie (__Host-saml-request, single-consume), one-time assertion ids, per-organization connections (saml_connection + unique-domain table, SamlConnectionStore with metadata import, RSA>=2048 certs, https SSO URL, trustsEmail linking flag), sessions issued as the organization's tenant, uniform SamlAssertionRejected with reasons only in logs and auth.user.signInFailed(assertionInvalid). Tests: 94 in packages/saml incl. the XSW corpus (XSW-1..8 shapes, duplicate IDs, cert-list trick, algorithm downgrades, transforms, XXE/comments/PIs/size/depth, cardinality-off defence in depth), ACS chain end to end, real HTTP, records on memory+SQLite, assertion boundaries; spec/behaviors/29-saml-sp.md rev 1.1, spec/models/10-saml.md rev 1.2. Gates: typecheck clean, oxlint clean, spec:verify:strict, check:readmes, circular, package:smoke. Deferred (README 'Not built'): signed AuthnRequests, IdP-initiated login, SLO, encrypted assertions, HTTP CRUD for connections, role mapping, Sso dispatcher.
