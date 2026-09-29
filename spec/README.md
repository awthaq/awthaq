# awthaq Specification

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-00 |
> | Revision | 1.3 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Planning |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Fixed 11 stale filenames in the behaviors table; updated models count/table for MOD-EA-014/015; added decisions-table rows for ADR-EA-013/014/015 (CCR-EA-002) <br> 1.2 (2026-09-12): Added a "`features/` is the acceptance suite" section noting the new Gherkin suite and its REQ-EA allocation (CCR-EA-003) <br> 1.3 (2026-09-29): Replaced the "planned system, no source tree, no CI" banner with the shipped state; refreshed every count and table (decisions, behaviors, models); described the wired BDD suite and the mechanical drift checks in `spec/scripts/` (DTWS-001, DTWS-006, AVS-008, CCR-EA-006) |

---

> **Status: implemented, pre-1.0, unpublished.** This tree is the normative source of *why* awthaq is built the way it is and of the behavior each package is meant to have, but it is no longer the only artifact: `packages/` holds a tested implementation of core, ports, persistence (SQLite, libSQL and Postgres), the HTTP contract and server, Password, OAuth, Passkey, Jwt, ApiKey (long-lived keys and `client_credentials` service tokens), Organization (teams, tenancy), Roles, the qadi bridge, Admin (impersonation, tenants), SCIM, the Effect client, React and Next.js bindings, the CLI, the test harness and three migration packages. `@awthaq/two-factor` and `@awthaq/magic-link` are still placeholder packages, and SAML and an OIDC provider are specified here but not built (device authorization, RFC 8628, ships as `@awthaq/device-authorization`). No package is published to npm (see the root [`README.md`](../README.md#publishing-status)). Where this tree and the code differ, the difference is either recorded in the affected behavior (an *Implementation* or *Deviation* note) or is a defect in one of the two; `spec/scripts/verify-traceability.sh --strict` (run by `pnpm check`) fails on the drift it can detect mechanically, and `traceability.md` says which claims rest on a passing test and which do not. Where this tree and `archive/` disagree, this tree governs.

## What this is

This is the specification tree for **awthaq**, a TypeScript authentication runtime being designed on Effect v4, with authorization delegated to a sibling library, **qadi**. The tree is organized the way a verified specification is organized once a project has shipped: user requirements (`urs.md`), architectural decisions (`decisions/`), domain models (`models/`), a behavior catalog that the BDD suite traces to (`behaviors/`), system invariants (`invariants.md`), a requirement-to-behavior traceability matrix (`traceability.md`), and process documents that fix the ID scheme and definitions of done (`process/`). Every document carries a Document-Control header with a stable ID, and every cross-document reference is a relative markdown link to the exact heading it cites, so the tree can be traced in either direction: from a requirement down to the behaviors that will satisfy it, or from a behavior up to the decision and requirement that justify it.

The difference from a normal post-hoc specification is temporal, not structural: this tree was authored **before** the implementation, rather than extracted from one, and it has since been checked against real code and revised in place, each revision recorded in the affected document's Change History. It uses the same ID scheme, document shapes and cross-reference discipline a mature, verified specification uses, so the implementation could be filled in against it and the two kept honest against each other.

## Contents

| Document | ID | Contents |
|---|---|---|
| [spec/overview.md](overview.md) | EFAUTH-OVERVIEW | Mission, design philosophy, the seven-stratum package map, the public API surface per stratum, and the north-star worked example. |
| [spec/urs.md](urs.md) | EFAUTH-URS | User Requirements Specification: purpose and scope, user groups, functional requirements (`URS-EA-NNN`), non-functional requirements (`NFR-EA-NNN`), a requirement-to-behavior traceability table, and the known gaps of the requirement set. |
| [spec/glossary.md](glossary.md) | EFAUTH-GLOSSARY | Flat, one-term-per-heading glossary of core concepts, plugin-system vocabulary, the qadi authorization bridge, and load-bearing Effect vocabulary used throughout the tree. |
| [spec/invariants.md](invariants.md) | EFAUTH-INV | System-wide invariants (`INV-EA-NNN`) that must hold regardless of which plugins are installed. |
| [spec/traceability.md](traceability.md) | EFAUTH-RTM | The requirements traceability matrix: every `URS`/`NFR`/`MOD` row mapped to the `BEH`/`ADR`/`INV` rows that satisfy it. |
| [spec/roadmap.md](roadmap.md) | EFAUTH-RMP | The delivery roadmap (milestones M0–M8), derived from `archive/PRD.md` §23, restated against this tree's IDs, with what has shipped against each milestone. |
| [spec/models/](models/) | `MOD-EA-001`–`015` | Sixteen files. `00-adoption-matrix.md` is an index with no `MOD` id of its own; `01`–`15` each specify one authentication-method or core-plugin domain model (see table below). |
| [spec/decisions/](decisions/) | `ADR-EA-001`–`034` | Thirty-two architectural decision records, one per file, each stating a decision, its rationale, and its consequences (see table below). `ADR-EA-020` and `021` are not allocated: they are held for the two-factor decisions. |
| [spec/behaviors/](behaviors/) | `BEH-EA-001`–`307` | Thirty-seven files, grouped by subsystem — the catalog the BDD/acceptance suite traces to (see table below). |
| [spec/process/](process/) | EFAUTH-PROC-01/02 | Two files: the requirement-ID scheme in full, and the definitions of done applied at each stage of work. |
| [spec/appendices/](appendices/) | — | Five files of supporting reference material, authored alongside the rest of the tree and cross-referenced from it rather than summarized here. |

### `spec/models/` — one file per authentication method or core plugin

| File | MOD ID | Model |
|---|---|---|
| `00-adoption-matrix.md` | — (index) | Cross-model adoption matrix; no `MOD` id of its own. |
| `01-password.md` | MOD-EA-001 | Password |
| `02-oauth-oidc.md` | MOD-EA-002 | OAuth and OIDC |
| `03-passkey-webauthn.md` | MOD-EA-003 | Passkey and WebAuthn |
| `04-magic-link.md` | MOD-EA-004 | Magic Link |
| `05-email-otp.md` | MOD-EA-005 | Email OTP |
| `06-two-factor-totp.md` | MOD-EA-006 | Two-Factor (TOTP) |
| `07-api-keys.md` | MOD-EA-007 | API Keys |
| `08-jwt-bearer.md` | MOD-EA-008 | JWT and Bearer |
| `09-sso.md` | MOD-EA-009 | SSO |
| `10-saml.md` | MOD-EA-010 | SAML |
| `11-oidc-provider.md` | MOD-EA-011 | OIDC Provider |
| `12-scim.md` | MOD-EA-012 | SCIM |
| `13-device-authorization.md` | MOD-EA-013 | Device Authorization |
| `14-organization.md` | MOD-EA-014 | Organization |
| `15-admin-impersonation.md` | MOD-EA-015 | Admin (Impersonation) |

### `spec/decisions/` — one architectural decision per file

| File | ADR ID | Decision |
|---|---|---|
| `001-*.md` | ADR-EA-001 | Plugins Contribute Effect Layers |
| `002-*.md` | ADR-EA-002 | The Plugin Graph Is Read Off the Service Graph |
| `003-*.md` | ADR-EA-003 | HttpApi Is the API Contract |
| `004-*.md` | ADR-EA-004 | Database-Neutral Models |
| `005-*.md` | ADR-EA-005 | Static Composition |
| `006-*.md` | ADR-EA-006 | Runtime Configuration Is Separate From Installation |
| `007-*.md` | ADR-EA-007 | Target Effect v4 |
| `008-*.md` | ADR-EA-008 | A Plugin Is a Context.Service Class |
| `009-*.md` | ADR-EA-009 | Authorization Is Delegated to Qadi |
| `010-*.md` | ADR-EA-010 | Plugins Require Ports and Never Provide Them |
| `011-*.md` | ADR-EA-011 | Configuration Is a Service With a Default |
| `012-*.md` | ADR-EA-012 | Slots Are Exclusive, Registries Aggregate |
| `013-*.md` | ADR-EA-013 | Error Taxonomy and HTTP Status Mapping |
| `014-*.md` | ADR-EA-014 | Session Storage Is Backend-Neutral |
| `015-*.md` | ADR-EA-015 | Qadi Bridge Path Selection |
| `016-*.md` | ADR-EA-016 | Verification Reservations Are a Dedicated Table, Claimed by a Conditional Upsert |
| `017-*.md` | ADR-EA-017 | JWT Signing Keys Rotate on a Grace Period Sized to Token Lifetime, With an Emergency Retire-Now Path |
| `018-*.md` | ADR-EA-018 | A Tenant Is an Organization Row; Core Carries an Opaque, Ambient Tenant Column |
| `019-*.md` | ADR-EA-019 | Encryption-at-Rest Keys Rotate by Retirement, With Lazy Re-Encryption |
| `020-*.md` | ADR-EA-020 | Two-Factor State — Encrypted Secrets, a Verification Challenge, One Failure Budget per Account |
| `021-*.md` | ADR-EA-021 | SMS OTP Is a Separate, Explicitly Restricted Plugin over the Email-OTP Substrate, Deferred |
| `022-*.md` | ADR-EA-022 | API Keys and Client Secrets Rotate With a Bounded Dual-Validity Window; Keys Travel in `x-api-key`, `Authorization: Bearer` Is Reserved for JWTs |
| `023-*.md` | ADR-EA-023 | Enterprise Federation Ships as Two First-Party Packages (`saml` SP-only, `scim` inbound) Behind a Thin `Sso` Dispatcher |
| `024-*.md` | ADR-EA-024 | Read-Replica Routing Is Opt-In, Classified Per Read, and Guarded by a Causal Token |
| `025-*.md` | ADR-EA-025 | Global Roles Answer Platform Authority; Organization Relations Answer Tenant Authority |
| `026-*.md` | ADR-EA-026 | Sign-Up Reveals an Existing Address by Default, With an Opt-In Conceal Mode |
| `027-*.md` | ADR-EA-027 | The CLI Is Built on effect/unstable/cli, With Typed Exit Codes and a Credential Store Port |
| `028-*.md` | ADR-EA-028 | Infrastructure Failures Are One Typed StoreUnavailable, Not Defects |
| `029-*.md` | ADR-EA-029 | Events Carry Identifiers, Not Personal Data, and the Audit Trail Is Pseudonymized on Erasure |
| `030-*.md` | ADR-EA-030 | Events Cross Process Boundaries by Tailing the Audit Log, Not by Widening the Bus |
| `031-*.md` | ADR-EA-031 | Erasure Is a Core Domain Service over an Aggregating Registry, and Retention Is a Separate, Opt-In Sweep |
| `032-*.md` | ADR-EA-032 | Observability Reuses Effect's HTTP Middleware, Adds Business-Logic Spans and a Fixed Field Vocabulary, and Ships Metric Definitions Without a Backend |
| `033-*.md` | ADR-EA-033 | Hook Registries Belong to the Composition, and a Tap Requires Its Point |
| `034-*.md` | ADR-EA-034 | Before 1.0 Breaking Changes Are Allowed, Each With a Changeset That Carries a Migration Note |
| `035-*.md` | ADR-EA-035 | A Plugin Adds Typed Scalar Fields to `users` Through One Declared Extension Point |

### `spec/behaviors/` — thirty files, grouped by subsystem

| File | BEH range | Subsystem |
|---|---|---|
| `01-plugin-contract.md` | 001–008 | Plugin Contract |
| `02-plugin-composition-validate.md` | 009–016 | Plugin Composition and `Validate<P>` |
| `03-ports-slots-hooks-registries.md` | 017–024 | Ports, Slots, Hook Points, and Registries |
| `04-contract-stratum.md` | 025–032 | The Contract Stratum |
| `05-persistence-stratum.md` | 033–040 | The Persistence Stratum |
| `06-domain-users-accounts.md` | 041–048, 254 | Users and Accounts |
| `07-sessions.md` | 049–056 | Sessions |
| `08-verification-tokens.md` | 057–064 | Verification Tokens |
| `09-authentication-middleware.md` | 065–072 | Authentication Middleware |
| `10-csrf.md` | 073–080 | CSRF Protection |
| `11-http-error-mapping.md` | 081–088 | HTTP Serving and Error Mapping |
| `12-hooks.md` | 089–096 | Hooks |
| `13-events.md` | 097–104 | Events |
| `14-rate-limiting.md` | 105–112 | Rate Limiting |
| `15-password.md` | 113–120 | Password Authentication |
| `16-oauth.md` | 121–128 | OAuth and OIDC |
| `17-passkey.md` | 129–136, 255–257 | Passkey and WebAuthn |
| `18-roles-subject-resolver.md` | 137–144 | Roles and the Subject Resolver |
| `19-qadi-bridge-path-a.md` | 145–152 | Qadi Bridge — Path A (Decide in Handler) |
| `20-qadi-bridge-path-b.md` | 153–160 | Qadi Bridge — Path B (Declared Permissions) |
| `21-qadi-resolvers-obligations.md` | 161–168 | Qadi Resolvers and Obligations |
| `22-client-effect.md` | 169–176 | The Effect Client |
| `23-react.md` | 177–184 | React Bindings |
| `24-nextjs-ssr.md` | 185–192 | Next.js Server Rendering |
| `25-testing-harness.md` | 193–200 | Testing Harness |
| `26-cli.md` | 201–208, 225–229, 307 | CLI |
| `27-admin-impersonation.md` | 209–224 | Admin and Impersonation |
| `28-tenancy.md` | 230–237 | Tenancy |
| `29-saml-sp.md` | 238–245 | SAML Service Provider |
| `30-scim.md` | 246–253 | SCIM (inbound provisioning) |
| `31-two-factor.md` | 260–266 | Two-Factor Authentication |
| `32-magic-link.md` | 267–270 | Magic Link |
| `33-email-otp.md` | 271–274 | Email OTP |
| `34-webhooks.md` | 275–282 | Outbound Webhooks |
| `35-organization.md` | 283–290 | Organization |
| `36-jwt.md` | 291–298 | JWT |
| `37-device-authorization.md` | 299–306 | Device Authorization |

### `spec/process/`

| File | ID | Contents |
|---|---|---|
| `requirement-id-scheme.md` | EFAUTH-PROC-01 | The full rules for every ID series in this tree. |
| `definitions-of-done.md` | EFAUTH-PROC-02 | The fourteen merge gates, which command wires each into `pnpm check`, and the per-change checklist. |

## The ID scheme, at a glance

Every identifier in this tree carries the infix `EA` and a series prefix that says what kind of thing it names: `URS-EA-NNN` (user requirements), `NFR-EA-NNN` (non-functional requirements), `MOD-EA-NNN` (domain models), `ADR-EA-NNN` (architectural decisions), `BEH-EA-NNN` (behaviors), `INV-EA-NNN` (invariants), `REQ-EA-NNN` (acceptance scenarios, allocated from `features/features/*.feature` by `features/scripts/allocate-req-ea.py`), and `CCR-EA-NNN` (change control records, used in every Change History line). None of these numbers are reused across series, and none are renumbered once allocated — a superseded item is marked superseded, not deleted or renumbered. This is the short version; [process/requirement-id-scheme.md](process/requirement-id-scheme.md) (EFAUTH-PROC-01) has the full allocation and lifecycle rules.

## `features/` is the acceptance suite

The repository root also holds [`features/`](../features/), a Gherkin acceptance suite (`features/features/*.feature`) that restates the behavior catalog in `spec/behaviors/` as scenarios, one `Rule:` per `BEH-EA-NNN` and one `REQ-EA-NNN`-tagged `Scenario:`/`Scenario Outline:` per requirement clause and named edge case. It is normative in the same sense `behaviors/` is — every scenario traces to a `BEH-EA` id and does not invent requirements beyond what that id states — but a scenario is only runtime evidence if it is wired. The suite runs with `pnpm test:bdd` (`features/vitest.config.ts`, `@effect-cucumber/vitest`, step definitions in `features/step-definitions/`) inside `pnpm check`: every feature file is wired against the real plugins except the ones tagged `@skip @unwired` (a plugin that is not built yet; none today), and a scenario-level `@skip` always carries a `# @skip:` rationale — a passing wired scenario is evidence, an unwired one is a restated requirement only. `spec/traceability.md` §6 has the per-file wiring status. [`behaviors/25-testing-harness.md`](behaviors/25-testing-harness.md) (`BEH-EA-193`–`200`) specifies the `@awthaq/test` harness (`TestAuth`, `runPluginContractTests`, the redaction guard) that plugin packages' own suites use. See [`traceability.md` §6](traceability.md#6-acceptance-scenarios-req-ea) for the `REQ-EA` allocation and [`features/README.md`](../features/README.md) for the suite's own structure and conventions.

## `research/` and `better-auth/` are evidence, not specification

The repository root also holds `research/` (a 100-question research corpus backing the original PRD) and `better-auth/` (a design-by-contract analysis of the competing better-auth framework). Both are cited **from** this tree — a decision in `decisions/` or a behavior in `behaviors/` may point to a research report or a better-auth contract finding as supporting evidence — but neither directory is itself normative, and neither is restructured into the `EA` ID scheme. They are inputs this specification drew on, preserved for traceability of *why* a decision was made, not restated as requirements in their own right.

## `archive/` is superseded

`archive/PRD.md` and `archive/design/*.md` are the product requirements document and design series this specification tree was derived from. They are retained as design rationale and historical record. Where `archive/` and `spec/` disagree, `spec/` governs; `archive/design/api-design.md` in particular uses superseded naming (`definePlugin`) and is not a source for anything in this tree.
