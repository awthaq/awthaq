# Auth Framework Landscape — Research

Assigned domain: product & positioning (Q1–Q7) plus a strategy-phase inventory supporting Q52–Q63. Protocol-level details for individual strategies (argon2 parameters, WebAuthn ceremony, TOTP specifics) are intentionally out of scope here — they belong to the strategy-specific research files. All statuses verified 2026-09-12 unless marked `[INFERENCE]`.

## TL;DR

- **The TS auth field consolidated in 2025–2026**: Auth.js/NextAuth was absorbed by Better Auth (2025-09-26), and Better Auth itself was acquired by Vercel (2026-07-07). TS auth is now partly a VC/platform-funded game; awthaq should not compete on plugin-count breadth or Next.js-first DX.
- **Lucia was deprecated as a library (March 2025)** and became a learning resource + "Auth Book"; the maintainer's framing — "the cleanest way to implement auth. Not the fastest — the cleanest" — is exactly the community sentiment awthaq can inherit: teach auth well, keep the core small and honest.
- **Auth.js is the governance cautionary tale**: v5 spent 2+ years in beta, never shipped stable, lead maintainer Balázs Orbán quit in January 2025, and the project was absorbed to avoid "eroding trust in open-source auth". Bus factor and maintainer economics matter as much as architecture.
- **better-auth's documented weaknesses are awthaq's thesis**: plugins own their DB schemas, the adapter seam is loosely typed (`any`-ish, arbitrary-string models, migrations passed as eval-able code strings per HN discussion). A compile-time typed plugin graph + framework-owned schema IR is a real differentiator, not a nicety.
- **Strategy phasing is standardized**: password + sessions + email verification ship in core; OAuth social and magic link ship at MVP; passkeys and TOTP ship post-MVP; API keys, JWT, SAML SSO, and SCIM are the enterprise tier; agent/MCP identity (Better Auth "Agent Auth", Stytch Connected Apps, Logto MCP, Casdoor) is the 2026 frontier.
- **License bifurcation**: embedded frameworks are MIT (better-auth, NextAuth, Lucia); self-hosted servers increasingly chose AGPL "risk transfer" (Zitadel Apache→AGPL-3.0, Hanko backend AGPLv3); Logto chose MPL-2.0. awthaq, as an embedded library, should stay MIT/Apache.
- **Passkeys are table stakes but passkey-only has never won a general framework** — only narrow OIDC-provider products (Pocket-ID) and passkey-first vendors (Hanko) do it. Ship password + OAuth first, passkeys as a strong early plugin.
- **Multi-tenancy is the B2B monetization boundary everywhere** (Clerk org tiers, WorkOS $125/connection SSO/SCIM, Logto multi-tenancy, Zitadel orgs/instances). awthaq should ship the runtime tenant-config seam day-one and the organization plugin later.
- **Effect as of 2026-09**: stable line 3.22.x (`effect@3.22.2`), v4 at Release Candidate (rewritten fiber runtime, unified package system). First-party platform runtimes exist for Node and Bun; none for Cloudflare Workers or Deno.
- **"Framework-native vs framework-agnostic" is a real fork in the road**: Auth.js bet on an agnostic `@auth/core` + per-framework adapters; Lucia bet on being a pure library with teaching docs. awthaq's bet — Effect-native identity where Layers/Schema/HttpApi are the plugin system — is defensible precisely because both prior models failed to keep deep framework integration maintainable.

## Questions answered

### Q1 — Primary user: existing Effect developers, not general TS devs

**Evidence.** PRD §6 already orders the audience: Effect application developers, then Effect library authors, then framework authors. The market context supports keeping that order. better-auth won TS-mindshare by being framework-agnostic and DX-first for the *broad* TypeScript population (npm description: "framework-agnostic authentication framework for TypeScript"); that lane is now occupied (and VC-funded, Vercel-distributed). Effect's own pitch is broad ("the missing standard library for TypeScript" per npm), but an auth framework whose plugin system *is* `Context.Service`/`Layer`/`Schema`/`HttpApi` is unusable without Effect fluency — the Lucia lesson is that a "clean, low-level, teach everything" approach builds durable goodwill precisely with developers who already want the host paradigm, while Auth.js's lesson is that trying to serve every framework thinly dilutes the team (framework adapters list on authjs.dev: Next.js, SvelteKit, Express, Qwik…). `[INFERENCE]` A general TS dev whose first Effect exposure is a Layer-graph auth framework will bounce; an Effect dev starved for first-party auth is an underserved, reachable audience.

**Key sources.** https://github.com/better-auth/better-auth ("framework-agnostic" positioning), https://www.npmjs.com/package/effect (Effect's broad pitch), https://lucia-auth.com/ + https://github.com/lucia-auth/lucia/discussions/1790 (the teach-the-concepts lane).

**Recommendation:** Primary user = existing Effect application developers; secondary = Effect library/plugin authors; treat "auth as an on-ramp to Effect" as a marketing bonus, never a docs constraint. Docs assume Layer/Service/Schema fluency, include one short "new to Effect" primer path, and every getting-started example is a working Effect app. Quickstart must stay small (`Auth.make({ plugins: [...] })`, PRD G7) so the ceiling of assumed knowledge is high but the floor stays low.

**Confidence:** high

### Q2 — Effect version range at v1

**Evidence.** As of 2026-09: stable line is `effect@3.22.2` (npm, "last published 2 days ago"), while Effect 4.0 is at **Release Candidate** (effect.website banner; beta shipped earlier in 2026 with a rewritten fiber runtime, smaller bundles, and a unified package system per InfoQ's April 2026 report and Effect's own office-hours series). So v4 stable is imminent but not landed, and PRD Risk 2 explicitly flags "Effect is evolving rapidly". Effect's monorepo releases platform packages in lockstep (`@effect/platform-bun@0.91.2` currently depends on `@effect/platform-node-shared@0.61.1`), meaning minor bumps move weekly.

**Key sources.** https://www.npmjs.com/package/effect (3.22.2 stable), https://effect.website/ ("Effect 4.0 — Release Candidate" banner), https://www.infoq.com/news/2026/04/effect-v4-beta/ (v4 beta scope), https://www.npmjs.com/package/@effect/platform-bun (lockstep platform packages).

**Recommendation:** (1) v1 declares `effect: "^3.x"` peer range (current minor floor pinned by CI, not by hand-waving) and is built *on* `@effect/platform` so the platform surface is the compatibility boundary. (2) Isolate Effect-version-specific internals in one internal module per package so the v4 migration is a bounded diff, not a rewrite. (3) Run a CI compatibility matrix: oldest supported 3.x, latest 3.x, and a nightly (non-blocking) job against v4 RC to catch breakage early. (4) Adopt v4 as the supported range the quarter after it stabilizes, in a minor release, and encode the required range in each plugin's `apiVersion` compatibility metadata (PRD §35) so ecosystem plugins and core can drift on independent schedules.

**Confidence:** medium (v4's landing date and any HttpApi API changes between RC and stable are unknowns)

### Q3 — Day-one runtime targets

**Evidence.** Effect ships first-party platform runtimes for Node (`@effect/platform-node`, `-node-shared`) and Bun (`@effect/platform-bun`, MIT, ~425K weekly npm downloads); there is **no** first-party Deno or Cloudflare Workers runtime in the Effect org. Community work on Effect-native Cloudflare bindings exists (e.g., the `effect-cloudflare` project, live-streamed builds Nov 2025) but is not a supported runtime. Workers remain the dominant edge target in 2026 (multiple 2026 edge guides, Hono's growth), so the *demand* is real even if Effect support is not ready. better-auth demonstrates that TS auth libs are expected to run beyond Node, but its runtime matrix is a marketing page, not a type guarantee `[INFERENCE]`.

**Key sources.** https://www.npmjs.com/package/@effect/platform-bun (425K DL/wk, MIT), https://www.npmjs.com/package/@effect/platform (platform surface/HttpApi), https://github.com/Effect-TS/effect/releases (no Workers/Deno runtime package).

**Recommendation:** (1) **Node LTS (22/24) is the only day-one promise**, via `@effect/platform-node` — it is where Effect's runtime, DB drivers, and argon2 native deps all work. (2) **Bun = best-effort supported** (test suite runs on it; platform package exists) because it is nearly free once core is platform-neutral. (3) **Edge/Workers: no day-one promise; instead an architectural guarantee** — core is written against Web-standard `Request`/`Response`/`crypto` (via `@effect/platform` interfaces), with native-only crypto (argon2) strictly behind the `PasswordHasher` capability so a Workers adapter becomes possible when Effect's platform story lands. State this as "edge-ready core, adapter later", not "works on Workers". (4) Deno: explicitly out of scope; node-compat may work but is untested. Publish the runtime matrix in docs like a support table, not marketing.

**Confidence:** high (Node+Bun), medium (edge strategy)

### Q4 — Positioning vs better-auth

**Evidence.** better-auth (v1.7.4, MIT, ~30K stars) is the benchmark: 50+ first-party plugins spanning auth (2FA, passkey, magic link, email OTP, phone, anonymous, username, generic OAuth, SIWE), enterprise (Admin, Organization, SAML SSO, SCIM), tokens (API key, JWT, Bearer, OAuth 2.1 provider, MCP, device authorization), and even payments (Stripe, Polar, Autumn, Creem, Dodo, Commet). It raised $5M seed (Peak XV, YC, P1 Ventures, Chapter One; TechCrunch 2025-06-25), absorbed Auth.js (2025-09-26), and was acquired by Vercel (2026-07-07) with founder Bereket Engida's team joining to work on "open-source auth and agent identity". Credible public criticisms (HN thread on the Auth.js absorption): plugins determine their own data models; the adapter interface is "implement a general SQL-like query executor" over arbitrary string models with migrations handed over as a code string; loose typing at plugin seams. Its founder frames the tradeoff as "we handle the database so you can own your auth without writing the logic yourself". **What to copy:** plugin-first ergonomics where a plugin contributes endpoints + schema + client + hooks (validates PRD §9); client derived from the server contract; a public plugin listing; CLI as install/migrate UX; the breadth roadmap shape (PRD phases 1–3 mirror it). **What to deliberately do differently:** compile-time plugin compilation into a typed Layer graph vs runtime registration; one schema IR with reviewable, ordered migrations vs plugin-decided DDL; typed errors end-to-end vs stringly `any` seams; capability-based dependency declarations (`provides`/`requires`/`conflicts`) vs implicit coupling; HttpApi as single source of truth for handlers+OpenAPI+typed client. **What we can never match:** 50-plugin breadth at launch, Vercel distribution and Next.js-first DX, VC velocity, payments integrations. **Side-step, don't fight:** awthaq's adopters are developers who already chose Effect; the comparison that matters is "the auth framework Effect apps deserve," not "a better better-auth".

**Key sources.** https://www.better-auth.com/docs/plugins (plugin taxonomy), https://techcrunch.com/2025/06/25/this-self-taught-ethiopian-dev-built-an-authentication-tool-and-got-into-yc/ ($5M seed), https://vercel.com/blog/vercel-acquires-better-auth (acquisition), https://news.ycombinator.com/item?id=45389293 (seam/typing criticisms).

**Recommendation:** Position as **"Effect-native auth, not framework-agnostic auth"**: the only TS auth framework where the plugin system is the host framework's own DI/composition system. Copy better-auth's *feature taxonomy* (so migration guides and parity checklists are easy), reject its *implementation seams*. Publish an honest parity table early ("we have X, they have Y") — trust is a moat better-auth's critics have left open. Never market against better-auth by name; market to Effect.

**Confidence:** high

### Q5 — Multi-tenancy: seam now, product later

**Evidence.** Every B2B platform treats tenancy as the monetization boundary: Clerk gates organizations by tier (free plan: 100 monthly retained orgs, then per-org billing) and sells B2B SSO as an add-on; WorkOS gives AuthKit away to 1M MAU but charges ~$125/connection for SAML/SCIM; Logto leads with "multi-tenancy, enterprise SSO, and RBAC"; Zitadel models instances/orgs natively; better-auth ships organizations as a plugin, not core. PRD already separates static plugin installation from runtime configuration (§33, ADR-006: "Tenant A → Google enabled"). The pattern across the industry: the *data model* for orgs is a plugin concern, but the *ability to resolve per-tenant provider/runtime config at request time* is a core concern — vendors that skipped it (GoTrue-era Supabase) retrofit painfully `[INFERENCE]`.

**Key sources.** https://clerk.com/multi-tenancy (org tiers), https://workos.com/pricing (1M MAU free, SSO paid), https://github.com/logto-io/logto (multi-tenancy headline), https://github.com/better-auth/better-auth (org as plugin).

**Recommendation:** Multi-tenancy is **not** a day-one feature but **is** a day-one architectural seam: (1) all provider/strategy configuration is resolved through a `TenantConfig`-style service (default impl: single static tenant) instead of read directly from static config; (2) repository interfaces take a tenant-scope parameter (default: singleton scope) so `LayerMap`-keyed per-tenant resources can slot in without breaking plugin authors; (3) the organization plugin (phase 2) owns org data model + membership, not config resolution. Document the seam in the plugin-author guide so third-party plugins never hardcode "the tenant".

**Confidence:** medium-high

### Q6 — Packages at MVP vs later

**Evidence.** PRD §53 scopes MVP (core runtime, plugin system, HttpApi middleware, repo interfaces + PostgreSQL adapter, password + OAuth plugins, CLI + schema generation) with client at Milestone 6 and plugin ecosystem at Milestone 7. Landscape evidence for *small credible first releases*: Lucia's minimal core + teaching docs defined a category despite having a single maintainer; Pocket-ID is a sustainable product built on a single strategy (passkey-only OIDC); meanwhile breadth without adoption maturity is what drew better-auth its sharpest criticism. Auth.js's `@auth/core` + thin per-framework adapters shows the value of a hard adapter contract.

**Key sources.** PRD §53/§61 (internal), https://github.com/pocket-id/pocket-id (single-strategy viability), https://github.com/lucia-auth/lucia/discussions/1707 (minimal-core legacy), https://authjs.dev/ (adapter-contract value).

**Recommendation:** MVP ships: `@awthaq/core`, `@awthaq/http`, `@awthaq/client` (thin, generated from HttpApi — even if minimal), `@awthaq/cli`, `@awthaq/test`, `@awthaq/adapter-postgres`, and plugins `password` + `oauth`. Add `@awthaq/schema` (public IR types) at MVP because plugin authors need it to contribute tables. Defer to post-MVP: `magic-link`, `passkey`, `2fa`, all framework adapters beyond a single "Effect HttpApi app" story (Effect apps host the API themselves), `api-key`, `jwt`, `sso`, `scim`, `organization`. "Credible" = secure-by-default password+OAuth sessions with typed errors and reviewable migrations, not a plugin catalog.

**Confidence:** medium

### Q7 — Governance: license, trademark, security, maintainers

**Evidence.** The embedded-framework norm is MIT (better-auth MIT; next-auth MIT; Lucia MIT). Server vendors increasingly chose AGPL as monetization leverage: Zitadel relicensed Apache-2.0 → AGPL-3.0-only (LICENSING.md; CEO openly describes the model as "selling risk transfer"), Hanko's backend moved fully to AGPLv3 (enterprise folder removed) keeping only hanko-elements/frontend-sdk MIT; Logto chose MPL-2.0 (file-level copyleft) as a middle path; Keycloak is Apache-2.0 under CNCF foundation governance (incubating since April 2023), which vendors cite for neutrality; FusionAuth is proprietary with a free self-hosted Community edition. For a *library embedded into arbitrary applications*, AGPL is commercially radioactive (linking propagates obligations) — that is why no successful embedded TS auth framework is AGPL. Security posture: better-auth runs GitHub Security Advisories + SECURITY.md; Auth.js documents a security page; Pocket-ID ships SECURITY.md even as a hobby-scale project.

**Key sources.** https://github.com/better-auth/better-auth (MIT), https://github.com/zitadel/zitadel/blob/main/LICENSING.md (AGPL-3.0-only), https://github.com/teamhanko/hanko (AGPL backend/MIT UI), https://www.cncf.io/blog/2023/04/11/keycloak-joins-cncf-as-an-incubating-project/ (foundation neutrality).

**Recommendation:** (1) License core + official plugins **MIT** (ecosystem norm, zero adoption friction); consider Apache-2.0 only if the team wants the explicit patent grant — pick one, document why, and never AGPL. (2) Reserve the `auth.*` capability namespace and the "official plugin" designation as a **trademark/branding policy** (like better-auth's first-party vs community split), with published security-review requirements (PRD §48). (3) Ship SECURITY.md, private-vulnerability reporting, and a disclosure/embargo policy at v0.1 — before launch, not after (auth is incident-magnet infrastructure). (4) Maintainer model: document benevolent-dictator + named module owners with explicit bus-factor targets; write the Auth.js post-mortem into the governance doc (sponsorship plan, no single-maintainer critical paths, apiVersion policy for ecosystem trust).

**Confidence:** high

## Technologies & libraries

| Name | What it is | License | Maturity (2026-09) | Relevance to awthaq |
|---|---|---|---|---|
| Lucia (lucia-auth) | Session-management library turned learning resource + "Auth Book" | MIT | Deprecated Mar 2025; site refreshed Jul 2026 with a single-file `auth_session.ts` replacement | Adopt: teaching philosophy, low-level session model, docs-as-product. Avoid: its lesson is not "ship no framework" but "own the concepts" |
| oslo | Crypto/utils toolkit by Pilcrow (hash, encoding, OTP) | MIT | Maintained companion of Lucia | Pattern for a runtime-split crypto capability (Node vs WebCrypto) behind `PasswordHasher` |
| arctic | OAuth 2.0/OIDC provider helpers by Pilcrow | MIT | Maintained | Reference for a minimal generic-OAuth provider interface (Q54) |
| Auth.js / NextAuth v5 | OAuth-first auth for JS frameworks; `@auth/core` + per-framework adapter packages | MIT | v5 never left beta; absorbed by Better Auth 2025-09-26; `next-auth@4.24.15` last v4 line | Adopt: adapter contract shape, OAuth-first onboarding. Avoid: beta-forever release model; provider-list-as-product |
| better-auth | Framework-agnostic TS auth+authorization framework, plugin-based | MIT | v1.7.4; ~30K stars; Vercel-owned since 2026-07-07 | Primary benchmark (see Q4). Copy taxonomy; reject seam design |
| OpenAuth (SST) | Standalone/embeddable standards-based (OAuth 2.1) auth provider | OSS (openauth.js.org) | Beta | Model for "your framework can also be the IdP" future plugin (OAuth provider role) |
| Clerk | Hosted CIAM + prebuilt UI components; orgs, SSO add-ons | Proprietary | Free ≤50K MAU; Pro ~$20–25/mo; B2B add-on for SSO; repriced early 2026 | Study org/multi-tenant packaging & UX bars; avoid vendor-dependency model (not applicable to awthaq anyway) |
| WorkOS AuthKit | User management + enterprise SSO/SCIM/dir-sync; free ≤1M MAU, ~$125/connection enterprise features | Proprietary | GA; enterprise wedge | The canonical "SSO/SCIM is the enterprise tier" evidence (phase 3 in PRD) |
| Stytch | Auth + fraud + "agent-ready" Connected Apps (OAuth for AI agents/MCP) | Proprietary | GA; Connected Apps free ≤10K active users/agents | Signal for agent-identity frontier; not v1 |
| Ory Kratos (+ Hydra) | API-first headless identity server (Go); Hydra = OAuth2/OIDC server | Apache-2.0 | Mature, VC-backed ($22M Series A); OpenAI case study; criticized for upgrade pain/complexity [secondary source] | Adopt: headless API-first flows, identity-credentials model. Avoid: config-file sprawl, server-ops burden |
| Keycloak | Full IAM server (Java/Quarkus); SAML/OIDC/SCIM; Workflows preview | Apache-2.0 (CNCF incubating since 2023) | 26.x line; 26.5 Jan 2026, ~26.7 Jul 2026 (SCIM preview) | The "everything server" end of the spectrum awthaq explicitly is not (PRD non-goals); useful phase-parity reference |
| Zitadel | Self-hostable CIAM (Go); orgs/instances, passkeys-first, actions | AGPL-3.0-only (was Apache-2.0; exceptions per dir) | Active; commercial cloud | Adopt: org/instance tenancy model, passkey-default UX. License approach is the counter-example for an embedded lib |
| Supabase Auth (GoTrue) | JWT-based auth server (Go) powering PostgREST RLS; third-party-JWT trust mode | Apache/MIT family (supabase/auth repo) | Production at scale | Adopt: JWT-per-request model as an *opt-in* plugin stance (Q60); third-party-token interop seam |
| Firebase Auth | Managed auth (Google); MFA behind Identity Platform upgrade | Proprietary | GA, massive scale | Baseline consumer expectations (email link, social); avoid lock-in pattern |
| Hanko | Passkey-first auth server + web components (EU) | Backend AGPLv3; elements/SDK MIT | v2.x | Evidence passkey-first products exist but stayed narrow (no password/SSO breadth) |
| FusionAuth | Self-hosted CIAM (Java); API-first, highly configurable | Proprietary (free Community edition) | GA, 10M+ users claims; founder Pontarelli retired; Brian Bell CEO | Study "batteries-included but API-first" config model; enterprise phase checklist |
| Logto | OIDC/OAuth 2.1 auth infra (TypeScript); multi-tenancy, SSO, RBAC, MCP support | MPL-2.0 | v1.x GA; ~14.5K stars | Closest OSS analog to awthaq's runtime (TS, Postgres); study its org/RBAC schema and connector (provider) abstraction |
| Authelia | Self-hosted auth/OIDC for reverse-proxy stacks | Apache-2.0 (OpenID Certified) | Mature self-hoster niche | Confirms OIDC-provider certification bar if awthaq ever grows a provider role |
| Casdoor | SSO/IAM server (Go); OAuth/OIDC/SAML/CAS/LDAP/SCIM/WebAuthn/TOTP; web console; "Agent-first"/MCP gateway positioning | Apache-2.0 | Active, ~14.4K stars | Breadth checklist; shows MCP/agent positioning is now table-stakes marketing |
| Pocket-ID | Passkey-only OIDC provider for self-hosters | BSD-2-Clause | ~9.2K stars; OpenID Certified | Proof that a single-strategy, scope-disciplined product is viable (MVP courage) |
| remix-auth | Strategy-based server auth for Remix/React Router | MIT | Maintained by Sergio Xalambrí | Best-in-class "strategy" abstraction (one interface, many credentials) to mirror in `AuthenticationStrategy` (Q61) |
| Effect + @effect/platform | The host runtime; HttpApi/Schema/Layer | MIT (Apache-2.0 for some pkgs) | v3.22.x stable; v4 RC | The product substrate — version policy per Q2 |

### Adopt vs avoid — per-framework notes

| Framework | Adopt for awthaq | Deliberately avoid |
|---|---|---|
| Lucia | Concept ownership; session model taught from first principles; docs-as-product (Auth Book); small MIT core with companion libs (oslo → crypto capability, arctic → generic OAuth) | Its end-state lesson is governance, not architecture: a single-maintainer "clean" library without a sustainability plan ends as documentation. awthaq needs the docs ethos *plus* an org behind it |
| Auth.js | The `@auth/core` + thin per-framework adapter split (one core, N adapters — the minimal adapter contract idea in PRD §41); provider config ergonomics; OAuth-first onboarding | Release model (v5 in beta 2+ years, never stable); de-facto Next.js gravity despite "agnostic" branding; credentials-as-afterthought posture |
| better-auth | Plugin contribution taxonomy (endpoints/schema/hooks/client per plugin); typed client derived from server; CLI as first-class DX; community-plugin listing; phased breadth roadmap | Runtime-registered plugins; plugins owning their own DB schema/migrations (unreviewed, `eval`-able code strings per HN critique); weakly typed adapter seam; breadth-before-hardening |
| Clerk | Organizations as first-class object with tiered limits; prebuilt-flow UX bar; components↔API duality | Hosted-only coupling; opaque pricing tiers; UI lock-in (not applicable to awthaq, but explains why its users can't leave — don't replicate the lock-in shape in the client API) |
| WorkOS AuthKit | "Consumer auth free, enterprise features paid" packaging; directory-sync/SCIM as the enterprise wedge; org-as-connection model | Directory-connection complexity leaking into the framework core (belongs in a plugin) |
| Stytch | Fraud/finger-printing as a separable product edge; Connected Apps (OAuth for agents) as a distinct surface from user auth | Bundling authz+fraud into auth core; awthaq keeps authorization a separate subsystem (PRD §5.6) |
| Ory Kratos | Headless, API-first identity flows (login/registration/recovery as API resources); separation of identity vs session vs OAuth server (Kratos/Hydra/Keto) | Config-file sprawl (schema-driven flows); operational weight; upgrade pain reported by users [secondary source] |
| Keycloak | Protocol breadth checklist (SAML/SCIM/OIDC); SPI extension model proves the need for a *validated* plugin API; foundation governance (CNCF) for longevity | JVM-scale operational footprint; admin-console-first model; everything-in-core architecture |
| Zitadel | Instances/orgs tenancy hierarchy; passkeys-default onboarding; Actions extensibility concept | AGPL licensing for an embedded library (commercially radioactive); drift toward server product (PRD §59 non-goal) |
| Supabase Auth (GoTrue) | JWT-claims-driven authorization (pairs with DB RLS); third-party-JWT trust mode (interoperate with *any* external issuer instead of replacing it) | JWT-as-only-session model (revocation pain); tight coupling to Supabase platform assumptions |
| Firebase Auth | Consumer UX baselines: email-link sign-in, silent social flows, generous free tier expectations | Proprietary lock-in; MFA/enterprise gated behind a platform upsell; no data export path discipline |
| Hanko | Passkey-first UX polish; web-components for quick integration; EU/data-residency positioning | Passkey-only scope for a *general* framework (viable for niche providers, not for awthaq's audience) |
| FusionAuth | API-first configurability (everything an API call); "batteries-included, self-hosted, free tier" trust model; enterprise checklist (webhooks, lambdas, connectors) | Monolith runtime (JVM); closed core; lambda-based customization instead of typed extension points |
| Logto | Connector (provider) abstraction; org RBAC schema; custom JWT claims; TS/Postgres stack closest to awthaq's world; MCP/agent support direction | Prebuilt-sign-in-experience-first philosophy (awthaq is headless-by-default; PRD HTTP-first) |
| Authelia | OpenID Certified discipline; tiny-footprint deployment story | Reverse-proxy-companion scope (incompatible with embedded-framework model) |
| Casdoor | Protocol breadth (OAuth/OIDC/SAML/CAS/LDAP/SCIM/WebAuthn/TOTP); admin-console-as-product; i18n provider catalog | Casbin-coupled authorization model; everything-configurable-in-UI runtime mutation |
| Pocket-ID | Scope discipline: one strategy, certified, done — proof a minimal credible product earns adoption | Passwordless-only generalization (works because it's an OIDC provider for homelab/B2C self-hosters, not an app framework) |
| remix-auth | The `Strategy` interface — one small contract, many credential types, composable with session storage — the cleanest TS precedent for `AuthenticationStrategy` (Q61) | Tying strategies to a single web framework's session semantics |

### Positioning models observed (framework-native vs framework-agnostic)

| Model | Exemplars | Core bet | Observed outcome (2025–2026) |
|---|---|---|---|
| Pure library / teach-the-concepts | Lucia (+oslo/arctic) | Developers assemble auth themselves; docs carry the value | Beloved, but deprecated as a library (Mar 2025); value migrated to the learning resource — concepts survive, maintenance didn't |
| Agnostic core + per-framework adapters | Auth.js/NextAuth v5 | One protocol-implementation core, N thin adapters, web-standard APIs | Never reached stable v5; lead maintainer left (Jan 2025); project absorbed by Better Auth (Sep 2025) — thin integration proved too thin to sustain a moat or a team |
| Agnostic monolith + plugin registry | better-auth | One framework-agnostic runtime; plugins add everything; adapters optional | Fastest-growing TS auth project; won mindshare and VC/platform backing — but at the cost of schema ownership, seam typing, and runtime-mutation flexibility that power users criticize |
| Hosted/SaaS-first (Clerk, Stytch, Auth0, Firebase, Supabase-auth) | Managed dashboards + SDKs | Outsource operations | Dominant for teams that don't want to own auth; irrelevant to awthaq's self-host thesis except as UX/pricing benchmark |
| Self-hostable server (Ory, Zitadel, Keycloak, Logto, Casdoor, Hanko, Pocket-ID, FusionAuth, Authelia) | Full identity servers | Run auth as separate infrastructure | Robust for platform teams; operationally heavy for app devs; licensing polarization (AGPL wave) — explicitly the complement of what awthaq is |

**Implication for awthaq:** the two failed models failed *for opposite reasons* — Lucia for lack of an organization, Auth.js for lack of depth. The defensible position is "framework-native" done structurally: because awthaq's plugin system *is* Effect's own composition system (Layers, typed errors, HttpApi), the integration depth is not a per-framework adapter tax that must be replicated N times — it is written once, and no generic competitor can follow without adopting Effect wholesale. That same choice dictates runtime strategy (Q3): the framework boundary follows Effect's platform boundary (Node/Bun first), not the web-adapter boundary Auth.js chased.

## Books, papers, blogs, talks

- **The Auth Book (Pilcrow)** — https://pilcrowonpaper.com/ (linked as "the Auth Book" from lucia-auth.com): free deep-dive on implementing auth in web apps; the direct descendant of Lucia's docs and the best model for awthaq's conceptual docs layer.
- **The Copenhagen Book** — https://thecopenhagenbook.com/: web-app security hardening checklist by the same author; template for awthaq's "secure defaults" documentation (PRD G6).
- **Lucia deprecation essays (Discussion #1707 "Future plans", #1714 "A fresh start", #1790 "Pushing the project forward")** — https://github.com/lucia-auth/lucia/discussions/1707, https://github.com/lucia-auth/lucia/discussions/1714, https://github.com/lucia-auth/lucia/discussions/1790: rare first-person maintenance-economics writing in TS auth; #1707 contains the "learning resource" rationale, #1790 the "cleanest, not fastest" creed.
- **"Auth.js is now part of Better Auth" (HN, Sept 2025)** — https://news.ycombinator.com/item?id=45389293: the best single thread on TS-auth sustainability: v5's timeline, Balázs Orbán's exit, plugin-schema criticism, OpenAI's auth stack (SSO/SAML → WorkOS, consumer → forked OSS), and better-auth founder responses.
- **"Vercel acquires Better Auth"** — https://vercel.com/blog/vercel-acquires-better-auth and https://better-auth.com/blog/better-auth-joins-vercel: platform consolidation and the "agent identity" product direction.
- **TechCrunch: Better Auth's $5M seed** — https://techcrunch.com/2025/06/25/this-self-taught-ethiopian-dev-built-an-authentication-tool-and-got-into-yc/: funding context and founder story.
- **Effect v4 Beta coverage (InfoQ, Apr 2026)** — https://www.infoq.com/news/2026/04/effect-v4-beta/ and https://effect.website/blog: the release train awthaq must ride (Q2).
- **RFC 9207 — OAuth 2.0 Authorization Server Issuer Identification (Vittorio Bertocci, 2022)** — https://datatracker.ietf.org/doc/rfc9207/: canonical reading for the OAuth plugin (mix-up defense); Bertocci co-authored OAuth-ecosystem RFCs per Auth0's memorial.
- **"In Celebration of Vittorio Bertocci" (Auth0/Okta memorial)** — https://auth0.com/blog/in-celebration-of-vittorio-bertocci/: overview of his OAuth/OIDC corpus (RFCs, "Identity, Unlocked" podcast, Microsoft Press book on Azure AD auth) — required background reading list for anyone building the OAuth plugin.
- **Zitadel on relicensing to AGPL ("selling risk transfer")** — https://www.reddit.com/r/selfhosted/comments/1rk8bpr/ + https://github.com/zitadel/zitadel/blob/main/LICENSING.md: the clearest articulation of the AGPL business logic awthaq is deliberately not choosing (Q7).
- **Daniel Moore, "difficulties of OSS business models"** — https://www.mooreds.com/wordpress/archives/3438 (FusionAuth devrel; also active in the HN thread above): sober maintenance-economics background for the governance section.
- **"A Message from the Founder" (Brian Pontarelli, FusionAuth)** — https://fusionauth.io/blog/message-from-pontarelli: bootstrapped-CIAM longevity lessons; complements the VC-funded path contrast.
- **NIST SP 800-63B (Digital Identity Guidelines, Authentication)** — https://pages.nist.gov/800-63-3/sp800-63b.html: the policy reference every password strategy in the inventory is measured against (feeds Q52 via the passwords research file).
- **OAuth 2.1 (IETF draft)** — https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/: the target profile (PKCE everywhere) the generic-OAuth plugin should implement (Q54/Q55 support).

## People & projects to follow

- **Pilcrow (pilcrowonpaper)** — Lucia creator, oslo/arctic author, Auth Book + Copenhagen Book; software developer in Tokyo focused on auth/appsec — https://pilcrowonpaper.com/, https://github.com/pilcrowonpaper. The intellectual north star for small, honest auth cores.
- **Balázs Orbán (balazsorban44)** — NextAuth/Auth.js creator & lead maintainer (quit Jan 2025); now Tech Lead at Unite AS (identity/SSO) — https://github.com/balazsorban44, https://x.com/balazsorban44. His v5-era posts are the cautionary release-management tale.
- **Bereket Engida (bekacru)** — better-auth founder (now Vercel) — https://github.com/bekacru, https://better-auth.com/blog. Watch for feature taxonomy and agent-identity moves post-acquisition.
- **Sergio Xalambrí (sergiodxa)** — remix-auth/remix-utils author; web dev at Daffy.org, previously Vercel/Platzi — https://sergiodxa.com/, https://github.com/sergiodxa. The strategy-abstraction reference implementation in TS.
- **Aeneas Rekkas (aeneasr)** — Ory founder & CTO; Hydra/Kratos architect — https://www.ory.com/authors/aeneas-rekkas, https://github.com/aeneasr. Headless-identity API design and OSS-infra economics.
- **Brian Pontarelli** — FusionAuth founder (now retired from CEO; Brian Bell is CEO) — https://www.linkedin.com/in/voidmain, https://fusionauth.io/blog. Bootstrapped CIAM strategy and API-first config design.
- **Daniel Moore (mooreds)** — FusionAuth devrel; OSS-business-model writer — https://www.mooreds.com/. Sustained, honest commentary on auth OSS economics.
- **Michael Grinich** — WorkOS founder/CEO — https://workos.com. Enterprise-SSO wedge thesis (his OpenAI-stack HN comment is instructive).
- **Florian Forster** — Zitadel founder/CEO — https://www.linkedin.com/in/forsterflorian. AGPL/open-core positioning in identity.
- **Dax Raad** — SST/OpenAuth — https://openauth.js.org. Standalone-embeddable provider model.
- **Reed McGinley-Stempel** — Stytch CEO — https://stytch.com. Agent/MCP identity productization.
- **Effect team (Michael Arnaldi, Johannes Schickling, et al.)** — Effect core/platform/HttpApi direction — https://github.com/Effect-TS/effect, https://effect.website/blog. The release cadence awthaq's compat policy must track.
- **Vittorio Bertocci** (in memoriam, 1977–2023) — OAuth/OIDC authority; RFC 9207 author, Auth0/Okta Principal Architect, "Identity, Unlocked" host — https://auth0.com/blog/in-celebration-of-vittorio-bertocci/, https://datatracker.ietf.org/doc/rfc9207/. His writing remains the standard OAuth curriculum.

## Recommended defaults for awthaq

1. **Audience (Q1):** Design and document for Effect-fluent developers first; treat TS-newcomer onboarding as marketing, not a docs requirement. Quickstart floor stays tiny; ceiling assumes Layers/Schema.
2. **Effect range (Q2):** Ship on `effect@^3` with `@effect/platform` as the compatibility boundary; nightly CI against v4 RC; adopt v4 shortly after stable via a coordinated minor bump; encode ranges in plugin `apiVersion` metadata.
3. **Runtimes (Q3):** Node LTS day-one; Bun best-effort supported; edge = "Web-standard core, adapter later" messaging only; no Deno promise. Native crypto (argon2) lives strictly behind `PasswordHasher` so the core stays edge-portable.
4. **Positioning (Q4):** One sentence: *"The auth framework where the plugin system is Effect."* Copy better-auth's feature taxonomy; reject runtime-mutation seams, plugin-owned migrations, and weak typing. Publish a parity checklist early; never market against better-auth by name.
5. **Schema ownership (Q4/Q51 support):** Core owns the schema IR and migration pipeline; plugins declare contributions that are validated and ordered at compile time — the single most quotable architectural difference from better-auth.
6. **Tenancy seam (Q5):** Ship `TenantConfig`-style runtime resolution + tenant-scoped repositories day-one (single-tenant default); organization plugin is phase 2. Never let a plugin read static global config.
7. **MVP package set (Q6):** `core`, `http`, `client`, `cli`, `test`, `adapter-postgres`, `schema` + plugins `password`, `oauth`. Everything else waits for adoption milestones (PRD §61).
8. **Governance (Q7):** MIT core + official plugins; reserved `auth.*` capability namespace; "official" = reviewed + trademarked designation; SECURITY.md + private disclosure from v0.1; documented maintainer/bus-factor model; no AGPL anywhere.
9. **Docs (Q1/Q4 support):** Three layers mirroring the market's best: an Auth-Book-style conceptual guide (own the concepts like Lucia did), framework quickstarts (better-auth-style DX), and plugin/adapter developer tracks (Auth.js-style adapter contracts).

### Strategy-phase inventory (supports Q52–Q63)

Evidence base: better-auth's plugin tiers (core vs plugin pages), Lucia's teaching order, Ory Kratos/Hanko/Pocket-ID/Zitadel feature sets, Clerk/WorkOS paywalls, FusionAuth/Keycloak/Casdoor checklists. Phase = where the *median serious framework* ships it, not where PRD must.

| Strategy | Who ships it (evidence) | Typical phase | awthaq default |
|---|---|---|---|
| Password / credentials | Every general framework's core (better-auth, Supabase, Firebase, Kratos, FusionAuth, Logto); Lucia teaches it first. Exceptions are passkey-only niche servers (Pocket-ID, Hanko) | Core | v1 plugin (`password`), secure-by-default |
| Sessions (opaque token, cookie) | Lucia, better-auth, Kratos, FusionAuth, Logto | Core | v1 core; hash-at-rest |
| Email verification / purpose tokens | Supabase, Firebase, better-auth (verification), Kratos | Core | v1 core |
| OAuth social (generic provider) | Auth.js (the product), better-auth core, Supabase, Firebase, Logto connectors | Core/MVP | v1 plugin (`oauth`), generic provider interface + PKCE |
| Magic link / email OTP | better-auth plugins (magic-link, email-otp), Supabase/Firebase built-ins, Kratos | MVP+ | First post-MVP plugin |
| Passkeys / WebAuthn | better-auth plugin, Clerk built-in, Zitadel default-friendly, Kratos, Hanko (core), Pocket-ID (only) | Post-MVP | Phase 1→2 plugin; strong priority (market expectation) |
| TOTP 2FA + recovery codes | better-auth 2FA plugin, Clerk (paid tier), Zitadel, Kratos, Casdoor | Post-MVP/Phase 2 | Phase 2 plugin |
| API keys | better-auth plugin, Casdoor, FusionAuth, Pocket-ID (its own API) | Phase 2–3 (B2B tier) | Phase 2 plugin; principal mapping (Q59) |
| JWT issuance / bearer | Supabase (core model), better-auth plugins (JWT, Bearer), FusionAuth | Phase 2; opt-in everywhere | Phase 2 opt-in plugin; sessions stay default |
| SAML SSO | WorkOS ($125/connection), better-auth SSO plugin, Keycloak, Zitadel, Casdoor, FusionAuth, Logto | Phase 3 / paid tier, always | Phase 3 enterprise plugin |
| SCIM / directory sync | WorkOS, better-auth SCIM plugin, Keycloak, Casdoor, Logto, FusionAuth | Phase 3 / paid tier | Phase 3, after SSO |
| Organizations / RBAC | Clerk (tiered), better-auth Organization plugin, Logto (headline), Zitadel | Phase 2–3 | Phase 2 plugin on the Q5 seam |
| Captcha / bot defense | better-auth Captcha plugin, Casdoor built-ins (Turnstile/hCaptcha/reCAPTCHA) | Phase 2–3 | Phase 2 hook-shaped plugin (Q63) |
| Breach checking (HIBP) | better-auth Have I Been Pwned plugin | Optional plugin | Opt-in plugin (Q52) |
| Impersonation / login-as | better-auth Admin plugin surface, FusionAuth admin features | Phase 3, admin-scoped | Phase 3, audited + time-boxed (Q62) |
| Device authorization grant | better-auth plugin, Casdoor/OAuth servers | Phase 3 | Phase 3, low priority |
| Agent / MCP identity | better-auth Agent Auth + MCP plugins (2026), Stytch Connected Apps, Logto MCP support, Casdoor "Agent-first" | Frontier (2026+) | Watchlist; design events/capabilities so it can arrive as a plugin |
| SIWE / wallet auth | better-auth plugin | Niche plugin | Ecosystem plugin, not official |

**Cross-cutting read:** (a) Nothing credible ships without password+OAuth+sessions; (b) passkeys/TOTP are now "early post-MVP", not enterprise; (c) SSO/SCIM/API keys are where B2B money is and where paid tiers start everywhere — awthaq can ship them as plugins without guilt about v1 parity; (d) the 2026 differentiator wave is agent/MCP identity, and every current implementation is bolted on at the *provider* layer — an Effect capability graph is a plausible long-term advantage there, but not an MVP goal.

**The three-wave phasing model** distilled from the table:

1. **Wave 1 — trust (core):** password, session management, email verification. Every framework that survived ships these first; Lucia's entire curriculum starts here. Skipping any of these makes the framework a demo, not infrastructure.
2. **Wave 2 — onboarding growth (MVP–post-MVP plugins):** OAuth social, magic link/email OTP, then passkeys and TOTP. These are the strategies users *choose between*; shipping them as early plugins is now the industry-standard sequencing (better-auth's plugin pages, Ory's flow catalog, Clerk's sign-in options).
3. **Wave 3 — B2B money (enterprise tier):** API keys, JWT, SAML SSO, SCIM, organizations, audit, impersonation. This is where every vendor paywalls (Clerk B2B add-on, WorkOS connections, Logto cloud tiers) — evidence that awthaq can ship them later as plugins without credibility damage, exactly as PRD phases 2–3 plan.

Sequencing risk to avoid: better-auth's Agent Auth, Stytch's Connected Apps, and Logto's MCP support show vendors racing to wave 4 (agent identity) while wave 2 ergonomics (passkey enrollment UX, 2FA recovery) still generate the most user complaints `[INFERENCE]` — awthaq should finish waves 1–2 before touching wave 4.

## Open questions for the user

1. **License (Q7):** (a) MIT everywhere (max adoption, ecosystem norm); (b) Apache-2.0 (explicit patent grant, slightly heavier); (c) MIT core + Apache for crypto-adjacent packages. Recommendation: (a).
2. **Effect version posture (Q2):** (a) 3.x-only until v1.0, adopt v4 in v1.x; (b) dual-support 3.x+4.x from the start (costlier, broader reach); (c) wait for v4 stable before any public release (slower, cleaner). Recommendation: (a).
3. **Edge messaging (Q3):** (a) strict "Node (Bun best-effort) only" promise; (b) "edge-ready core, adapters coming" soft promise with no support SLA. Recommendation: (b).
4. **MVP plugin set (Q6):** (a) password + OAuth only (leanest); (b) password + OAuth + magic link (passwordless story complete for v1 marketing). Recommendation: (a) — magic link is a fast follow once `Mailer` capability lands.
5. **Relationship to the better-auth ecosystem (Q4):** (a) purely independent positioning; (b) ship official import/migration tooling from better-auth/Lucia/Auth.js (goodwill + adoption wedge). Recommendation: (b), post-v1.
6. **"Official plugin" governance strictness (Q7):** (a) trademark-enforced review gate (slow, trustworthy); (b) lightweight listing + namespace reservation only. Recommendation: (a) for security-sensitive categories (crypto, OAuth), (b) otherwise.

## Sources

- https://github.com/lucia-auth/lucia/discussions/1707 — Lucia future plans / learning-resource decision
- https://github.com/lucia-auth/lucia/discussions/1714 — Lucia v3 deprecation by March 2025
- https://github.com/lucia-auth/lucia/discussions/1790 — "Pushing the project forward" (cleanest-not-fastest quote)
- https://lucia-auth.com/ — deprecated status, July 2026 update, Auth Book, single-file replacement
- https://x.com/pilcrowonpaper/status/1843258855280742481 — deprecation announcement
- https://pilcrowonpaper.com/ — author site (Tokyo, auth/appsec, Auth Book)
- https://news.ycombinator.com/item?id=45389293 — Auth.js joins Better Auth thread (v5 timeline, Orbán exit, criticisms, OpenAI stack)
- https://www.better-auth.com/blog/authjs-joins-better-auth — absorption announcement
- https://authjs.dev/ — "part of Better Auth" banner, © Better Auth Inc. 2026, adapter model
- https://authjs.dev/contributors — Auth.js core team
- https://github.com/nextauthjs/next-auth/discussions/13382 — v5 beta-duration discussion
- https://www.npmjs.com/package/next-auth — v4.24.15 latest
- https://github.com/balazsorban44 — creator bio (acquired by Better Auth; Unite AS)
- https://github.com/better-auth/better-auth — MIT, ~30K stars, feature claims
- https://www.better-auth.com/docs/plugins — 50+ plugin taxonomy (incl. Agent Auth, MCP, SSO, SCIM, API Key, JWT, Captcha, HIBP)
- https://www.npmjs.com/package/better-auth — v1.7.4
- https://techcrunch.com/2025/06/25/this-self-taught-ethiopian-dev-built-an-authentication-tool-and-got-into-yc/ — $5M seed (Peak XV, YC, P1, Chapter One)
- https://vercel.com/blog/vercel-acquires-better-auth — Vercel acquisition, 2026-07-07
- https://better-auth.com/blog/better-auth-joins-vercel — team joining, agent-identity direction
- https://www.ycombinator.com/companies/better-auth — YC profile, Vercel news
- https://clerk.com/pricing — free ≤50K MAU, Pro pricing
- https://clerk.com/multi-tenancy — orgs free tier (100 MROs)
- https://clerk.com/articles/clerk-vs-auth0-which-authentication-platform-fits-your-team — early-2026 pricing restructures
- https://clerk.com/articles/essential-user-management-features-startups — Firebase MFA gated behind Identity Platform
- https://workos.com/pricing — User Management free ≤1M MAU
- https://www.apibenchmarks.com/auth/workos — $125/connection SSO/SCIM
- https://workos.com/changelog/introducing-authkit-and-user-management — AuthKit announcement
- https://stytch.com/ — "enterprise-ready and agent-ready" positioning
- https://stytch.com/blog/connected-apps-standalone/ — Connected Apps GA, 10K free users/agents
- https://www.ory.com/authors/aeneas-rekkas — Ory founder & CTO bio
- https://www.insightpartners.com/ideas/cloud-security-provider-ory-corp-raises-22-million-in-series-a-round-led-by-insight-partners/ — Ory Series A
- https://www.ory.sh/case-studies/openai — OpenAI/Ory case study
- https://www.descope.com/blog/post/ory-kratos-alternatives — Kratos criticisms [secondary/marketing source]
- https://github.com/keycloak/keycloak/releases — release line
- https://www.keycloak.org/2026/01/keycloak-2650-released — 26.5, Workflows preview
- https://skycloak.io/blog/keycloak-25-released-new-features-and-enhancements/ — 26.7 (Jul 2026), SCIM preview [secondary]
- https://www.cncf.io/blog/2023/04/11/keycloak-joins-cncf-as-an-incubating-project/ — CNCF incubating
- https://github.com/zitadel/zitadel/blob/main/LICENSING.md — AGPL-3.0-only licensing policy
- https://github.com/zitadel/zitadel/discussions/9529 — Apache→AGPL switch discussion
- https://www.reddit.com/r/selfhosted/comments/1rk8bpr/why_we_moved_to_agpl_sustainability_open_source/ — Zitadel CEO on "risk transfer"
- https://github.com/supabase/auth — GoTrue, JWT-based auth server
- https://supabase.com/features/third-party-authentication — external-JWT trust mode
- https://supabase.com/docs/guides/auth — JWT/session model
- https://firebase.google.com/docs/auth — Firebase Auth docs (baseline reference)
- https://github.com/teamhanko/hanko — AGPL backend / MIT elements split
- https://github.com/teamhanko/hanko/blob/main/LICENSE — license text
- https://newreleases.io/project/github/teamhanko/hanko/release/backend%252Fv2.1.1 — AGPLv3 unification note
- https://fusionauth.io/pricing — Community free / Starter $162/mo
- https://fusionauth.io/blog/message-from-pontarelli — founder transition
- https://fusionauth.io/blog/brian-bell-ceo-pr — Brian Bell CEO
- https://www.linkedin.com/in/voidmain — Pontarelli (retired)
- https://github.com/logto-io/logto — MPL-2.0, OIDC/OAuth 2.1, multi-tenancy, MCP
- https://logto.io/ — product positioning
- https://www.authelia.com/ — OpenID Certified OIDC provider, reverse-proxy companion
- https://startwithidentity.com/articles/top-10-open-source-iam-solutions/ — Authelia Apache-2.0, footprint [secondary]
- https://github.com/casdoor/casdoor — Apache-2.0; protocol breadth; agent-first/MCP positioning
- https://github.com/pocket-id/pocket-id — BSD-2-Clause; passkey-only OIDC; OpenID Certified
- https://openauth.js.org/ — SST OpenAuth, standards-based provider
- https://gitnation.com/person/sergio_xalambri — Sergio Xalambrí bio (remix-auth et al.)
- https://github.com/sergiodxa — Daffy.org, ex-Vercel/Platzi
- https://www.npmjs.com/package/effect — effect@3.22.2
- https://effect.website/ — "Effect 4.0 — Release Candidate" banner
- https://www.infoq.com/news/2026/04/effect-v4-beta/ — v4 beta: runtime rewrite, unified packages
- https://effect.website/blog — Effect release/office-hours trail
- https://www.npmjs.com/package/@effect/platform — HttpApi modules
- https://www.npmjs.com/package/@effect/platform-bun — Bun runtime package (MIT, lockstep deps)
- https://auth0.com/blog/in-celebration-of-vittorio-bertocci/ — Bertocci memorial (RFCs, OpenID Foundation board)
- https://datatracker.ietf.org/doc/rfc9207/ — RFC 9207 (issuer identification)
- https://news.ycombinator.com/item?id=48038827 — community reaction to Lucia deprecation ("brilliant")
- https://pages.nist.gov/800-63-3/sp800-63b.html — NIST 800-63B
- https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/ — OAuth 2.1 draft
