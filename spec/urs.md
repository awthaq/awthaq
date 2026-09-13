# awthaq User Requirements Specification

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-URS |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | User Requirements Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added §6 entries recording the previously-missing traceability.md crosswalk and the Organization/Admin cross-reference defect, both now tracked (CCR-EA-002) |

---

> **This describes a planned system.** No requirement below has been verified against a running awthaq; there is no implementation to verify it against yet. Every `URS-EA-NNN` and `NFR-EA-NNN` row is a target requirement, stated before the system that must satisfy it exists.

## 1. Purpose

This document states the user requirements for awthaq **before an implementation exists**. That is the inverse of how a requirements specification is normally produced: the ordinary process extracts requirements from an existing system's behavior, user feedback, and support history, then verifies them retroactively against what was built. Here there is no system to observe, so every requirement below is derived instead from the product requirements document (`archive/PRD.md`, in particular §3 Goals and §6 Target users) and from the design series it names — a synthesis of stated intent, not observed need.

This ordering has a consequence recorded explicitly in §6 Known Gaps: a requirement written before implementation can state what its authors intended, but it cannot yet reflect what real usage will surface. Both are legitimate inputs to a requirements specification; only the first is available today.

### 1.1 Scope

| In scope | Out of scope |
|---|---|
| Authentication: sessions, users, accounts, verification tokens, password/OAuth/passkey/2FA/magic-link/API-key/JWT sign-in methods | Hosting identity as a service (no managed/hosted offering) |
| A typed plugin system (`AuthPlugin.Service`, `Auth.make`) with compile-time dependency, port, and slot checking | Implementing every OAuth provider ecosystem-wide |
| The HTTP contract stratum (`HttpApi`), server handlers, and a derived Effect/React/Next.js client | Supporting every database on day one (v1 targets Postgres and SQLite) |
| Database-neutral persistence via `Model.Class` and repositories over `SqlClient` | Loading plugins at runtime (the plugin set is static, resolved at build/boot time) |
| The bridge to qadi: the `SubjectResolver` slot, `AuthorizedSubject` middleware, `SubjectExtractor` layer | Being a general-purpose application plugin system (plugins are authentication-scoped only) |
| Testing and operational tooling: `TestAuth`, contract tests, CLI (`doctor`, `plugin list`, `migration`, `openapi`) | Being an ORM or a mail provider (awthaq depends on `SqlClient` and `Mailer` as ports, not implementations) |
| **Deciding *who is asking*** (a `Principal`) | **Deciding *what they may do or see*.** awthaq implements no permission model, no policy language, and no authorizer — that is qadi's responsibility in full (`archive/PRD.md` §9, §15) |
| First-party plugins scheduled for v1 and v1.x (Password, OAuth, Passkey, Roles, then TwoFactor, MagicLink, EmailOtp, Organization, ApiKey, Admin, Jwt, Bearer) | Every enterprise protocol in v1 (SSO, SAML, OIDC Provider, SCIM, Device Authorization are phase-3) |

## 2. User groups

Documentation and requirements are organized around three audiences (`archive/PRD.md` §6, §20):

**Effect application developers** are the primary audience: teams building an application on Effect who need authentication without hand-rolling session handling, credential verification, or CSRF defenses on top of a Promise-based library wrapped in `Effect.tryPromise`. Their need is to wire a working authentication layer in a small number of declarative steps, with the compiler — not a runtime linker or a support ticket — telling them what is missing.

**Plugin authors** build new authentication methods or organization-specific extensions (an invite flow, a custom sign-in strategy) as `AuthPlugin.Service` classes. Their need is a contract precise enough that a plugin they write today keeps working against a version of the core the authors have not seen, and that the type checker — not a manifest linter run in CI — catches a plugin that names a table or endpoint group outside its own namespace.

**Adapter and framework-integration authors** connect awthaq's ports (`SqlClient`, `Mailer`, `PasswordHasher`, `WebAuthn`, `KeyValueStore`, `RateLimiter`) and its HTTP contract to a concrete driver or host framework (a Postgres driver, an SES mailer, a Next.js route handler, a Hono app). Their need is a small, stable adapter surface — a handful of Layers and one `Request → Response` entry point — that does not require touching plugin internals to add support for a new driver or framework.

## 3. Functional requirements

### URS-EA-001 — Add a plugin without modifying core

A developer can add an authentication capability to their application by adding a plugin class to the `Auth.make([...])` tuple and providing whatever ports it still requires. No core file changes, and no plugin registry outside that tuple, are required.

Rationale: this is the concrete form of Goal G7 (small application surface) and the counter-thesis to an untyped plugin model where adding a capability means patching shared state.

### URS-EA-002 — A missing plugin dependency is caught before the application runs

If a plugin in the tuple depends on another plugin that is not also in the tuple, `Auth.make` reports the missing plugin by name at the call site — a compile-time failure, not a boot-time exception or a runtime 500.

Rationale: Goal G2 (type-checked composition); this is the primary developer-facing promise distinguishing awthaq from an untyped plugin model.

### URS-EA-003 — A missing port implementation is caught before the application runs

If a plugin (or the ports it needs, such as `PasswordHasher` or `Mailer`) is not given an implementation somewhere in the application's Layer stack, `Layer.launch` refuses to compile, naming the still-unsatisfied port types.

Rationale: Goal G2; ports are the seam a developer must fill exactly once, and a forgotten one must never surface only in production.

### URS-EA-004 — Two plugins cannot share one plugin id

`Auth.make` rejects a tuple containing two plugins (or two plugin variants) with the same id, at the call site, before the application runs.

Rationale: Goal G2; a duplicate id is a configuration mistake that must never resolve to "last one wins."

### URS-EA-005 — Two plugins cannot override the same slot

If two plugins in the tuple both attempt to override one exclusive slot (for example, `SubjectResolver`), `Auth.make` rejects the tuple and names both plugins and the slot.

Rationale: Goal G2; slots are exclusive by definition (ADR-EA-012), so a conflict here is a design error the compiler, not a runtime priority rule, must catch.

### URS-EA-006 — A hook tap on an undefined hook point is a compile error

A plugin (or application code) that taps a hook point which no installed plugin or core defines fails to compile: the point's service type remains in the tap's requirements until something provides it.

Rationale: Goal G2; a tap on a point nobody defines must never silently become a no-op.

### URS-EA-007 — A contract cannot exist without its handlers, or the reverse

`auth.api` (the merged `HttpApi` contract) and `auth.layer` (the merged handler Layer) are computed from the same plugin tuple, so it is impossible to end up with a contract group that has no handler implementation, or a handler that serves a group the contract does not declare.

Rationale: Goal G3 (contract first); this is what makes the contract trustworthy as the sole source of truth for the API surface.

### URS-EA-008 — The contract is importable in the browser without server code

Stratum 1 (the contract: schemas, errors, `HttpApi` group and middleware definitions) has no server-side dependency and can be imported by client code, including in a browser bundle, without pulling in `SqlClient`, handlers, or any Node-only dependency.

Rationale: Goal G3; this is what lets a derived client exist at all, and what keeps client bundle size independent of server implementation size.

### URS-EA-009 — The contract drives handlers, the client, OpenAPI, and tests

A single `HttpApi` contract is the source that handlers implement against, that the Effect and React clients are generated from, that OpenAPI documentation is generated from, and that the test harness exercises — never four independently maintained representations of the same API.

Rationale: Goal G3; one contract, one source of truth, avoids the drift a hand-maintained client or hand-written OpenAPI file would introduce.

### URS-EA-010 — Persistence is database-neutral

Domain entities are `Model.Class` values with repositories built over the generic `SqlClient` interface. Swapping the underlying database driver (Postgres, SQLite, and others as adapters are added) requires providing a different `SqlClient` Layer, not rewriting domain code.

Rationale: Goal G5 (database independence).

### URS-EA-011 — Authorization decisions are never made by awthaq itself

No awthaq service evaluates a permission, a policy, or an authorization rule. Every authorization decision is made by qadi, reached through the `SubjectResolver` slot and the two integration paths (`AuthorizedSubject` middleware for Path A, `SubjectExtractor` for Path B). awthaq's own responsibility ends at producing a `Principal` and, through the slot, a qadi `AuthSubject`.

Rationale: Goal G9 / `archive/PRD.md` §9, §15 and ADR-EA-009; this is the boundary the entire two-library split depends on, and it must hold even for first-party plugins such as `Roles`.

### URS-EA-012 — At most one plugin resolves subjects

The `SubjectResolver` slot has exactly one active implementation at a time: the fail-closed identity-only default, or the single plugin that overrides it (for example, `Roles`). A tuple with two overriding plugins is rejected under URS-EA-005.

Rationale: consequence of Goal G2 and the slot/registry distinction (ADR-EA-012); a subject must have one, unambiguous origin.

### URS-EA-013 — The application's wiring is small and declarative

A working application's authentication setup is expressible as `Auth.make([...plugins])` followed by a `Layer.provide` pipeline of port implementations and configuration overrides — no imperative registration step, no separate manifest file, no build step beyond normal TypeScript compilation.

Rationale: Goal G7.

### URS-EA-014 — A plugin author can define new hook points and slots

A plugin author can declare a hook point or a slot that is scoped to their own plugin, in the same way core declares `BeforeSignUp` or `SubjectResolver`, so that other plugins (with a declared dependency) can tap or query it.

Rationale: extension need implied by §6 (plugin authors); without this, third-party plugins could not offer the same extensibility core offers.

### URS-EA-015 — A plugin's tables and contract groups are namespaced to its id

A plugin's `tables` must be prefixed with its own id, and its `contract` groups must be named its own id or a dotted sub-id of it; a plugin definition that violates either is a compile error, not a naming convention enforced by review.

Rationale: Goal G2 and G7; this is what makes plugin composition safe without a central registry checking for name collisions at runtime.

### URS-EA-016 — An adapter author can swap a driver without touching plugin code

Replacing the `SqlClient`, `KeyValueStore`, or `RateLimiter` implementation (for example, moving from an in-memory store to Redis, or from SQLite to Postgres) is a Layer substitution at the application's composition root. No plugin package needs to change or be republished.

Rationale: need of adapter/framework-integration authors (§6); ports exist precisely so this substitution is uniform.

### URS-EA-017 — A signed-in user can inspect and manage their own sessions

A user can list their active sessions (with device/user-agent metadata), revoke a specific session, revoke every session but the current one, and sign out, all through the core `session` contract group.

Rationale: baseline expectation of any application developer building on awthaq (§6); this is core, not a plugin, precisely because every application needs it.

### URS-EA-018 — Verification tokens are scoped to one purpose and consumed once

A verification token (email verification, password reset, and similar flows) is valid only for the purpose it was issued for, and using it succeeds at most once; a second use of the same token is a distinct, observable failure rather than a silent success or an ambiguous error.

Rationale: baseline security expectation carried into functional requirements from `archive/PRD.md` §13 (domain stratum) and §18 (security model, see also NFR-EA-005).

### URS-EA-019 — OAuth account linking is explicit by default

Signing in through an OAuth provider whose verified email matches an existing account does not automatically link the two accounts unless the application has explicitly opted a provider into trusted, verified-email auto-linking.

Rationale: `archive/PRD.md` §16, §25 (open decision resolved in the default) and the account-takeover risk documented in the research corpus (`research/05-oauth-oidc.md`); explicit-by-default is the safer posture for a library others will configure without necessarily reading every implication.

### URS-EA-020 — The CLI can inspect a plugin graph without running the application

An operator or developer can list the installed plugin graph, routes, and migration status of an `Auth.make` composition using the CLI, without starting an HTTP server or otherwise running the application. The CLI reads the manifest `Auth.make` derives; it does not execute application code to produce its output.

Rationale: operational need of all three user groups (§6, §20/§21); a static, side-effect-free introspection tool is what makes `doctor`-style pre-flight checks possible.

## 4. Non-functional requirements

### NFR-EA-001 — Session secrets are never stored in verifiable form

Only `SHA-256(secret)` of a session token is persisted; the plaintext secret exists solely in the token handed to the client. Comparison at verification time is constant-time.

Rationale: `archive/PRD.md` §18; a leaked session table must not be sufficient to authenticate as any user.

### NFR-EA-002 — Session cookies use the strictest available browser defaults

The session cookie is issued as `__Host-session; Secure; HttpOnly; SameSite=Strict; Path=/`, with no `Domain` attribute, unless an application explicitly opts into a looser policy.

Rationale: `archive/PRD.md` §18; this is the RFC 10017 (Browser-Based Apps BCP) floor the research corpus identifies as now normative (`research/04-sessions-tokens.md`).

### NFR-EA-003 — CSRF protection is enforced server-side and required by the client's type

Every unsafe-method endpoint enforces CSRF server-side, and `CsrfProtection`'s `requiredForClient: true` means a generated client does not type-check unless it also supplies the CSRF header — omission is a compile error for client authors, not a runtime gap.

Rationale: `archive/PRD.md` §10, §18.

### NFR-EA-004 — Passwords are hashed with argon2id by default and rehashed opportunistically

The default `PasswordHasher` port implementation uses argon2id, storing PHC-format strings, and rehashes a password's stored hash on a successful login if the stored parameters are weaker than current defaults.

Rationale: `archive/PRD.md` §18; NIST SP 800-63B-4 and the OWASP argon2id baseline the research corpus cites (`research/07-passwords-2fa.md`).

### NFR-EA-005 — Verification tokens are hashed at rest and consumed atomically

A verification token's value is never stored in verifiable plaintext, and consuming it (marking it used and taking the dependent action) happens in one transaction; a replayed token publishes an observable `auth.token.replay` event rather than failing silently.

Rationale: `archive/PRD.md` §13, §18.

### NFR-EA-006 — OAuth flows use PKCE and server-held state, with explicit linking

Every OAuth authorization-code flow uses PKCE with the S256 challenge method and server-side (not client-visible) state; account linking follows URS-EA-019.

Rationale: `archive/PRD.md` §18; RFC 9700 (OAuth BCP) as the security floor identified in `research/05-oauth-oidc.md`.

### NFR-EA-007 — Impersonation is off by default, gated, and fully audited

Impersonation capability does not exist unless an application installs the plugin that provides it; when installed, starting an impersonation session requires admin privilege and a reason, carries a hard expiry with no sliding refresh, preserves the dual identity (`actingAs`) on the resulting principal, and publishes an audit event.

Rationale: `archive/PRD.md` §18.

### NFR-EA-008 — Secrets and credentials never reach logs, spans, or published events

Passwords, tokens, and other sensitive values travel through the system wrapped as `Redacted`; a contract-level test suite asserts that no `Redacted` value ever reaches a log line, a tracing span, or a published domain event.

Rationale: `archive/PRD.md` §18, §19 (`runPluginContractTests`'s redaction check).

## 5. Traceability

| Requirement | Behavior(s) |
|---|---|
| URS-EA-001 | [BEH-EA-001](behaviors/01-plugin-contract.md#beh-ea-001-a-plugin-is-a-contextservice-class-produced-by-authpluginservice), [BEH-EA-009](behaviors/02-plugin-composition-validate.md#beh-ea-009-authmake-computes-three-outputs-from-one-plugin-tuple) |
| URS-EA-002 | [BEH-EA-009](behaviors/02-plugin-composition-validate.md#beh-ea-009-authmake-computes-three-outputs-from-one-plugin-tuple) |
| URS-EA-003 | [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value) |
| URS-EA-004 | [BEH-EA-009](behaviors/02-plugin-composition-validate.md#beh-ea-009-authmake-computes-three-outputs-from-one-plugin-tuple) |
| URS-EA-005 | [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value) |
| URS-EA-006 | [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value), [BEH-EA-089](behaviors/12-hooks.md#beh-ea-089-a-hook-point-is-declared-as-a-service-carrying-its-own-kind) |
| URS-EA-007 | [BEH-EA-001](behaviors/01-plugin-contract.md#beh-ea-001-a-plugin-is-a-contextservice-class-produced-by-authpluginservice), [BEH-EA-025](behaviors/04-contract-stratum.md#beh-ea-025-a-principal-is-a-tagged-union-carrying-a-zanzibar-shaped-reference) |
| URS-EA-008 | [BEH-EA-025](behaviors/04-contract-stratum.md#beh-ea-025-a-principal-is-a-tagged-union-carrying-a-zanzibar-shaped-reference) |
| URS-EA-009 | [BEH-EA-025](behaviors/04-contract-stratum.md#beh-ea-025-a-principal-is-a-tagged-union-carrying-a-zanzibar-shaped-reference), [BEH-EA-169](behaviors/22-client-effect.md#beh-ea-169-the-client-derives-from-the-merged-contract), [BEH-EA-193](behaviors/25-testing-harness.md#beh-ea-193-testauthlayer-is-the-whole-pipeline-over-memory), [BEH-EA-201](behaviors/26-cli.md#beh-ea-201-doctor-checks-link-config-and-insecure-defaults) |
| URS-EA-010 | [BEH-EA-033](behaviors/05-persistence-stratum.md#beh-ea-033-every-entity-is-a-modelclass-with-modeluuidv7insert-ids) |
| URS-EA-011 | [BEH-EA-145](behaviors/19-qadi-bridge-path-a.md#beh-ea-145-authorizedsubject-bridges-currentprincipal-to-currentsubject), [BEH-EA-153](behaviors/20-qadi-bridge-path-b.md#beh-ea-153-subjectextractor-runs-session-resolution-on-the-raw-request), [BEH-EA-161](behaviors/21-qadi-resolvers-obligations.md#beh-ea-161-attributes-resolved-from-the-user-table) |
| URS-EA-012 | [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value), [BEH-EA-137](behaviors/18-roles-subject-resolver.md#beh-ea-137-the-subjectresolver-slot-defaults-to-identity-only) |
| URS-EA-013 | [BEH-EA-009](behaviors/02-plugin-composition-validate.md#beh-ea-009-authmake-computes-three-outputs-from-one-plugin-tuple) |
| URS-EA-014 | [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value), [BEH-EA-089](behaviors/12-hooks.md#beh-ea-089-a-hook-point-is-declared-as-a-service-carrying-its-own-kind) |
| URS-EA-015 | [BEH-EA-001](behaviors/01-plugin-contract.md#beh-ea-001-a-plugin-is-a-contextservice-class-produced-by-authpluginservice), [BEH-EA-033](behaviors/05-persistence-stratum.md#beh-ea-033-every-entity-is-a-modelclass-with-modeluuidv7insert-ids) |
| URS-EA-016 | [BEH-EA-017](behaviors/03-ports-slots-hooks-registries.md#beh-ea-017-configuration-is-a-contextreference-with-a-default-value), [BEH-EA-033](behaviors/05-persistence-stratum.md#beh-ea-033-every-entity-is-a-modelclass-with-modeluuidv7insert-ids) |
| URS-EA-017 | [BEH-EA-049](behaviors/07-sessions.md#beh-ea-049-a-session-token-is-an-opaque-idsecret-pair) |
| URS-EA-018 | [BEH-EA-057](behaviors/08-verification-tokens.md#beh-ea-057-a-verification-token-is-scoped-to-one-purpose) |
| URS-EA-019 | [BEH-EA-121](behaviors/16-oauth.md#beh-ea-121-pkce-s256-is-structural-not-optional) |
| URS-EA-020 | [BEH-EA-201](behaviors/26-cli.md#beh-ea-201-doctor-checks-link-config-and-insecure-defaults) |
| NFR-EA-001 | [BEH-EA-049](behaviors/07-sessions.md#beh-ea-049-a-session-token-is-an-opaque-idsecret-pair) |
| NFR-EA-002 | [BEH-EA-049](behaviors/07-sessions.md#beh-ea-049-a-session-token-is-an-opaque-idsecret-pair), [BEH-EA-065](behaviors/09-authentication-middleware.md#beh-ea-065-the-authentication-middleware-tries-a-cookie-handler-first-in-its-declared-security-record) |
| NFR-EA-003 | [BEH-EA-073](behaviors/10-csrf.md#beh-ea-073-sec-fetch-site-is-the-primary-csrf-signal), [BEH-EA-169](behaviors/22-client-effect.md#beh-ea-169-the-client-derives-from-the-merged-contract) |
| NFR-EA-004 | [BEH-EA-113](behaviors/15-password.md#beh-ea-113-sign-up-issues-a-pending-user-and-a-verification-mail) |
| NFR-EA-005 | [BEH-EA-057](behaviors/08-verification-tokens.md#beh-ea-057-a-verification-token-is-scoped-to-one-purpose) |
| NFR-EA-006 | [BEH-EA-121](behaviors/16-oauth.md#beh-ea-121-pkce-s256-is-structural-not-optional) |
| NFR-EA-007 | [BEH-EA-041](behaviors/06-domain-users-accounts.md#beh-ea-041-a-user-is-identified-by-a-case-insensitively-unique-email), [BEH-EA-097](behaviors/13-events.md#beh-ea-097-authevents-is-a-bounded-pubsub) |
| NFR-EA-008 | [BEH-EA-097](behaviors/13-events.md#beh-ea-097-authevents-is-a-bounded-pubsub), [BEH-EA-193](behaviors/25-testing-harness.md#beh-ea-193-testauthlayer-is-the-whole-pipeline-over-memory) |

## 6. Known gaps

Writing requirements before an implementation exists is weaker than extracting them from one, in specific, nameable ways:

- **No real usage to observe.** These requirements cannot capture the sign-in edge case a support ticket would surface, the configuration combination a real deployment stumbles into, or the plugin interaction only visible once third-party authors start writing plugins. Requirements extraction from a shipped system routinely finds needs nobody stated up front; this document, by construction, contains none of those.
- **Numbers are estimates, not measurements.** Where a requirement implies a threshold (a rate-limit window, a token TTL), the value here is the design's stated default, not a value tuned against production traffic or abuse data.
- **The user groups are inferred, not interviewed.** §2's three audiences come from the PRD's stated target users, not from a survey or a body of support interactions with people who have actually tried to adopt the system.
- **Compile-time guarantees are asserted, not demonstrated.** Every "is a compile error" claim in §3 describes an intended type-level property of a design (`archive/design/plugins-as-layers.md`); none has been checked against an actual TypeScript compiler run, because no such code exists yet.
- **This document cannot be self-correcting yet.** A requirements specification derived from a live system gets revised when reality contradicts it. This one can only be revised when implementation begins and either confirms or contradicts what is written here — until then, gaps in it are invisible from the inside.
- **`traceability.md` previously had no URS/NFR crosswalk.** Until this revision, `traceability.md` cross-referenced behaviors, invariants, decisions, and planned test files, but never the `URS-EA-NNN`/`NFR-EA-NNN` requirements stated in this document — the only requirement-to-behavior table lived in this document's own §5, nowhere else in the traceability record. That asymmetry is now fixed: `traceability.md` §2 carries the same crosswalk. The gap is recorded here because it was a real defect in the specification tree for however long this document existed without it, not because the fix retroactively erases that it existed.
- **The `Organization` and `Admin` plugins were referenced before being formally specified.** An earlier audit found `spec/models/09-sso.md` (MOD-EA-009) listing `Organization` as a hard dependency, and `spec/behaviors/18-roles-subject-resolver.md`'s BEH-EA-142 asserting impersonation state is "set once, at `admin.impersonate`, per file 06's admin plugin" — but no `Organization` or `Admin` plugin had a model, a behavior, or even a non-normative adoption record anywhere in this repository; file 06 is Users and Accounts, not an admin plugin. Both false/dangling references are corrected as of this revision, and both plugins now have a non-normative adoption record: [MOD-EA-014](models/14-organization.md) (Organization) and [MOD-EA-015](models/15-admin-impersonation.md) (Admin/Impersonation). Neither has a behaviors file yet — no `BEH-EA` ids are allocated to either — so this remains a real gap, now at least a tracked one instead of a silently-assumed one.
