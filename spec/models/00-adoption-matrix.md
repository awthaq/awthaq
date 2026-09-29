# 00 — Authentication Method Adoption Matrix

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-00 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added MOD-EA-014 (Organization) and MOD-EA-015 (Admin/Impersonation) rows; noted an open question on whether a new enabler category is needed (CCR-EA-002) <br> 1.2 (2026-09-29): Added a `Shipped-Unpublished` status and flipped the eight implemented rows (Password, OAuth, Passkey, API Keys, JWT with the Bearer seam, Organization, Admin, SCIM); rewrote the pre-implementation preamble, §1 and §5 (AOMS-011, DTWS-001, CCR-EA-006) |

---

This document is **not normative**. It records, for each authentication
method — and, as of MOD-EA-014/015, each core plugin — what phase it belongs
to, why, and what shared piece of infrastructure it depends on, and whether it
has shipped. The repository now holds implementations of many of the entries
(see the status column and [`../roadmap.md`](../roadmap.md)); none is published
to npm. An entry is only as real as its package and its passing tests: a status
here is a claim about a package under `packages/`, and the table below names
the package.

```
REQUIREMENT: A model document MUST NOT allocate BEH-EA, INV-EA, or REQ-EA
identifiers. A model describes a plan; a behavior describes a verified
requirement. Confusing the two is exactly the failure this rule prevents.
An authentication runtime is exactly the kind of system where "we planned it"
and "we verified it" get conflated under pressure — this rule is what keeps
spec/models/ from ever being cited as proof that something works.
```

`spec/models/` is where the plan for a method or core plugin is written down
before it exists, so that the shape can be argued over and fixed cheaply,
before implementation makes changing it expensive. An entry graduates out of
this document's speculative territory when it acquires a normative behavior
file under `spec/behaviors/`: Password ([15](../behaviors/15-password.md)),
OAuth ([16](../behaviors/16-oauth.md)), Passkey ([17](../behaviors/17-passkey.md)),
Admin/Impersonation ([27](../behaviors/27-admin-impersonation.md)), SCIM
([30](../behaviors/30-scim.md)) and the tenancy half of Organization
([28](../behaviors/28-tenancy.md)) have; Jwt, ApiKey and the rest of
Organization are implemented without a behavior file of their own, which is a
specification gap, not a claim that the behavior is undefined. SAML has a
behavior file ([29](../behaviors/29-saml-sp.md)) and no code.

## 1. Status vocabulary

Unlike qadi's own adoption matrix, an entry here can be either a plan or a
delivery, and the status says which. **Shipped-Unpublished** means a plugin
package with real source and a passing test suite exists under `packages/`; it
is not yet published to npm, and it does not mean the package is feature
complete (each model file's "What is missing" says what is not built).

| Status | Meaning |
|---|---|
| **Shipped-Unpublished** | A plugin package with real source and passing tests exists in `packages/`; not yet published to npm. |
| **Planned-MVP** | Intended for the first release described in `archive/PRD.md` §17. No code exists. (No entry carries this status now: the whole MVP tuple shipped.) |
| **Planned-Phase2** | Intended for the second wave of official plugins per `archive/PRD.md` §17. May have a placeholder package with no exports. |
| **Planned-Phase3** | Intended for the third wave. Several of these methods (SSO, SAML, OIDC Provider, SCIM) turn awthaq from a relying party into an identity provider, which is a materially larger scope than the rest of the matrix and is planned last on purpose. |
| **Scheduled** | Specified and committed to, with a decision record, but not yet built. |
| **Excluded** | Considered and deliberately kept off the roadmap. (No entry in the current 15-row matrix carries this status; it is defined here so a future revision can use it without inventing a new vocabulary.) |

## 2. Priority

Priority is assigned by expected demand and integration cost, not by academic
or protocol prominence — a method can be well-known and still sit at P3 here
if few applications ask for it and it is expensive to wire in.

| Priority | Criterion |
|---|---|
| **P0** | Expected on essentially every application that adopts awthaq; blocking for a credible MVP. |
| **P1** | Asked for by most production applications; costs one well-scoped enabler. |
| **P2** | Asked for by a recognizable class of application (consumer apps wanting passwordless, teams wanting light 2FA); additive on top of an MVP enabler. |
| **P3** | Asked for mainly by B2B/enterprise buyers; costs a large, mostly self-contained subsystem. |
| **P4** | Rarely asked for outside a narrow niche, or requires awthaq to take on an identity-provider-as-server role rather than a relying-party role. |

## 3. Enablers

The thirteen methods below reduce to **five** pieces of shared infrastructure.
Planning capability once per enabler — rather than once per method — is what
keeps this matrix from becoming thirteen independent designs that each bolt an
unrelated concern onto the plugin system in `archive/design/plugins-as-layers.md`.

| Enabler | What it unlocks |
|---|---|
| **E1 — Verification-token infrastructure** | Password (reset/verify), Magic Link, Email OTP |
| **E2 — External provider/port abstraction** | OAuth/OIDC, Passkey/WebAuthn, SSO, SAML, OIDC Provider |
| **E3 — Principal-type extension** | API Keys, JWT/Bearer |
| **E4 — Hook-point step-up/divert wiring** | Two-Factor (TOTP), Device Authorization |
| **E5 — Identity-provider-as-server** | OIDC Provider, SAML, SCIM |

Some methods draw on more than one enabler (OIDC Provider draws on both E2 and
E5, SAML on both E2 and E5); each method's own file names every enabler it
depends on.

**Open question.** [MOD-EA-014](14-organization.md) (Organization) and
[MOD-EA-015](15-admin-impersonation.md) (Admin/Impersonation) are the first
two entries in this matrix that are core plugins rather than authentication
methods (see `../process/requirement-id-scheme.md` §2's broadened MOD-EA
description). Provisionally: Organization is filed under **E3** below because
it needs its own tables and repositories in the same shape API Keys and
JWT/Bearer do, and Admin is filed under **E4** because impersonation is a
gated session-issuance variant in the same shape Two-Factor's divert hook and
Device Authorization are. Neither fit is exact — Organization's
`RelationshipResolver` contribution to qadi is not a principal-type concern
at all, and nothing in E4's "hook-point step-up/divert" framing was written
with an admin-gated session substitution in mind. Whether these two plugins
in fact need a sixth enabler category (something like "E6 — qadi resolver
contribution" or "E6 — gated session-issuance variant") is an open question
this revision deliberately leaves open rather than resolving by inventing an
E-number unilaterally; each of `14-organization.md` and
`15-admin-impersonation.md` names its provisional enabler with the same
caveat.

## 4. The matrix

| Method | Status | Priority | Enabler(s) | File |
|---|---|---|---|---|
| Password | Shipped-Unpublished (`@awthaq/password`, `packages/password/test`) | P0 | E1 | [01-password.md](01-password.md) |
| OAuth and OIDC | Shipped-Unpublished (`@awthaq/oauth`, `packages/oauth/test`) | P0 | E2 | [02-oauth-oidc.md](02-oauth-oidc.md) |
| Passkey and WebAuthn | Shipped-Unpublished (`@awthaq/passkey`, `packages/passkey/test`) | P1 | E2 | [03-passkey-webauthn.md](03-passkey-webauthn.md) |
| Magic Link | Planned-Phase2 (placeholder package `@awthaq/magic-link`) | P2 | E1 | [04-magic-link.md](04-magic-link.md) |
| Email OTP | Planned-Phase2 (no package) | P2 | E1 | [05-email-otp.md](05-email-otp.md) |
| Two-Factor (TOTP) | Planned-Phase2 (placeholder package `@awthaq/two-factor`) | P1 | E4 | [06-two-factor-totp.md](06-two-factor-totp.md) |
| API Keys | Shipped-Unpublished (`@awthaq/api-key`, `packages/api-key/test`) | P1 | E3 | [07-api-keys.md](07-api-keys.md) |
| JWT and Bearer | Shipped-Unpublished (`@awthaq/jwt`, `packages/jwt/test`; the Bearer half is a built-in `Authentication` scheme, not a separate plugin) | P1 | E3 | [08-jwt-bearer.md](08-jwt-bearer.md) |
| Organization (core plugin) | Shipped-Unpublished (`@awthaq/organization`, `packages/organization/test`) | P1 | E3 (provisional — see §3's open question) | [14-organization.md](14-organization.md) |
| Admin / Impersonation (core plugin) | Shipped-Unpublished (`@awthaq/admin`, `packages/admin/test`) | P2 | E4 (provisional — see §3's open question) | [15-admin-impersonation.md](15-admin-impersonation.md) |
| SSO | Planned-Phase3 | P2 | E2 | [09-sso.md](09-sso.md) |
| SAML | Scheduled (SP only; specified, not built) | P3 | E2 | [10-saml.md](10-saml.md) |
| OIDC Provider | Planned-Phase3 | P3 | E2, E5 | [11-oidc-provider.md](11-oidc-provider.md) |
| SCIM | Shipped-Unpublished (`@awthaq/scim`, `packages/scim/test`) | P4 | E5 | [12-scim.md](12-scim.md) |
| Device Authorization | Planned-Phase3 (specified, no code) | P4 | E4 | [13-device-authorization.md](13-device-authorization.md) |

## 5. A note on honesty

Eight entries are Shipped-Unpublished (Password, OAuth, Passkey, API Keys, JWT,
Organization, Admin, SCIM): each names its package and test directory, and its
model file's "Verification" cell points at real tests. The other seven (Magic
Link, Email OTP, Two-Factor, SSO, SAML, OIDC Provider, Device Authorization)
describe a shape, not a delivery. Read the two groups differently: for a
shipped entry, the model file is an adoption record that has been reconciled
with the package (its "What is missing" lists only what is genuinely unbuilt);
for a planned entry, the value of the document is to fix the shape — what
service it would expose, what enabler it depends on, what a caller's code would
look like — before implementation begins, so that disagreements about the shape
are cheap to resolve now and expensive to discover later.

_Related: [archive/PRD.md](../../archive/PRD.md) §17 (Official plugins), [archive/design/plugins-as-layers.md](../../archive/design/plugins-as-layers.md)_
