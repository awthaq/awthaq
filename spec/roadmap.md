# Roadmap

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-RMP |
> | Revision | 1.2 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Fixed gate-count and M7 Bearer omission; clarified milestone-to-gate mapping (gates cluster at M0/M1/M6/M8, other milestones certified retroactively); reworded M0 to not overclaim gate 5's mechanized proof (CCR-EA-002) <br> 1.2 (2026-09-14): Replaced the stale "pre-implementation, no source exists" current-state line — implementation has since progressed through M4 and beyond; pointed readers to `README.md` and the shipping-gaps map instead of restating a milestone checklist here |

---

Current state: this specification remains the normative source of *why* things are built the way they are, but it is no longer the only artifact — `packages/` has a real, tested implementation of every milestone through M4 (Core, Password, the qadi bridge, OAuth and Passkey), plus Organization, Admin, and Jwt beyond the milestones originally scoped here, and partial progress on M6/M8's tooling and release gates. No package is published to npm yet (`README.md`'s own "Publishing status" section). This document still records the milestone plan and each phase's done-criteria; for what has actually shipped, see the root [`README.md`](../README.md) and, for the most recent gap-closure pass against this roadmap, [`.scratch/shipping-gaps/map.md`](../.scratch/shipping-gaps/map.md) — that map, not a milestone checklist restated here, is what stays current as work lands.

This document restates the milestone roadmap of `archive/PRD.md` §23 as this specification's own phases, records what gates each phase must pass once `spec/process/definitions-of-done.md` exists to enforce them, and carries forward the open decisions of `archive/PRD.md` §25 and the non-goals of `archive/PRD.md` §4 as things this roadmap deliberately does not resolve or include.

---

## M0 Architecture

- `AuthPlugin.Service` — the base class every plugin extends, per `archive/design/plugins-as-layers.md` §2.
- `Auth.make` with `Validate<P>` — pairwise compile-time checks over the plugin tuple (duplicate id, missing dependency, slot conflict).
- The core tuple (`Users`, `Accounts`, `Sessions`, `Verification`, `Authentication`, `Csrf`, `SessionView`) prepended by `Auth.make`.
- `AuthHttp` — the mechanism that registers a composed `HttpApi` with a router.
- A toy plugin that compiles, and a missing dependency that demonstrably fails to compile — the first concrete, if manually-reviewed, proof that the type-level invariants of `spec/invariants.md` §1 hold. Gate 5 (M1) is what turns this from a proof a reviewer reads by eye into one a type-testing tool asserts mechanically; M0 does not claim gate 5 is active.

## M1 Core

- `Users`, `Accounts`, `Sessions`, `Verification`, `Authentication`, `CSRF` as domain services.
- Memory and SQL persistence for all of the above.

## M2 Password

- Sign-up, sign-in, password reset, verification, and optional breach check as the `Password` plugin.

## M3 qadi bridge

- `SubjectResolver` slot.
- `AuthorizedSubject` middleware (Path A) and `SubjectExtractor` layer (Path B).
- `Roles` plugin (subject resolver over a role table).
- Obligation handlers (`ObligationHandlers.reauth`, and the like).

## M4 OAuth and Passkey

- OAuth providers as Layers, PKCE, explicit account linking.
- `Passkey` plugin against the `WebAuthn` port.

## M5 Client and React

- `AtomHttpApi` client and session atom.
- React providers, including `QadiProvider` integration.
- Next.js adapter.

## M6 Tooling

- `TestAuth` test harness.
- Plugin contract tests (`runPluginContractTests`).
- CLI (`doctor`, `plugin list --graph`, `routes`, `schema`, `migration status|apply`, `openapi`, `seed admin`, `import`).
- Migrations and OpenAPI generation.

## M7 Phase-2 plugins

- `TwoFactor` (divert hook, hashed recovery codes).
- `MagicLink`, `EmailOtp`.
- `Organization` (membership, invitations, relationship resolver).
- `ApiKey` (service principals).
- `Admin` (impersonation with hard expiry and `actingAs`).
- `Jwt` (EdDSA, JWKS on `LayerRef`) and `Bearer`.

## M8 Stable

- Security review.
- Documentation for all three audiences (application developer, plugin author, adapter author — `archive/PRD.md` §20).
- Plugin API v1 frozen.

---

## Gate status

Every milestone above is, in the end, only as real as the gates that certify it complete. `spec/process/definitions-of-done.md` (Document ID EFAUTH-PROC-02) carries the full gate list — fourteen forward-looking gates spanning architecture, authentication, authorization, HTTP, client, persistence, tooling and security, adapted from `archive/PRD.md` §24's definition of done for v1. See that document for the exact gates and their descriptions. As of this revision, **every gate is Not yet active** — there is no code for any gate to check, and no milestone above has begun.

Gates do not attach one-per-milestone: they cluster at four checkpoints (gates 1-3 at M0, gates 4-6 at M1, gates 7-10 at M6, gates 11-14 at M8). A milestone with no gates of its own (M2, M3, M4, M5, M7) is not ungated forever — its work is certified retroactively by the next checkpoint's gates once they land (concretely: anything built in M2-M5 is covered by M6's gate 7 plugin-contract-test harness and gate 9 traceability verification; M7's Phase-2 plugins are covered the same way by M6's gates if M7 lands before M8, or by M8's gates 11-14 otherwise). Until a milestone's covering checkpoint is reached, "done" for that milestone means only "matches this specification," not "passed a gate."

| Milestone | Gates that attach here | Gate status |
|---|---|---|
| M0 Architecture | 1-3 | Not yet active |
| M1 Core | 4-6 | Not yet active |
| M2 Password | none directly — certified via M6's gates | Not yet active |
| M3 qadi bridge | none directly — certified via M6's gates | Not yet active |
| M4 OAuth and Passkey | none directly — certified via M6's gates | Not yet active |
| M5 Client and React | none directly — certified via M6's gates | Not yet active |
| M6 Tooling | 7-10 | Not yet active |
| M7 Phase-2 plugins | none directly — certified via M6's or M8's gates | Not yet active |
| M8 Stable | 11-14 | Not yet active |

---

## Under consideration

The following are open decisions carried verbatim from `archive/PRD.md` §25. None is resolved by this roadmap; each remains a gray area to be closed before, or during, the milestone it affects.

1. npm scope rename.
2. Session lifetime defaults (30d/7d per this PRD vs 7d/1d ecosystem norm).
3. Registry policy: curated with contract-test badge (proposed) vs open list.
4. Whether third parties may override core groups (proposed: no; `E_GROUP_CONFLICT`).
5. React primitive priority: `@effect/atom-react` first (proposed) vs TanStack Query adapter first.

---

## What is deliberately excluded from v1

Drawn from `archive/PRD.md` §4 (Non-goals). The initial product will not:

- Host identity as a service.
- Implement every OAuth provider.
- Support every database on day one.
- Load plugins at runtime.
- Be a general application plugin system.
- Be an ORM or a mail provider.
- Implement authorization — that is qadi's responsibility, not awthaq's (see `archive/PRD.md` §5, principle 7, and [ADR-EA-009](decisions/009-authorization-delegated-to-qadi.md)).
- Implement every enterprise protocol in v1 (an OIDC provider and device authorization are M(3) roadmap items, not v1 scope — see `archive/PRD.md` §17, Phase 3). SAML (service provider only) and SCIM (inbound) are scheduled, not deferred: user status (done) → `@awthaq/scim` (done) → `@awthaq/saml` (specified) → the `Sso` dispatcher, per [ADR-EA-023](decisions/023-enterprise-federation-packages.md).
