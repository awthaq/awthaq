---
plan: 36-config-scope
ticket: 11
title: "Jwt: a tenant-scoped Context.Service key with a boot-scoped key ring"
type: execute
wave: 2
depends_on: ["03"]
files_modified:
  - packages/jwt/src/JwtConfig.ts
  - packages/jwt/src/Jwt.ts
  - packages/jwt/src/KeyRing.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1574]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "JwtConfig is declared Tenant.perTenant with the key ring's fields as boot"
    - "Jwt.ts reads JwtConfig only through Tenant.inForce; KeyRing's layer build does too"
    - "KeyRing's maintenance functions (settle, rotate) keep reading the key from their own context, documented"
    - "JwtTenantConfig.test.ts passes unchanged"
  artifacts:
    - path: "packages/jwt/src/JwtConfig.ts"
      provides: "JwtConfigScoped"
  key_links:
    - from: "Jwt.ts:258-259, 346-347, 601-602"
      to: "Tenant.inForce(JwtConfigScoped)"
      via: "issuer, audience and ttl per tenant"
      pattern: "inForce\\(JwtConfigScoped\\)"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Declare `JwtConfig` (PLAN.md §2.3 row 8) and route the plugin's reads through the accessor. `JwtConfig` is a `Context.Service` (required fields, no default), so it gets a declaration and no descriptor (PLAN.md Q5).
Purpose: G1 and G3 for jwt.
Output: three edited modules.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 row 8, §3.5)
@packages/jwt/src/JwtConfig.ts (lines 95-130)
@packages/jwt/src/Jwt.ts (lines 250-265, 340-380, 425-440, 595-610)
@packages/jwt/src/KeyRing.ts (lines 155-170, 230-245, 280-295, 315-330, 340-350, 395-410)
@packages/jwt/test/JwtTenantConfig.test.ts
</context>

<tasks>
<task type="auto">
  <name>Task 1: declaration, boot verdicts, constructor</name>
  <files>packages/jwt/src/JwtConfig.ts</files>
  <read_first>JwtConfig.ts lines 37-130; PLAN.md §3.5 rule 3</read_first>
  <action>Add `JwtConfigScoped = Tenant.perTenant(JwtConfig, { boot: [...] })`. Candidates (PLAN.md §2.3): `algorithm`, `rsaModulusLength`, `keyRotationInterval`, `keyGracePeriod`, `keyCacheMaxAge`, `keyMinRefreshInterval`, `jwksMaxAge`, `acceptAsBearer`. Apply rule 3 to each with `grep -n "<field>" packages/jwt/src/*.ts`; a field read from `configNow`'s value in an operation (for example `jwksMaxAge` in a JWKS handler) is not boot. Record each verdict in Comments. Make `config` (`:111`) return the declaration's `layer`, keeping its input normalisation.</action>
  <verify><automated>pnpm build</automated></verify>
  <acceptance_criteria>
    - `grep -c "perTenant(JwtConfig" packages/jwt/src/JwtConfig.ts` prints 1 (baseline 0)
  </acceptance_criteria>
  <done>Declared, with justified boot fields.</done>
</task>

<task type="auto">
  <name>Task 2: reads</name>
  <files>packages/jwt/src/Jwt.ts, packages/jwt/src/KeyRing.ts</files>
  <read_first>the read sites in context</read_first>
  <action>In `Jwt.ts`, replace the three build-read-plus-old-helper pairs (`:258-259`, `:346-347`, `:601-602`) with `yield* Tenant.inForce(JwtConfigScoped)` (keep the names; where the build value is also used, add `const builtConfig = yield* configNow` in the build, as ticket 10 does), and `:430` (`acceptAsBearer`, boot) with a build read through the accessor. In `KeyRing.ts`, route the `layerFromStore` build read (`:320`) through the accessor. The other KeyRing reads (`:165`, `:240`, `:287`, `:347`, `:403`) are maintenance functions that require `JwtConfig` in their context and run from a rotation fiber or an operator job: confirm none is called per request (grep their callers), leave them, and add a one-line comment at each: "key-ring maintenance: reads the key from its own context (PLAN 36 §3.5 rule 2 exception)". If one is called per request, route it through the accessor instead and record that in Comments.</action>
  <verify><automated>npx vitest run packages/jwt/test/JwtTenantConfig.test.ts packages/jwt/test/Jwt.test.ts packages/jwt/test/KeyRing.test.ts packages/jwt/test/BearerReentry.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *JwtConfig\b' packages/jwt/src/Jwt.ts | wc -l` prints 0 (baseline 4)
    - `grep -rnE 'yield\* *JwtConfig\b' packages/jwt/src | wc -l` prints 5 (baseline 10), or fewer if a maintenance read was found to run per request
    - `grep -rn 'configInForce' packages/jwt/src | wc -l` prints 0 (baseline 3)
  </acceptance_criteria>
  <done>The jwt plugin reads its configuration through the accessor; maintenance reads are documented.</done>
</task>
</tasks>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Jwt.ts raw reads 4 → 0, package 10 → 5; JwtTenantConfig green.
</success_criteria>

## Comments

Result: JwtConfigScoped = perTenant(JwtConfig, boot: algorithm, rsaModulusLength, keyRotationInterval, keyGracePeriod, keyCacheMaxAge, keyMinRefreshInterval, acceptAsBearer). jwksMaxAge not boot (per-request JWKS handler). config() is Layer.unwrap over JwtConfigScoped.layer (validation kept). Jwt.ts raw reads 4 -> 0; KeyRing layerFromStore via accessor; 5 maintenance reads (settle/rotate/import/etc.) kept with the comment, none per request. Package raw reads 10 -> 5, configInForce 0. jwt+oauth vitest 436 pass; tsc clean for both packages.
