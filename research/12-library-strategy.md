# Library strategy, release security & governance — Research

Covers Q95–Q100 (CLI, docs, monorepo/release, plugin author experience, reference apps, versioning), Q92–Q94 (secure release, redaction, security testing), and Q7 (governance). All version numbers verified against npm/GitHub as of 2026-09-12.

## TL;DR

- Effect itself is the best available template: pnpm@11 workspaces + changesets (fixed version group, 25+ packages in lockstep) + changesets/action, publishing with npm OIDC trusted publishing (`id-token: write`, `permissions: {}`, SHA-pinned actions) ([effect repo](https://github.com/Effect-TS/effect), [release.yml](https://github.com/Effect-TS/effect/blob/main/.github/workflows/release.yml)).
- Effect's canary story is two-layered: per-PR/commit builds via `pkg-pr-new` snapshot workflow, plus an npm `snapshot` dist-tag (`0.0.0-snapshot-<sha>`), with prerelease channels `rc`/`beta` (Effect v4 = `4.0.0-rc.115` under `rc`).
- npm classic tokens were revoked (Dec 2025); trusted publishing (OIDC) is GA since 2025-07-31 and auto-generates Sigstore provenance — a new project in 2026 should never hold a long-lived publish token.
- Community Effect libs show the peer-range trap: `effect-http` froze at `effect ^3.14.0`, `@sqlfx/sql` died on `effect ^2`; Effect's own packages use `workspace:^` and lockstep majors. awthaq should support exactly one Effect major per major line.
- ESM-only is now safe: Effect v4 and better-auth 1.7.4 ship ESM-only, and Node ≥ 20.19 / 22.12 `require()` ESM by default.
- better-auth's docs run on fumadocs + Next.js with a concepts/plugins/guides/reference IA; effect.website is an Astro app with versioned docs channels. fumadocs is the pragmatic 2026 pick for a TS framework.
- `@effect/cli` is still Effect-3-only (0.77.1); in Effect v4 the CLI moved to an unstable export (`effect/unstable/cli`). Build the MVP CLI on `@effect/cli`, keep the command layer thin.
- Lucia deprecated its npm package and became a learning resource — a cautionary tale: docs ARE the product for auth frameworks.
- Security posture lessons from better-auth: a critical 2025 CVE in its API-keys plugin (third-party find), a coordinated multi-advisory "security update" cycle in June 2026 — disclosure infra (SECURITY.md → GitHub CNA advisories) and a plugin-code threat model are day-one needs.
- Redaction should be a type, not a convention: Effect's `Redacted<A>` (since 3.3.0) already redacts string/JSON/inspect output; awthaq should standardize on it plus a deny-by-default redactor at the log/span/event boundary.

## Questions answered

### Q95 — CLI scope at MVP and framework choice

**Evidence.** PRD MVP lists CLI + schema generation + migrations + test utilities (PRD §53). The natural command set: `doctor` (environment/compat validation), `schema generate|diff`, `migration create|status|apply`, `plugin list|validate`. Framework landscape, verified 2026-09:

| Library | Version | Notes |
|---|---|---|
| `@effect/cli` | 0.77.1 | peers `effect ^3.22.2`, `@effect/platform ^0.97.2`; built on clipanion; Effect-native (Options/Args composables, `Config` integration, typed errors, declarative help) ([npm](https://www.npmjs.com/package/@effect/cli)) |
| `effect/unstable/cli` (v4) | — | Effect v4 folded the CLI into the core package under an `unstable/` export path; there is no `@effect/cli` 4.x on npm ([effect exports](https://github.com/Effect-TS/effect/blob/main/packages/effect/package.json)) |
| citty | 0.2.2 | UnJS, tiny, ESM; still 0.x ([npm](https://www.npmjs.com/package/citty)) |
| commander | 15.0.0 | stable, imperative API ([npm](https://www.npmjs.com/package/commander)) |
| oclif | 5.0.0 | heavyweight plugin/CLI framework (Salesforce lineage) |
| clipanion | 4.0.0-rc.4 | powerful typed parser (Yarn's), still RC ([npm](https://www.npmjs.com/package/clipanion)) |

Since the CLI (`doctor`, `schema`, `migration`) must read plugin configs, `@effect/cli`'s `Config` integration and shared Effect primitives avoid duplicating parsing logic that `Auth.make` also needs. Its cost: it is 0.x and v4-unstable, but the command layer can be kept thin (each command = a function taking typed args), making a port to `effect/unstable/cli` mechanical. Post-MVP: `init` (scaffold app + adapter selection, like `nuxi init`/`create-astro`) and `client codegen` — but codegen mostly comes free from `HttpApiClient`, so it is low priority (see Q96/Q39 research in siblings).

MVP command surface (design target):

| Command | Purpose | Notes |
|---|---|---|
| `awthaq doctor` | validate environment: Effect version in peer range, adapter deps present, config parses, plugin graph compiles | non-zero exit with fix text; `--json` for CI |
| `awthaq schema generate` | emit DDL/migration from aggregated plugin Schema IR | `--dialect pg\|sqlite\|mysql` |
| `awthaq schema diff` | drift between IR and live DB | read-only |
| `awthaq migration create <name>` | ordered migration from IR diff, plugin topo order | destructive ops require `--allow-destructive` (PRD Q75 guard) |
| `awthaq migration status\|apply` | ledger check / apply against target DB | transactional where the dialect allows |
| `awthaq plugin list` | installed plugins, versions, `apiVersion`, capabilities | `--matrix` shows official-plugin compatibility |
| `awthaq plugin validate` | static compile: ids, deps, cycles, routes, schemas | also the plugin-author gate (Q98) |

All commands run non-interactively (CI mode) and share exit codes; every validation failure prints the offending plugin id plus a docs link (this is PRD Q22's compile-error UX reused by the CLI).

**Recommendation:** MVP commands: `awthaq doctor`, `schema generate|diff`, `migration create|status|apply` (with destructive-op guard), `plugin list|validate`. Build on `@effect/cli` while awthaq targets Effect 3 stable; wrap every command in a plain function so the eventual Effect 4 port to `effect/unstable/cli` is a rewrite of wiring only. Skip `init` and `codegen` at MVP.
**Confidence:** high (scope), medium (framework — depends on which Effect major awthaq v1 targets).

### Q96 — Docs platform, structure, examples/playground

**Evidence.** Verified stacks, 2026-09:

- **better-auth**: docs are fumadocs (`fumadocs-core`, `fumadocs-mdx`, `fumadocs-ui`, `fumadocs-typescript`, typesense search adapter) on Next.js ([docs/package.json](https://github.com/better-auth/better-auth/blob/main/docs/package.json)). Its IA: `installation → basic-usage → concepts → plugins → guides → reference → adapters → integrations → examples` ([docs tree](https://github.com/better-auth/better-auth/tree/main/docs/content/docs)) — this is the closest match to awthaq's three audiences and demonstrably scales to a plugin-heavy framework.
- **Effect**: effect.website is an Astro app (`apps/web`, astro dev) with **versioned docs channels** — the release workflow deploys `channel: v4` separately from v3 ([Effect-TS/website](https://github.com/Effect-TS/website), [release.yml](https://github.com/Effect-TS/effect/blob/main/.github/workflows/release.yml)). Relevant because Effect's fast major cadence forces channel-split docs.
- **Framework comparison** (2026 guides): fumadocs wins when docs live in Next.js with typed search, OpenAPI-driven reference pages, and custom UI; Starlight (Astro, 0.42.0) wins for content-first multi-audience docs with lowest maintenance; Nextra 4.6.1 is the lighter-weight Next.js option ([PkgPulse 2026](https://www.pkgpulse.com/guides/fumadocs-vs-nextra-v4-vs-starlight-documentation-sites-2026), [StarterPick 2026](https://starterpick.com/guides/fumadocs-vs-nextra-vs-docusaurus-2026)).
- **Lucia deprecated its npm package** and pivoted to a learning-resources site ([npm deprecation](https://www.npmjs.com/package/lucia)) — in auth, docs and trust carry the project as much as code.

**Recommendation:** fumadocs on Next.js. Reasons: TS-first (typed frontmatter, typed search incl. a hosted engine adapter), built-in OpenAPI-driven API reference pages that can render the aggregated HttpApi OpenAPI spec (PRD G4/§38), best-in-class static rendering for copy-paste code, and the proven better-auth precedent. Structure by audience with shared spine: Getting started → Concepts (users/sessions/principals/plugins) → Authentication methods → Authorization → Plugins (one page per official plugin) → Guides (recipes) → Reference (config, errors, CLI, HttpApi/OpenAPI) → Plugin-dev section (architecture, contributions, testing, publishing, compatibility) → Adapter-dev section (repositories, schema IR, migrations). For examples: skip a hosted playground (Effect + Postgres exceeds WebContainers-style sandboxes [INFERENCE]); instead ship runnable `examples/*` packages inside the monorepo (Effect's own pattern: `examples/*` in its workspace) linked from docs, plus a single demo app (better-auth keeps `demo/` in-repo). Split docs channels when the second supported Effect major arrives, copying Effect's `channel:` deploy model.

Concrete shape:

```text
/docs
  getting-started/   # app devs; one 5-minute path per adapter
  concepts/          # users, accounts, sessions, principals, plugin model
  authentication/    # one page per method
  authorization/
  plugins/           # one page per official plugin + community listing
  guides/            # recipes: BFF, SPA, edge, multi-tenant prep
  reference/         # config, errors, CLI, OpenAPI, changelog
  plugin-dev/        # architecture → contributions → testing → publishing → compatibility
  adapter-dev/       # repository IR, migrations, transactions, test harness
```

- Search: typesense adapter (the better-auth precedent) or fumadocs' built-in static search — static is enough at launch.
- Code snippets: single-source from `examples/*` where practical; docs examples rot faster than APIs.
- Versioning: one docs channel per supported awthaq major (`/docs` current, `/docs/v1` frozen at v2) — adopt Effect's `channel:` deploy model only when the second major exists; don't pay the cost up front.
**Confidence:** high.

### Q97 — Monorepo, changesets, provenance, canary, Effect peer ranges

**Evidence.** Effect's own repo is the primary source (verified 2026-09): pnpm@11.20.0 workspaces; `tsc -b` project references for typechecking across ~30 packages; oxlint + dprint; Vitest; **changesets** (`@changesets/cli` 3.0.2, `@changesets/changelog-github`) with a **`fixed` group** so `effect` + all `@effect/*` packages version in lockstep; release via `changesets/action` with `id-token: write` and an explicit `npm install -g npm@11` for OIDC, `permissions: {}` and SHA-pinned actions throughout ([root package.json](https://github.com/Effect-TS/effect/blob/main/package.json), [.changeset/config.json](https://github.com/Effect-TS/effect/blob/main/.changeset/config.json), [release.yml](https://github.com/Effect-TS/effect/blob/main/.github/workflows/release.yml)). In-repo inter-package deps use `workspace:^`, which pnpm rewrites to caret ranges at publish. Canary channels: a `snapshot` workflow publishes every PR/commit through `pkg-pr-new` (0.0.88), and npm carries a `snapshot` dist-tag (`0.0.0-snapshot-<sha>`), plus `beta`/`rc` dist-tags for prerelease lines ([snapshot.yml](https://github.com/Effect-TS/effect/blob/main/.github/workflows/snapshot.yml), [npm dist-tags](https://www.npmjs.com/package/effect)). Changesets prerelease mode (`pre enter rc`) produces the `4.0.0-rc.N` line ([changesets prereleases guide](https://changesets.dev/guide/prereleases)).

Task runners: Turborepo 2.10.12 vs Nx 23.2.1 today. 2026 comparisons converge: turborepo = fast remote caching with minimal opinions, fits JS/TS repos using package.json scripts; nx = more coordination/polyglot power, more opinions ([newstack.dev](https://newstack.dev/devops/turborepo-vs-nx/), [PkgPulse](https://www.pkgpulse.com/guides/turborepo-vs-nx-monorepo-2026)). Notably **Effect itself uses neither** — plain `pnpm --recursive --filter` + `tsc -b` suffices at its scale.

Peer-range strategies across Effect breaking releases (npm, verified): Effect's own packages: `workspace:^` → caret-on-major after rewrite; community: `effect-http` peers `effect ^3.14.0, @effect/platform ^0.80.0` and stalled ([npm](https://www.npmjs.com/package/effect-http)); `@effect-atom/atom` peers `effect ^3.22.1` with a caret per minor ([npm](https://www.npmjs.com/package/@effect-atom/atom)); `@sqlfx/sql` still peers `effect ^2.4.7` — abandoned line ([npm](https://www.npmjs.com/package/@sqlfx/sql)). Lesson: per-minor carets are too tight and rot; Effect 3→4 is a hard break (HttpApi moved into `effect/unstable/*` exports), so cross-major peer ranges would be fiction.

ESM policy: Effect v4 is `"type": "module"` ([npm](https://registry.npmjs.org/effect/4.0.0-rc.115)); better-auth 1.7.4 ships ESM-only (`exports` has only `.mjs` default, no `require` condition) ([npm](https://www.npmjs.com/package/better-auth)). `require(esm)` is enabled by default since Node 20.19.0 / 22.12.0, removing the last CJS-consumer argument ([Node 20.19.0](https://nodejs.org/en/blog/release/v20.19.0), [Socket analysis](https://socket.dev/blog/require-esm-backported-to-node-js-20)). TS authoring config: `tsc -b` composite project references (Effect), TS ≥ 5.9 (Effect's `tstyche --target '>=5.9'`), `moduleResolution: nodenext` for library builds, `check-dist-types`-style verification of emitted types, plus `publint` (0.3.24) and `@arethetypeswrong/cli` in CI; note Effect is also developing `@effect/tsgo` (native TS) as an option ([effect scripts](https://github.com/Effect-TS/effect/blob/main/package.json)).

**Recommendation:** (1) pnpm workspaces + changesets, versioning all `@awthaq/*` in one **fixed group** (plugin contract is one product; lockstep removes choreography bugs). (2) Turborepo only when CI wall-time hurts (<15 packages: plain `pnpm -r` + `tsc -b` first, matching Effect). (3) Publish via **npm trusted publishing** (OIDC, `id-token: write`, no stored tokens) — classic tokens are revoked since Dec 2025, and trusted publishing auto-attaches Sigstore provenance ([npm docs](https://docs.npmjs.com/trusted-publishers/), [GitHub changelog GA 2025-07-31](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/), [context](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/)). (4) Channels: `latest` (stable), `rc` for next-major, and per-PR snapshots via `pkg-pr-new`; changesets `pre` mode for the RC line. (5) Peer deps: `"effect": "^3.<floor>"` on the v1 line — one Effect major per awthaq major; a CI job builds against `effect@latest` (and `effect@rc` for warning signals) on every push; when Effect 4 stabilizes, ship awthaq v2 with `effect ^4` rather than a dual range. (6) ESM-only, `engines.node >= 20.19`, `moduleResolution: nodenext`, declaration maps on, `publint` + `attw` + a `check-dist-types` equivalent as merge gates.
**Confidence:** high.

Release runbook (fully automated; humans only write changesets and merge the Version Packages PR):

1. Contributor adds `.changeset/*.md` (change + bump type; PR template enforces it).
2. CI on main: `changesets/action` opens/updates "Version Packages"; merging it runs the release job — build (`tsc -b` + package builds), `publint`/`attw`/dist-types gates, then `changeset publish` under OIDC trusted publishing, then tags.
3. Prerelease line: `changeset pre enter rc` makes all versions `x.y.z-rc.N`; `changeset pre exit` returns to stable.
4. Per-PR builds: `pkg-pr-new publish` comments an installable commit build on every PR (Effect's `snapshot.yml` is the copy-paste template).
5. Consumers verify supply chain: `npm audit signatures`; provenance renders on npmjs.com per release.

Compatibility CI for peer ranges:

- Required job: `effect@latest` × Node 20/22/24 (+ Bun where an adapter claims it) — fails CI on any typecheck/test error.
- Advisory job: `effect@rc` — allowed to fail; a red run opens an issue so the next minor can prepare for the upcoming Effect release.

### Q98 — Plugin author experience: templates, validator, publishing checklist, registry

**Evidence.** Comparable extension ecosystems: **Nuxt Modules** — a curated, PR-maintained directory at nuxt.com/modules where official modules live under the `@nuxtjs/` scope and community modules are listed with metadata + compatibility ranges ([registry](https://nuxt.com/modules)); Nuxt also ships an official module starter template (`nuxi init --template module`, [nuxt/starter](https://github.com/nuxt/starter)). **Astro** — `astro add` installs official or community integrations; the integrations reference reserves the `astro:` prefix for built-in hooks, i.e. namespacing is enforced by convention + docs ([integrations guide](https://docs.astro.build/en/guides/integrations/), [integrations reference](https://docs.astro.build/en/reference/integrations-reference/)). **ESLint** — no registry service at all; naming convention `eslint-plugin-*` plus a curated community list (awesome-eslint) sustains discovery ([ESLint plugins docs](https://eslint.org/docs/latest/extend/plugins)). npm scope strategy: an npm org reserves the `@scope` namespace on creation; unscoped names are first-come ([npm orgs docs](https://docs.npmjs.com/organizations/about-organizations)). Availability check before naming: `npm view @awthaq/core` (404 = free) plus org creation.

**Recommendation:** (1) Ship `create-awthaq-plugin` (usable as `npm create awthaq-plugin`): a template with `definePlugin` scaffold, the `@awthaq/test` contract-test harness prewired (PRD Q31), changesets + trusted-publishing release workflow, `publint`/`attw` gates, and README publishing checklist. Model it on Nuxt's module starter. (2) Validation: the CLI's `plugin validate` runs the compiler statically (duplicate ids, missing deps, cycles, `apiVersion` compatibility, route/schema conflicts — PRD §9.4) against a matrix of official-plugin combinations, and `plugin test` wraps the contract harness; both must be runnable locally with zero config. (3) Publishing checklist (docs page, enforced as far as possible): peer `effect` caret range on the supported major; `apiVersion` bumped iff plugin-contract usage changed; ESM-only + clean `attw`; provenance published (show the `npm audit signatures` command); security expectations restated — third-party plugins execute application code and are not trusted by conformance alone (PRD §47). (4) Registry/listing: a PR-based directory (JSON entries in the docs repo, rendered at /plugins) with two tiers — **Official** (in `@awthaq` scope, required security review per PRD §48) and **Community** (listed after automated checks + human lightbox review); skip building registry infrastructure — the ESLint/Nuxt evidence says curated list + conventions are enough. (5) Naming: official `@awthaq/plugin-*`; community `@<scope>/awthaq-plugin-*` (or unscoped `awthaq-plugin-*`); reserve the `@awthaq` npm org, GitHub org, and the unscoped `awthaq` name on day one.

The publishing checklist, concretely:

- `apiVersion` matches the contract version the plugin compiles against (checked by `plugin validate`).
- peer `effect` range = caret on the supported major; the template ships a compat job installing `effect@latest`.
- `publint` + `attw` clean; ESM-only; minimal `files`; LICENSE + README present.
- Released via trusted publishing (workflow included in the template); provenance visible on npmjs.com.
- Contract-test harness green against the supported core version matrix.
- README security section: what the plugin does with credentials/tokens; no secrets persisted beyond the documented contract.
**Confidence:** high.

### Q99 — Which three reference apps ship

**Evidence.** PRD targets Effect application developers and framework integrators (§6), and requires proving PostgreSQL + SQLite adapters, HttpApi, and the plugin matrix at MVP (§53). Effect's repo keeps `examples/*` in-workspace; better-auth keeps a `demo/` app plus `e2e/` in-repo ([repo root](https://github.com/better-auth/better-auth)). The docs benefit of an example per framework×DB cell: each example doubles as a docs "recipe" (Q96).

**Recommendation:** ship exactly three, in-repo under `examples/`:
1. **`examples/nextjs-postgres`** — Next.js (App Router) + `@effect/sql-pg` + plugins: password, oauth, passkey, organization. Proves the full plugin matrix, RSC/BFF topology, cookie sessions, and the flagship docs path.
2. **`examples/hono-sqlite`** — Hono on Node or Bun + `@effect/sql-sqlite-node` + plugins: password, api-key, jwt. Proves the framework-adapter contract (PRD §40), non-React serving, and machine-to-machine principals (`ApiKeyPrincipal`).
3. **`examples/astro-d1-edge`** — Astro + Cloudflare Workers + `@effect/sql-d1` + plugins: password, magic-link (email OTP). Proves edge-portability claims and the WebCrypto-only crypto path.
Each example: one README with the exact `Auth.make` config, deploy button/instructions, and the CI must boot them against ephemeral DBs (proves migrations end-to-end).

| Example | Framework | DB | Plugins proved |
|---|---|---|---|
| `nextjs-postgres` | Next.js (App Router) | PostgreSQL (`@effect/sql-pg`) | password, oauth, passkey, organization |
| `hono-sqlite` | Hono (Node/Bun) | SQLite (`@effect/sql-sqlite-node`) | password, api-key, jwt |
| `astro-d1-edge` | Astro + Cloudflare Workers | D1 (`@effect/sql-d1`) | password, magic-link |
**Confidence:** high (structure); Astro-vs-SvelteKit for slot 3 is taste — flag in Open questions.

### Q100 — Semver, `apiVersion` evolution, deprecation, Effect bump policy

**Evidence.** SemVer spec: major = incompatible API changes; **0.x grants no stability** ("anything MAY change", §4) — so awthaq's stability promises only start at 1.0 ([semver.org](https://semver.org)). PRD §44 already fixes the shape: patch = fixes, minor = additive, major = breaking public API or plugin contract; plugin `apiVersion` is an additional boundary. The best-practice analog for tiered stability inside one version stream is OpenTelemetry's versioning-and-stability policy: components carry explicit stability levels (stable / development / experimental) with different guarantee strengths ([otel versioning-and-stability](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/), [spec status](https://opentelemetry.io/docs/specs/status/)) — Effect does the same thing with `unstable/*` export paths in v4. Nuxt Modules' per-module `compatibility` ranges show the user-facing UX for compatibility metadata. For deprecation mechanics: TSDoc `@deprecated` tags surface in IDEs and typescript-eslint can flag usage; `npm deprecate` warns installers of abandoned lines ([npm docs](https://docs.npmjs.com/cli/v10/commands/npm-deprecate)); Effect itself ships codemods for breaking migrations (`scripts/codemod.mjs` in-repo).

**Recommendation:** (1) SemVer 2.0, no 0.x promises beyond "tag your issues"; first 1.0 is the stability line. (2) `apiVersion` = single monotonic integer on the plugin contract; bump only for breaking changes to the contract (not to core's internal APIs); the compiler hard-fails on mismatch and the error message links the migration note for that bump. Keep a published `apiVersion` changelog; two contract-breaking bumps per awthaq major maximum ([INFERENCE] — choose a conservative cadence; plugins must not churn). (3) Deprecation process: announce in the changesets changelog + docs "Deprecations" page → `@deprecated` JSDoc (IDE-visible) → runtime warning once per process via the logger (no console spam) → removal only in the next major, never a minor → for dead majors, `npm deprecate` + codemod where mechanical (Effect precedent). (4) Effect bump policy: v1 line peers the latest stable Effect 3 minor; CI runs against `effect@latest` continuously and `effect@rc` as an advisory signal (rc job is allowed to fail); when Effect 4 hits stable, awthaq v2 ships peers `effect ^4` with a migration guide — no dual-major peer ranges, matching the evidence that cross-major support rots (Q97).

Worked flow: core 1.4 adds an optional hook argument → no bump. Core 1.5 changes `definePlugin`'s `hooks` shape → ships `apiVersion` 3; plugins compiled against `apiVersion: 2` fail `plugin validate` with "plugin X declares apiVersion 2; core requires 3 — see /docs/plugin-dev/compatibility#v3 (codemod: `npx awthaq-codemod api-v3`)". Community plugins get at least one full minor cycle before core's `requiresApiVersion` steps to 3. Deprecation example: `auth.session.listAll()` deprecated in 1.6 (TSDoc `@deprecated` + one-time logger warning naming the replacement), removed in 2.0, with the changesets changelog entry linking the migration guide.
**Confidence:** high.

### Q92 — Secure release process: SECURITY.md, embargo, CVEs, dependency audit, provenance

**Evidence.** GitHub is a CVE Numbering Authority: a repository security advisory can reserve and publish a CVE directly, privately while embargoed, and feed GHSA/npm-advisory consumers ([GitHub docs](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-repository-security-advisories), [GitHub blog](https://github.blog/security/github-advisory-database-by-the-numbers-known-security-vulnerabilities-and-what-you-can-do-about-them/)). better-auth (the direct competitor benchmark) maintains SECURITY.md at repo root and demonstrates the full cycle: a critical 2025 API-keys plugin CVE reported by a third party (CVE-2025-61928) and a coordinated June 2026 multi-advisory release with per-plugin upgrade paths ([SECURITY.md](https://github.com/better-auth/better-auth/blob/main/SECURITY.md), [ZeroPath writeup](https://zeropath.com/blog/breaking-authentication-unauthenticated-api-key-creation-in-better-auth-cve-2025-61928), [better-auth security update blog](https://better-auth.com/blog/security-update-june-2026)); it even keeps a `.postmortem/` directory in-repo. Publishing security: npm trusted publishing via OIDC is GA (2025-07-31) and classic tokens were permanently revoked on 2025-12-09, so short-lived CI-bound credentials are now the only sane mode; provenance attestations are generated automatically on trusted publishes and verifiable via `npm audit signatures` ([npm docs](https://docs.npmjs.com/trusted-publishers/), [GitHub changelog](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/), [token revocation context](https://wayjam.me/posts/npmjs-trusted-publishing-changes/), [practical guide](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/)). Supply-chain posture measurement: OpenSSF Scorecard automates checks (build provenance, pinned dependencies, token permissions, security policy, vulnerability tracking) and offers a GitHub Action + weekly ecosystem scans ([scorecard.dev](https://scorecard.dev/), [scorecard-action](https://github.com/ossf/scorecard-action)). Effect's release workflow already models the hygiene baseline: `permissions: {}`, SHA-pinned actions, `id-token: write` only in the release job (Q97).

**Recommendation:** Adopt, concretely: (1) `SECURITY.md` with private-vulnerability-reporting enabled, supported-version table, and a 72h-triage/90d-disclosure target. (2) Embargo flow on GitHub: private fork → draft security advisory → fix + canary-verified → patch release → publish advisory (auto-CVE via GitHub CNA) → GHSA reaches npm audit consumers automatically → public postmortem for high severity. Never discuss exploit details in issues. (3) Release job: trusted publishing only; separate GitHub **environment** with required reviewers for `latest` publishes; snapshots/rc can bypass human gate. (4) Dependency hygiene as CI: Renovate (grouped, automerge dev-deps), `npm audit`/osv-scanner gate on new highs, lockfile committed, `npm audit signatures` verify step. (5) OpenSSF Scorecard badge from 1.0 (it also functions as a trust signal users check before adopting auth libraries). (6) Dependency-minimal core: every runtime dep is supply-chain attack surface for an auth library — argue for near-zero core deps (Effect's own `effect` 3.x has only `fast-check` + `@standard-schema/spec`).

Advisory timeline (T = report confirmed):

- T+72h: triage verdict to the reporter; draft advisory opened (private fork).
- T+N: fix in the private fork + regression test; fix verified against a canary snapshot build.
- Release day: patches for all supported lines → advisory published (CVE via GitHub CNA + GHSA, reaching `npm audit` consumers) → changelog entry without exploit detail → reporter credited (or anonymized on request).
- T+7d: postmortem published for high/critical (better-auth keeps `.postmortem/` in-repo).

`SECURITY.md` contents: supported-versions table; scope (core + official plugins); report channel (GitHub private vulnerability reporting primary, security@ email fallback); disclosure targets (72h triage / 90d publish); safe-harbor statement for researchers.
**Confidence:** high.

### Q93 — Sensitive-data redaction: what, and by what mechanism

**Evidence.** PRD §52 fixes the what: logs/traces/events must redact passwords, session tokens, OAuth authorization codes, API keys, recovery codes, and secrets. The mechanism should be native to Effect: the **`Redacted<A>`** module (since Effect 3.3.0) wraps sensitive values so "string, JSON, and inspection output" render a placeholder while trusted code can still recover/wipe the value ([Redacted.ts source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Redacted.ts)); `Config.redacted` gives the same treatment to configuration secrets. Effect's logger/span model (structured annotations, `auth.*` span names per PRD §52) gives a single choke point to enforce redaction: if the type is `Redacted`, a naive log/attribute pass-through renders the placeholder — leakage requires deliberately calling `Redacted.value`, which greps for. OWASP's Logging Cheat Sheet is the canonical never-log list (passwords, tokens, session ids, secrets, PII beyond need) ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)). What redaction cannot catch at the type level is free-form fields (email, IP, user agent) — those need a boundary policy, not types.

**Recommendation:** Redaction by construction, deny-by-default at one boundary: (1) Every secret-bearing value in core/plugin code is `Redacted<string>` from construction (tokens, codes, keys, recovery codes, hasher outputs); `Config.redacted` for all secret config. (2) A core `Redactor` service is the ONLY place log/span/event payloads pass through: deny-list of field names (PRD §52 list) + type check — `Redacted` values and fields carrying a Schema "sensitive" annotation are dropped/masked; events themselves are Schemas, so sensitive fields are declared once at the Schema and inherited by logs, traces, events, and OpenAPI docs. (3) Span attributes for auth ops carry identifiers (principal id, plugin id) and never payloads. (4) Enforcement is testable: an in-repo property test drives auth flows with planted canary secrets and asserts the serialized log/span/event corpus never contains them (Q94). (5) Document that host-side scanning (e.g. a vendor's sensitive-data scanner) is defense-in-depth, not the mechanism. Community plugins inherit all of this automatically if they build payloads on their declared Schemas — which the contract tests check.

Enforcement sketch: a Schema-level `sensitive` annotation marks fields once (`S.annotate(SensitiveAnnotation)`) on every payload/error/event Schema; the `Redactor` walks serialized values — `Redacted` instances and `sensitive`-annotated fields become `[REDACTED]`, deny-listed keys are dropped, everything else passes. Because events are Schemas (PRD §49), one annotation covers audit events, trace attributes, and OpenAPI docs. The canary property test (Q94) plants unique marker strings as "passwords"/"tokens" through real flows and asserts the captured log/span/event corpus never contains them — turning the policy from a review-time convention into a merge gate.
**Confidence:** high on mechanism; medium on coverage of free-form fields (needs a policy decision — see Open questions).

### Q94 — Security testing: abuse cases, property tests, static analysis, pre-1.0 audit scope

**Evidence.** Tools verified 2026-09: **fast-check** 4.10.0 (MIT) is the standard TS property-testing library and is already an Effect dependency (`effect` 3.x depends on `fast-check ^3.23.1`), with Effect Schema exposing arbitrary generation ([npm](https://www.npmjs.com/package/fast-check), [effect deps](https://www.npmjs.com/package/effect)). **Semgrep** CE does JS/TS SAST with a free rules registry; 2025 Semgrep engineering posts document real OSS JS vulnerability finds, and the registry's JWT/Node/security-audit rulesets target exactly auth pitfalls (JWT mistakes, secrets, unsafe deserialization); Trail of Bits publishes public semgrep rules ([Semgrep JS support](https://docs.semgrep.dev/languages/javascript), [deep-dive blog](https://semgrep.dev/blog/2025/a-technical-deep-dive-into-semgreps-javascript-vulnerability-detection), [Trail of Bits rules](https://github.com/trailofbits/semgrep-rules)). Fuzzing: `@jazzer.js/core` 4.0.0 (Apache-2.0) brings coverage-guided fuzzing to Node, though property tests usually cover the practical need. Benchmarks: `mitata` 1.0.34 and vitest bench (tinybench 6.2.0) are the current JS micro-bench norm. The scope-setting data point: better-auth's critical CVE-2025-61928 was found by an external researcher in a plugin (API keys) and their 2026 cycle shipped advisories across core and several plugins — i.e., **plugin-contributed code is the attack surface**, so the compiler's conflict/dependency validation and the contract test harness are security controls, not just DX.

**Recommendation:** (1) In-repo abuse-case suite mapped 1:1 from the threat model doc (PRD Q88): credential stuffing (rate-limit + lockout), session fixation (rotation on auth change), CSRF (token absent/mis-scoped), token replay (single-use enforcement), enumeration (uniform responses + timing on password miss), OAuth SSRF (discovery URL fetch), open redirect (callback `redirect_uri`/`returnTo` allowlist), and `TestClock`-driven expiry tests. These are vitest cases in `packages/core/test/security/*`, named after the abuse case. (2) Property tests with fast-check: token unpredictability can't be proven, but invariants can — session expiry monotonicity, single-use consumption, pagination total order, redaction canaries (Q93), plus Schema-driven arbitrary generation fuzzing every HttpApi endpoint payload/error path. (3) Static: semgrep CE in CI with `p/javascript` + `p/typescript` + `p/secrets` high-confidence rules plus a small in-repo ruleset for awthaq-specific pitfalls (e.g. `Redacted.value` in non-redactor files, cookie set without `secure`); typescript-eslint strict; gitleaks for secret scanning. (4) Benchmarks: vitest bench + mitata for the request-path overhead budget (PRD §49) tracked per release to catch regressions. (5) Pre-1.0 audit scope: fixed-scope external review (1–2 weeks, or a reputable community audit) covering: session/token issuance+validation, OAuth callback + state/nonce handling, password hashing config, plugin compiler validation (dependency/capability/route conflicts), and the CLI's migration apply path — the code paths that turn a bug into account takeover. Internal abuse-case suite + semgrep clean is the entry ticket, not a substitute.

In-repo semgrep rules to start with (all mechanical): flag `Redacted.value` outside redactor/logger modules; flag `Set-Cookie` construction missing `Secure`/`HttpOnly`/`SameSite`; flag non-constant-time `===` comparisons on secret-typed values (must route through the crypto capability); flag `fetch` to user-controlled URLs in the OAuth plugin (SSRF review marker); flag `console.log` in `packages/*` (logger only). Audit entry ticket ("definition of ready" for the external review): abuse-case suite green, semgrep high-confidence clean, gitleaks clean, Scorecard ≥ 7, threat-model doc mapping every abuse case to its test — so reviewers spend their time on design flaws, not trivia.
**Confidence:** high.

### Q7 — Governance: license, official-plugin policy, security policy, maintainer model

**Evidence.** License landscape: Effect, better-auth, fast-check, noble crypto libs — the entire reference ecosystem — are **MIT** (verified per package.json/npm). Apache-2.0 adds an explicit patent grant with retaliation clause, an explicit trademark non-grant, and NOTICE requirements — the choice of most security-claiming infrastructure (CNCF norms) ([Apache-2.0 discussion](https://opensource.stackexchange.com/questions/7964/why-is-the-apache-license-2-0-patent-license-clause-useful-important), [comparison](https://www.mend.io/blog/top-10-apache-license-questions-answered/)); MIT leaves patent rights implicit, which is the standard criticism when a project makes security claims ([LinkedIn analysis](https://www.linkedin.com/pulse/mit-vs-apache-20-how-i-chose-license-my-open-source-project-khur-5sc5c)). Official-plugin policy evidence: Astro reserves the `astro:` hook namespace and distinguishes official vs community integrations in docs ([reference](https://docs.astro.build/en/reference/integrations-reference/)); Nuxt gates the `@nuxtjs/` scope and a curated registry ([modules](https://nuxt.com/modules)); better-auth marks plugins official by docs tier and ships them from the core repo. Security policy: GitHub's advisory/CNA pipeline (Q92) plus SECURITY.md is the 2026 baseline; OpenSSF Scorecard operationalizes the posture publicly ([scorecard.dev](https://scorecard.dev/)). Maintainer models in the wild: Effect = foundation-adjacent company-backed team; better-auth = BDFL-ish founder + core team; healthy small-project norm = CODEOWNERS + 2-approver rule for security-sensitive paths.

**Recommendation:** (1) **License: Apache-2.0** for core and official plugins — the explicit patent grant and trademark non-grant are worth it for a project whose marketing includes "secure defaults"; MIT is the ecosystem norm so this is a mild deviation, but downstream Effect users all already accept Apache-2.0 deps (it's ubiquitous in TS infra). Note: must also publish the NOTICE file discipline. (2) Official-plugin trademark policy, lightweight: "Official" = lives in the awthaq repo or the `@awthaq` npm scope; the project does NOT claim the word "official" as a registered trademark in year one — enforcement is scope ownership (npm org + GitHub org reserved day one, Q98) plus a docs page stating community plugins must not use the `@awthaq` scope or imply endorsement; revisit trademark registration only if the project grows a brand worth attacking. (3) Security policy: SECURITY.md + private reporting + GitHub CNA advisories (Q92 flow), 2-person rule for cutting security releases. (4) Maintainer model: single lead + 2–3 core maintainers with CODEOWNERS; security-sensitive paths (crypto, session, oauth, compiler validation) require 2 approvals; plugin-contract changes require an ADR (PRD §58 style) and a changeset; add OpenSSF Scorecard badge + Best Practices badge as cheap governance signals. Do NOT pursue a foundation early — administrative cost, zero user value at current scale.

Maintainer mechanics: CODEOWNERS maps security-sensitive paths (crypto, session, oauth, compiler validation, release workflows) to ≥2 maintainers; release tags must be reproducible from the Version Packages PR (build from a clean checkout, signing happens only in CI); new maintainers join through a track record of reviewed plugin-contract contributions; decision log = ADRs (PRD §58 style) plus an RFC issue process for plugin-contract changes with a 14-day comment window.
**Confidence:** medium (license is a genuine values call — see Open questions).

## Technologies & libraries

| Name | What it is | License | Maturity | Relevance to awthaq |
|---|---|---|---|---|
| pnpm | Workspace/package manager (Effect uses pnpm@11) | MIT | Very high | Monorepo foundation, `workspace:^` protocol |
| changesets | Versioning + changelogs + publish (3.0.2) | MIT | Very high | Lockstep releases, prerelease `pre` mode |
| @changesets/changelog-github | GitHub-linked changelogs | MIT | High | Release notes quality |
| Turborepo | Task runner/cache (2.10.12) | MIT | Very high | Optional CI acceleration; plain pnpm first |
| Nx | Task runner/graph (23.2.1) | MIT | Very high | Alternative; more opinionated than needed |
| pkg-pr-new | Per-PR npm snapshot publishing (0.0.88) | MIT | Growing | Effect's canary channel for PRs |
| npm trusted publishing / Sigstore | OIDC publish + provenance attestations | n/a | GA (2025-07) | Tokenless secure releases |
| fumadocs | Next.js docs framework (16.15.9) | MIT | High | Docs platform pick (better-auth uses it) |
| Starlight (@astrojs/starlight 0.42.0) | Astro docs theme | MIT | High | Runner-up docs platform |
| Nextra | Next.js MDX docs (4.6.1) | MIT | High | Lighter alternative |
| @effect/cli | Effect CLI framework (0.77.1, Effect 3) | MIT | 0.x but stable in practice | MVP CLI |
| effect/unstable/cli | Effect v4 in-core CLI (unstable) | MIT | Preview | Future CLI migration target |
| citty / commander / oclif | Alternative CLIs (0.2.2 / 15.0.0 / 5.0.0) | MIT | High / Very high / High | Considered, not chosen |
| fast-check | Property-based testing (4.10.0) | MIT | Very high | Security invariant tests, Schema fuzzing |
| Semgrep CE | JS/TS SAST | LGPL-2.1 (engine) | High | Auth-pitfall static analysis in CI |
| @jazzer.js/core | Coverage-guided Node fuzzing (4.0.0) | Apache-2.0 | Medium | Optional deep fuzzing of parsers |
| mitata / tinybench | JS benchmarking (1.0.34 / 6.2.0) | MIT | High | Request-path overhead budgets (vitest bench) |
| publint / @arethetypeswrong/cli | Export-map / type-correctness linters | MIT | High | Publish gates for ESM-only packages |
| Redacted (Effect module) | Secret wrapper with redacted rendering | MIT | Stable since Effect 3.3 | Core redaction primitive (Q93) |
| gitleaks | Secret scanning in CI | MIT | High | CI gate |
| OpenSSF Scorecard | Supply-chain posture checks | Apache-2.0 | High | Public trust signal + CI action |
| osv-scanner | Dependency vulnerability scanning (Google) | Apache-2.0 | High | CI gate alongside `npm audit` |
| Renovate | Automated dependency updates | MIT | Very high | Grouped updates; automerge dev-deps |
| @effect/vitest | Vitest integration for Effect (0.30.0) | MIT | High | Foundation for `@awthaq/test` harness |
| oxlint + dprint | Lint + format (Effect's choice) | MIT | High | Repo hygiene without config bikeshedding |
| orama | Local static docs search for fumadocs | MIT | High | Docs search at launch, zero infra |

## Books, papers, blogs, talks

- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) — canonical never-log list; basis of the redactor deny-list.
- [OpenTelemetry: Versioning and stability for clients](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/) — the most rigorous public stability-tier policy; template for `apiVersion` semantics.
- [Semgrep: A technical deep dive into JavaScript vulnerability detection (2025)](https://semgrep.dev/blog/2025/a-technical-deep-dive-into-semgreps-javascript-vulnerability-detection) — evidence JS SAST finds real auth-class bugs; justifies CI placement.
- [npm trusted publishing docs](https://docs.npmjs.com/trusted-publishers/) + [Phil Nash, "Things you need to do for npm trusted publishing" (2026-01)](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/) — the post-token-revival release model, incl. automatic provenance.
- [Changesets prereleases guide](https://changesets.dev/guide/prereleases) — `pre` mode mechanics behind `rc`/`beta` channels.
- [require(esm) backported to Node 20 (Socket)](https://socket.dev/blog/require-esm-backported-to-node-js-20) + [Node 20.19.0 release notes](https://nodejs.org/en/blog/release/v20.19.0) — why ESM-only is now cost-free for consumers.
- [Better Auth security update June 2026](https://better-auth.com/blog/security-update-june-2026) + [ZeroPath on CVE-2025-61928](https://zeropath.com/blog/breaking-authentication-unauthenticated-api-key-creation-in-better-auth-cve-2025-61928) — worked example of multi-plugin advisory handling and of plugins as attack surface.
- [PkgPulse: fumadocs vs nextra v4 vs starlight (2026)](https://www.pkgpulse.com/guides/fumadocs-vs-nextra-v4-vs-starlight-documentation-sites-2026) — current docs-framework decision matrix.
- [Turborepo vs Nx (newstack.dev, 2026)](https://newstack.dev/devops/turborepo-vs-nx/) — decision frame: execution caching vs coordination.
- [Effect Office Hours: v4 RC status (video)](https://www.youtube.com/watch?v=7xvcl2Pfp9A) — context on Effect 4 timeline, which gates the peer-range strategy.

## People & projects to follow

- **Tim Smart** (`@tim-smart`) — Effect core maintainer; `@effect-atom/atom` shows the current best-practice community peer-range discipline ([GitHub](https://github.com/tim-smart), [npm](https://www.npmjs.com/package/@effect-atom/atom)).
- **Michael Arnaldi** (`@mikearnaldi`) — Effect lead; Effect's monorepo/release machinery is the reference implementation for this document ([GitHub](https://github.com/mikearnaldi)).
- **Bereket Engida (`Bekacru`)** — better-auth lead; SECURITY.md, advisory cadence, and docs IA are the competitive benchmark ([GitHub](https://github.com/Bekacru)).
- **pilcrowOnPaper** — Lucia/Oslo author; Lucia's pivot to docs-as-product and Oslo's crypto choices inform docs + crypto-adjacent strategy ([GitHub](https://github.com/pilcrowOnPaper)).
- **Nicolas Dubien (`dubzzz`)** — fast-check author; property-testing patterns for security invariants ([GitHub](https://github.com/dubzzz)).
- **Fuma Nama** — fumadocs author; docs-platform direction ([GitHub](https://github.com/fuma-nama)).
- **William Woodruff (`woodruffw`)** — supply-chain security (zizmor for GitHub Actions); worth following for workflow-hardening guidance ([GitHub](https://github.com/woodruffw)).
- **Effect-TS org** — the release/monorepo workflows themselves ([GitHub](https://github.com/Effect-TS/effect)).
- **changesets org** — versioning tooling direction ([GitHub](https://github.com/changesets/changesets)).

## Recommended defaults for awthaq

1. Monorepo: pnpm workspaces + changesets with a single **fixed group** for all `@awthaq/*` packages; `tsc -b` project references; add Turborepo only when CI hurts.
2. Releases: changesets/action + **npm trusted publishing (OIDC)**, publish job in a protected GitHub environment, `permissions: {}` + SHA-pinned actions, provenance on every package.
3. Channels: `latest` / `rc` (changesets `pre` mode) / `beta`; per-PR installs via pkg-pr-new; npm `snapshot` tag optional after demand exists.
4. Packaging: ESM-only, `engines.node >= 20.19`, `moduleResolution: nodenext`, declaration maps, `publint` + `attw` + dist-type checks as merge gates.
5. Effect peers: `effect ^3.<floor>` on v1; never cross-major ranges; CI tracks `effect@latest` (required) and `effect@rc` (advisory); awthaq v2 majors with Effect 4.
6. CLI: `@effect/cli` with a thin command-function layer; MVP = `doctor`, `schema generate|diff`, `migration create|status|apply`, `plugin list|validate`; `init`/codegen post-MVP.
7. Docs: fumadocs on Next.js; better-auth-shaped IA extended with plugin-dev and adapter-dev sections; examples live in-repo (`examples/*`), docs channel-split only when a second Effect major is supported.
8. Plugin DX: `npm create awthaq-plugin` template with contract harness + release workflow prewired; `plugin validate`/`plugin test` CLI commands; PR-based community listing (Nuxt-modules model), Official tier gated by security review; reserve `@awthaq` npm org + GitHub org + unscoped name day one.
9. Release security: SECURITY.md + private reporting → embargoed GitHub advisory → CVE via GitHub CNA → coordinated release → postmortem for high severity; Renovate + osv-scanner + gitleaks in CI; near-zero runtime deps in core.
10. Security testing: threat-model-mapped abuse-case suite in-repo; fast-check invariant + redaction-canary property tests; semgrep `p/javascript`/`p/typescript`/`p/secrets` + custom auth rules; vitest bench (mitata) overhead budget; fixed-scope external review of session/token/OAuth/compiler paths before 1.0.
11. Redaction: `Redacted` everywhere, one `Redactor` boundary for logs/spans/events, sensitive fields declared once on Schemas, canary-secrets property test as enforcement.
12. Governance: Apache-2.0, CODEOWNERS + 2-approver rule on security paths, ADRs for plugin-contract changes, OpenSSF Scorecard badge at 1.0.

## Open questions for the user

1. **License** — Apache-2.0 (recommended: patent grant, security posture) vs MIT (ecosystem norm, zero friction)?
   - a) Apache-2.0 for all packages
   - b) MIT for all packages
   - c) MIT core + Apache-2.0 official plugins (mixed — most complexity, not recommended)
2. **Effect target for awthaq v1** — gates Q95/Q97 details:
   - a) Effect 3 stable (`latest`) only, v2 line for Effect 4 (recommended)
   - b) Target Effect 4 RC now and ride it to stable (bleeding-edge positioning, unstable APIs like `unstable/cli`, `unstable/httpapi`)
   - c) Dual releases for 3 and 4 (highest cost; evidence says this rots)
3. **Free-form PII redaction policy** — type-level redaction covers secrets; emails/IPs need a policy:
   - a) Redact emails/IPs in events, keep in logs for ops (recommended default)
   - b) Configurable strictness with a privacy-first preset
   - c) Never log emails/IPs anywhere (harder ops debugging)
4. **Third reference app** — proves edge portability but adds CI surface:
   - a) Astro + D1 on Cloudflare (recommended: distinct topology, edge proof)
   - b) SvelteKit + Postgres (covers another major framework's users)
   - c) Ship only two examples at MVP, add the third post-1.0
5. **Community plugin listing bar** — how gated is the docs registry?
   - a) Automated checks + light human review before listing (recommended)
   - b) Open listing, warnings only
   - c) Scorecard-style security score displayed per plugin
6. **Trademark posture** — enforce "official" via npm/GitHub scope ownership only (recommended, year one), or register a trademark early?

## Sources

- https://github.com/Effect-TS/effect (monorepo, package.json, .changeset/config.json, .github/workflows/release.yml, .github/workflows/snapshot.yml, packages/effect/package.json, packages/platform/node/package.json, packages/sql/pg/package.json, packages/effect/src/Redacted.ts)
- https://github.com/Effect-TS/website (Astro docs app)
- https://www.npmjs.com/package/effect (dist-tags: latest 3.22.2, rc 4.0.0-rc.115, snapshot, beta)
- https://registry.npmjs.org/@effect/cli/latest · https://registry.npmjs.org/@effect-atom/atom/latest · https://registry.npmjs.org/effect-http/latest · https://registry.npmjs.org/@sqlfx/sql/latest
- https://registry.npmjs.org/better-auth/latest (peer ranges, ESM-only exports) · https://github.com/better-auth/better-auth (SECURITY.md, docs/package.json, docs IA, .postmortem, demo/)
- https://www.npmjs.com/package/lucia (deprecation notice)
- https://docs.npmjs.com/trusted-publishers/ · https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ · https://philna.sh/blog/2026/01/28/trusted-publishing-npm/ · https://wayjam.me/posts/npmjs-trusted-publishing-changes/
- https://changesets.dev/guide/prereleases · https://www.npmjs.com/package/pkg-pr-new
- https://newstack.dev/devops/turborepo-vs-nx/ · https://www.pkgpulse.com/guides/turborepo-vs-nx-monorepo-2026
- https://www.pkgpulse.com/guides/fumadocs-vs-nextra-v4-vs-starlight-documentation-sites-2026 · https://starterpick.com/guides/fumadocs-vs-nextra-vs-docusaurus-2026 · https://www.fumadocs.dev/
- https://nuxt.com/modules · https://github.com/nuxt/starter · https://docs.astro.build/en/guides/integrations/ · https://docs.astro.build/en/reference/integrations-reference/ · https://eslint.org/docs/latest/extend/plugins
- https://docs.npmjs.com/organizations/about-organizations · https://docs.npmjs.com/cli/v10/commands/npm-deprecate
- https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-repository-security-advisories · https://github.blog/security/github-advisory-database-by-the-numbers-known-security-vulnerabilities-and-what-you-can-do-about-them/
- https://better-auth.com/blog/security-update-june-2026 · https://zeropath.com/blog/breaking-authentication-unauthenticated-api-key-creation-in-better-auth-cve-2025-61928 · https://cybersecuritynews.com/better-auth-api-keys-vulnerability/
- https://scorecard.dev/ · https://github.com/ossf/scorecard-action · https://openssf.org/projects/scorecard/
- https://opentelemetry.io/docs/specs/otel/versioning-and-stability/ · https://opentelemetry.io/docs/specs/status/
- https://semver.org · https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- https://docs.semgrep.dev/languages/javascript · https://semgrep.dev/blog/2025/a-technical-deep-dive-into-semgreps-javascript-vulnerability-detection · https://github.com/trailofbits/semgrep-rules
- https://www.npmjs.com/package/fast-check · https://www.npmjs.com/package/@jazzer.js/core · https://www.npmjs.com/package/mitata · https://www.npmjs.com/package/tinybench
- https://www.npmjs.com/package/citty · https://www.npmjs.com/package/clipanion · https://www.npmjs.com/package/commander · https://www.npmjs.com/package/nextra · https://www.npmjs.com/package/fumadocs-core · https://www.npmjs.com/package/@astrojs/starlight · https://www.npmjs.com/package/turbo · https://www.npmjs.com/package/nx · https://www.npmjs.com/package/publint
- https://nodejs.org/en/blog/release/v20.19.0 · https://socket.dev/blog/require-esm-backported-to-node-js-20 · https://nodejs.org/en/about/previous-releases
- https://www.linkedin.com/pulse/mit-vs-apache-20-how-i-chose-license-my-open-source-project-khur-5sc5c · https://opensource.stackexchange.com/questions/7964/why-is-the-apache-license-2-0-patent-license-clause-useful-important · https://www.mend.io/blog/top-10-apache-license-questions-answered/
- https://www.youtube.com/watch?v=7xvcl2Pfp9A (Effect v4 RC status)
