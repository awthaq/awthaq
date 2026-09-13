# Effect Native Auth — 100 Design Questions

Version 0.1 — 2026-09-12. This is the working questionnaire that drives PRD v2.

**How it works:** research agents answer their assigned question ranges with evidence (see `research/01..12-*.md`). Each answer carries a `Recommendation` and `Confidence`. Questions that remain contested after research become explicit user decisions (PRD v2 + ADRs).

Conventions: `awthaq` = this project (`@awthaq/*`); PRD = `PRD.md` at repo root.

---

## A. Product & positioning (Q1–Q7)

1. Who is the primary user — existing Effect application developers, or general TypeScript devs whom auth could introduce to Effect — and how does that change default ergonomics and docs?
2. Which Effect version range do we support at v1, and how do we handle Effect's fast release cadence and experimental-module moves (peer range, CI matrix, compatibility tests)?
3. Which runtimes are day-1 targets (Node LTS, Bun, Deno, Cloudflare Workers / Vercel Edge) and which Effect platform adapters must work?
4. Exactly where do we position vs better-auth — what do we copy, what do we deliberately do differently, and what can we never match (and must instead side-step)?
5. Is multi-tenancy (per-tenant providers/config, `LayerMap`-keyed resources) day-one or later? What seam must exist now to allow it?
6. Which packages ship at MVP vs later — `core/http/client/cli/test/adapters/plugins` — and what is the smallest release that is still credible?
7. Governance: license (MIT vs Apache-2.0), "official plugin" trademark policy, security policy, maintainer model?

## B. Effect architecture (Q8–Q19)

8. How should `Auth.make({ plugins })` produce a single typed Layer graph, and where are TypeScript's inference limits with N plugins × M contributions (type depth, IDE/perf)?
9. What is the service naming/namespacing convention for plugin-contributed `Context` tags so ecosystem plugins cannot collide?
10. Do plugins contribute raw `Layer`s or declarative contributions that the compiler wraps into Layers? What does each buy us in validation, linting, and CLI introspection?
11. How are capability interfaces (`PasswordHasher`, `RateLimiter`, `Mailer`, …) declared, defaulted, and swapped (conflict rules, priority, test doubles)?
12. Where do hooks live — one `AuthHooks` service vs per-hook tags — and how is execution order kept deterministic (topo by plugin deps, explicit priority)?
13. Events: `PubSub`/`Stream`-based bus? Delivery guarantees, error isolation (observers must never fail auth), backpressure, shutdown draining?
14. How does the compiled auth expose a typed facade (`auth.password.signIn`) whose keys depend on installed plugins — mapped tags, merged interface, or codegen?
15. Configuration: how do plugin configs merge with Effect `Config`, secrets, redaction, and compile-time validation of the merged config?
16. Observability: span naming (`auth.*`), metrics, sensitive-field redaction — core-enforced or plugin-declared?
17. Error architecture: one error hierarchy vs per-domain errors; mapping to HttpApi errors/status; separating user-facing messages from internal detail.
18. Testing on Effect: TestLayer/in-memory repository patterns, `TestClock`-driven expiry tests, property-based tests, HTTP tests without a server.
19. Performance: Layer memoization, per-request context cost, principal propagation (middleware-provided service vs `FiberRef`), benchmark harness design.

## C. Plugin system (Q20–Q31)

20. What is the minimal plugin definition contract (required vs optional contributions), and what is the stable `apiVersion` policy?
21. How do plugins declare dependencies — plugin ids, capability strings, or `Context.Tag` requirements — and what are the tradeoffs of each?
22. Cycle detection and compile-error UX: actionable messages (the cycle path, the offending plugins), links to docs?
23. Capability namespace conventions: registry, reserved prefixes (`auth.*`), exclusivity (`provides`/`requires`/`conflicts`) — how enforced?
24. Route conflict policy: exact collisions, param-name mismatches (`:id` vs `:orgId`), per-plugin prefixes, override/extension mechanisms?
25. Schema conflict policy: table names, column names, adding columns to shared tables (`user.*`) vs side tables — validation rules?
26. Migration aggregation: ordering by plugin topo order, generated vs handwritten, reviewability, destructive-op guardrails?
27. Hook semantics: typed hook contexts, failure = abort (which hooks may abort vs only observe), isolation of failing observers, ordering?
28. Middleware contributions: per-endpoint/group/global middleware from plugins; ordering relative to auth/session middleware?
29. Client contributions: how a plugin's client API derives from its HttpApi definition (one contract, no duplication)?
30. What runtime seam exists between "static install" (compile time) and "runtime config" (tenants enabling/disabling installed providers)?
31. What does the plugin contract test suite look like — the `@awthaq/test` harness every plugin author can run against their plugin?

## D. HTTP & API (Q32–Q41)

32. What are HttpApi's current capabilities and gaps (OpenAPI, clients, middleware, error encoding) on our target Effect version — and what must we build around?
33. Route taxonomy: core fixed routes vs plugin prefixes; naming conventions; versioning of the API surface?
34. How does auth middleware provide `CurrentPrincipal` to handlers (HttpApi middleware + context), and how do handlers declare "requires auth" in types?
35. Default CSRF strategy for cookie flows (SameSite + double-submit vs BFF), and its interaction with server-to-server clients?
36. Error responses: consistent payload shape (problem-details style?), status-code mapping table per typed error?
37. Rate limiting: abstraction shape (key/limit/window), per-route rules, response headers, storage backends?
38. OpenAPI: one aggregated spec across plugins, security schemes, docs hosting?
39. Client generation: how much of the typed client comes free from Effect `HttpApiClient` vs a custom plugin client surface?
40. Framework adapters: what belongs in `@awthaq/http` vs `@awthaq/next|hono|tanstack|astro` — the minimal adapter contract?
41. Input validation defaults: Schema strictness (unknown keys), body size limits, content-type policy?

## E. Core domain model (Q42–Q51)

42. User model: base fields, extensibility (plugin columns), email normalization, multiple emails, soft delete, identifiers (UUIDv7/ULID/nanoid) — id generation as a service?
43. Account/identity model: `(provider, providerAccountId)` uniqueness, linking policy (verified-email auto-link?), unlink guards (can't remove last credential)?
44. Principal abstraction: unified principal type (user/api-key/service), how strategies map credentials → principals, session-less principals?
45. Session model: token format & storage (opaque token, hash at rest), device metadata, rotation policy, concurrent-session limits, revocation semantics?
46. Verification/tokens: purpose-scoped tokens (verify email, reset password, invite), TTLs, single-use semantics, replay-protection storage?
47. Time handling: expiry via `Duration` + `TestClock`, clock skew (TOTP), token issuance/claims times?
48. Email/SMS delivery abstraction: Mailer capability shape, template approach, what plugins may assume?
49. Audit & events minimum set: event payloads as Schemas, redaction rules, retention?
50. Anonymous users: anonymous→registered upgrade flows, deletion cascades (GDPR erasure)?
51. Core vs plugin boundary for the "identity graph": is organization/api-key/passkey strictly additive with zero core knowledge? Prove with a dependency audit of better-auth.

## F. Authentication strategies (Q52–Q63)

52. Password: default algorithm & parameters per runtime (argon2id/scrypt/bcrypt), rehash-on-login, policy defaults (NIST 800-63B), breach checking (HIBP k-anonymity) as opt-in plugin?
53. PasswordHasher capability: native deps (`@node-rs/argon2`) vs pure-JS vs WebCrypto constraints on edge runtimes — what ships by default?
54. OAuth: generic provider interface (authz URL, token endpoint, userinfo, profile mapping), PKCE everywhere (OAuth 2.1), state/nonce storage, callback URL handling, provider set at v1?
55. OAuth account linking: auto-link on verified email? the conflicting-account flow (link-account UX), silent account creation policy?
56. Passkey/WebAuthn: RP config (rpID/origins), multi-credential per user, credential metadata (backup state), challenge storage & replay, attestation defaults, platform quirks?
57. Magic link / email OTP: TTL, single-use, enumeration-safe responses, click-to-session flow?
58. 2FA/TOTP: RFC 6238 details, recovery codes (hashed, single-use), pre-auth session state, rate limiting of verification attempts?
59. API keys: key format (prefix + secret), hashing, scopes, expiry, revocation, principal mapping?
60. JWT plugin: algorithm policy (EdDSA/ES256 over HS256?), key rotation/JWKS, claims mapping, when JWT vs opaque sessions?
61. Strategy chain: how multiple authenticators compose per request (session → api key → bearer), ambiguity policy, per-request caching?
62. Impersonation / admin "login as": audited, time-boxed principal switching?
63. Bot defense: captcha (Turnstile/hCaptcha) as a pre-signup hook — plugin shape?

## G. Authorization (Q64–Q71)

64. Core primitives: Principal + typed permission checks — string permissions vs Schema-checked permission registry — what is the v1 shape?
65. RBAC: roles/permissions bindings in core or plugin? What does an `admin` plugin own vs an `organization` plugin?
66. ReBAC future-proofing: how would a Zanzibar-style relationships model or an external SpiceDB/OpenFGA adapter plug in via capabilities?
67. Ownership checks: `requireOwned(resource)` patterns vs policy objects — typed against resource schemas?
68. Organization/team (phase 2): membership, per-org roles, invitations, sub-orgs — schema and API outline?
69. Policy composition: AND/OR/not, ABAC predicates as Effects, error typing (Forbidden vs NotFound for enumeration safety)?
70. Enforcement ergonomics: middleware-level `requirePermission` vs in-handler service calls — can we enforce one style via contract tests/lint?
71. Decision observability: deny logs with principal+permission (never payload), metrics on denials?

## H. Persistence & schema (Q72–Q81)

72. Repository interfaces: surface for User/Account/Session/Verification, pagination (keyset vs offset), transactions (Effect transaction scope API)?
73. Schema IR: the data-model of tables/columns/indexes/FKs — can one definition drive both validation Schemas and DDL?
74. Adapters at v1: PostgreSQL (`@effect/sql-pg`), SQLite (node + D1?), MySQL — feature gaps and effort (DDL dialects, RETURNING, type mapping)?
75. Migration engine: diff-generated vs plugin-authored, migration ledger table, drift detection, dry-run + destructive confirmation UX?
76. Naming conventions: snake_case mapping, index/FK naming — documented and enforced by the IR?
77. IR type system: JSON columns, timestamps, booleans, enums, defaults — dialect mapping rules?
78. Shared-table extension policy: how plugin columns land on `user` (ALTER) vs side tables — conflict resolution order?
79. Query performance: session-lookup hot path, indexes on token hashes, prepared statements, pool configuration via Effect?
80. NoSQL/edge seams: what interfaces must exist now so D1/Mongo/Redis-session adapters can arrive later?
81. Seeds/imports: initial admin bootstrap, importing users from better-auth/Lucia/Auth.js?

## I. Client & frontend (Q82–Q87)

82. Client surface: typed HttpApiClient + session helpers; cookie vs bearer modes; CSRF handling client-side?
83. React package: `useSession`/`useAuth` patterns, TanStack Query integration, SSR/RSC support?
84. Next.js: App Router integration, middleware (edge) constraints (session check without DB), server actions vs route handlers?
85. Minimal adapter contract for Hono/TanStack Start/Astro/SvelteKit — what does an adapter actually do?
86. Client error typing: surfacing the typed error union to UI, safe user-facing messages, i18n?
87. SPA/BFF guidance: recommended deployment topologies and what the library enforces vs documents?

## J. Security engineering (Q88–Q94)

88. Threat model: documented abuse cases (credential stuffing, session fixation, CSRF, token replay, enumeration, OAuth SSRF, open redirect, timing attacks) mapped to controls and tests?
89. Crypto inventory: primitives used (argon2id, HMAC-SHA256, Ed25519, AES-GCM), key sources, "no homegrown crypto" policy, Node vs WebCrypto split?
90. Enumeration resistance: uniform responses, timing normalization on password miss — where is this enforced in core?
91. Rate limiting/lockout defaults: safe-by-default settings that don't ruin dev experience?
92. Secure release process: SECURITY.md, embargo, CVE handling, dependency audit, npm provenance?
93. Sensitive-data redaction: what is redacted by default in logs/traces/events, and the mechanism?
94. Security testing: abuse-case suite in-repo, fuzzing/property tests, static analysis (semgrep), scope of a pre-1.0 audit?

## K. DX, docs, tooling (Q95–Q100)

95. CLI scope at MVP (`doctor`, `schema`, `migration`, `plugin list`) built on `@effect/cli`? Later: `init`, codegen?
96. Docs platform and structure for the three audiences (app dev, plugin dev, adapter dev) — examples/playground?
97. Monorepo: pnpm + turborepo/nx, changesets + provenance, canary releases, Effect peer ranges?
98. Plugin author experience: templates (`create-awthaq-plugin`?), validator, publishing checklist, registry/listing?
99. Reference apps: which 3 example apps ship (frameworks × DB × plugins) to prove the matrix?
100. Compatibility & versioning: semver policy, plugin `apiVersion` evolution, deprecation process, Effect bump policy?
