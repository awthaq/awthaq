---
plan: 36-config-scope
ticket: 12
title: "OAuth: a tenant-scoped Context.Service key with a boot-scoped provider registry"
type: execute
wave: 2
depends_on: ["03"]
files_modified:
  - packages/oauth/src/OAuthConfig.ts
  - packages/oauth/src/OAuth.ts
  - packages/oauth/src/OAuthTokenAccess.ts
  - packages/oauth/src/OAuthProviders.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1574]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "OAuthConfig is declared Tenant.perTenant with verified boot fields"
    - "Every OAuthConfig read in the oauth package goes through Tenant.inForce"
    - "OAuthTenantConfig.test.ts passes unchanged"
  artifacts:
    - path: "packages/oauth/src/OAuthConfig.ts"
      provides: "OAuthConfigScoped"
  key_links:
    - from: "OAuth.ts:437, 686-687; OAuthTokenAccess.ts:157-158"
      to: "Tenant.inForce(OAuthConfigScoped)"
      via: "trusted origins and default callback per tenant"
      pattern: "inForce\\(OAuthConfig(\\.OAuthConfig)?Scoped\\)"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Declare `OAuthConfig` (PLAN.md §2.3 row 7; a `Context.Service`, no descriptor, Q5) and route every read through the accessor.
Purpose: G1 and G3 for oauth.
Output: four edited modules.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 row 7, §3.5)
@packages/oauth/src/OAuthConfig.ts (lines 100-170)
@packages/oauth/src/OAuth.ts (lines 430-440, 505-520, 680-750, 765-775)
@packages/oauth/src/OAuthTokenAccess.ts (lines 150-165)
@packages/oauth/src/OAuthProviders.ts (lines 55-70)
@packages/oauth/test/OAuthTenantConfig.test.ts
</context>

<tasks>
<task type="auto">
  <name>Task 1: declaration and constructor</name>
  <files>packages/oauth/src/OAuthConfig.ts</files>
  <read_first>OAuthConfig.ts lines 50-170; PLAN.md §3.5 rule 3</read_first>
  <action>Add `OAuthConfigScoped = Tenant.perTenant(OAuthConfig, { boot: [...] })`. Candidates: `baseUrl`, `nativeRedirectURLs`, `providers`, `retry`, `httpTimeouts` (OAuth.ts:700, :721, :739, :746; OAuthProviders.ts:61). Apply rule 3 with `grep -n "<field>" packages/oauth/src/*.ts` and record verdicts in Comments; `trustedOrigins`, `defaultCallbackURL`, `linking` and `bounce` are per operation (OAuthTenantConfig.test.ts:85) and must not be boot. Make `config` (`:152`) return the declaration's `layer`, keeping its input normalisation.</action>
  <verify><automated>pnpm build</automated></verify>
  <acceptance_criteria>
    - `grep -c "perTenant(OAuthConfig" packages/oauth/src/OAuthConfig.ts` prints 1 (baseline 0)
  </acceptance_criteria>
  <done>Declared, with justified boot fields.</done>
</task>

<task type="auto">
  <name>Task 2: reads</name>
  <files>packages/oauth/src/OAuth.ts, packages/oauth/src/OAuthTokenAccess.ts, packages/oauth/src/OAuthProviders.ts</files>
  <read_first>the read sites in context</read_first>
  <action>Replace `OAuth.ts:437` and `:686-687` and `OAuthTokenAccess.ts:157-158` with `yield* Tenant.inForce(OAuthConfigScoped)` bound to the existing names (`configNow`; add `const config_ = yield* configNow` in the build where `config_` is used for boot derivations, OAuth.ts:700-746). Route `OAuthProviders.ts:61` (the registry, built once) through the accessor. Leave `OAuth.ts:513` (`SessionCookieConfig`, an ambient host-level read) unchanged.</action>
  <verify><automated>npx vitest run packages/oauth/test/OAuthTenantConfig.test.ts packages/oauth/test/OAuth.test.ts packages/oauth/test/OAuthTokenAccess.test.ts packages/oauth/test/OAuthNative.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *(OAuthConfig\.)?OAuthConfig\b' packages/oauth/src | wc -l` prints 0 (baseline 4)
    - `grep -rn 'configInForce' packages/oauth/src | wc -l` prints 0 (baseline 3)
  </acceptance_criteria>
  <done>The oauth package reads its configuration only through the accessor.</done>
</task>
</tasks>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Raw reads 4 → 0; OAuthTenantConfig green.
</success_criteria>

## Comments

Result: OAuthConfigScoped = perTenant(OAuthConfig, boot: baseUrl, nativeRedirectURLs, providers, retry). httpTimeouts is NOT boot (read per operation at OAuth.ts token exchange/jwks/userinfo and OAuthTokenAccess.ts:234). config() returns OAuthConfigScoped.layer(...). OAuth.ts (2 sites), OAuthTokenAccess.ts, OAuthProviders.ts read via Tenant.inForce; raw reads 4 -> 0, configInForce 0. Tests green (436 across jwt+oauth); tsc clean for both packages.
