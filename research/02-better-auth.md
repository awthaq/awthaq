# Better Auth — Research

Research date: 2026-09-12. All versions verified against npm/GitHub on this date unless noted.

## TL;DR

- **Status:** better-auth `1.7.4` is `latest` on npm (package modified 2026-09-10; 930 published versions since 2024-04-22). MIT-licensed. Acquired by **Vercel on 2026-07-07**; founder Bereket Engida (`bekacru`) and team joined Vercel; library stays open source and framework-agnostic, and the team now also drives the **Agent Auth** protocol (Vercel blog, npm registry).
- **Funding:** $5M seed (June 2025) led by Peak XV Partners with Y Combinator, Chapter One, P1 Ventures, Seaplane Ventures; ~4.7M weekly npm downloads and 850+ contributors at acquisition (better-auth blog; Vercel blog).
- **Scale of plugin surface:** 50+ official plugins (auth methods, org/RBAC, API keys, JWT, SSO/SCIM, OAuth/MCP provider, billing, captcha) plus a PR-curated, explicitly unverified community list. Plugins are being split into scoped `@better-auth/*` packages (`sso`, `scim`, `oauth-provider`, `api-key`, `passkey`, `electron`).
- **Plugin contract (source-verified):** one object with `id` + optional `init`, `endpoints`, `middlewares`, `onRequest/onResponse`, `hooks.before/after` (matcher+handler), `schema`, `migrations`, `$Infer`, `$ERROR_CODES`, `rateLimit`, and `adapter` (per-model DB override). Only `id` is required; there is **no** dependency declaration, **no** `apiVersion`, **no** compile-time conflict detection.
- **Client plugins mirror server plugins via type-only `$InferServerPlugin`:** endpoint paths are inferred and kebab-cased→camelCase into `authClient.<plugin>.<action>`; extras come from `getActions`/`getAtoms` (nanostores). One contract exists only loosely — client plugins duplicate semantics; `inferAdditionalFields<typeof auth>` is needed for field inference, and inference breaks across separate client/server repos (documented caveat).
- **Database:** built-in Kysely adapter (PG/MySQL/SQLite/D1/MSSQL) + drizzle/prisma/mongo/memory adapters. Migrations are **schema-diff push** (`auth migrate` prompts; `auth generate` emits SQL or ORM schema) — there is no versioned migration ledger, no deterministic planner, and 1.7 required manual data migrations (SCIM reprovision, Microsoft `sub`→`oid`, OAuth client table rename).
- **Shared-table extension is the core plugin-schema mechanism:** twoFactor/admin/username/organization all add columns to `user`, and organization adds `activeOrganizationId` to `session` (source-verified) — the plugin system is *not* strictly additive over core.
- **Type-inference fragility is the #1 criticism:** `$Infer` regressions collapsing `user` to `any` (#5538, #5462), sensitivity to `tsconfig` (`moduleResolution: "node10"`, `exactOptionalPropertyTypes`), and `Awaited<ReturnType<...>>` workarounds that "may break with multiple plugins or large configs" (#2818).
- **Security history is substantial:** 14 advisories in the June 2026 cycle alone (2 critical: SSO provider-registration URL validation; OIDC/MCP refresh-token handling), plus CVE-2025-61928 (unauthenticated API-key creation for any user), CVE-2026-67327 (pre-account hijacking via magic-link/OTP), CVE-2026-67336 (`none` alg + plain PKCE defaults in oidcProvider/mcp), CVE-2025-71399 (rou3 path-normalization bypasses `disabledPaths`/rate limits), CVE-2025-71403 (`trustedOrigins` open redirect). A dedicated security-review workstream started 2026-06; no third-party audit has been announced as of 2026-09 [INFERENCE from public channels].
- **Biggest opportunities for effect-auth:** a real plugin compiler (deps, cycles, route/schema conflicts), Effect `HttpApi`/`HttpApiClient` so the client is *derived* not inferred-by-convention, a versioned migration planner with ledger and destructive-op guardrails, typed error channels instead of string `APIError`, session tokens hashed at rest, and deny-by-default account linking.

---

## Questions answered

### Q20 — Minimal plugin definition contract and `apiVersion` policy

Evidence: The entire `BetterAuthPlugin` contract is `id` + optional contributions (`init`, `endpoints`, `middlewares`, `onRequest/onResponse`, `hooks`, `schema`, `migrations`, `$Infer`, `$ERROR_CODES`, `rateLimit`, `adapter`) — `packages/core/src/types/plugin.ts:39`. Docs: "The only required property is `id`" ([plugins docs](https://better-auth.com/docs/concepts/plugins)).

Server assembly: `betterAuth(options)` returns a single instance exposing `handler` (a `Request → Response` Web-handler mounted at `basePath`, default `/api/auth`), `api` (server-side endpoint invocation as plain functions, bypassing HTTP), `$context` (a `Promise<AuthContext & InferPluginContext>` resolving options, tables, secret, cookies helper, logger, `db`/`adapter`/`internalAdapter`, `trustedOrigins`/`isTrustedOrigin` — source `types/auth.ts:17`, `auth/base.ts:115`, [plugins docs context object](https://better-auth.com/docs/concepts/plugins)), and `$Infer` (source `types/auth.ts:21`). Plugins mutate this context at init (`init?(ctx)` may return a modified `context`/`options`), and a plugin's `adapter` field can *override core database operations per model* (`packages/core/src/types/plugin.ts`) — a powerful but entirely untyped seam. Every plugin initializes eagerly at instance creation; there is no compiled artifact, so all validation is deferred to runtime ([database docs — schema validation fails per-request](https://better-auth.com/docs/concepts/database#schema-validation)).

There is no `apiVersion`; compatibility is managed by semver + upgrade guides (e.g., the [1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide)), and a plugin breaking under a new core surfaces at runtime/typecheck time, not via an explicit contract gate. The June 2026 security post shows the operational pain of implicit coupling: advisories span top-level `better-auth` *and* scoped packages that must be upgraded in lockstep.

**Recommendation:** Require `{ id, version, apiVersion, capabilities }` metadata (as PRD §9.2 already sketches) and refuse to compile on mismatch with an actionable error. `id`-only contracts scale poorly once third-party plugins exist — better-auth's own remediation path (manual upgrade guides, scoped-package lockstep) is evidence.
**Confidence:** high

### Q21 — How plugins declare dependencies

Evidence: better-auth plugins **cannot declare dependencies at all**. A repo-wide grep of `packages/better-auth/src/plugins` for `requiresPlugins|requiresCapabilities|dependencies` returns nothing (verified 2026-09-12 against `main`). Cross-plugin needs are implicit: e.g., the organization plugin's `requireOrgRole` helper assumes a session exists (`sessionMiddleware` composed by the endpoint author), and `apiKey`'s "organization-owned keys" feature silently requires both plugins to be installed ([api-key docs](https://better-auth.com/docs/plugins/api-key#features)). Security advisories about ownership checks (GHSA-fmh4-wcc4-5jm3 organization invitation ownership; GHSA-g38m-r43w-p2q7 OAuth account linking ownership) show what unvalidated composition costs.

**Recommendation:** Declare dependencies as `Context.Tag` requirements (PRD Q21 option 3): a plugin's `Layer` already names its required services in `R`, so `Layer.mergeAll` composition *is* the dependency check — missing requirement = compile error + missing-service diagnose at Layer build. Keep a small plugin-id list only for ordering/migrations. This is exactly the capability better-auth lacks and Effect gives for free.
**Confidence:** high

### Q22 — Cycle detection and compile-error UX

Evidence: With no dependency graph, better-auth has no cycles to detect; ordering problems instead appear as runtime `undefined` context or hooks that don't fire [INFERENCE from architecture]. Its closest analog is schema validation at init: "Requests await the same check and fail if the schema does not match" ([database docs](https://better-auth.com/docs/concepts/database#schema-validation)) — a runtime, per-request failure mode.

**Recommendation:** effect-auth's compiler (PRD §12) should detect cycles before any Layer is built and render the cycle path with the offending plugin ids plus a docs link (PRD §9.4), e.g. `PluginDependencyCycle: password → session → password` exactly as PRD §9.4 sketches. The usability bar should come from better-auth's *good* runtime errors (schema validation prints the missing table/column plus the fix command) applied to *compile* time: missing dependency → "plugin `apiKey` requires capability `organization` — install `@effect-auth/plugin-organization` or remove the requirement", cycle → the full path, conflict → both claiming plugin ids and the contested route/column. This is purely additive value better-auth cannot match because it never builds a graph.
**Confidence:** high

### Q23 — Capability namespaces, registry, exclusivity

Evidence: better-auth has no capability registry. Namespacing is by **convention only**: "Make sure your paths are unique to avoid conflicts with other plugins. If you're using a common path, add the plugin name as a prefix" ([plugins docs](https://better-auth.com/docs/concepts/plugins#rules-for-endpoints)). Server and client plugins share the same `id` string by convention; the client uses it to match `$InferServerPlugin`. There is no `provides/requires/conflicts` concept.

**Recommendation:** Adopt explicit capability strings with reserved prefixes (`auth.*` core-owned) and declared `provides/requires/conflicts`, enforced at compile time (PRD §34, §36). Keep plugin `Context.Tag` identifiers globally prefixed by package (`"@effect-auth/plugin-organization/OrganizationService"`) — Effect tags make collision-free namespacing structural rather than conventional.
**Confidence:** high

### Q24 — Route conflict policy

Evidence: Endpoint rules are documentation-only: kebab-case paths, GET/POST only, mutating actions POST, "make sure your paths are unique" ([plugins docs](https://better-auth.com/docs/concepts/plugins#rules-for-endpoints)). The underlying router is `better-call` over `rou3`; CVE-2025-71399 showed route-matching subtleties become security bugs — extra slashes let attackers "bypass disabledPaths configuration and path-based rate limits" in versions bundling the unfixed rou3 (CISA SB26-215). There is no param-name-mismatch or override detection.

**Recommendation:** effect-auth should statically reject exact path collisions and param-name mismatches (`:id` vs `:orgId`) in the compiler (PRD §9.4), since `HttpApi` endpoints are first-class values; normalize URL paths before matching/rate-limiting (better-auth's CVE is the cautionary tale). Per-plugin prefixes should be a *default* (enforced), not a convention.
**Confidence:** high

### Q25 — Schema conflict policy

Evidence: Plugin schemas are `{ tableName: { fields, modelName, indexes, disableMigration } }` with field attrs `type` (string/number/boolean/date), `required`, `unique`, `fieldName`, `references` (default `onDelete: cascade`), and table-level `indexes` (≤16 fields) ([plugins docs](https://better-auth.com/docs/concepts/plugins#schema)). Adding fields to `user`/`session` is a first-class feature and the *standard* way plugins ship data (twoFactor: `user.twoFactorEnabled`; admin: `user.role/banned/banReason/banExpires` — source `plugins/admin/schema.ts`). No validation exists for two plugins claiming the same column on a shared table; runtime "schema validation" checks DB drift, not plugin-vs-plugin conflicts.

**Recommendation:** effect-auth must distinguish **side tables** (default, zero conflict surface) from **shared-table extensions** (explicit, reviewed, declared per-column, first-writer-wins with a compile error on duplicate column claims) per PRD §20/§78. Better-auth's `input: false` / `returned: false` field flags are excellent — copy them as Schema-level metadata (server-owned vs user-writable, returned-in-responses).
**Confidence:** high

### Q26 — Migration aggregation: ordering, generated vs handwritten, reviewability

Evidence: better-auth's story is schema *push*, not migrations: `npx auth migrate` "checks your database and prompts you to add missing tables or update existing ones" (Kysely adapter only); `npx auth generate` emits SQL or a Drizzle/Prisma schema for ORM-managed setups; `getMigrations()` supports programmatic runs (Workers/D1), Kysely-only ([database docs](https://better-auth.com/docs/concepts/database#cli)). Plugin `schema` "will automatically create migrations"; hand-written `migrations` are an escape hatch when migrations are disabled per table (`packages/core/src/types/plugin.ts`). There is no migration ledger, no ordering by plugin topology, no destructive-op confirmation model — and real upgrades require **manual** SQL/data steps: 1.7 asks users to deduplicate `(providerId, accountId)` keys, reprovision SCIM data, move `oauthApplication`→`oauthClient` rows, and even hand-roll `ALTER TABLE account ALTER COLUMN issuer DROP NOT NULL` for 1.7.0–1.7.2 databases ([1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide)). The `issuer` column was added in 1.7.0–1.7.2 and removed again in 1.7.3 — within one minor.

**Recommendation:** effect-auth should implement PRD §21 fully: a deterministic planner over the aggregated Schema IR (plugins in topo order, stable table/column ordering), a ledger table, `auth migration generate` producing reviewable artifacts, dry-run + explicit confirmation for destructive ops, and a **data-migration** escape hatch (versioned, testable Effects) — the 1.7 guide is a catalog of exactly the failure modes this prevents.
**Confidence:** high

### Q27 — Hook semantics: typed contexts, abort vs observe, isolation, ordering

Evidence: Global config hooks are a single `before`/`after` `createAuthMiddleware`; "each hook takes a single middleware function, not an array. To run logic for different endpoints, branch on `ctx.path`" ([hooks docs](https://better-auth.com/docs/concepts/hooks)). Plugin `hooks.before/after` are `{matcher, handler}` arrays ([plugins docs](https://better-auth.com/docs/concepts/plugins#hooks)). Key semantics: **hooks run even when the endpoint is invoked directly via `auth.api`, while middlewares only run on HTTP requests** ([plugins docs](https://better-auth.com/docs/concepts/plugins#middleware)). Abort = throw `APIError` or return a `Response`; mutation = return `{context}`; after-hooks see `ctx.context.returned` (response or APIError), `newSession`, `responseHeaders`. A separate `databaseHooks` layer (user/session/account × create/update/delete) can abort via `return false` or replace payloads ([database docs](https://better-auth.com/docs/concepts/database#database-hooks)). Ordering across multiple plugins' hook arrays is undocumented. A `runInBackground(ctx.context.runInBackground(...))` facility schedules post-response work ([hooks docs](https://better-auth.com/docs/concepts/hooks#runinbackground)).

**Recommendation:** effect-auth should preserve the hook-vs-event split (PRD §17/§18) but make three things explicit: (1) which hooks may abort (typed error channel) vs observe (failing observers isolated, never fail the request); (2) deterministic order = plugin topo order + explicit priority; (3) one hook registry as a service, not string-matched path branching. Copy `runInBackground` as `Effect.forkDaemon`/scoped background execution with a redacted span.
**Confidence:** high

### Q28 — Middleware contributions and ordering

Evidence: Plugins contribute `middlewares: [{path, middleware}]` matched by better-call path matchers; they run only on API requests ([plugins docs](https://better-auth.com/docs/concepts/plugins#middleware)). Auth is opt-in per endpoint via `use: [sessionMiddleware]`; helpers `getSessionFromCtx`, `requireResourceOwnership({model, idParam, idSource, ownerField, ...})`, and `requireOrgRole({orgIdParam, allowedRoles})` layer ownership/RBAC checks after session middleware ([plugins docs](https://better-auth.com/docs/concepts/plugins#server-plugin-helper-functions)). Ordering relative to other plugins' middleware is implicit; `onRequest`/`onResponse` wrap *everything*.

**Recommendation:** effect-auth: middleware as `HttpApi`-level `Effect` middleware composed in the compiler; auth/`CurrentPrincipal` provided once (PRD §14), with ownership/role checks as typed capabilities (`requireOwned`, `requirePermission`) rather than per-endpoint middleware stacking. If both exist, define precedence rules in the compiler, not docs. The `requireResourceOwnership`/`requireOrgRole` helpers are a DX pattern worth adapting (as typed handlers, PRD Q70).
**Confidence:** high

### Q29 — Client contributions: how a client plugin derives from the server plugin

Evidence: Client plugins are a separate interface (`packages/core/src/types/plugin-client.ts:94`): `id`, `$InferServerPlugin` ("only used for type inference. don't pass the actual plugin"), `getActions($fetch, $store, options)`, `getAtoms($fetch)` (nanostores), `pathMethods`, `fetchPlugins`, `atomListeners`, `$ERROR_CODES`. Paths are inferred from the server plugin and kebab→camel-cased (`/my-plugin/hello-world` → `myPlugin.helloWorld`); `pathMethods` overrides GET/POST ([plugins docs](https://better-auth.com/docs/concepts/plugins#creating-a-client-plugin)). `inferAdditionalFields<typeof auth>()` is required for extra user fields client-side, and inference fails "when your server and client code are in separate projects" ([typescript docs](https://better-auth.com/docs/concepts/typescript); [session docs caveats](https://better-auth.com/docs/concepts/session-management#customizing-session-response)). Get-session type collapse bugs are chronic (#5538).

**Recommendation:** effect-auth gets this structurally from Effect: plugin `HttpApi` + `HttpApiClient` derive one typed client with zero duplication (PRD §22, Q29, Q39) — no `$InferServerPlugin` mirror, no `pathMethods`, no cross-repo inference cliff (client needs only the API type, which is importable/generated). Optionally provide a thin nanostores/`useSyncExternalStore` atom layer for `useSession`-style reactivity.
**Confidence:** high

### Q30 — Static install vs runtime config seam

Evidence: Everything is resolved at `betterAuth(options)` construction; there is no runtime enable/disable of installed plugins. Runtime-conditional behavior exists only as *options-level* functions: `trustedOrigins(request)`, `accountLinking.trustedProviders(request)` (async, request-scoped) ([options reference](https://better-auth.com/docs/reference/options)), `allowUserToCreateOrganization(user)` ([organization docs](https://better-auth.com/docs/plugins/organization)), and rate limiting that is disabled in dev by default and applies only to client-initiated requests ([rate-limit docs](https://better-auth.com/docs/concepts/rate-limit)).

**Recommendation:** effect-auth: keep the PRD's two-graph separation — the Layer graph is static; runtime config is a `Config`/`Ref`-backed service consumed by capabilities (e.g., a `RuntimeFlags` service deciding provider enablement per request/tenant). Multi-tenancy later slots in as `LayerMap` without changing the plugin contract (PRD §33).
**Confidence:** high

### Q31 — Plugin contract test suite

Evidence: better-auth ships a `test-utils` plugin ("Testing utilities for integration and E2E testing") ([plugin list](https://better-auth.com/docs/plugins)) and source tests use `authClient.$context`-style access (source `plugins/test-utils/`), but there is **no published harness** a third-party plugin author can run to prove their plugin honors the contract (schema validity, route uniqueness, hook ordering, client parity). Community plugins ship with an explicit "not official or verified... review their source code" disclaimer ([community plugins](https://better-auth.com/docs/plugins/community-plugins)).

**Recommendation:** Build `@effect-auth/test` as a first-class deliverable (PRD §38/§39): contract tests every plugin runs in CI (unique routes/tables, schema IR validity, hook isolation, migration determinism, client/server parity), plus TestLayer/TestClock utilities. This is a differentiator better-auth lacks entirely.
**Confidence:** high

### Q51 — Core vs plugin boundary: is the identity graph strictly additive?

Evidence (dependency audit of better-auth, source-verified):

- Core owns `user`, `account`, `session`, `verification` tables, OAuth/social providers, email+password, cookies, rate limiting, hooks — all in `betterAuth()` core, not plugins ([database docs](https://better-auth.com/docs/concepts/database#core-schema); account-linking is a *core option* in [options reference](https://better-auth.com/docs/reference/options#accountlinking)).
- Plugins extend **shared core tables** in-place: organization adds `session.activeOrganizationId` (source `plugins/organization/schema.ts:213`); admin adds `user.role/banned/banReason/banExpires` + `session.impersonatedBy` (source `plugins/admin/schema.ts`); twoFactor adds `user.twoFactorEnabled` + a `twoFactor` side table (source `plugins/two-factor/schema.ts`); username adds columns to `user`.
- Nothing prevents this from being a hard coupling: an org-less deployment still carries `activeOrganizationId` on `session`; types and session responses include plugin fields via inference, so removing a plugin changes core response shapes.

Conclusion: better-auth's plugins are **not** strictly additive with zero core knowledge — they are additive at the *code* level (no `if (organizationPlugin)` branches in core [INFERENCE, spot-check]) but invasive at the *schema and type* level via shared-table extension and merged session types.

**Recommendation:** effect-auth should prove the stronger property: plugins contribute side tables + declared extensions; the core `Principal/Session` model stays plugin-free; plugin contributions enter the session response only through a typed extension point (e.g., a `SessionCustomizations` service the compiled facade merges), so uninstalling a plugin never changes core contracts.
**Confidence:** high

### Q54 — Generic OAuth provider interface

Evidence: Built-in `socialProviders` share a provider interface: `clientId` (string or array for multi-audience), `clientSecret`, `scope`, `redirectURI` (default `/api/auth/callback/${provider}`), `prompt`, `responseMode`, `disableSignUp`/`disableImplicitSignUp`, `requireEmailVerification`, `mapProfileToUser`, `getUserInfo(token)`, `refreshAccessToken`, `verifyIdToken`, and (1.7) a declarative `idToken` config verified by one central verifier; generic providers use `accountSubject` when `sub`/`id` isn't the immutable identifier ([oauth docs](https://better-auth.com/docs/concepts/oauth); [1.7 guide](https://better-auth.com/docs/guides/1-7-upgrade-guide)). PKCE defaults on in 1.7; reserved authorization params (`state`, `code_challenge`, …) are rejected at the API boundary; OAuth state stores `callbackURL`, `codeVerifier`, `expiresAt`, plus a server-only `serverContext` slot (`addOAuthServerContext`) that clients cannot forge ([oauth docs](https://better-auth.com/docs/concepts/oauth#passing-additional-data-through-oauth-flow)). State storage: database (signed cookie binding) by default, cookie-only in stateless mode ([options reference](https://better-auth.com/docs/reference/options#storestatestrategy)).

**Recommendation:** effect-auth: one `OAuthProvider` capability interface (authorization URL, token endpoint, profile fetch, `accountSubject`, `idToken` config) validated at compile time; PKCE S256 always; state as purpose-scoped `Verification` rows with TTL under `TestClock`; keep the server-trusted-context idea (map to a `FiberRef`/`Context` value carried across the redirect) — it is a good security pattern.
**Confidence:** high

### Q55 — OAuth account linking policy

Evidence: Core `account.accountLinking` defaults: `enabled: true`, `allowDifferentEmails: false`, `trustedProviders: [...]` (static or request-scoped async), `disableImplicitLinking: false`, `allowUnlinkingAll`, `updateUserInfoOnLink: false` ([options reference](https://better-auth.com/docs/reference/options#accountlinking)). So the default is: same verified email ⇒ implicit link on OAuth sign-in. Identity key is `(providerId, accountId)`; every user row requires an email — providers without email need placeholder-email workarounds (per-provider table with stability/`email_verified` trust notes; email-less users tracked in issue #9124) ([oauth docs](https://better-auth.com/docs/concepts/oauth#handling-providers-without-email)). Linking has a real CVE history: GHSA-g38m-r43w-p2q7 "OAuth account linking ownership" (High, fixed 1.6.11) ([June 2026 security update](https://better-auth.com/blog/security-update-june-2026)). Token material: `encryptOAuthTokens: false` by default ([options reference](https://better-auth.com/docs/reference/options#account)).

**Recommendation:** effect-auth should default `disableImplicitLinking`-equivalent to **on** (explicit linking only; verified-email auto-link opt-in per trusted provider), refuse to require an email column on the principal (link by `(provider, subject)` with optional email claim), encrypt provider tokens at rest by default, and treat `(provider, subject, issuer)` as the unique account key (1.7's duplicate-key check exists precisely because this wasn't enforced early).
**Confidence:** high

### Q56 — Passkey plugin architecture (plugin-level)

Evidence: The passkey plugin lives in scoped `@better-auth/passkey` and is "powered by SimpleWebAuthn behind the scenes"; it contributes `passkey` endpoints + a `passkey` table, with server and client plugins installed separately ([passkey docs](https://better-auth.com/docs/plugins/passkey)). 1.6 added WebAuthn extension support on registration/authentication ([Better Auth 1.6](https://better-auth.com/blog/1-6)). Deep protocol details (rpID/origins, attestation, challenge replay) are covered by the WebAuthn research file; from the plugin-system angle the notable fact is that WebAuthn is **purely additive** — no core schema knowledge, no shared-table extension (side table only).

From the plugin-system angle, passkey is the cleanest example of the *good* better-auth pattern: purely additive (side table only, no `user`/`session` column claims), no core knowledge, one scoped package, protocol complexity hidden behind a library dependency. Its install flow (server plugin → migrate/generate → client plugin) is the canonical three-step every plugin docs page repeats — a DX template worth reproducing for effect-auth (`auth` CLI + client package install).

**Recommendation:** effect-auth's passkey plugin should mirror this shape: side table + capability-interface over a WebAuthn library, RP config (`rpID`, `origins`) as typed plugin config, challenges as purpose-scoped verification rows.
**Confidence:** high

### Q57 — Magic link / email OTP

Evidence: `magic-link` and `email-otp` are official plugins ([plugin list](https://better-auth.com/docs/plugins)). Their shared verification machinery is the `verification` table; the security lesson is CVE-2026-67327: with open email/password registration, an attacker pre-registers the victim's email (unverified); when the victim later signs in via magic link/OTP, "the account is marked verified without removing the pre-existing password or revoking existing sessions", yielding persistent attacker access (fixed 1.6.22/1.7.0-beta.10) ([GHSA-9wm3-rh5c-fc37](https://github.com/advisories/GHSA-9wm3-rh5c-fc37)). Enumeration-adjacent machinery exists (`customSyntheticUser` builds fake sign-up responses under enumeration protection; [admin docs](https://better-auth.com/docs/plugins/admin#email-enumeration-protection)).

**Recommendation:** effect-auth: passwordless sign-in that satisfies a verification **must** be a state transition that invalidates competing credentials (drop pre-existing passwords for unverified accounts, revoke foreign sessions) — encode as a single atomic transition in the account service, with a regression test. Purpose-scoped token TTLs single-use under `TestClock` (PRD §28.3/Q46).
**Confidence:** high

### Q58 — 2FA/TOTP plugin internals

Evidence: Schema (source `plugins/two-factor/schema.ts`): `user.twoFactorEnabled` (boolean, `input: false`) + side table `twoFactor` (`secret` string required not-returned indexed, `backupCodes` required not-returned, `userId` FK→user indexed, `verified` boolean). Docs describe `twoFactorEnabled`, `twoFactorSecret`, and encrypted `twoFactorBackupCodes` as user additions ([database docs](https://better-auth.com/docs/concepts/database#plugins-schema)) — the source shows the secret/backup codes normalized into the side table in current versions (docs lag source; trust source). It adds a pre-auth `two_factor` cookie ([cookies docs](https://better-auth.com/docs/concepts/cookies)), a strict rate limit `/two-factor/verify` 3 req/10 s ([rate-limit docs](https://better-auth.com/docs/concepts/rate-limit)), and per-plugin TOTP `issuer` ([options reference](https://better-auth.com/docs/reference/options#appname)).

**Recommendation:** effect-auth 2FA plugin: same normalization (secrets in a side table, never on `user`), pre-auth step-up state as a short-TTL server-side token (not just a cookie), per-endpoint rate-limit rules contributed by the plugin (PRD §28.4), recovery codes hashed + single-use (PRD Q58).
**Confidence:** high

### Q59 — API keys

Evidence: Now scoped `@better-auth/api-key`. Features: built-in rate limiting, custom expiration/remaining-count/refill, metadata, custom prefix, sessions-from-API-keys, secondary-storage lookup mode, multiple key configurations, organization-owned keys ([api-key docs](https://better-auth.com/docs/plugins/api-key#features)). Security history is the worst in the project: CVE-2025-61928 — before 1.3.26, an unauthenticated attacker could create/modify API keys for any user via `api/auth/api-key/create` (server-only-field validation only ran when `authRequired` was true) ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-61928)).

**Recommendation:** effect-auth api-key capability: key format `prefix.secret` with only the hash (SHA-256) at rest; `requiresAuth` as a type-level precondition, never a runtime branch around field validation; principal mapping (user/org keys) through the unified `Principal` service (Q44/Q61); rate-limit rules contributed via the shared limiter.
**Confidence:** high

### Q60 — JWT plugin

Evidence: `jwt()` serves `/token` and `/jwks`; tokens are Ed25519 (`kty: OKP`, `crv: Ed25519`) by default and verifiable via JWKS with `kid`-driven cache refresh; `getSession` also returns a JWT in the `set-auth-jwt` header; pairs with `bearer()` for `Authorization`-header auth ([jwt docs](https://better-auth.com/docs/plugins/jwt)). Multi-algorithm support exists in source tests (`plugins/jwt/multi-alg.test.ts`). The cookie-cache can verify against the plugin's JWKS when `sessionCookieCache: true` ([session docs](https://better-auth.com/docs/concepts/session-management#jwks-backed-cookie-cache-jwts)). Security note: the *provider*-side plugins (oidcProvider/mcp) shipped insecure crypto defaults (`none` advertised, plain PKCE accepted) before 1.6.11 — CVE-2026-67336 ([CISA SB26-215](https://www.cisa.gov/news-events/bulletins/sb26-215)).

**Recommendation:** effect-auth: asymmetric signing only (EdDSA/ES256) with JWKS; HS256 deprecated-by-default; key rotation via a `KeyRing` capability; claims mapping as a Schema; document "JWT for service-to-service, opaque sessions for browsers" guidance (PRD Q60). Never allow algorithm negotiation to widen the accepted set — the CVE above is the exact failure mode.
**Confidence:** high

### Q61 — Strategy chain (session → api key → bearer per request)

Evidence: There is no formal strategy-chain abstraction. Each mechanism plugs into the same session resolution: `getSession` reads the cookie; `bearer()` accepts the JWT from `/token` in `Authorization`; `apiKey()` can mint sessions from keys ("sessions from API keys"); `customSession()` can rewrite the session response ([api-key docs](https://better-auth.com/docs/plugins/api-key#features); [session docs](https://better-auth.com/docs/concepts/session-management#customizing-session-response)). Ambiguity policy is undocumented; rate limiting notes that `auth.api` server-side calls bypass it, showing request-path vs direct-call asymmetry is a recurring semantic trap.

**Recommendation:** effect-auth: one `Authentication` service with an ordered, typed list of credential→`Principal` strategies (session, api-key, bearer) resolved in one place; unambiguous failure when multiple credentials conflict; per-strategy caching via `Effect.cache`/`FiberRef`. This is a core improvement over better-auth's per-plugin middleware accretion.
**Confidence:** high

### Q62 — Impersonation / "login as"

Evidence: admin plugin: `impersonateUser`/`stopImpersonating` endpoints; impersonation creates a real session row with `session.impersonatedBy = adminId` (source `plugins/admin/routes.ts:1281`), so it is time-boxed (`impersonationSessionDuration`, default 1 hour) and auditable by column; gated by access-control statements `user: [impersonate]` and `user: [impersonate-admins]` ([admin docs](https://better-auth.com/docs/plugins/admin)).

**Recommendation:** effect-auth: keep the better-auth mechanics (separate session row + `impersonatedBy`, TTL) but add: audit event emission by default (PRD §18/Q49), explicit display indicator in the session payload, and deny-listing of impersonating admins.
**Confidence:** high

### Q63 — Bot defense / captcha plugin shape

Evidence: `captcha()` is an official plugin ("Captcha verification for auth flows") ([plugin list](https://better-auth.com/docs/plugins)); the seed-round blog lists bot/abuse/fraud protection as part of the planned hosted platform ([seed round](https://better-auth.com/blog/seed-round)).

**Recommendation:** effect-auth: captcha as a pre-signup/pre-signin **hook capability** (`BotDefense.check: Effect<boolean, BotDefenseError>`), contributed rate-limit rules for the protected routes, and an explicit fail-open/closed policy in config (availability vs abuse tradeoff should be a decision, not an accident). Verification results should be single-use and short-TTL in the `Verification` store so a solved challenge cannot be replayed across accounts. The plugin surface is small — copy the plugin concept, not the hosted platform.
**Confidence:** medium (captcha plugin internals not deeply reviewed)

### Q64 — Core permission primitives shape

Evidence: `createAccessControl({ resource: ["action", ...] } as const)` builds a typed statement registry; `ac.newRole({...})` composes roles; checks run server-side via `auth.api.hasPermission`/`userHasPermission` and client-side synchronously via `checkRolePermission` (which "will not include any dynamic roles as everything is ran synchronously on the client") ([organization docs](https://better-auth.com/docs/plugins/organization#access-control)). Dynamic roles are stored in an `organizationRole` table behind a `dynamicAccessControl.enabled` flag.

**Recommendation:** effect-auth (PRD Q64): a Schema-checked permission registry (resource/action as Schema literals, not bare strings), permission checks returning typed `Effect<boolean, AuthorizationError>`, and client-side evaluation only for static roles. Better-auth's `as const`-typed statements are a good idea underpowered by their runtime string model; Effect Schema gives the same ergonomics with real validation.
**Confidence:** high

### Q65 — What an `admin` plugin owns vs an `organization` plugin

Evidence: admin = user-level RBAC + user/session management: roles on `user.role`, ban (with reason/expiry), list/create users, revoke sessions, impersonation; statement resources `user`/`session` ([admin docs](https://better-auth.com/docs/plugins/admin)). organization = org-scoped RBAC + membership lifecycle: org/member/invitation/team tables, invitations, active-org on the session, org-level statements `organization`/`member`/`invitation` ([organization docs](https://better-auth.com/docs/plugins/organization)). Both allow custom roles by merging `defaultStatements`; both require passing the same `ac`/`roles` to server *and* client plugins (duplication by design).

**Recommendation:** effect-auth: keep the split (admin = principal lifecycle; organization = ReBAC-ish scoping) but define each as a pure plugin with capabilities; the org plugin must not touch the core session table (contrast Q51) — active-org becomes an `ActiveOrg` service populated by an extension point.
**Confidence:** high

---

## Technologies & libraries

| Name | What it is | License | Maturity | Relevance to effect-auth |
| --- | --- | --- | --- | --- |
| better-auth | The framework under study; v1.7.4 latest, MIT | MIT | Very mature (930 versions, ~4.7M dl/wk) | Benchmark for plugin surface, DX, ecosystem |
| better-call | Mini web framework behind `createAuthEndpoint` (by same team) | MIT | Mature, coupled to better-auth | Counter-example: effect-auth uses `HttpApi` instead of a bespoke router |
| @better-fetch/fetch | Fetch wrapper powering the client + `fetchPlugins` | MIT | Mature | effect-auth: `HttpApiClient` replaces it |
| Kysely + `@better-auth/kysely-adapter` | Built-in SQL adapter; enables `auth migrate`/programmatic migrations | MIT | Mature | Evidence for "own the DDL" tradeoffs; effect-auth: `@effect/sql-*` |
| `@better-auth/{drizzle,prisma,mongo,memory}-adapter` | ORM/NoSQL adapters as scoped packages | MIT | Mature | Validates PRD §19 adapter split; memory adapter is a good `@effect-auth/test` idea |
| rou3 (via better-call) | Router; CVE-2025-71399 path-normalization bypass | MIT | Transitive dep | Lesson: router semantics are security surface |
| jose | JWT/JWKS for the jwt plugin | MIT | Mature | Same choice fits effect-auth |
| @noble/hashes, @noble/ciphers | Crypto primitives | MIT | Mature | Aligns with PRD Q89 "no homegrown crypto" |
| nanostores | Client atoms (`getAtoms`, `useSession` reactivity) | MIT | Mature | Optional pattern for `@effect-auth/react` thin adapters |
| zod | Validation in endpoint definitions | MIT | Mature | effect-auth uses `Schema` instead; note dual-validation cost |
| SimpleWebAuthn | WebAuthn under the passkey plugin | MIT | Mature | Candidate capability implementation |
| @better-auth/redis-storage | Official `SecondaryStorage` impl (ioredis) | MIT | Newer | Model for a Redis session/rate-limit adapter |
| `auth` CLI (npm) | `migrate`, `generate`, `upgrade`, `init` commands | MIT | Mature | Benchmark for PRD §37 CLI scope |
| dash.better-auth.com / better-auth.build | Hosted dashboard + infra (announced with seed) | Proprietary | Early | Competitive context: framework stays OSS, platform monetizes |
| Agent Auth protocol (`agentauthprotocol.com`) | Agent identity work the team continues at Vercel | — | New (2026) | Adjacent future-proofing for effect-auth roadmap |

## Books, papers, blogs, talks

- [Vercel acquires Better Auth (Guillermo Rauch, 2026-07-07)](https://vercel.com/blog/vercel-acquires-better-auth) — confirms ownership, MIT continuation, agent-identity direction.
- [Announcing our $5M seed round (2025-06-24)](https://better-auth.com/blog/seed-round) — funding, team, and the hosted-infra roadmap.
- [Better Auth 1.6](https://better-auth.com/blog/1-6) and [Better Auth 1.4](https://www.better-auth.com/blog/1-4) — release cadence, joins (2–3× latency wins), WebAuthn extensions.
- [Security update: June 2026](https://better-auth.com/blog/security-update-june-2026) — 14 advisories indexed by component; describes the security-review workstream and breaking-fix policy (`next` channel vs stable).
- [Upgrading to Better Auth 1.7](https://better-auth.com/docs/guides/1-7-upgrade-guide) — the definitive catalog of manual schema/data migrations; required reading when designing effect-auth's migration planner.
- [Database concepts](https://better-auth.com/docs/concepts/database), [Plugins concepts](https://better-auth.com/docs/concepts/plugins), [Hooks](https://better-auth.com/docs/concepts/hooks), [Session management](https://better-auth.com/docs/concepts/session-management), [Cookies](https://better-auth.com/docs/concepts/cookies), [Rate limiting](https://better-auth.com/docs/concepts/rate-limit) — the design surface this file maps to PRD §§9/20/21/22.
- [Issue #5538 — User typed as `any`](https://github.com/better-auth/better-auth/issues/5538) — concrete type-inference fragility evidence, with maintainer participation.
- [TechCrunch: a self-taught Ethiopian dev built an authentication tool and got into YC (2025-06-25)](https://techcrunch.com/2025/06/25/this-self-taught-ethiopian-dev-built-an-authentication-tool-and-got-into-yc/) — team backstory.
- [Flavio Copes: Better Auth — an introduction](https://flaviocopes.com/better-auth/) and [DevTools Academy: BetterAuth vs NextAuth](https://www.devtoolsacademy.com/blog/betterauth-vs-nextauth) — third-party positioning.
- [Dreams of Code: "Better Auth is so good that I **almost** switched…" (YouTube)](https://www.youtube.com/watch?v=dNY4FKXwTsM) — influential community review; useful for DX expectations.
- [HN: Better Auth is joining Vercel](https://news.ycombinator.com/item?id=48819512) — community sentiment at acquisition.

## People & projects to follow

- **Bereket Engida (`bekacru`)** — creator and founder; now at Vercel post-acquisition. [GitHub](https://github.com/bekacru) · [X](https://x.com/bekacru) · [LinkedIn](https://www.linkedin.com/in/bekacru).
- **better-auth core team** — continued stewardship under Vercel; advisories signed "Better Auth Maintainers". [GitHub org](https://github.com/better-auth) · [X](https://x.com/better_auth).
- **R5dan** — prolific contributor on type-inference fixes (e.g., PR #5208 referenced in issue #5538). [GitHub](https://github.com/R5dan).
- **better-call & better-fetch** — sibling libraries by the same author defining the endpoint/client idioms. [better-call](https://github.com/bekacru/better-call) · [better-fetch](https://better-fetch.vercel.app).
- **Kriasoft better-auth-plugins** — third-party enterprise plugin collection showing ecosystem demand beyond official scope. [kriasoft.com/better-auth](https://kriasoft.com/better-auth/getting-started.html).
- **Agent Auth Protocol** — the team's post-acquisition agent-identity work. [agentauthprotocol.com](https://agentauthprotocol.com/).

## Recommended defaults for effect-auth

1. **Adopt (adapt): the one-plugin object with declared contributions** — services/API/handlers/schema/hooks/events/migrations/client (PRD §9.1). Better-auth proves the *breadth* is right; effect-auth adds the compile step it lacks (`apiVersion`, deps, conflicts).
2. **Copy: plugin-contributed rate-limit rules** (`pathMatcher/limit/window`) as a typed `RateLimitRule` list aggregated by the compiler; add URL normalization before matching (CVE-2025-71399 lesson).
3. **Copy: `input`/`returned` field metadata** as Schema annotations driving what enters request bodies and response payloads; default sensitive fields to server-owned (better-auth's own admin/twoFactor schemas do this).
4. **Copy: freshness checks + cookie-cache tradeoff documentation** (`freshAge`, revocation caveats) — but expose rotation/revocation as explicit typed semantics (PRD §28.2), and hash session tokens at rest (better-auth stores the raw token).
5. **Copy: `runInBackground`** as a scoped post-commit execution hook for fire-and-forget work (analytics, counters) — with Effect supervision.
6. **Adapt: hooks-as-middleware** — replace path-string matching with typed hook points (`onSignUp`, `onSessionCreated`, …) registered via a `Hooks` service; failure semantics per hook class per PRD Q27; keep `auth.api`-direct calls running the same hooks (better-auth got this right).
7. **Adapt: `requireResourceOwnership`/`requireOrgRole` helpers** into typed, capability-backed guards (`requireOwned`, `requirePermission`) enforced in handler types, not stacked middleware.
8. **Reject: shared-table extension as the default plugin-schema mechanism.** Side tables first; shared `user`/`session` columns only as explicitly declared, conflict-checked extensions (PRD §20/§78). Rationale: better-auth's org/admin/2FA all mutate core tables, coupling uninstall/migration behavior.
9. **Reject: string-typed `APIError(status, {message})` as the error model.** Typed error channels per PRD §29, mapped to status codes once; plugin `$ERROR_CODES` becomes redundant.
10. **Reject: client-plugin action duplication.** Derive the client from the plugin's `HttpApi` via `HttpApiClient` (PRD §22); keep an optional atoms layer for React-style ergonomics.
11. **Reject: implicit verified-email account linking by default.** Explicit linking default; trusted-provider auto-link opt-in; tokens encrypted at rest; account key = `(provider, subject, issuer)`.
12. **Build beyond better-auth: versioned migration planner + ledger + destructive-op confirmation + data-migration Effects** (PRD §21). The 1.7 upgrade guide is the evidence base for how much manual pain this removes.
13. **Build beyond better-auth: `@effect-auth/test` contract harness** for every plugin (route/table uniqueness, hook isolation, migration determinism, client parity), replacing "review the source yourself" community-plugin trust.
14. **Copy: the `SecondaryStorage` KV seam** — a tiny interface (`get/set/delete/getAndDelete/increment`) that routes sessions, verification tokens, and rate-limit counters to Redis/memory when present ([database docs](https://better-auth.com/docs/concepts/database#secondary-storage)). effect-auth should model this as a `KeyValueStore` capability so edge/session-store adapters arrive without touching repositories (PRD Q80).
15. **Ecosystem posture:** official plugins free and core-adjacent (`@effect-auth/plugin-*`), a PR-curated community list with explicit verification tiers, and a strict lockstep-compat story for scoped packages (learn from the June 2026 advisory upgrade matrix).

## Open questions for the user

1. **Shared-table extension policy** — (a) allow plugin columns on `user`/`session` like better-auth (max DX, coupling), (b) side tables only (clean core, extra joins), or (c) side tables + opt-in declared extensions with compile-time conflict checks (recommended)?
2. **Client DX depth** — (a) pure `HttpApiClient` derivation, (b) derivation + atoms/`useSession` layer per framework, or (c) better-auth-style action namespaces (`authClient.organization.create`) re-exported from the derived client?
3. **Account linking default** — (a) better-auth default (implicit link on verified email), (b) explicit-only default with per-provider opt-in (recommended), or (c) explicit-only with no auto-link at all (most conservative)?
4. **Ecosystem verification** — (a) simple PR-curated community list, (b) list + `@effect-auth/test` badge required for listing, or (c) signed/verified tier with security review for "official" mark (PRD §47/§48)?

## Sources

- https://www.npmjs.com/package/better-auth (registry metadata, dist-tags, versions, modified 2026-09-10; dependencies list)
- https://better-auth.com/docs/introduction
- https://better-auth.com/docs/concepts/plugins
- https://better-auth.com/docs/concepts/database
- https://better-auth.com/docs/concepts/hooks
- https://better-auth.com/docs/concepts/session-management
- https://better-auth.com/docs/concepts/cookies
- https://better-auth.com/docs/concepts/typescript
- https://better-auth.com/docs/concepts/oauth
- https://better-auth.com/docs/concepts/rate-limit
- https://better-auth.com/docs/reference/options
- https://better-auth.com/docs/plugins
- https://better-auth.com/docs/plugins/organization
- https://better-auth.com/docs/plugins/admin
- https://better-auth.com/docs/plugins/api-key
- https://better-auth.com/docs/plugins/jwt
- https://better-auth.com/docs/plugins/passkey
- https://better-auth.com/docs/plugins/community-plugins
- https://better-auth.com/docs/guides/1-7-upgrade-guide
- https://better-auth.com/blog/seed-round
- https://better-auth.com/blog/security-update-june-2026
- https://better-auth.com/blog/1-6
- https://www.better-auth.com/blog/1-4
- https://better-auth.com/changelog
- https://vercel.com/blog/vercel-acquires-better-auth
- https://techcrunch.com/2025/06/25/this-self-taught-ethiopian-dev-built-an-authentication-tool-and-got-into-yc/
- https://github.com/better-auth/better-auth (source: `packages/core/src/types/plugin.ts`, `packages/core/src/types/plugin-client.ts`, `packages/better-auth/src/types/auth.ts`, `packages/better-auth/src/auth/base.ts`, `packages/better-auth/src/context/create-context.ts`, `plugins/admin/schema.ts`, `plugins/two-factor/schema.ts`, `plugins/organization/schema.ts`; verified 2026-09-12)
- https://github.com/better-auth/better-auth/issues/5538
- https://github.com/better-auth/better-auth/security/advisories (index; GHSA-g38m-r43w-p2q7, GHSA-fmh4-wcc4-5jm3, GHSA-qq9h-g4jm-xgf3 et al. via June 2026 post)
- https://nvd.nist.gov/vuln/detail/CVE-2025-61928
- https://github.com/advisories/GHSA-9wm3-rh5c-fc37 (CVE-2026-67327)
- https://www.cisa.gov/news-events/bulletins/sb26-215 (CVE-2025-71399, CVE-2026-67336, CVE-2025-71403)
- https://cybersecuritynews.com/better-auth-api-keys-vulnerability/
- https://github.com/advisories/GHSA-rf63-989x-x4x8 (multi-session sign-out hook)
- https://github.com/bekacru/better-call
- https://better-fetch.vercel.app
- https://kriasoft.com/better-auth/getting-started.html
- https://flaviocopes.com/better-auth/
- https://www.devtoolsacademy.com/blog/betterauth-vs-nextauth
- https://www.youtube.com/watch?v=dNY4FKXwTsM
- https://news.ycombinator.com/item?id=48819512
- https://agentauthprotocol.com/
