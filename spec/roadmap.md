# Roadmap

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-RMP |
> | Revision | 1.3 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Fixed gate-count and M7 Bearer omission; clarified milestone-to-gate mapping (gates cluster at M0/M1/M6/M8, other milestones certified retroactively); reworded M0 to not overclaim gate 5's mechanized proof (CCR-EA-002) <br> 1.2 (2026-09-14): Replaced the stale "pre-implementation, no source exists" current-state line — implementation has since progressed through M4 and beyond; pointed readers to `README.md` and the shipping-gaps map instead of restating a milestone checklist here <br> 1.3 (2026-09-29): Reconciled with the shipped state: each milestone carries an implementation status (M0-M6 implemented; M7 partly: TwoFactor, MagicLink and EmailOtp remain; M8 not started), the gate table separates implementation status from gate status and takes gate status from `definitions-of-done.md`'s "Wired as" column, and the capabilities that shipped outside the original milestone list (tenancy, SCIM, events outbox, erasure, observability, read replicas) are recorded (DTWS-005, MM-005, CCR-EA-006) |

---

Current state: this specification remains the normative source of *why* things are built the way they are, and `packages/` now holds a real, tested implementation of milestones M0 through M6 and most of M7. What has shipped, by milestone:

- **M0-M4** (architecture, core, Password, the qadi bridge, OAuth and Passkey): implemented in `@awthaq/core`, `api`, `server`, `sql`, `ports`, `password`, `oauth`, `passkey`, `qadi` and `roles`. Persistence runs on SQLite, libSQL and Postgres, with opt-in read-replica routing ([ADR-EA-024](decisions/024-read-replica-routing.md)).
- **M5** (client, React, Next.js): implemented in `@awthaq/client`, `react` and `next`.
- **M6** (tooling): `@awthaq/test` (`TestAuth`, `runPluginContractTests`, the redaction guard) and the `awthaq` CLI (`@awthaq/cli`) are implemented; the gates that certify tooling are only partly wired (see "Gate status").
- **M7** (phase-2 plugins): `Organization` (teams, invitations, tenancy), `Admin` (impersonation, tenants), `Jwt`, `ApiKey` (keys and `client_credentials` service tokens) and the `Bearer` seam (a built-in `Authentication` scheme fed by `CredentialResolvers`, not a separate plugin) are implemented. `TwoFactor` and `MagicLink` are placeholder packages and `EmailOtp` has no package; all three are specified only.
- **M8** (stable): not started. No security review has been done, the documentation for the three audiences is partial, and the plugin API is not frozen. No package is published to npm (the root [`README.md`](../README.md)'s "Publishing status").

Capabilities shipped beyond the original milestone list: multi-tenancy ([ADR-EA-018](decisions/018-tenancy-is-an-organization.md)), inbound SCIM provisioning (`@awthaq/scim`, [ADR-EA-023](decisions/023-enterprise-federation-packages.md)), the audit-log outbox relay, account erasure and export, retention, breach-signal detection, and the observability substrate ([ADR-EA-029](decisions/029-event-pii-posture.md) through [ADR-EA-032](decisions/032-observability-substrate.md)), and three migration packages (`migrate-auth0`, `migrate-firebase`, `migrate-better-auth`). SAML (`@awthaq/saml`, service provider only) is specified ([behaviors/29-saml-sp.md](behaviors/29-saml-sp.md)) but not built, as is an OIDC provider; device authorization (RFC 8628) shipped as `@awthaq/device-authorization` ([behaviors/37-device-authorization.md](behaviors/37-device-authorization.md)) with the CLI's interactive `login` as its first consumer. This document still records the milestone plan and each phase's done-criteria; for the most recent gap-closure pass see [`.scratch/shipping-gaps/map.md`](../.scratch/shipping-gaps/map.md).

This document restates the milestone roadmap of `archive/PRD.md` §23 as this specification's own phases, records what gates each phase must pass (`spec/process/definitions-of-done.md` enforces them), and carries forward the open decisions of `archive/PRD.md` §25 and the non-goals of `archive/PRD.md` §4 as things this roadmap deliberately does not resolve or include.

---

## M0 Architecture

**Status: implemented.**

- `AuthPlugin.Service` — the base class every plugin extends, per `archive/design/plugins-as-layers.md` §2.
- `Auth.make` with `Validate<P>` — pairwise compile-time checks over the plugin tuple (duplicate id, missing dependency, slot conflict).
- The core tuple (`Users`, `Accounts`, `Sessions`, `Verification`, `Authentication`, `Csrf`, `SessionView`) prepended by `Auth.make`.
- `AuthHttp` — the mechanism that registers a composed `HttpApi` with a router.
- A toy plugin that compiles, and a missing dependency that demonstrably fails to compile — the first concrete, if manually-reviewed, proof that the type-level invariants of `spec/invariants.md` §1 hold. Gate 5 (M1) is what turns this from a proof a reviewer reads by eye into one a type-testing tool asserts mechanically; M0 does not claim gate 5 is active.

## M1 Core

**Status: implemented (memory, SQLite, libSQL and Postgres persistence).**

- `Users`, `Accounts`, `Sessions`, `Verification`, `Authentication`, `CSRF` as domain services.
- Memory and SQL persistence for all of the above.

## M2 Password

**Status: implemented.**

- Sign-up, sign-in, password reset, verification, and optional breach check as the `Password` plugin.

## M3 qadi bridge

**Status: implemented (`@awthaq/qadi`, `@awthaq/roles`).**

- `SubjectResolver` slot.
- `AuthorizedSubject` middleware (Path A) and `SubjectExtractor` layer (Path B).
- `Roles` plugin (subject resolver over a role table).
- Obligation handlers (`ObligationHandlers.reauth`, and the like).

## M4 OAuth and Passkey

**Status: implemented.**

- OAuth providers as Layers, PKCE, explicit account linking.
- `Passkey` plugin against the `WebAuthn` port.

## M5 Client and React

**Status: implemented (`@awthaq/client`, `react`, `next`).**

- `AtomHttpApi` client and session atom.
- React providers, including `QadiProvider` integration.
- Next.js adapter.

## M6 Tooling

**Status: implemented; gates 7 and 8 only partly wired.**

- `TestAuth` test harness.
- Plugin contract tests (`runPluginContractTests`).
- CLI (`doctor`, `plugin list --graph`, `routes`, `schema`, `migration status|apply`, `openapi`, `seed admin`, `import`).
- Migrations and OpenAPI generation.

## M7 Phase-2 plugins

**Status: implemented. Shipped: TwoFactor, MagicLink, EmailOtp (email only), Organization, ApiKey, Admin, Jwt and the Bearer seam.**

- `TwoFactor` (divert hook, hashed recovery codes) — shipped in `@awthaq/two-factor`.
- `MagicLink`, `EmailOtp` — shipped in `@awthaq/magic-link` (email only; SMS is a later restricted plugin, ADR-EA-021).
- `Organization` (membership, invitations, relationship resolver).
- `ApiKey` (service principals): long-lived API keys plus `client_credentials` clients minting short-lived service JWTs through `Jwt`. Scope note (wayfinder ticket 10): this pulls a slice of Phase 3's authorization-server capability — the `client_credentials` grant, a pure back-channel POST needing none of the browser, consent or discovery machinery of the `OidcProvider` plugin — into M7 ahead of schedule. It lives in `@awthaq/api-key`; `@awthaq/oauth` stays a client of external IdPs.
- `Admin` (impersonation with hard expiry and `actingAs`).
- `Jwt` (EdDSA, JWKS on `LayerRef`) and `Bearer`.

## M8 Stable

**Status: not started.**

- Security review.
- Documentation for all three audiences (application developer, plugin author, adapter author — `archive/PRD.md` §20).
- Plugin API v1 frozen.

---

## Gate status

Every milestone above is, in the end, only as real as the gates that certify it complete. `spec/process/definitions-of-done.md` (Document ID EFAUTH-PROC-02) carries the full gate list — fourteen gates spanning architecture, authentication, authorization, HTTP, client, persistence, tooling and security, adapted from `archive/PRD.md` §24's definition of done for v1 — and its "Wired as" column says which step of `pnpm check` implements each. This section keeps two questions apart: whether a milestone's code exists (*implementation*), and whether the gates that certify it run (*gates*). Gate status below is copied from that column; where the two documents disagree, `definitions-of-done.md` governs.

Gates do not attach one-per-milestone: they cluster at four checkpoints (gates 1-3 at M0, gates 4-6 at M1, gates 7-10 at M6, gates 11-14 at M8). A milestone with no gates of its own (M2, M3, M4, M5, M7) is not ungated forever — its work is certified retroactively by the next checkpoint's gates once they land (concretely: anything built in M2-M5 is covered by M6's gate 7 plugin-contract-test harness and gate 9 traceability verification; M7's Phase-2 plugins are covered the same way). Until a gate is wired, "done" for the milestone means only "matches this specification and its own tests pass," not "passed a gate."

| Milestone | Implementation | Gates that attach here | Gate status |
|---|---|---|---|
| M0 Architecture | Implemented | 1-3 | 1 Active; 2 Active; 3 Active-partial (`check:error-tags`, `check:readmes`) |
| M1 Core | Implemented | 4-6 | 4 Active; 5 Active-partial (`@ts-expect-error` cases inside `pnpm typecheck`, no type-testing tool); 6 Active (coverage thresholds enforced) |
| M2 Password | Implemented | none directly — certified via M6's gates | Covered by gates 6 and 9; does not yet run `runPluginContractTests` (gate 7) |
| M3 qadi bridge | Implemented | none directly — certified via M6's gates | Covered by gates 6 and 9 |
| M4 OAuth and Passkey | Implemented | none directly — certified via M6's gates | Covered by gates 6 and 9; neither runs `runPluginContractTests` |
| M5 Client and React | Implemented | none directly — certified via M6's gates | Covered by gates 6 and 9 |
| M6 Tooling | Implemented | 7-10 | 7 Active-partial (admin, jwt, organization, the template); 8 Active-partial (root README quickstart only); 9 Active; 10 Active-partial (core HttpApi and Ports inventories) |
| M7 Phase-2 plugins | Partly implemented (TwoFactor, MagicLink, EmailOtp not built) | none directly — certified via M6's or M8's gates | Covered by gates 6 and 9 for what exists |
| M8 Stable | Not started | 11-14 | 11 Active (`package:smoke`); 12 Active but a no-op while packages are private; 13 Not wired; 14 Not wired |

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
- Implement every enterprise protocol in v1 (an OIDC provider and device authorization are M(3) roadmap items, not v1 scope — see `archive/PRD.md` §17, Phase 3). SAML (service provider only) and SCIM (inbound) are scheduled, not deferred: user status (done) → `@awthaq/scim` (done) → `@awthaq/saml` (done) → the `Sso` dispatcher, per [ADR-EA-023](decisions/023-enterprise-federation-packages.md).
