# ADR-EA-023: Enterprise Federation Ships as Two First-Party Packages — `saml` (SP Only) and `scim` (Inbound) — Behind a Thin `Sso` Dispatcher

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-023 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — SCIM and SAML (SP) implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (AOMS-009, CWM-002, SFS-003, SFS-006, SFS-007; wayfinder tickets 08 and 18). The plan proposed ADR-EA-019, which [ADR-EA-019](019-encryption-key-rotation.md) already holds. <br> 1.1 (2026-09-29): SAML is built; the port is `XmlSignature` (generic XML-DSig) rather than `SamlSigner`, verified over `xml-crypto`, with the library evaluation recorded in Decision 3 (SFS-003) |

---

## Context

Enterprise buyers of a self-hosted auth runtime routinely gate the purchase on SAML single sign-on and SCIM directory sync, and both were "Planned-Phase3, no code, no design" in the adoption matrix. Wayfinder ticket 08 made the scope call: pull the *relying-party* direction (SP-initiated SAML, inbound SCIM provisioning) forward from "unscheduled Phase 3" to "scheduled, sequenced now", keep awthaq as an identity provider (E5) out of scope, and sequence the substrate before the protocol. Ticket 18 ([ADR-EA-018](018-tenancy-is-an-organization.md)) added the tenant model those packages hang off: an organization owns its connections.

## Decision

**1. Two packages, each an `AuthPlugin.Service`** ([ADR-EA-008](008-plugin-is-context-service-class.md)), not extensions of `@awthaq/oauth` or `@awthaq/organization`: SAML's XML-signature verification and SCIM's resource-schema mapping are large, protocol-specific concerns and get their own package boundary, as every other protocol already has.

- **`@awthaq/scim`** — an inbound RFC 7644 provisioning server (awthaq is the receiving end of a directory sync). **Implemented.**
- **`@awthaq/saml`** — a SAML 2.0 *service provider* only: it consumes IdP assertions, it never issues them. **Implemented** (`spec/models/10-saml.md`, `spec/behaviors/29-saml-sp.md`): SP metadata, SP-initiated login, the ACS with the full validation chain, per-organization connections routed by email domain, the sign-in acting as the connection's organization (the tenant).

**2. Substrate before protocol.** SCIM stands on state that already exists: the user `status` (`Users.setStatus`, `Users.assertCanSignIn`, wayfinder ticket 09) and `Sessions.revokeAll`. Its one new table pair, `scim_connection` and `scim_resource` (the connection's ownership-and-external-id mapping), is owned by the `scim` package, so no SCIM concept leaks into `@awthaq/core`. SAML needs a `saml_connection` table and an XML-signature port, both new.

**3. The `XmlSignature` port (SFS-003).** A port in `@awthaq/ports` ([ADR-EA-010](010-plugins-require-ports-never-provide.md): the plugin requires it, the application provides it), not part of the plugin, because XML-DSig is exactly the code a deployment may want to swap or sandbox. It is generic XML-DSig (it was drafted as a SAML-shaped `SamlSigner`; reading an assertion is the plugin's job, over what the port returns). Its contract fuses *parse and verify*: `verify({ xml, trust, policy })` takes the raw document and returns only the canonical bytes of the element a verified signature covers — no unverified intermediate DOM ever escapes, DTDs, external entities, comments and processing instructions are refused inside the port, canonicalization is exclusive C14N handled internally, the algorithm and transform allow-list refuses SHA-1, HMAC, XSLT and XPath, and the trust set (certificates keyed by fingerprint with `notBefore`/`notAfter`) carries the rotation overlap window. The contract is in `spec/models/10-saml.md`; the ordered validation chain that surrounds it is `spec/behaviors/29-saml-sp.md` (SFS-007).

*The implementation, and why this library.* The production adapter (`XmlSignatureNode`, in `@awthaq/saml`) wraps **`xml-crypto` 6.3.2**, pinned exactly. The candidates, evaluated 2026-09-29 against GitHub advisories, npm downloads and the repository's release-age policy:

| Library | Weekly downloads | Advisories | Verdict |
|---|---:|---|---|
| `xml-crypto` (node-saml) | ~5.3 M | three CRITICAL signature-bypass advisories (GHSA-2xp3-57p7-qf4v fixed in 6.0.0; GHSA-x3m8-899r-f7c3 and GHSA-9p8x-f768-wp2g fixed in 6.0.1, 2025-03); none open; 6.2.0-6.3.2 shipped within eight days of this evaluation and already depend on the patched `@xmldom/xmldom` 0.8.15 | **Adopted**: the smallest surface that does what is needed (verify a signature, hand back the signed bytes), maintained by the node-saml organisation, its API now exposes `getSignedReferences()` for exactly the reading discipline this port enforces |
| `@node-saml/node-saml` | ~1.2 M | two CRITICAL in 2025-07 (fixed 5.1.0), older signature bypass in 2022 | Rejected: a whole SAML SP (request signing, cache providers, its own validation chain) on top of `xml-crypto`; adopting it would put its validation, not ours, on the trust boundary, and the spec fixes ours |
| `samlify` | ~1.7 M | CRITICAL signature-wrapping 2025-05, HIGH XML injection in AttributeValue 2026-05 | Rejected: two signature-integrity advisories within sixteen months, and its validation chain again replaces ours |
| a home-grown C14N/XML-DSig | n/a | n/a | Rejected outright (this ADR's alternatives) |

`pnpm-workspace.yaml` sets no explicit `minimumReleaseAge` (only an exclude list for the effect packages, so pnpm's default policy applies); `xml-crypto` 6.3.2 (published 2026-09-24) and `@xmldom/xmldom` 0.8.15 (2026-09-08) installed under it without an exclusion. Both are pinned exactly, so an upgrade is a reviewed change that re-runs the negative-test corpus. A library with this history is trusted only through what surrounds it, so the adapter adds: a lexical gate before any parser (size, DOCTYPE/ENTITY, comments, processing instructions, depth), the caller's cardinality policy, unique-ID enforcement, a structural check of every `ds:Signature` before any cryptography (one `Reference`, `#ID` only, the Signature a child of the element it signs, transforms limited to enveloped-signature and exclusive C14N), `getCertFromKeyInfo` disabled (the library prefers a document's own certificate over the configured one otherwise), certificate pinning by SHA-256 fingerprint inside a validity window, every signature in the document required to verify, and the library's algorithm registries pruned to the allow-list so a structural gap would still meet "unknown algorithm" inside it. The result is read only from `getSignedReferences()`.

**4. `Sso` is a thin dispatcher, not a third protocol implementation (SFS-006).** `Saml` and `OAuth` own their protocol routes (`saml.*`, `oauth.*` groups, [BEH-EA-4](../behaviors/01-plugin-contract.md)). `Sso` (`spec/models/09-sso.md`, still Planned) is a connection-resolver plugin over the organization's connections (`organization_oauth_connection` today, kind `oidc | oauth2`, with `saml` reserved): `POST /auth/sso/start { email | organizationId }` resolves the connection (by email domain or organization id) and returns the redirect the owning plugin produces. The resolver half already exists — `OrganizationConnectionStore.discover` ([BEH-EA-235](../behaviors/28-tenancy.md)) maps an organization id or an email's domain to a provider id — so `Sso` is the HTTP shell around it.

**5. Deprovisioning is a first-class act.** A SCIM `active: false` is suspension (`Users.setStatus(userId, "suspended")` then `Sessions.revokeAll(userId, "suspended")`), never a deletion; `DELETE` is configured to deactivate (the default) or erase (`Users.delete`, running the `BeforeUserDelete` taps). SCIM only ever acts on users **its connection provisioned**: it neither adopts an existing account by email (a directory must not be able to claim, then suspend, someone else's global identity — [ADR-EA-018](018-tenancy-is-an-organization.md) Decision 4) nor changes a provisioned user's `userName` (an IdP-driven email change would be an account-takeover path), and it reactivates only a suspension it made itself. The contracts are in `spec/behaviors/30-scim.md` and `spec/models/12-scim.md`.

**6. Roadmap.** SAML and SCIM move from "Planned-Phase3, not v1 scope" to a scheduled sequence: user status (done, ticket 09) → SCIM (done) → SAML SP (done, with its `XmlSignature` port over `xml-crypto`) → the `Sso` dispatcher. `spec/roadmap.md` and `spec/models/00-adoption-matrix.md` reflect it. OIDC Provider and Device Authorization keep their own rows.

## Alternatives considered

**Leave both unscheduled** — rejected by ticket 08: OIDC-only federation plus manual deprovisioning is the disqualifier for the enterprise buyer this runtime targets. **Build the SAML IdP direction too (E5)** — rejected: a materially larger, separable subsystem nothing in this scope demands. **Fold SAML into `@awthaq/oauth` / SCIM into `@awthaq/organization`** — rejected: the protocol surfaces are large and unrelated to those plugins' stratum. **Adopt existing users by email in SCIM** — rejected (Decision 5). **A home-grown XML signature check** — rejected outright; the port exists so the implementation is a vetted library behind a fused, anti-wrapping interface.

## Consequences

**Positive**: a first-party, tenant-aware enterprise story with the riskiest protocol code isolated behind one port; offboarding through an IdP ends sessions immediately; SCIM cannot be turned against accounts it did not create.

**Negative**: SAML depends on a third-party XML-DSig library with a real advisory history, contained by the port and its negative-test corpus (an upgrade re-runs it); SCIM's ownership rule means an organization cannot bulk-link pre-existing accounts through SCIM (it links them by having them sign in through its connection, or an application-level import); `Sso` remains a design.

**Trade-off accepted**: SCIM `userName` is immutable and existing accounts are never adopted — the safe defaults — at the cost of directory features some IdPs assume (renames, adoption), which can be added behind explicit configuration once a real consumer needs them.
