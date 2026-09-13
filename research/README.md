# Effect Native Auth — Research Corpus

Built 2026-09-12. Pipeline: `PRD.md` → 100 design questions (`00-questions.md`) → 12 domain research reports (01–12) → 5-part scientific plugin-system corpus (13–17) + review article (18) → DbC spec (`../better-auth/`) → Effect v4 mapping (19) → PRD v2 + ADRs.

Every report follows the same skeleton: TL;DR · per-question evidence with links · technologies table · books/papers/blogs/talks · people to follow · recommended defaults · open questions for the user · sources. All claims cite primary sources verified as of 2026-09; unverified conclusions are marked `[INFERENCE]` in-file.

## File index

| File | Domain | Questions | One-line takeaway |
|---|---|---|---|
| `00-questions.md` | Questionnaire | — | The 100 questions driving PRD v2, grouped A–K |
| `01-effect-ecosystem.md` | Effect architecture | Q8–Q19 | Effect 3.22.2 stable / v4 RC; PRD's `Context.Service` idiom doesn't exist in v3 (`Effect.Service`/`Context.Tag`); HttpApi is Unstable; `LayerMap` gives the tenant seam; **`@effect-auth` npm scope is taken** |
| `02-better-auth.md` | better-auth internals | Q20–Q31, Q51–Q65 | Plugin contract source-verified: no dependency declarations, no apiVersion, no conflict detection; client inference breaks cross-repo; Vercel acquired better-auth 2026-07-07 — effect-auth's typed compile-time model is the counter-thesis |
| `03-auth-landscape.md` | Framework landscape | Q1–Q7 | Field consolidated (better-auth absorbed Auth.js; Vercel acquired better-auth; Lucia now a learning resource); strategy phasing + positioning + MIT recommendation |
| `04-sessions-tokens.md` | Sessions & tokens | Q45–Q47, Q60–Q62, Q35, Q88 | Opaque `id.secret` tokens hashed at rest; RFC 10017 (Aug 2026) makes BFF cookie+CSRF normative; JWT default EdDSA; strategy chain first-match-wins |
| `05-oauth-oidc.md` | OAuth/OIDC | Q54–Q55, Q48, Q88 | Provider values → registry/client tags → flow state in core Verification; account linking default-off recommended; RFC 9700 + RFC 10017 are the security floor |
| `06-webauthn-passkeys.md` | WebAuthn/passkeys | Q56 | Wrap SimpleWebAuthn v14; attestation `none` default; challenges single-use/TTL'd; identity = verified assertion mapping only (CVE lessons) |
| `07-passwords-2fa.md` | Passwords, 2FA, API keys, captcha | Q52–Q53, Q57–Q59, Q63 | NIST 800-63B-4 final; argon2id via capability with hash-wasm fallback for edge; API keys as first-class Principal; HIBP plugin fail-open |
| `08-authorization.md` | Authorization | Q44, Q64–Q71 | Deny-by-default `Authorizer` service with `ConsistencyToken` seam; Zanzibar-style external engines plug in via Layer swap; RFC 9110-based 403/404 mapping |
| `09-plugin-architecture.md` | Plugin systems prior art | Q20–Q31 | Frozen declarative plugin records (VS Code model) + apiVersion (Nuxt model) + Kahn cycle detection; keep `Auth.make` non-generic to never hit TS2589; hooks: before-may-abort / after-fail-isolated |
| `10-schema-migrations.md` | Schema IR & migrations | Q72–Q81 | JSON-serializable Schema IR drives both validation Schemas and DDL; snapshot-diff planner + checksum ledger (stock `@effect/sql` Migrator insufficient); PG reference adapter, SQLite node+wasm, MySQL early v1.x |
| `11-client-frontend.md` | Client & frontend | Q39–Q40, Q82–Q87 | Client is fully derived from compiled HttpApi (zero hand-written endpoint code); `@effect-auth/react` on `@effect-atom/atom-react`; 5-item adapter contract, v1 = Next + Hono |
| `12-library-strategy.md` | Library strategy & security process | Q7, Q92–Q100 | changesets + npm provenance/trusted publishing; fumadocs docs; plugin templates + registry tiers; MIT + SECURITY.md + OpenSSF basics; fast-check + semgrep + vitest bench |
| `13-modularity-foundations.md` | Modularity & OS-extensibility science | — | Parnas/Baldwin&Clark design rules; SPIN/Exokernel validate compile-time choice; SFI lineage; every entry primary-verified |
| `14-plugin-platforms.md` | Empirical plugin-ecosystem studies | — | Eclipse/Firefox/Chrome/VS Code/WordPress numbers: declared compat ≠ real compat (96.7% vs 50.2% survival), registry malware at scale, deprecation UX failure modes |
| `15-extensibility-theory.md` | CBSE, contracts, feature interaction, product lines | — | Beugnard 4-level contracts map onto plugin contract levels; plugin conflicts = feature-interaction problem (detection vs resolution); plugin sets = product-line configurations |
| `16-api-evolution.md` | API evolution & semver science | — | 20.1%/28.6% of non-major releases break (Maven/Go); only 7.9% of clients impacted; deprecation ignored without codemods → apiVersion integer as load-bearing contract |
| `17-capability-security.md` | Capability security & supply chain | — | Capability canon (Dennis&Van Horn→Miller) + macaroons + marketplace studies → 6-step before-sandboxing playbook; Wasm sandbox as priced v2 seam |
| `18-plugin-science-review.md` | **Review article** (synthesis of 13–17) | — | Seven design laws for the plugin compiler; verified policy table; ~185 entries/250 verified links; documents literature gaps (no .NET study, no JetBrains science, no TS evolution data) |
| `19-dbc-to-effect-mapping.md` | DbC spec → Effect v4 primitives | — | Synthesis, not primary research: maps every `../better-auth/` contract category onto verified `effect@4.0.0` source read from the local monorepo checkout (not npm/v3.22) — `Context.Service` is real in v4 (vindicates the PRD), native `RateLimiter`/`KeyValueStore`/`Tx*` STM/`unstable/cli`/`unstable/observability` remove several v3.22-era "must build ourselves" assumptions |

## 2026-09 facts that change the PRD

- **Effect versions:** stable `3.22.2` (2026-09-09), v4 RC `4.0.0-rc.115`; v4 moves HttpApi to `effect/unstable/httpapi` and renames ServiceMap → Context. PRD code examples must be rewritten to `Effect.Service`/`Context.Tag` (PRD's `Context.Service` sample is not current v3 API). (01, 11)
- **HttpApi risk:** marked Unstable in v3 docs; gaps listed in `01` (docs, middleware-skip bug #6121, SSE in v4 only). Adopt/wrap/abstain is a tracked decision. (01)
- **Competitive field:** better-auth 1.7.4 (MIT, Vercel-owned, 50+ plugins, agent/MCP auth frontier); its verified weak seams — no plugin dependency/apiVersion/conflict validation, `any`-collapse client inference, schema-push migrations without ledger, 14 advisories in one 2026 cycle — are exactly where effect-auth's compile-time compiler differentiates. (02, 03)
- **npm scope:** `@effect-auth/core` and `@effect-auth/cli` already exist on npm (alpha, dead repo). Naming decision required before MVP. (01)
- **Security floor:** RFC 9700 (OAuth BCP), RFC 10017 (Browser-Based Apps BCP, Aug 2026), NIST SP 800-63B-4, OWASP argon2id baseline. (04, 05, 07)
- **People:** Pilcrow (Lucia/Auth Book), Bereket Engida (better-auth), Balázs Orbán (ex-Auth.js — governance cautionary tale), Sergio Xalambrí, Aeneas Rekkas, Jake Moshenko (SpiceDB), Sam Scott (Authorization Academy — Oso, not authzed), Matthew Miller (SimpleWebAuthn), Gabriel Vergnaud (Type-Level TypeScript). Attribution corrections vs initial briefs are noted in-files. (02, 03, 08, 09)
- **v4 checkout corrections to `01`'s v3.22 findings:** read directly from the local Effect monorepo (not npm) — `Context.Service` **is** the real, current v4 idiom (`Context.ts`), unifying what v3 split across `Effect.Service`/`Context.Tag`; the PRD's original naming was right for v4, wrong only for the v3.22 line `01` tested against. Several "must build ourselves" assumptions in `01`/`07`/`10` are no longer necessary in v4: a native keyed `RateLimiter` and `KeyValueStore` ship in `effect/unstable/persistence`, a full `Tx*` STM family replaces hand-rolled atomic-fallback, the CLI framework is in-core at `effect/unstable/cli` (not an external `@effect/cli` package), and OTel/Prometheus wiring is in-core at `effect/unstable/observability`. Two v4-only modules with no v3.22-era equivalent are worth prototyping: `Redactable` (context-aware redaction, complementing `Redacted`) and `Combiner`/`Reducer` (statement/role aggregation). (19)

## Open decisions for PRD v2

Cross-file consolidated list — each row is researched and ready to decide:

1. **npm scope** — keep/rename `@effect-auth/*` vs new scope (01).
2. **Effect track** — `^3.22` + CI-green on v4-rc (recommended) vs dual-track vs wait for v4 stable (01, 10, 11) — de-risked somewhat by (19): several v4 primitives (`Context.Service`, native `RateLimiter`/`KeyValueStore`, in-core CLI/observability) mean less bespoke code either way, and `Context.Service` usage should target v4's real shape regardless of which track ships first.
3. **HttpApi posture** — adopt unstable vs wrap vs drop to HttpRouter (01) — (19) confirms `HttpApi` still lives under `effect/unstable/httpapi` in the v4 checkout, alongside `unstable/cluster`/`unstable/workflow`; the "Unstable" risk is not resolved by moving to v4.
4. **Plugin contract** — frozen declarative records + `apiVersion` + dependency/capability validation (09, 02) — (19) confirms `Layer`/`Context.Service` alone do not give plugin-level collision/dependency detection for free in v4 either; the effect-auth compiler must still implement this itself regardless of Effect version.
5. **Account linking default** — deny-by-default + explicit `linkSocial` (recommended) vs better-auth-style implicit verified-email linking (05, 02).
6. **Multi-tenancy** — LayerMap seam day-one vs Phase 3 (01, 09).
7. **Events** — in-memory PubSub/Stream at v1 vs durable outbox (01).
8. **React binding base** — `@effect-atom/atom-react` vs plain hooks + optional react-query (11).
9. **Adapters at v1** — Next.js + Hono first (11); PG + SQLite first, MySQL early v1.x (10).
10. **License & governance** — MIT (03, 12).
11. **Enterprise tier timing** — SAML/SCIM/API-keys/JWT phasing (03).
12. **D1/edge story** — experimental adapter now vs later (07, 10).
13. **Native-primitive adoption** — use v4's in-core `RateLimiter`, `KeyValueStore`, `Tx*` STM, `unstable/cli`, `unstable/observability` instead of building bespoke equivalents (recommended) vs hedging with custom abstractions in case these `unstable`-tier APIs churn before v1 ships (19).
14. **Durable sagas (device-authorization polling, SSO/SCIM provisioning)** — model as adapter-backed state machines (status + expiry columns) at v1 (recommended) vs adopting `effect/unstable/workflow`. **Recommend against adoption**: the only durable `WorkflowEngine` (`ClusterWorkflowEngine`) requires the full `Sharding` + `MessageStorage` cluster runtime — a fundamentally heavier operational model than a stateless-HTTP-plus-SQL deployment; the in-memory alternative is explicitly documented as non-durable. Revisit only post-v1, if a genuine multi-day cross-process saga emerges and `unstable/cluster` has stabilized (19, §4a).
15. **Migration engine build-vs-reuse** — confirmed (not just assumed): v4's stock `unstable/sql/Migrator` still has no checksums, no dry-run, and wraps every pending migration in one all-or-nothing transaction (no per-migration transaction mode for `CONCURRENTLY`-style DDL). effect-auth must build its own snapshot-diff planner + checksum ledger on top, reusing only the Migrator's insert-as-concurrency-guard locking mechanism (10, 19 §9a).
16. **Redaction mechanism** — `Redacted<A>` opaque-wrapper (as research 12 specified) vs. the newer `Redactable` context-aware protocol (objects present different representations depending on runtime context) as the primary mechanism at the log/span/event `Redactor` boundary, or both together (12, 19).
