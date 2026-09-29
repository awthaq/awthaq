# ADR-EA-036: IdP-Initiated SAML Login and Encrypted Assertions Are Refused, as Decisions

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-036 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented (both refusals are tested) |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (PV-370, SFS-007; recorded when the rest of the SAML "Not built" list was built) |

---

## Context

When `@awthaq/saml` was built, five things were left off its list: signed AuthnRequests, Single Logout, a connection CRUD surface, role mapping and the `Sso` dispatcher ([BEH-EA-314 through 318](../behaviors/29-saml-sp.md)). All five are built. Two more items on the same list are not "not yet": they are refusals, and a refusal is a decision that should be written down with its reason, so nobody builds it later by accident and nobody wonders whether it was forgotten.

## Decision

**1. IdP-initiated login is refused.** An IdP-initiated response is an unsolicited assertion: there is no request this server made, so there is no request id to bind it to ([BEH-EA-244](../behaviors/29-saml-sp.md#beh-ea-244-inresponseto-matches-a-stored-single-consume-request-id)), no state cookie proving the browser is the one that started the login, and no defence against a login-CSRF that posts an attacker's own valid assertion into a victim's browser. The ACS therefore requires the `__Host-saml-request` state a login this server started, and an assertion's `InResponseTo` must name it. No connection setting admits an unsolicited response. Someone who needs "start from the IdP's app launcher" points the launcher at `GET /auth/saml/login?connection=<id>`: the launcher starts the SP-initiated flow, which is the flow that has the defences. If a per-connection opt-in is ever built it needs, at minimum, a replay-protected assertion id (already kept) and a `RelayState` allow-list, and a new decision.

**2. Encrypted assertions are refused.** An `EncryptedAssertion` anywhere in a response refuses the document ([BEH-EA-239](../behaviors/29-saml-sp.md)), and so does an `EncryptedID` in a logout message. This service provider holds no decryption key by design: a decryption key is one more secret to seal, rotate and publish, and a decryptor in the signature path is the place XML-processing attacks concentrate. TLS already protects the assertion in transit and the assertion is signed; an IdP that insists on encrypting is configured to send signed, unencrypted assertions to this SP, which its administrators can do per service provider.

## Consequences

**Positive**: the ACS has one entry condition; no decryption code sits on the trust boundary; the two most common SAML deployment attacks (unsolicited assertion, malicious encrypted content) are closed by absence.

**Negative**: an IdP that can only do IdP-initiated login, or only send encrypted assertions, cannot be connected. Both are configurable at every mainstream IdP; the cost is one setting on the IdP side, stated in the README.
