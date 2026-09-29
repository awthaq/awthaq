# Invariants

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-INV |
> | Revision | 1.4 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Corrected INV-EA-014's Source/Enforcement/Related fields, which falsely implied Admin-plugin behavior coverage that does not exist (CCR-EA-002) <br> 1.2 (2026-09-13): Updated INV-EA-014's Source/Enforcement/Related fields now that [27-admin-impersonation.md](behaviors/27-admin-impersonation.md) (BEH-EA-209 through 220) makes the Admin plugin's impersonation behavior normative (CCR-EA-004) <br> 1.3 (2026-09-29): Added INV-EA-018 (identifiers are never capabilities, APS-010) <br> 1.4 (2026-09-29): Replaced the pre-implementation banner and the "(planned)" runtime section; every INV-EA-007..016 Enforcement cell now names the test that exists (or says plainly that none does); the check that keeps them honest is in `spec/scripts/check-drift.mjs` (TMS-009, DTWS-007, DTWS-001, IDS-009, CCR-EA-006) |

---

An invariant, here, is a property the system is designed to hold — a statement that should be true of every plugin composition, every session, every token, every authorization decision. Each entry below names the property, the mechanism that makes it hold, and what breaks if that mechanism is absent or defeated.

> **How to read the Enforcement cells.** The **type-level invariants** in §1 are enforced by the TypeScript compiler acting on the plugin-composition types in `packages/core`, and are exercised by `@ts-expect-error` cases compiled by `tsc -p tsconfig.test.json` (part of `pnpm typecheck`). Each **runtime invariant** in §2 names the test that exercises it, or says in so many words that no test does; `spec/scripts/check-drift.mjs` fails `pnpm check` if a cell cites a test file that does not exist, or calls an existing file missing. A named test is evidence the mechanism works in the cases it covers, not a proof of the invariant.

---

## Type-level invariants

These are properties that the TypeScript compiler enforces through `Auth.make`'s `Validate<P>` and Effect's `Layer` type algebra (`packages/core/src/Auth.ts`, `AuthPlugin.ts`; design in `archive/design/plugins-as-layers.md` §1, §4.2). They differ from every other invariant in this document in one respect: their enforcing mechanism, the compiler, is not something awthaq had to build beyond the types themselves, and the cases are checked by `@ts-expect-error` tests in `packages/core/test/AuthPlugin.test.ts` and `HookPoint.types.test.ts`.

## INV-EA-001: A plugin dependency that is not installed keeps the application from compiling

**Source**: TypeScript compiler, via `Validate<P>` in `Auth.make` and `Layer` type algebra at `Layer.launch` — a plugin's `dependsOn` entries join its Layer's `RIn` (`archive/design/plugins-as-layers.md` §2.2, `DepsOf<typeof options>`); if the depended-on plugin's class is not among the tuple passed to `Auth.make`, its service instance remains unsatisfied in the composed Layer's `RIn`, and separately `Auth.make`'s `MissingDep<P>` check reports the missing plugin by name at the call site.

**Implication**: Without this, "plugin B needs plugin A" is representable only as documentation or a runtime assertion discovered at boot (or later, in production) — exactly the failure mode `archive/PRD.md` §2 attributes to better-auth's untyped plugin model (no dependency declarations, no compatibility gate). With it, an application that installs `TwoFactor` without `Password` never produces a running binary; the gap is visible in the editor.

**Related**: [BEH-EA-009 through 016](behaviors/02-plugin-composition-validate.md), [ADR-EA-008](decisions/008-plugin-is-context-service-class.md), [ADR-EA-001](decisions/001-plugins-contribute-layers.md).

## INV-EA-002: A port with no implementation keeps the application from compiling

**Source**: TypeScript compiler, via `Layer` type algebra at `Layer.launch` — a port (`PasswordHasher`, `Mailer`, `WebAuthn`, `SqlClient`, `Crypto`, `KeyValueStore`, `RateLimiter`) is required (`RIn`) by any plugin that uses it and is never provided (`ROut`) by a plugin (`archive/design/plugins-as-layers.md` §3.3); if the application's `Layer.provide` stack omits an implementation, that port's service remains in the final composed Layer's `RIn`, and `Layer.launch` / `Effect.provide` refuses to type-check against a required environment of `never`.

**Implication**: Without this, a missing `Mailer` implementation surfaces only when a password-reset email silently fails to send, in production, to a real user. With it, deleting the `Mailer.layerSes` line from an application's Layer stack (`archive/PRD.md` §26) is a compile error, not an incident.

**Related**: [BEH-EA-017 through 024](behaviors/03-ports-slots-hooks-registries.md), [ADR-EA-010](decisions/010-plugins-require-ports-never-provide.md).

## INV-EA-003: Two plugins declaring the same id is a compile-time error at `Auth.make`

**Source**: TypeScript compiler, via `Validate<P>`'s `DuplicateId<P>` conditional type, evaluated pairwise over the tuple passed to `Auth.make` (`archive/design/plugins-as-layers.md` §4.2) — the tuple's type is narrowed to a literal error-object type (`{ readonly "awthaq": "plugin id \"...\" appears more than once" }`) whenever two entries share an `id`, so the argument itself fails to type-check against `Auth.make`'s parameter type.

**Implication**: Without this, two plugins that happen to choose the same id (for example, two third-party plugins both named `"invite"`) could silently shadow one another's handler groups, tables, or migrations at the point where the tuple is folded — the exact "last-wins merge" failure mode `archive/PRD.md` §2 documents in better-auth. With it, the collision is named at the `Auth.make([...])` call site before anything runs.

**Related**: [BEH-EA-009 through 016](behaviors/02-plugin-composition-validate.md), [ADR-EA-008](decisions/008-plugin-is-context-service-class.md).

## INV-EA-004: Two plugins overriding the same exclusive slot is a compile-time error at `Auth.make`

**Source**: TypeScript compiler, via `Validate<P>`'s `SlotConflict<P>` conditional type — a slot (for example `SubjectResolver`) is a `Context.Reference` a plugin may override by providing it in its Layer's `ROut` (`archive/design/plugins-as-layers.md` §3.5); `SlotConflict<P>` walks the tuple's `ROut` types pairwise and, on finding one slot key present in two plugins' `ROut`, narrows the tuple's type to a literal naming both plugin ids and the slot.

**As shipped (MA-005)**: enforced at layer-build time, always — `Slots.override` requires the `SlotsRegistry` that `Auth.make` provides once per composition, so `Auth.make([Roles, Organization])` fails to build with a `SlotConflict` naming both plugins and the slot; a `Context.Reference` is invisible to `ROut`, which is why the compiler cannot see it.

**Implication**: Without this, installing both `Roles` and `Organization` — each of which wants to be the one source of truth for `SubjectResolver` — resolves by silent last-registration-wins, which is precisely the ambiguity ADR-EA-012 (Slots Are Exclusive, Registries Aggregate) exists to rule out. With it, `Auth.make([Roles, Organization])` fails to compile, naming both plugins and the contested slot, forcing an explicit composing plugin instead.

**Related**: [BEH-EA-017 through 024](behaviors/03-ports-slots-hooks-registries.md), [ADR-EA-012](decisions/012-slots-exclusive-registries-aggregate.md), [ADR-EA-008](decisions/008-plugin-is-context-service-class.md).

## INV-EA-005: A hook tap on an undefined hook point keeps the application from compiling

**Source**: TypeScript compiler, via `Layer` type algebra at `Layer.launch` — a hook point is a service (`HookPoint.Service`); tapping it (`BeforeSignUp.tap(...)`) produces a `Layer<never, never, R>` where `R` includes the hook point's own service (`archive/design/plugins-as-layers.md` §3.4); if no plugin in the composition defines that point, its service is never in any Layer's `ROut`, so it remains in the composed Layer's `RIn` and `Layer.launch` refuses to compile, the same shape of failure as a missing port.

**Implication**: Without this, a plugin author who mistypes a hook point's key, or who taps a point from a plugin that was later uninstalled, gets a tap that silently never fires — a no-op masquerading as a registered behavior. With it, the point's absence is a type error naming exactly what is missing, identical in kind to a missing plugin dependency.

**Related**: [BEH-EA-017 through 024](behaviors/03-ports-slots-hooks-registries.md), [BEH-EA-089 through 096](behaviors/12-hooks.md), [ADR-EA-001](decisions/001-plugins-contribute-layers.md).

## INV-EA-006: A plugin's contract group named outside its own namespace fails the plugin's own type definition

**Source**: TypeScript compiler, via a template-literal constraint on `AuthPlugin.Service`'s `contract` parameter — `GroupsFor<Id>` types a plugin's allowed groups as `HttpApiGroup<Id | \`${Id}.${string}\`, ...>` (`archive/design/plugins-as-layers.md` §2.2); a group id that is not the plugin's own id or a dotted sub-id of it does not satisfy `GroupsFor<Id>`, so the plugin class definition itself — not `Auth.make`, not `Layer.launch` — fails to type-check, at the point the plugin author writes it.

**Implication**: Without this, a plugin could mount handler groups at another plugin's namespace (or at core's), reproducing the route-collision and ownership-ambiguity problems `archive/PRD.md` §2 and §10 call out. With it, the constraint is checked once, at authoring time, and every consumer of the plugin inherits the guarantee for free — no downstream check is needed.

**Related**: [BEH-EA-001 through 008](behaviors/01-plugin-contract.md), [ADR-EA-003](decisions/003-httpapi-as-contract.md), [ADR-EA-008](decisions/008-plugin-is-context-service-class.md).

---

## Runtime invariants

These are properties that hold at runtime through the domain services, persistence layer, HTTP middleware and qadi bridge. Each is derived from `archive/PRD.md` §13 (Domain / Sessions), §15 (Authorization: qadi), and §18 (Security model). Each "Enforcement" cell names the test file that exercises it; where a test is missing the cell says so plainly rather than implying coverage.

## INV-EA-007: A session secret is never stored in plaintext, only its SHA-256 hash

**Source**: `Sessions` domain service — per `archive/PRD.md` §13 and §18, a session token is `id.secret`; only `SHA-256(secret)` is persisted, and comparison at verification time is constant-time over the fixed-length hash via `Crypto.digest` equality, never a comparison of the raw secret.

**Implication**: Without this, a read of the sessions table (a backup, a compromised replica, a misconfigured log) discloses live, bearer-equivalent session tokens directly. With it, the same disclosure discloses only hashes that cannot be replayed as a token.

**Enforcement**: `packages/core/test/Sessions.test.ts` — "BEH-EA-049/050: issues an opaque id.secret token, never storing the secret itself" and "BEH-EA-050/056: a tampered secret is rejected", against both `layerMemory` and `layerSql`; the hashing and the constant-time comparison are `hashSecret` and `constantTimeEqual` in `packages/core/src/Sessions.ts` (over `SecretHash`).

**Related**: [BEH-EA-049 through 056](behaviors/07-sessions.md), [ADR-EA-007](decisions/007-target-effect-v4.md).

## INV-EA-008: A session's absolute expiry never extends past its original value under sliding idle refresh

**Source**: `Sessions` domain service — `archive/PRD.md` §13 describes "absolute plus idle expiry from `SessionConfig`, throttled sliding refresh"; the intended rule is that idle-window refresh may push the session's idle deadline forward but must never move the absolute deadline set at issuance.

**Implication**: Without this, a session touched frequently enough could remain valid indefinitely, defeating the purpose of an absolute expiry entirely and turning "sliding window" into "no ceiling." With it, an attacker (or a legitimate but forgotten background tab) that keeps a session alive by activity alone is still cut off at the original absolute bound.

**Enforcement**: `packages/core/test/Sessions.test.ts` — "BEH-EA-051/INV-EA-008: idle refresh never pushes past the absolute expiry" (against both layers, driven by `TestClock`).

**Related**: [BEH-EA-049 through 056](behaviors/07-sessions.md).

## INV-EA-009: A verification token is consumable exactly once, inside the same transaction as the state change it authorizes

**Source**: `Verification` domain service — `archive/PRD.md` §13 and §18 specify purpose-scoped, hashed, single-use tokens consumed "in-transaction"; the intended mechanism is that marking a token consumed and applying the state change it authorizes (password reset, email confirmation) happen under one SQL transaction, so no window exists where the token is valid but the change has not applied, or the change has applied but the token can still be replayed.

**Implication**: Without atomicity, a race between two concurrent requests bearing the same token could apply the state change twice, or apply it once while leaving the token marked unconsumed and replayable. With it, replay is structurally impossible rather than merely checked-for.

**Enforcement**: `packages/core/test/Verification.test.ts` — "BEH-EA-058/062: consuming succeeds exactly once, and a replay is refused" and the concurrent-consumption race case (MLO-006), against `layerMemory` and `layerSql` (one atomic `UPDATE ... RETURNING`, ADR-EA-016). Wrapping `consume` and the caller's own state change in one SQL transaction is the calling plugin's job (`packages/password/test/Password.test.ts` covers `confirmReset`).

**Related**: [BEH-EA-057 through 064](behaviors/08-verification-tokens.md).

## INV-EA-010: Verification token replay is observable — every consumption attempt after the first publishes an event

**Source**: `AuthEvents` / `Verification` domain service — `archive/PRD.md` §13 states "replay publishes `auth.token.replay`"; the intended mechanism is that a consumption attempt against an already-consumed (or expired, or unknown) token publishes a replay event to the bounded `AuthEvents` `PubSub` in addition to failing the request.

**Implication**: Without this, replay attempts are indistinguishable from ordinary invalid-token errors in any downstream monitoring, so an attacker probing stale links leaves no operational signal. With it, replay is a first-class, queryable event stream independent of the audit table.

**Enforcement**: `packages/core/test/Verification.test.ts` — "BEH-EA-059: every failed consumption publishes auth.token.replay" (an already-consumed and a never-issued identifier both publish it).

**Related**: [BEH-EA-057 through 064](behaviors/08-verification-tokens.md), [BEH-EA-097 through 104](behaviors/13-events.md).

## INV-EA-011: CSRF protection is required by the generated client's type, not merely documented

**Source**: `CsrfProtection` `HttpApiMiddleware` — `archive/PRD.md` §10 and §16 specify `CsrfProtection` with `requiredForClient: true`, so `HttpApiClient.make` / `AtomHttpApi.Service` generation over a contract that declares this middleware does not type-check unless `HttpApiMiddleware.layerClient(CsrfProtection, ...)` is also supplied.

**Implication**: Without this, CSRF enforcement is a server-side check a client author could forget to satisfy and only discover via a runtime 403 in production. With it, an application that omits the CSRF client layer never produces a compiling client — the same "compiler as gate" pattern as the type-level invariants in §1, but proved here by a test against the generated client type rather than by `Auth.make` itself, since it depends on runtime contract construction.

**Enforcement**: `packages/client/test/Csrf.test.ts` ("CsrfClientLive (BEH-EA-170/INV-EA-011)", a type-level proof against `Api.CsrfProtection` itself) and `packages/server/test/Csrf.test.ts` (`requiredForClient` enforced by the generated client's own type). There is no separate `Csrf.test-d.ts`.

**Related**: [BEH-EA-073 through 080](behaviors/10-csrf.md), [BEH-EA-169 through 176](behaviors/22-client-effect.md).

## INV-EA-012: A qadi resolver's failure never becomes an authorization denial

**Source**: qadi bridge, governed by qadi's own rule "failure is not denial" as inherited into awthaq per `archive/PRD.md` §5 (Design principle 7) and §15 — a resolver (attributes, relationships, decision history) that fails (times out, throws, cannot reach its data source) must surface as a distinguishable failure outcome, never silently coerced into a `false` / `AccessDenied` decision.

**Implication**: Without this, a transient database blip or a slow relationship lookup would masquerade as "this user may not do this," which is both a wrong answer and an unauditable one — a legitimate user is refused for a reason that looks like policy when it is actually infrastructure. With it, callers can distinguish "denied by policy" (403) from "the system could not decide" (502 or equivalent), per `archive/PRD.md` §15's "Rules" bullet.

**Enforcement**: `packages/qadi/test/Resolvers.test.ts` ("UserAttributes maps a Users outage to AttributeResolveError (TS-002)": a store outage is a typed, attribute-naming `AttributeResolveError`, never `undefined` and never an uncaught defect) and `packages/organization/test/OrganizationQadi.test.ts` (the relationship resolver's equivalent). `packages/qadi/test/AuthorizedSubject.test.ts` covers the bridge wiring, not this rule.

**Related**: [BEH-EA-161 through 168](behaviors/21-qadi-resolvers-obligations.md), [ADR-EA-009](decisions/009-authorization-delegated-to-qadi.md).

## INV-EA-013: An endpoint under qadi's declared-permission path with neither a permission nor a public-endpoint annotation is refused, never silently allowed

**Source**: `SubjectExtractor` / `RequirePermission` bridge, Path B — `archive/PRD.md` §15 states "unannotated endpoints are refused"; the intended mechanism is that every endpoint reachable through the Path B contract must carry either a `RequiredPermission` annotation or an explicit `PublicEndpoint` annotation, and the middleware's default for an endpoint carrying neither is refusal, not pass-through.

**Implication**: Without this, an endpoint added to a contract and simply forgotten to annotate would be reachable unauthenticated-for-authorization-purposes by default — the single most common real-world authorization bug (the "new route nobody remembered to guard" class). With it, forgetting the annotation produces a refused endpoint, which is loud and immediately visible, rather than an open one, which is silent.

**Enforcement**: `@qadi/http`'s own `RequirePermission` refuses an unannotated endpoint; awthaq installs `SubjectExtractorLive` underneath it (`packages/qadi/src/SubjectExtractor.ts`) and does not reimplement the refusal. There is no awthaq-side test for it (a `packages/qadi/test/RequirePermission.test.ts` does not exist); the refusal is verified in the sibling `qadi` repository's own suite.

**Related**: [BEH-EA-153 through 160](behaviors/20-qadi-bridge-path-b.md), [ADR-EA-009](decisions/009-authorization-delegated-to-qadi.md).

## INV-EA-014: An impersonation session carries a hard expiry with no sliding refresh

**Source**: `Admin` plugin, impersonation — [BEH-EA-209/210](behaviors/27-admin-impersonation.md) now normatively fix this: an impersonation session's expiry is fixed at issuance (`idleExpiresAt = absoluteExpiresAt`) and is never extended by activity, unlike an ordinary session's idle-refresh behavior (INV-EA-008). `archive/PRD.md` §17 and §18 originally named it as "off by default, admin-gated, reason required, hard expiry, dual identity, audit events."

**Implication**: Without a hard ceiling, an admin impersonating a user during an active support session could remain impersonating indefinitely simply by continuing to act, which is a materially worse blast radius than an ordinary session outliving its absolute expiry. With it, impersonation is bounded no matter how continuously it is used.

**Enforcement**: [BEH-EA-209/210](behaviors/27-admin-impersonation.md) — `packages/core/test/Sessions.test.ts` ("BEH-EA-210: a session issued with actingAs gets idleExpiresAt = absoluteExpiresAt" and "BEH-EA-210: verify never advances idleExpiresAt for an actingAs session") for the session mechanism, and `packages/admin/test/Admin.test.ts`, `packages/admin/test/AuthHttp.test.ts` and `packages/admin/test/ImpersonationRecords.test.ts` for the end-to-end impersonation session.

**Related**: [BEH-EA-209 through 220](behaviors/27-admin-impersonation.md), [MOD-EA-015](models/15-admin-impersonation.md) (superseded non-normative sketch). [BEH-EA-049 through 056](behaviors/07-sessions.md) covers ordinary session expiry/idle-refresh only, by contrast (INV-EA-008); BEH-EA-210 is the one place that contrast is bridged.

## INV-EA-015: The `(provider, subject, issuer)` tuple is unique per account, and the OAuth state / PKCE verifier is single-use

**Source**: `OAuth` plugin, `Accounts` domain service — `archive/PRD.md` §18 states "OAuth: PKCE S256, server-side state, explicit linking, `(provider, subject, issuer)` uniqueness"; the intended mechanism is a uniqueness constraint on that tuple at the accounts table, plus single-use, server-side-stored state and PKCE verifier values consumed exactly once during the authorization-code exchange.

**Implication**: Without tuple uniqueness, two different upstream accounts (or the same upstream account under two issuers, in a token-confusion attack) could collide onto one local account. Without single-use state/verifier, a captured or replayed authorization callback could complete a second time. With both, account linking is unambiguous and the OAuth exchange cannot be replayed.

**Enforcement**: uniqueness: the `UNIQUE ("providerId", subject, issuer)` index in `packages/sql/src/CoreMigrations.ts` and `packages/core/test/Accounts.test.ts` ("BEH-EA-125: a second link under the same (providerId, subject, issuer) is rejected"); single-use flow state: `packages/oauth/test/OAuth.test.ts` ("REQ-EA-333: a replayed callback using an already-consumed state fails").

**Related**: [BEH-EA-121 through 128](behaviors/16-oauth.md).

## INV-EA-017: The core identity tables share one transaction domain, and any partitioning scheme co-locates a user with its accounts

**Source**: `OAuth` plugin's just-in-time sign-up and `Password.confirmReset` — the two transactions that depend on it. OAuth's first sign-in creates a `users` row and links its `accounts` row inside one `SqlTransaction.withTransaction` (a failure between the two would otherwise leave an orphaned, unlinked user with no way back in), and `confirmReset` consumes a verification token and rotates credentials in one (BEH-EA-058). `SqlTransaction` (`layerSql`) is one `SqlClient` transaction: it is atomic only across tables that live in the same logical database.

**Implication**: The core identity tables — `users`, `accounts`, `sessions`, `verification_tokens` — must share a single transaction domain. A deployment that shards or partitions them (by tenant, region or user id) must place a user and all of that user's accounts (and sessions and verification tokens) in the same shard, or the cross-table transactions above silently stop being atomic. There is deliberately no runtime assertion: the boundary is a deployment/partitioning choice, and detecting it would be speculative infrastructure; the invariant is a design constraint every shard-key proposal (multi-tenancy, data residency) must respect. `SqlTransaction.layerNoop` (in-memory compositions) is atomic only per `Ref`, so a memory composition can still orphan a user if `accounts.link` dies — acceptable for development and tests only.

**Enforcement**: Design constraint, no runtime check. Referenced from [BEH-EA-035](behaviors/05-persistence-stratum.md#beh-ea-035-repositories-are-built-with-sqlmodelmakerepository-over-the-ambient-sqlclient-never-opening-their-own-transactions); the transactions relying on it are covered by `packages/oauth/test/OAuth.test.ts` and `packages/password/test/Password.test.ts`.

**Related**: [BEH-EA-035](behaviors/05-persistence-stratum.md), [BEH-EA-058](behaviors/08-verification-tokens.md), [BEH-EA-121 through 128](behaviors/16-oauth.md).

## INV-EA-016: A plugin cannot alter a shared table outside its declared extension points

**Source**: Persistence stratum, plugin table-prefix constraint — `archive/PRD.md` §9.1 and `archive/design/plugins-as-layers.md` §2.1-§2.2 require a plugin's `tables` to be named `${Id}_${string}`, and shared tables (`users`, `sessions`, `accounts`) are owned by core plugins; the intended runtime rule (beyond the compile-time namespace check, INV-EA-006's persistence analogue) is that a plugin's migrations may only create or alter tables under its own prefix, and any extension to a shared table happens only through a declared extension point (a hook point contributing derived data, or a registry such as `SessionClaims`), never a direct `ALTER TABLE` on `users` or `sessions` from plugin migration code.

**Implication**: Without this, two plugins could each migrate the same shared table in incompatible ways, or a plugin could silently widen a core table's shape in a way core does not know about — the schema-column "silent last-wins merge" failure `archive/PRD.md` §2 names as a better-auth failure mode. With it, a shared table's shape is owned by exactly one plugin, and every other plugin's relationship to it is mediated by an explicit, typed extension point.

**Enforcement**: partial. The table-prefix half is checked per plugin by `runPluginContractTests` (`packages/test/src/TestAuth.ts`, "every declared table carries this plugin's own id prefix"; its own suite is `packages/test/test/runPluginContractTests.test.ts`), and `Auth.make` refuses a plugin that reads another's table without depending on it (`packages/core/test/AuthPlugin.test.ts`, JH-007). No test asserts that a plugin's migration DDL touches only its own tables, and `packages/sql/test/MigrationOwnership.test.ts` does not exist.

**Related**: [BEH-EA-033 through 040](behaviors/05-persistence-stratum.md), [BEH-EA-089 through 096](behaviors/12-hooks.md), [ADR-EA-004](decisions/004-database-neutral-models.md).

## INV-EA-018: Identifiers are never capabilities — no state transition acts on a principal or session id without a credential's proof

**Source**: APS-010, and PIL-007's own finding — principal and session ids are UUIDv7 (time-ordered, therefore partially predictable), and the session id in particular is the *public* half of the `id.secret` token: it appears in cookies, JWT `sid` claims, error messages and logs. Any path that authorizes, or even changes state, on an id alone is one leaked or guessed id away from abuse (PIL-007: presenting `<supersededId>.<anything>` used to trigger reuse detection and revoke the user's whole live session family).

**Implication**: Without this, an id disclosed for a benign purpose (a device list, a log line, a JWT claim) becomes a lever for targeted denial of service or worse. With it, every operation that acts on a session or principal id first proves possession of the matching secret or credential (`Sessions.verify` proves the secret before evaluating any row state; ownership-scoped operations — `Sessions.findOwned`/`revokeOwned` — additionally bind the id to the authenticated user), and error responses for unknown, foreign and forged ids are uniform (BEH-EA-086).

**Enforcement**: `Sessions.verify` (`packages/core/test/Sessions.test.ts` — the PIL-007 tests); `Sessions.revokeOwned`/`findOwned` (same file, GC-005/TIR-003 tests). Ids are additionally never used as bearer tokens by any endpoint.

**Related**: [BEH-EA-049](behaviors/07-sessions.md#beh-ea-049-a-session-token-is-an-opaque-idsecret-pair), [BEH-EA-056](behaviors/07-sessions.md#beh-ea-056-session-secret-verification-is-a-constant-time-comparison-over-a-fixed-length-hash), [BEH-EA-086](behaviors/11-http-error-mapping.md#beh-ea-086-error-responses-are-enumeration-safe-uniformly-across-the-http-surface).
