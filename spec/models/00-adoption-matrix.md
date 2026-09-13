# 00 — Authentication Method Adoption Matrix

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-MOD-00 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added MOD-EA-014 (Organization) and MOD-EA-015 (Admin/Impersonation) rows; noted an open question on whether a new enabler category is needed (CCR-EA-002) |

---

This document is **not normative**. awthaq is currently **pre-implementation**:
no code exists yet, anywhere in this repository. This matrix records, for each
authentication method — and, as of MOD-EA-014/015, each core plugin — the
project intends to ship, what phase it is planned for, why, and what shared
piece of infrastructure it depends on. Nothing on this page has been built,
and nothing on this page should be read as evidence that it has.

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
this document's speculative territory only when it acquires a normative
behavior file under `spec/behaviors/` — this document never claims that has
happened for any of the fifteen entries below (thirteen authentication
methods plus Organization and Admin/Impersonation), because as of this
revision it has not happened for any of them.

## 1. Status vocabulary

Unlike qadi's own adoption matrix — which records real shipped capability
alongside gaps — every status value here describes a plan, not a delivery.
There is no **Shipped** value in this matrix, and there will not be one until
this repository contains actual runtime code, a plugin implementing the
method, and a passing test suite. Until then:

| Status | Meaning |
|---|---|
| **Planned-MVP** | Intended for the first release described in `archive/PRD.md` §17. No code exists; this is the highest-confidence, nearest-term plan. |
| **Planned-Phase2** | Intended for the second wave of official plugins per `archive/PRD.md` §17. Depends on MVP enablers landing first. |
| **Planned-Phase3** | Intended for the third wave. Several of these methods (SSO, SAML, OIDC Provider, SCIM) turn awthaq from a relying party into an identity provider, which is a materially larger scope than the rest of the matrix and is planned last on purpose. |
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
| Password | Planned-MVP | P0 | E1 | [01-password.md](01-password.md) |
| OAuth and OIDC | Planned-MVP | P0 | E2 | [02-oauth-oidc.md](02-oauth-oidc.md) |
| Passkey and WebAuthn | Planned-MVP | P1 | E2 | [03-passkey-webauthn.md](03-passkey-webauthn.md) |
| Magic Link | Planned-Phase2 | P2 | E1 | [04-magic-link.md](04-magic-link.md) |
| Email OTP | Planned-Phase2 | P2 | E1 | [05-email-otp.md](05-email-otp.md) |
| Two-Factor (TOTP) | Planned-Phase2 | P1 | E4 | [06-two-factor-totp.md](06-two-factor-totp.md) |
| API Keys | Planned-Phase2 | P1 | E3 | [07-api-keys.md](07-api-keys.md) |
| JWT and Bearer | Planned-Phase2 | P1 | E3 | [08-jwt-bearer.md](08-jwt-bearer.md) |
| Organization (core plugin) | Planned-Phase2 | P1 | E3 (provisional — see §3's open question) | [14-organization.md](14-organization.md) |
| Admin / Impersonation (core plugin) | Planned-Phase2 | P2 | E4 (provisional — see §3's open question) | [15-admin-impersonation.md](15-admin-impersonation.md) |
| SSO | Planned-Phase3 | P2 | E2 | [09-sso.md](09-sso.md) |
| SAML | Planned-Phase3 | P3 | E2, E5 | [10-saml.md](10-saml.md) |
| OIDC Provider | Planned-Phase3 | P3 | E2, E5 | [11-oidc-provider.md](11-oidc-provider.md) |
| SCIM | Planned-Phase3 | P4 | E5 | [12-scim.md](12-scim.md) |
| Device Authorization | Planned-Phase3 | P4 | E4 | [13-device-authorization.md](13-device-authorization.md) |

## 5. A note on honesty

Every "Verification" cell across the fifteen files linked above reads **None
yet — no test exists**, without exception. Every "What is missing" cell is
honest about the fact that, literally, everything is missing: there is no
implementation, no contract, no handler, no test, for any of these fifteen
entries, because awthaq is pre-implementation in its entirety. The value
of these fifteen documents today is not to describe something built — it is
to fix the planned shape of each method or core plugin (what service it would
expose, what enabler it depends on, what a caller's code would look like)
before implementation begins, so that disagreements about the shape are cheap to
resolve now and expensive to discover later.

_Related: [archive/PRD.md](../../archive/PRD.md) §17 (Official plugins), [archive/design/plugins-as-layers.md](../../archive/design/plugins-as-layers.md)_
